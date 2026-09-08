import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { safeName, visualEvidenceMedia } from "./artifacts.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

function checkFailureFeedback(check, log = "") {
  const highlights = String(log).split(/\r?\n/).filter((line) =>
    /not ok\b|FAIL(?:ED)?\b|\b(?:error|expected|actual|AssertionError|ERR_)\b/i.test(line)
  ).slice(-80).join("\n").slice(-6000);
  return {
    id: `check:${check.id}`,
    body: [`GitHub check "${check.name}" failed (${check.conclusion}).`, highlights, check.details_url].filter(Boolean).join("\n\n")
  };
}

function repositoryFromRemote(remote) {
  const match = String(remote).match(/(?:https?:\/\/|ssh:\/\/git@|git@)([^/:]+)[/:](.+?)(?:\.git)?$/i);
  if (!match) throw new Error(`Unsupported origin URL: ${remote}`);
  const [, host, path] = match;
  return { host: host.toLowerCase(), path: path.replace(/\.git$/, "") };
}

class JsonApi {
  constructor({ baseUrl, token, fetchImpl = fetch, headers = {} }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.headers = headers;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: { accept: "application/json", ...this.headers, ...(options.body && !(options.body instanceof FormData) ? { "content-type": "application/json" } : {}), ...options.headers }
    });
    const text = response.text ? await response.text() : JSON.stringify(await response.json());
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
    if (!response.ok) throw Object.assign(new Error(payload?.message || payload?.error || `Remote forge returned ${response.status}`), { status: response.status });
    return payload;
  }
}

export class GitHubDelivery {
  constructor({ repository, token = process.env.GITHUB_TOKEN, fetchImpl = fetch, baseUrl = process.env.GITHUB_API_URL || "https://api.github.com" }) {
    if (!token) throw new Error("GITHUB_TOKEN is required for GitHub delivery");
    this.repository = repository;
    this.api = new JsonApi({ baseUrl, token, fetchImpl, headers: {
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      accept: "application/vnd.github+json"
    } });
  }

  async create({ branch, base, title, body }) {
    const pull = await this.api.request(`/repos/${this.repository}/pulls`, { method: "POST", body: JSON.stringify({ head: branch, base, title, body, draft: false }) });
    return { provider: "github", id: pull.number, url: pull.html_url, headSha: pull.head?.sha };
  }

  async description(change, body) {
    const pull = await this.api.request(`/repos/${this.repository}/pulls/${change.id}`, body === undefined ? {} : { method: "PATCH", body: JSON.stringify({ body }) });
    return pull.body || "";
  }

  async uploadEvidence(change, files) {
    const root = `/repos/${this.repository}/git`;
    const tree = [];
    for (const file of files) {
      const blob = await this.api.request(`${root}/blobs`, { method: "POST", body: JSON.stringify({ content: file.bytes.toString("base64"), encoding: "base64" }) });
      tree.push({ path: file.name, mode: "100644", type: "blob", sha: blob.sha });
    }
    const snapshot = await this.api.request(`${root}/trees`, { method: "POST", body: JSON.stringify({ tree }) });
    // Keep evidence reachable without adding binaries or workflow runs to the product branch.
    const ref = `heads/codex/evidence/pr-${change.id}/${snapshot.sha}`;
    let commit;
    try { commit = (await this.api.request(`${root}/ref/${ref}`)).object; }
    catch (error) {
      if (error.status !== 404) throw error;
      commit = await this.api.request(`${root}/commits`, { method: "POST", body: JSON.stringify({ message: `Evidence for PR #${change.id}\n\nWhy: Keep reviewed proof accessible after local artifact cleanup.`, tree: snapshot.sha, parents: [] }) });
      try { await this.api.request(`${root}/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/${ref}`, sha: commit.sha }) }); }
      catch (error) {
        if (error.status !== 422) throw error;
        commit = (await this.api.request(`${root}/ref/${ref}`)).object;
      }
    }
    return files.map((file) => {
      const url = `${change.url.split("/pull/")[0]}/blob/${commit.sha}/${encodeURIComponent(file.name)}`;
      return file.mediaKind === "image" ? `![${file.name}](${url}?raw=true)` : `[${file.name}](${url})`;
    });
  }

  async status(change) {
    const root = `/repos/${this.repository}`;
    const pull = await this.api.request(`${root}/pulls/${change.id}`);
    const [reviews, comments, checks, statuses] = await Promise.all([
      this.api.request(`${root}/pulls/${change.id}/reviews`),
      this.api.request(`${root}/pulls/${change.id}/comments`),
      this.api.request(`${root}/commits/${pull.head.sha}/check-runs`),
      this.api.request(`${root}/commits/${pull.head.sha}/status`)
    ]);
    const latestReviews = new Map();
    for (const review of reviews || []) latestReviews.set(review.user?.login || String(review.id), review);
    const feedback = [
      ...[...latestReviews.values()].filter((review) => review.state === "CHANGES_REQUESTED" && review.body).map((review) => ({ id: `review:${review.id}`, body: review.body, author: review.user?.login })),
      ...(comments || []).filter((comment) => comment.body).map((comment) => ({ id: `comment:${comment.id}`, body: comment.body, path: comment.path, line: comment.line || comment.original_line, author: comment.user?.login }))
    ];
    const checkRuns = checks?.check_runs || [];
    const failedChecks = checkRuns.filter((check) => check.status === "completed" && !["success", "neutral", "skipped"].includes(check.conclusion));
    const checkFeedback = await Promise.all(failedChecks.map(async (check) => {
      let log = "";
      try { log = await this.api.request(`${root}/actions/jobs/${check.id}/logs`); } catch {}
      return checkFailureFeedback(check, log);
    }));
    const hasStatuses = (statuses?.statuses || []).length > 0;
    const pending = checkRuns.some((check) => check.status !== "completed") || (hasStatuses && statuses.state === "pending");
    const failed = checkRuns.some((check) => check.status === "completed" && !["success", "neutral", "skipped"].includes(check.conclusion)) || (hasStatuses && ["failure", "error"].includes(statuses.state));
    return {
      headSha: pull.head.sha,
      feedback: [...feedback, ...checkFeedback],
      checks: failed ? "failed" : pending ? "pending" : "passed",
      mergeable: !pull.draft && pull.mergeable === true,
      ready: !pull.draft && pull.mergeable === true && !failed && !pending && !feedback.length,
      mergeState: pull.mergeable_state,
      merged: Boolean(pull.merged)
    };
  }

  async merge(change, title) {
    const result = await this.api.request(`/repos/${this.repository}/pulls/${change.id}/merge`, {
      method: "PUT", body: JSON.stringify({ merge_method: "squash", commit_title: title })
    });
    if (!result.merged) throw new Error(result.message || "GitHub did not merge the pull request");
    return { commit: result.sha };
  }

  comment(change, body) {
    return this.api.request(`/repos/${this.repository}/issues/${change.id}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  }
}

export class GitLabDelivery {
  constructor({ project, token = process.env.GITLAB_TOKEN, fetchImpl = fetch, baseUrl = process.env.GITLAB_API_URL || "https://gitlab.com/api/v4" }) {
    if (!token) throw new Error("GITLAB_TOKEN is required for GitLab delivery");
    this.project = encodeURIComponent(project);
    this.api = new JsonApi({ baseUrl, token, fetchImpl, headers: { "private-token": token } });
  }

  async create({ branch, base, title, body }) {
    const request = await this.api.request(`/projects/${this.project}/merge_requests`, {
      method: "POST", body: JSON.stringify({ source_branch: branch, target_branch: base, title, description: body, squash: true, remove_source_branch: false })
    });
    return { provider: "gitlab", id: request.iid, url: request.web_url, headSha: request.sha };
  }

  async description(change, description) {
    const request = await this.api.request(`/projects/${this.project}/merge_requests/${change.id}`, description === undefined ? {} : { method: "PUT", body: JSON.stringify({ description }) });
    return request.description || "";
  }

  async uploadEvidence(_change, files) {
    const links = [];
    for (const file of files) {
      const body = new FormData();
      body.append("file", new Blob([file.bytes], { type: file.mediaType }), file.name);
      const uploaded = await this.api.request(`/projects/${this.project}/uploads`, { method: "POST", body });
      if (!uploaded.markdown) throw new Error("GitLab evidence upload returned no Markdown link");
      links.push(uploaded.markdown);
    }
    return links;
  }

  async status(change) {
    const root = `/projects/${this.project}/merge_requests/${change.id}`;
    const [request, discussions] = await Promise.all([this.api.request(root), this.api.request(`${root}/discussions`)]);
    const feedback = (discussions || []).flatMap((discussion) => (discussion.notes || [])
      .filter((note) => !note.system && note.resolvable && !note.resolved && note.body)
      .map((note) => ({ id: `note:${note.id}`, body: note.body, author: note.author?.username })));
    const pipeline = request.head_pipeline?.status;
    const failed = ["failed", "canceled"].includes(pipeline);
    const pending = ["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled", "manual"].includes(pipeline);
    const mergeable = ["mergeable", "ci_still_running"].includes(request.detailed_merge_status);
    return {
      headSha: request.sha,
      feedback,
      checks: failed ? "failed" : pending ? "pending" : "passed",
      mergeable: mergeable && request.blocking_discussions_resolved !== false,
      ready: mergeable && !failed && !pending && !feedback.length && request.blocking_discussions_resolved !== false,
      mergeState: request.detailed_merge_status,
      merged: request.state === "merged"
    };
  }

  async merge(change) {
    const result = await this.api.request(`/projects/${this.project}/merge_requests/${change.id}/merge`, {
      method: "PUT", body: JSON.stringify({ squash: true, should_remove_source_branch: false })
    });
    if (result.state !== "merged") throw new Error(result.message || "GitLab did not merge the merge request");
    return { commit: result.merge_commit_sha || result.squash_commit_sha };
  }

  comment(change, body) {
    return this.api.request(`/projects/${this.project}/merge_requests/${change.id}/notes`, { method: "POST", body: JSON.stringify({ body }) });
  }
}

export function deliveryForRemote(remote, options = {}) {
  const repository = repositoryFromRemote(remote);
  if (repository.host === "github.com" || repository.host === new URL(process.env.GITHUB_SERVER_URL || "https://github.com").host) {
    return new GitHubDelivery({ repository: repository.path, ...options });
  }
  if (repository.host.includes("gitlab") || process.env.GITLAB_API_URL) return new GitLabDelivery({ project: repository.path, ...options });
  throw new Error(`No GitHub or GitLab delivery adapter for ${repository.host}`);
}

async function git(cwd, args, execImpl = exec) {
  const { stdout = "" } = await execImpl("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

export async function remoteContext(cwd, execImpl = exec) {
  const remote = await git(cwd, ["remote", "get-url", "origin"], execImpl);
  let base;
  try { base = (await git(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], execImpl)).replace(/^origin\//, ""); }
  catch { base = await git(cwd, ["branch", "--show-current"], execImpl); }
  if (!base) throw new Error("Could not determine the target branch");
  return { remote, base };
}

export async function pushTicketBranch(cwd, branch, execImpl = exec) {
  await git(cwd, ["push", "--force-with-lease", "--set-upstream", "origin", branch], execImpl);
}

export async function unmergedPaths(cwd, execImpl = exec) {
  return (await git(cwd, ["diff", "--name-only", "--diff-filter=U"], execImpl)).split("\n").filter(Boolean);
}

export async function reconcileWithRemote(cwd, base, { resolveConflicts, execImpl = exec } = {}) {
  let activeMerge = false;
  try { await git(cwd, ["rev-parse", "--verify", "MERGE_HEAD"], execImpl); activeMerge = true; }
  catch {}
  let failure;
  if (!activeMerge) {
    // Ticket worktrees are disposable delivery branches. Restart interrupted
    // legacy rebases and merge the reviewed branch tip once instead.
    await git(cwd, ["rebase", "--abort"], execImpl).catch(() => {});
    await git(cwd, ["fetch", "origin", base], execImpl);
    try { await git(cwd, ["merge", "--no-edit", `origin/${base}`], execImpl); }
    catch (error) { failure = error; }
  }
  if (failure || activeMerge) {
    const conflicts = await unmergedPaths(cwd, execImpl);
    if (activeMerge && !conflicts.length) {
      await git(cwd, ["-c", "core.editor=true", "merge", "--continue"], execImpl);
      return { commit: await git(cwd, ["rev-parse", "HEAD"], execImpl) };
    }
    if (!conflicts.length || !resolveConflicts) throw failure || new Error("An active merge still needs conflict resolution");
    await resolveConflicts({ cwd, conflicts });
    await git(cwd, ["add", "--all"], execImpl);
    await git(cwd, ["-c", "core.editor=true", "merge", "--continue"], execImpl);
  }
  return { commit: await git(cwd, ["rev-parse", "HEAD"], execImpl) };
}

export async function safeSyncLocal(cwd, base, execImpl = exec) {
  await git(cwd, ["fetch", "origin", base], execImpl);
  if (await git(cwd, ["status", "--porcelain"], execImpl)) return { status: "skipped", reason: "opened repository has local changes" };
  try { await git(cwd, ["merge-base", "--is-ancestor", "HEAD", `origin/${base}`], execImpl); }
  catch { return { status: "skipped", reason: "opened branch is not behind the merged target" }; }
  await git(cwd, ["merge", "--ff-only", `origin/${base}`], execImpl);
  return { status: "updated", commit: await git(cwd, ["rev-parse", "HEAD"], execImpl) };
}

export const parseRemoteRepository = repositoryFromRemote;

// Updating one marked section makes a retry after an uncertain PATCH harmless.
export async function publishDeliveryEvidence(forge, change, checks) {
  if (checks?.status === "failed") throw new Error("Cannot publish failed verification as delivery proof");
  const evidence = checks?.evidence || [];
  if (!evidence.length) return;
  const files = [];
  for (const [index, item] of evidence.entries()) {
    const media = visualEvidenceMedia(item.name || item.path);
    if (!media) throw new Error(`Unsupported delivery evidence: ${item.name}`);
    files.push({ name: `${index + 1}-${safeName(item.name || item.path.split("/").at(-1))}`, ...media, bytes: await readFile(item.path) });
  }
  const digest = createHash("sha256").update(JSON.stringify({ summary: checks.summary, assertions: evidence.map((item) => item.assertions || []), files: files.map((file) => [file.name, createHash("sha256").update(file.bytes).digest("hex")]) })).digest("hex");
  const start = "<!-- harness-evidence -->";
  const end = "<!-- /harness-evidence -->";
  const body = await forge.description(change);
  if (body.includes(`${start}\n<!-- ${digest} -->`)) return;
  const links = await forge.uploadEvidence(change, files);
  const proof = links.map((link, index) => [link, ...(evidence[index].assertions || []).map((assertion) => `- ${typeof assertion === "string" ? assertion : JSON.stringify(assertion)}`)].join("\n\n")).join("\n\n");
  const section = `${start}\n<!-- ${digest} -->\n## Verification evidence\n\n${checks.summary || "Final verification evidence"}\n\n${proof}\n${end}`;
  const pattern = /<!-- harness-evidence -->[\s\S]*?<!-- \/harness-evidence -->/;
  await forge.description(change, pattern.test(body) ? body.replace(pattern, () => section) : `${body}\n\n${section}`);
}

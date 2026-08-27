export function executionGraph(plan) {
  const nodes = plan?.nodes || [];
  const owner = new Map();
  for (const node of nodes) {
    owner.set(node.id, node.id);
    for (const child of node.children || []) owner.set(child.id, node.id);
  }

  const units = nodes.map((node) => {
    const dependencies = (node.type === "group" ? node.children.flatMap((child) => child.dependsOn || []) : node.dependsOn || [])
      .map((id) => owner.get(id))
      .filter((id, index, all) => id && id !== node.id && all.indexOf(id) === index);
    return { id: node.id, node, dependencies };
  });
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const memo = new Map();
  const levelOf = (id, visiting = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    const next = new Set(visiting).add(id);
    const dependencies = byId.get(id)?.dependencies.filter((dependency) => byId.has(dependency)) || [];
    const level = dependencies.length ? Math.max(...dependencies.map((dependency) => levelOf(dependency, next))) + 1 : 0;
    memo.set(id, level);
    return level;
  };
  for (const unit of units) unit.level = levelOf(unit.id);

  const columns = Array.from({ length: Math.max(0, ...units.map((unit) => unit.level)) + 1 }, () => []);
  for (const unit of units) columns[unit.level].push(unit);
  return {
    columns,
    edges: units.flatMap((unit) => unit.dependencies
      .filter((dependency) => byId.has(dependency))
      .map((dependency) => ({ from: dependency, to: unit.id })))
  };
}

export function artifactsForStage(artifacts = [], stageId) {
  return artifacts.filter((artifact) => artifact.stageId === stageId || (stageId === "verify" && artifact.stageId?.startsWith("review-round-")));
}

export function preferredStepId(plan, currentId) {
  const steps = (plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children : [node]);
  if (steps.some((step) => step.id === currentId)) return currentId;
  return steps.find((step) => step.status === "review_ready")?.id || steps[0]?.id || null;
}

export function restartOptions(run) {
  if (!run || run.merge || run.integration) return [];
  const artifacts = run.artifacts || [];
  const options = [];
  if (run.workspace?.cwd && run.baselineTree && artifacts.some((artifact) => artifact.kind === "requirements")) {
    options.push({ value: "stage:explore", label: "Explore code again", detail: "Restore the repository baseline, then regenerate exploration and the plan." });
  }
  if (run.workspace?.cwd && run.baselineTree && ["requirements", "product-context-snapshot", "implementation-delta"].every((kind) => artifacts.some((artifact) => artifact.kind === kind))) {
    options.push({ value: "stage:design", label: "Design & plan again", detail: "Keep requirements and exploration, discard the current plan, and design again." });
  }
  const steps = (run.plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children : [node]);
  for (const step of steps) {
    if (step.baseTree || run.baselineTree) options.push({ value: `step:${step.id}`, label: `Step · ${step.title}`, detail: "Restore the checkpoint before this step and rerun it and every later step." });
  }
  if (steps.length && steps.every((step) => step.status === "accepted")) {
    options.push({ value: "stage:verify", label: "Review & verify again", detail: "Keep accepted code and rerun combined checks and independent review." });
  }
  return options;
}

export function runMetrics(run, now = Date.now()) {
  if (!run) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, correctionRounds: 0, durationSeconds: 0 };
  const steps = (run.plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children : [node]);
  const attempts = steps.flatMap((step) => step.attempts || []);
  const stageEvents = (run.stages || []).flatMap((stage) => stage.activity?.events || []);
  const events = [...attempts.flatMap((attempt) => attempt.events || []), ...stageEvents];
  const usage = events.filter((event) => event.type === "usage").reduce((total, event) => ({
    input: total.input + Number(event.input || 0),
    output: total.output + Number(event.output || 0),
    cacheRead: total.cacheRead + Number(event.cacheRead || 0),
    cacheWrite: total.cacheWrite + Number(event.cacheWrite || 0)
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const end = run.completedAt || (run.status === "completed" ? run.integration?.integratedAt : null) || now;
  const start = Date.parse(run.createdAt || end);
  return {
    ...usage,
    calls: events.filter((event) => event.type === "tool_start").length,
    correctionRounds: steps.reduce((total, step) => total + Math.max(0, (step.attempts?.length || 0) - 1), 0) + Math.max(0, (run.reviews?.length || 0) - 1),
    durationSeconds: Math.max(0, Math.floor((new Date(end).getTime() - start) / 1000))
  };
}

function firstLine(value, fallback = "") {
  return String(value || "").split(/\r?\n/).find((line) => line.trim())?.trim().replace(/[*`]/g, "").slice(0, 120) || fallback;
}

export function freeTextTicket(value, id) {
  const description = String(value || "").trim();
  const suffix = String(id || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!description) throw new Error("Describe the task first");
  if (!suffix) throw new Error("Task ID is required");
  const title = firstLine(description).replace(/^#+\s*/, "") || "Untitled task";
  return {
    id: `local-text-${suffix}`,
    identifier: `TEXT-${suffix.replaceAll("-", "").slice(0, 8).toUpperCase()}`,
    title,
    description,
    source: "local",
    state: { name: "Free text", type: "local", color: "#8b7cf6" },
    team: { name: "Local" }
  };
}

function toolTitle(tool, args) {
  let values = {};
  try { values = JSON.parse(args || "{}"); } catch {}
  if (tool === "worker_report") {
    const status = values.status ? ` · ${values.status}` : "";
    const summary = firstLine(values.summary);
    return `Worker report${status}${summary ? ` — ${summary}` : ""}`;
  }
  const label = ({ bash: "Command", read: "Read", grep: "Search", find: "Find", ls: "List", edit: "Edit", write: "Write" })[tool] || tool.replaceAll("_", " ");
  const subject = firstLine(values.command || values.cmd || values.path || values.pattern || values.query);
  return subject ? `${label} · ${subject}` : label;
}

function expandJson(value) {
  if (Array.isArray(value)) return value.map(expandJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandJson(item)]));
  if (typeof value !== "string" || !/^[{[]/.test(value.trim())) return value;
  try { return expandJson(JSON.parse(value)); } catch { return value; }
}

export function formatOutput(value = "") {
  const text = String(value);
  if (!/^[{[]/.test(text.trim())) return text;
  try { return JSON.stringify(expandJson(JSON.parse(text)), null, 2); } catch { return text; }
}

export function eventTimeline(events = []) {
  const items = [];
  const byCallId = new Map();
  const pendingByTool = new Map();
  for (const event of events) {
    if (event.type === "tool_start") {
      const item = { key: event.callId || `${event.tool}:${items.length}`, tool: event.tool, title: `${event.actor ? `${event.actor} · ` : ""}${toolTitle(event.tool, event.args)}`, at: event.at, args: event.args || "", output: "", result: "", status: "running", isError: false };
      items.push(item);
      if (event.callId) byCallId.set(event.callId, item);
      else pendingByTool.set(event.tool, [...(pendingByTool.get(event.tool) || []), item]);
      continue;
    }
    if (["tool_update", "tool_end"].includes(event.type)) {
      let item = event.callId ? byCallId.get(event.callId) : pendingByTool.get(event.tool)?.find((candidate) => candidate.status === "running");
      if (!item) {
        item = { key: event.callId || `${event.tool}:${items.length}`, tool: event.tool, title: event.tool, at: event.at, args: "", output: "", result: "", status: "running", isError: false };
        items.push(item);
      }
      if (event.type === "tool_update") item.output = event.replace ? event.detail || "" : item.output + (event.detail || "");
      else Object.assign(item, { result: event.result || "", status: event.isError ? "failed" : "finished", isError: Boolean(event.isError) });
      continue;
    }
    if (event.type === "agent_error") items.push({ key: `error:${items.length}`, title: `${event.actor ? `${event.actor} · ` : ""}Model request failed`, at: event.at, result: event.label || "Unknown model error", status: "failed", isError: true });
    if (["thinking", "phase"].includes(event.type)) items.push({ key: `reasoning:${items.length}`, title: `Reasoning · ${event.actor ? `${event.actor} · ` : ""}${event.label || "working"}`, at: event.at, result: "", status: "summary", isError: false });
    if (event.type === "reasoning_summary") items.push({ key: `reasoning:${items.length}`, title: `Reasoning · ${event.actor ? `${event.actor} · ` : ""}${firstLine(event.detail, "summary")}`, at: event.at, result: event.detail || "", status: "summary", isError: false });
  }
  return items.map((item) => ({ ...item, hasDetails: Boolean(item.args || item.output || item.result) }));
}

export function eventGroups(events = []) {
  const groups = [];
  let current;
  for (const item of eventTimeline(events)) {
    if (item.key.startsWith("reasoning:")) {
      const title = item.title.replace(/^Reasoning · /, "");
      if (current && current.items.length === 0) {
        current.title = title;
        current.note = [current.note, item.result].filter(Boolean).join("\n\n");
      } else {
        current = { key: item.key, title, note: item.result || "", at: item.at, endedAt: item.at, items: [], isError: false };
        groups.push(current);
      }
      continue;
    }
    if (!current) {
      current = { key: `activity:${groups.length}`, title: item.title, note: "", at: item.at, endedAt: item.at, items: [], isError: false };
      groups.push(current);
    }
    current.items.push(item);
    current.endedAt = item.at || current.endedAt;
    current.isError ||= item.isError;
  }
  return groups;
}

function findingDetails(findings) {
  return findings.map((finding, index) => `### Finding ${index + 1} · ${finding.severity || "issue"}\n\n${finding.claim || "Unspecified finding"}${finding.suggestedFix ? `\n\n**Suggested fix:** ${finding.suggestedFix}` : ""}`).join("\n\n");
}

export function stageMilestones(run, stage) {
  const activity = stage?.activity;
  if (stage?.id === "verify") {
    const items = activity?.startedAt ? [{ title: "Agent review started.", status: "started", at: activity.startedAt, detail: "Independent requirements, integration, verification, and deterministic-check reviews started." }] : [];
    for (const [index, review] of (run?.reviews || []).entries()) {
      const findings = review.actionableFindings || [];
      items.push({
        title: `Review round ${index + 1} ${findings.length ? "found issues." : "passed."}`,
        status: findings.length ? `${findings.length} finding${findings.length === 1 ? "" : "s"}` : "clean",
        at: review.createdAt,
        detail: findings.length ? findingDetails(findings) : (review.reviews || []).map((item) => `**${item.role}:** ${item.summary}`).join("\n\n")
      });
      if (review.fix) items.push({
        title: "Focused fixes completed.",
        status: "fixed",
        at: review.fix.artifact?.createdAt || review.createdAt,
        detail: [review.fix.report?.summary, review.fix.diff ? `${review.fix.diff.files?.length || 0} files · +${review.fix.diff.additions || 0} −${review.fix.diff.deletions || 0}` : null].filter(Boolean).join("\n\n")
      });
    }
    if (stage.status === "active") items.push({ title: `Review round ${(run?.reviews?.length || 0) + 1} started.`, status: "running", at: stage.updatedAt, detail: "Reviewing the combined implementation after the latest fixes." });
    if (stage.status === "completed") items.push({ title: "Agent review completed.", status: "complete", at: stage.updatedAt, detail: stage.summary });
    return items;
  }
  if (stage?.id === "handoff") {
    const items = activity?.startedAt ? [{ title: "Handoff started.", status: "started", at: activity.startedAt, detail: "Preparing the final product-context update and repository integration." }] : [];
    const proposal = (run?.artifacts || []).find((artifact) => artifact.kind === "product-context-update");
    if (proposal) items.push({ title: "Product context update prepared.", status: run.checkpoint?.kind === "product_context_review" ? "awaiting approval" : "approved", at: proposal.createdAt, detail: proposal.content });
    const merge = run?.merge;
    if (merge?.queuedAt) items.push({ title: "Added to merge queue.", status: merge.status === "queued" ? `position ${merge.position}` : "started", at: merge.queuedAt, detail: `Target repository: \`${merge.sourceCwd}\`\n\nTicket branch: \`${merge.branch}\`` });
    if (merge?.startedAt) items.push({ title: "Automated merge started.", status: "merging", at: merge.startedAt, detail: "Git is merging in an isolated integration worktree; the opened repository remains untouched until verification passes." });
    if (merge?.resolverStartedAt) items.push({ title: "Merge conflicts found.", status: `${merge.conflicts?.length || 0} conflict${merge.conflicts?.length === 1 ? "" : "s"}`, at: merge.resolverStartedAt, detail: (merge.conflicts || []).map((file) => `- \`${file}\``).join("\n") });
    if (merge?.resolverCompletedAt) items.push({ title: "Conflict-resolution agent completed.", status: "resolved", at: merge.resolverCompletedAt, detail: merge.resolutionArtifact?.content || "Conflicts resolved in the isolated integration worktree." });
    if (merge?.verifiedAt) items.push({ title: "Merged result verified.", status: merge.checks?.status || "passed", at: merge.verifiedAt, detail: merge.checks?.summary || "Repository checks passed." });
    if (merge?.failedAt) items.push({ title: "Merge queue blocked.", status: "needs attention", at: merge.failedAt, detail: merge.error });
    if (run?.integration) items.push({ title: "Changes integrated into the working directory.", status: "complete", at: run.integration.integratedAt, detail: `Repository: \`${run.integration.sourceCwd}\`\n\nCommit: \`${run.integration.commit}\`` });
    return items;
  }
  return [];
}

export function runHeartbeat(active, live = {}, now = Date.now()) {
  if (!active) return null;
  const elapsed = Math.max(0, Math.floor((now - Date.parse(active.startedAt)) / 1000));
  const idle = Math.max(0, Math.floor((now - Date.parse(live.lastAt || active.lastEventAt || active.startedAt)) / 1000));
  const warning = Boolean(live.warning || active.warning);
  return {
    label: live.label || active.lastEvent || "Agent is running",
    elapsed,
    idle,
    state: warning ? "warning" : idle >= 30 ? "stale" : "active",
    note: warning ? "operation failed; correction or permission may be required" : idle >= 30 ? "model request or command may still be running" : ""
  };
}

export function parseDiff(patch = "") {
  const blocks = patch.split(/^diff --git /m).slice(1).map((block) => `diff --git ${block}`);
  const files = blocks.map((block, fileIndex) => {
    const header = block.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const name = header?.[2] || `Changed file ${fileIndex + 1}`;
    const rows = [];
    let oldLine = null;
    let newLine = null;
    let additions = 0;
    let deletions = 0;
    const hunks = [];
    const metadata = [];
    let currentHunk = null;
    for (const line of block.split("\n").slice(1)) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        currentHunk = { id: `hunk-${hunks.length + 1}`, header: line, context: hunk[3].trim(), rows: [], additions: 0, deletions: 0 };
        hunks.push(currentHunk);
        rows.push({ kind: "hunk", old: "", new: "", text: `@@ ${hunk[3].trim()}`.trim() });
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        const row = { kind: "add", old: "", new: newLine++, text: line.slice(1) };
        rows.push(row); currentHunk?.rows.push(row); if (currentHunk) currentHunk.additions++;
        additions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        const row = { kind: "delete", old: oldLine++, new: "", text: line.slice(1) };
        rows.push(row); currentHunk?.rows.push(row); if (currentHunk) currentHunk.deletions++;
        deletions++;
      } else if (oldLine !== null && !line.startsWith("\\")) {
        const row = { kind: "context", old: oldLine++, new: newLine++, text: line.startsWith(" ") ? line.slice(1) : line };
        rows.push(row); currentHunk?.rows.push(row);
      } else if (!/^(index |--- |\+\+\+ )/.test(line) && line) {
        const row = { kind: "meta", old: "", new: "", text: line };
        rows.push(row); metadata.push(row);
      }
    }
    if (!hunks.length && metadata.length) hunks.push({ id: "meta", header: "File metadata", context: "File metadata", rows: metadata, additions: 0, deletions: 0 });
    return { name, additions, deletions, rows, hunks, binary: /^(?:GIT binary patch|Binary files )/m.test(block) };
  });
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0)
  };
}

export function reviewNotesForRows(notes = [], path, rows = []) {
  return notes.filter((note) => note.status === "current" && note.path === path && rows.some((row) => {
    const line = note.side === "LEFT" ? row.old : row.new;
    return Number.isInteger(line) && line >= note.startLine && line <= note.endLine;
  }));
}

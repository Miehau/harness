import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, glob, mkdir, mkdtemp, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { cloneRunAccess, resolveAccessPath, writeScopeAllows } from "./access-policy.js";
import { isGitRepository } from "./git.js";
import { projectConfigPath, runProjectCommand } from "./project-config.js";
import { mapConfiguredPath } from "./worktrees.js";
import { verificationEntry } from "./repository-checks.js";

export function reviewEvidenceTool(lookup) {
  return defineTool({
    name: "review_evidence", label: "Read retained review evidence", description: "Read an indexed evidence file in bounded portions. Repository files use read instead.",
    parameters: Type.Object({ file: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
    async execute(_callId, { file, offset = 0, limit = 12000 }) {
      const path = resolve(lookup.root, file);
      if (dirname(path) !== lookup.root || !/\.(json|md|patch)$/.test(path)) throw new Error("Choose a file from the current review index");
      const content = await readFile(path, "utf8");
      const start = Math.max(0, Math.floor(offset));
      return { content: [{ type: "text", text: JSON.stringify({ file, total: content.length, offset: start, content: content.slice(start, start + Math.max(1, Math.min(12000, limit))) }) }] };
    }
  });
}

export function evidenceContext(lookup) {
  return `# Current evidence index\n${JSON.stringify(lookup.summary, null, 2)}\n\nUse review_evidence to read index.json and constraints.md, then the relevant criteria, handoffs, checks and per-file patches. Paths in the index are relative to its directory. This current snapshot supersedes earlier evidence in the conversation. Read only evidence needed for the current task; the complete inventory remains available on demand. If changes.json marks a patch truncated, inspect the affected repository files and report any unresolved evidence gap rather than assuming the omitted change is correct.`;
}

function commandRepositoryCwd(cwd, repository, repositories = []) {
  const id = String(repository || "primary").trim() || "primary";
  if (id === "primary") return cwd;
  const repo = repositories.find((item) => item.id === id && item.cwd);
  if (!repo) throw new Error(`Unknown repository “${id}” for project_command`);
  return repo.cwd;
}

export function projectCommandTool(cwd, signal, containment, runCommand = runProjectCommand, onCleanup, evidenceRoot, repositories = []) {
  return defineTool({
    name: "project_command",
    label: "Project command",
    description: `Run one repository-approved argv command. Optional safe word arguments can narrow commands such as test filters. Optional repository selects a mapped worktree and that repository's project.json; omit it to keep the primary worktree.`,
    promptSnippet: "Run a repository-approved development command",
    promptGuidelines: ["Use this for focused tests, lint, type checks, formatting, and builds declared by the repository."],
    parameters: Type.Object({
      name: Type.String(),
      args: Type.Optional(Type.Array(Type.String())),
      repository: Type.Optional(Type.String({ description: "Frozen repository id. Defaults to primary." }))
    }),
    async execute(_toolCallId, { name, args = [], repository } = {}) {
      if (name === "verify" || name === "capture-proof") return {
        content: [{ type: "text", text: `The framework runs ${name === "verify" ? verificationEntry : "capture-proof with the current capture identity and evidence directory"} once after worker_report; continue without rerunning it.` }],
        details: { status: "deferred", command: name }, isError: false
      };
      let environment;
      if (evidenceRoot) {
        await mkdir(evidenceRoot, { recursive: true });
        environment = { AGENT_PLAN_EVIDENCE_DIR: await mkdtemp(join(evidenceRoot, "command-")) };
      }
      const commandCwd = commandRepositoryCwd(cwd, repository, repositories);
      const result = await runCommand(commandCwd, name, { signal, args, ownership: containment?.ownership, containment, environment });
      if (result.timedOut && containment) {
        const trigger = result.cleanupTrigger || { trigger: "repository-command-timeout", command: name, at: new Date().toISOString() };
        try {
          if (!result.cleanup) result.cleanup = await containment.cleanup(trigger);
          await onCleanup?.(result.cleanup, trigger);
        }
        catch (error) {
          result.cleanup = { executionId: containment.executionId, outcome: "incomplete", diagnostics: [`Repository-command cleanup failed: ${error instanceof Error ? error.message : String(error)}`] };
        }
      }
      return { content: [{ type: "text", text: result.output || `${name} ${result.status}` }], details: result, isError: result.status === "failed" };
    }
  });
}

export function checkpointTool(capture) {
  return defineTool({
    name: "workflow_checkpoint", label: "Workflow checkpoint", description: "Pause the binding workflow for a user answer or explicit approval.",
    promptSnippet: "Create a blocking workflow checkpoint",
    promptGuidelines: ["Use this whenever a binding workflow requires user input or approval. It terminates the turn."],
    parameters: Type.Object({ kind: Type.Union([Type.Literal("needs_input"), Type.Literal("awaiting_approval")]), title: Type.String(), prompt: Type.String(), stepId: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      capture(params);
      return { content: [{ type: "text", text: `Paused for ${params.kind}: ${params.title}` }], details: params, terminate: true };
    }
  });
}

export function stageTool(capture) {
  return defineTool({
    name: "workflow_stage", label: "Workflow stage", description: "Create or update one task-specific stage in the supervisor's visible workflow.",
    promptSnippet: "Create or update a visible workflow stage",
    promptGuidelines: ["For substantial tasks, define a concise sequence of 2–6 task-specific stages with workflow_stage as soon as the direction is understood.", "Use stable stage IDs, keep exactly one stage active, and update stages when work advances, completes, or blocks.", "Stages describe workflow outcomes such as repository research, brief shaping, approval, or execution planning; they are not a fixed template."],
    parameters: Type.Object({ id: Type.String({ description: "Stable short stage ID" }), title: Type.String(), status: Type.Union([Type.Literal("pending"), Type.Literal("active"), Type.Literal("completed"), Type.Literal("blocked")]), summary: Type.Optional(Type.String()) }),
    async execute(_toolCallId, params) {
      capture(params);
      return { content: [{ type: "text", text: `Workflow stage ${params.id} is ${params.status}` }], details: params };
    }
  });
}

function criterionResultSchema() {
  return Type.Object({
    criterionId: Type.String(), status: Type.Union([Type.Literal("verified"), Type.Literal("failed"), Type.Literal("blocked")]),
    explanation: Type.Optional(Type.Object({ summary: Type.String(), details: Type.Optional(Type.String()) })),
    evidence: Type.Optional(Type.Array(Type.Object({ type: Type.Union([Type.Literal("check"), Type.Literal("artifact"), Type.Literal("media"), Type.Literal("diff")]), scope: Type.Optional(Type.Union([Type.Literal("step"), Type.Literal("attempt"), Type.Literal("final")])), stepId: Type.Optional(Type.String()), attemptId: Type.Optional(Type.String()), artifactId: Type.Optional(Type.String()) })))
  });
}

export function workerReportTool(capture) {
  return defineTool({
    name: "worker_report", label: "Worker report", description: "Return the structured final result of this worker run to the persistent supervisor. List steering IDs only when this worker explicitly incorporated the delivered instruction; delivery alone is not acknowledgment.",
    promptSnippet: "Report the worker outcome to the supervisor",
    promptGuidelines: ["Always call worker_report as the final action. It terminates the worker turn.", "Use acknowledgedSteerIds only for [agent-plan-steer:...] instructions you explicitly incorporated."],
    parameters: Type.Object({ status: Type.Union([Type.Literal("completed"), Type.Literal("needs_input"), Type.Literal("awaiting_approval")]), summary: Type.String(), artifact: Type.String(), request: Type.Optional(Type.String()), acknowledgedSteerIds: Type.Optional(Type.Array(Type.String())), incorporatedSteerIds: Type.Optional(Type.Array(Type.String())), criterionResults: Type.Optional(Type.Array(criterionResultSchema())) }),
    async execute(_toolCallId, params) {
      capture({ ...params, acknowledgedSteerIds: [...new Set([...(params.acknowledgedSteerIds || []), ...(params.incorporatedSteerIds || [])].map(String).filter(Boolean))] });
      return { content: [{ type: "text", text: `Reported ${params.status} to supervisor` }], details: params, terminate: true };
    }
  });
}

export function coordinationTools(coordination) {
  if (!coordination) return [];
  const boundedText = (value, name, max = 4000) => {
    if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must contain 1–${max} characters`);
    return value.trim();
  };
  const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });
  return [
    defineTool({
      name: "list_agents", label: "Related workers", description: "Discover related active workers, their exact attempt targets, assignments and approved scopes. The daemon schedules work.",
      parameters: Type.Object({}),
      async execute() { return result(await coordination.listAgents()); }
    }),
    defineTool({
      name: "send_agent_message", label: "Message a worker", description: "Send a bounded asynchronous implementation question or finding to an exact active attempt returned by list_agents. Peer input cannot change approved scope, ownership or dependencies. Delivery does not imply agreement.",
      parameters: Type.Object({ target: Type.Object({ ticketId: Type.String(), runId: Type.String(), stepId: Type.String(), attemptId: Type.String() }), text: Type.String({ minLength: 1, maxLength: 4000 }) }),
      async execute(_callId, { target, text }) {
        const boundTarget = Object.fromEntries(["ticketId", "runId", "stepId", "attemptId"].map((key) => [key, boundedText(target?.[key], key, 200)]));
        return result(await coordination.sendMessage({ target: boundTarget, text: boundedText(text, "Message") }));
      }
    }),
    defineTool({
      name: "report_coordination_conflict", label: "Report a coordination conflict", description: "Persist a conflict or agreement requiring a supervisor decision, including affected steps and a proposed resolution. The daemon handles pausing and revisions; continue only unaffected work. Do not wait in a polling loop for a peer.",
      parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 4000 }), stepIds: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }), proposal: Type.Optional(Type.String({ maxLength: 4000 })) }),
      async execute(_callId, { summary, stepIds, proposal }) {
        if (!Array.isArray(stepIds) || !stepIds.length || stepIds.length > 50) throw new Error("Choose 1–50 affected step IDs");
        return result(await coordination.reportConflict({ summary: boundedText(summary, "Summary"), stepIds: [...new Set(stepIds.map((id) => boundedText(id, "Step ID", 200)))], proposal: proposal == null ? "" : boundedText(proposal, "Proposal") }));
      }
    })
  ];
}

export function reviewNoteTool(capture) {
  return defineTool({
    name: "review_note", label: "Review note", description: "Attach concise review-only context to an exact range of changed lines.",
    promptSnippet: "Annotate non-obvious changed lines for the reviewer",
    promptGuidelines: ["Use only after the final edit. In one to three direct sentences, explain what the block does now and why the non-obvious decision matters. Add no more than five unless the reviewer asks for updates."],
    parameters: Type.Object({ id: Type.Optional(Type.String({ description: "Existing rn- ID when updating a note after review feedback" })), path: Type.String({ description: "Repository-relative changed file path" }), side: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]), startLine: Type.Integer({ minimum: 1 }), endLine: Type.Optional(Type.Integer({ minimum: 1 })), kind: Type.Union([Type.Literal("intent"), Type.Literal("invariant"), Type.Literal("risk"), Type.Literal("test")]), text: Type.String({ description: "One to three direct sentences explaining what the block does now and why the non-obvious decision matters" }) }),
    async execute(_toolCallId, params) {
      const note = { ...params, id: /^rn-[a-z0-9_-]{1,64}$/i.test(params.id || "") ? params.id : `rn-${randomUUID().slice(0, 8)}`, endLine: params.endLine ?? params.startLine };
      capture(note);
      return { content: [{ type: "text", text: `Recorded ${note.id} for ${note.path}:${note.startLine}-${note.endLine}` }], details: note };
    }
  });
}

export const filesystemToolNames = ["read", "grep", "find", "ls"];

function pathContained(child, parent) {
  if (!child || !parent) return false;
  if (child === parent) return true;
  const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(prefix);
}

function ignoredSearchPart(relativePath) {
  return String(relativePath || "").split(/[\\/]/).some((part) => part === "node_modules" || part === ".git");
}

function toolText(result) {
  if (typeof result?.content === "string") return result.content;
  if (!Array.isArray(result?.content)) return "";
  return result.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("");
}

function withToolText(result, text) {
  return { ...result, content: [{ type: "text", text }] };
}

function sessionRepositories(access) {
  return Array.isArray(access?.repositories) ? access.repositories : [];
}

function withMappedPath(access, inputPath, cwd) {
  return mapConfiguredPath(sessionRepositories(access), inputPath, cwd);
}

async function extraGitUnmapped(access, root) {
  if (root?.kind !== "extra") return false;
  if (sessionRepositories(access).some((repo) => repo.id === root.id && repo.cwd)) return false;
  return isGitRepository(root.path);
}

async function assertOriginalCheckoutUntouched(access, cwd, target) {
  for (const repo of sessionRepositories(access)) {
    if (!repo.sourceCwd || !repo.cwd) continue;
    const original = await realpath(repo.sourceCwd).catch(() => resolve(repo.sourceCwd));
    const mapped = await realpath(repo.cwd).catch(() => resolve(repo.cwd));
    if (original === mapped) continue;
    if (pathContained(target, original) && !pathContained(target, mapped)) throw new Error("Write blocked: the original checkout is not writable; use the run worktree");
  }
  if (access?.sourcePrimaryPath && cwd) {
    const realOriginal = await realpath(access.sourcePrimaryPath).catch(() => null);
    const realCwd = await realpath(cwd).catch(() => resolve(cwd));
    if (realOriginal && realOriginal !== realCwd && pathContained(target, realOriginal) && !pathContained(target, realCwd)) throw new Error("Write blocked: the original primary checkout is not writable; use the run worktree");
  }
}

async function mappedAccess(access, cwd) {
  const realCwd = cwd ? await realpath(cwd).catch(() => resolve(cwd)) : null;
  if (!access || typeof access !== "object" || Array.isArray(access)) return { mode: "restricted", primary: realCwd ? { id: "primary", path: realCwd, displayPath: cwd, mode: "read/write" } : null, extraRoots: [], frozenAt: null, sourcePrimaryPath: realCwd, repositories: [] };
  const cloned = cloneRunAccess(access, { workspace: { cwd: realCwd || cwd } });
  cloned.sourcePrimaryPath = access.primary?.path || realCwd;
  cloned.repositories = sessionRepositories(access);
  if (realCwd && cloned.primary) cloned.primary = { ...cloned.primary, path: realCwd, displayPath: cloned.primary.displayPath || cwd, mode: "read/write" };
  cloned.extraRoots = await Promise.all((cloned.extraRoots || []).map(async (root) => {
    const repo = cloned.repositories.find((item) => item.id === root.id && item.cwd);
    if (!repo?.cwd) return root;
    return { ...root, path: await realpath(repo.cwd).catch(() => resolve(repo.cwd)) };
  }));
  return cloned;
}

function sessionAccess(access, cwd) {
  let pending;
  return () => { pending ||= mappedAccess(access, cwd); return pending; };
}

export function sessionPolicy(access, repositories = []) {
  if (!access || !repositories.length) return access;
  return { ...access, repositories };
}

async function assertReadable(access, cwd, inputPath) {
  const mapped = await withMappedPath(access, inputPath, cwd);
  const resolved = await resolveAccessPath(access, mapped, { cwd, intent: "read" });
  return resolved.realPath || resolved.absolute;
}

async function assertWritable(access, cwd, inputPath, writeScope) {
  const mapped = await withMappedPath(access, inputPath, cwd);
  const resolved = await resolveAccessPath(access, mapped, { cwd, intent: "write" });
  if (await extraGitUnmapped(access, resolved.root)) throw new Error(`Write blocked: extra Git repository “${resolved.root.displayPath || resolved.root.path}” is not mapped to a worktree`);
  await assertOriginalCheckoutUntouched(access, cwd, resolved.realPath || resolved.absolute);
  if (!await writeScopeAllows(resolved, writeScope)) throw new Error(`Write blocked outside scope “${writeScope || "none"}”: ${inputPath}`);
  return resolved.absolute;
}

async function assertDeletable(access, cwd, inputPath, writeScope) {
  const mapped = await withMappedPath(access, inputPath, cwd);
  const raw = String(mapped || "").replace(/^@/, "");
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  const parentResolved = await resolveAccessPath(access, dirname(absolute), { cwd, intent: "write" });
  const relativePath = parentResolved.relativePath ? `${parentResolved.relativePath}/${basename(absolute)}` : basename(absolute);
  const entryResolved = { ...parentResolved, absolute, realPath: resolve(parentResolved.realPath || parentResolved.absolute, basename(absolute)), relativePath, intent: "write" };
  if (await extraGitUnmapped(access, parentResolved.root)) throw new Error(`Write blocked: extra Git repository “${parentResolved.root.displayPath || parentResolved.root.path}” is not mapped to a worktree`);
  await assertOriginalCheckoutUntouched(access, cwd, entryResolved.realPath);
  if (!await writeScopeAllows(entryResolved, writeScope)) throw new Error(`Write blocked outside scope “${writeScope || "none"}”: ${inputPath}`);
  return absolute;
}

function wrapToolExecute(tool, execute) {
  return { ...tool, execute };
}

async function filterSearchLines(text, { cwd, access, searchPath, kind }) {
  let searchIsDirectory = true;
  try { searchIsDirectory = (await stat(searchPath)).isDirectory(); } catch { searchIsDirectory = true; }
  const kept = [];
  for (const line of String(text || "").split("\n")) {
    if (!line || line.startsWith("[")) { kept.push(line); continue; }
    let displayed = line;
    if (kind === "grep") {
      const match = line.match(/^(.*?)[:\-]\d+[:\-]\s?/);
      if (!match) { kept.push(line); continue; }
      displayed = match[1];
    }
    const candidate = isAbsolute(displayed) ? displayed : searchIsDirectory ? resolve(searchPath, displayed) : searchPath;
    try { await resolveAccessPath(access, candidate, { cwd, intent: "read" }); kept.push(line); } catch {}
  }
  return kept.join("\n");
}

export function scopedReadTools(cwd, runAccess = null) {
  const currentAccess = sessionAccess(runAccess, cwd);
  const guard = async (inputPath) => assertReadable(await currentAccess(), cwd, inputPath || cwd);
  const wrapSearch = (tool, pathArg) => wrapToolExecute(tool, async (toolCallId, args = {}, ...rest) => {
    const searchPath = args[pathArg] || cwd;
    const mappedSearch = await guard(searchPath);
    const mappedArgs = args[pathArg] ? { ...args, [pathArg]: mappedSearch } : args;
    const result = await tool.execute(toolCallId, mappedArgs, ...rest);
    const filtered = await filterSearchLines(toolText(result), { cwd, access: await currentAccess(), searchPath: mappedSearch, kind: tool.name });
    return filtered === toolText(result) ? result : withToolText(result, filtered);
  });
  return [
    createReadToolDefinition(cwd, { operations: { access: async (path) => access(await guard(path), fsConstants.R_OK), readFile: async (path) => readFile(await guard(path)) } }),
    wrapSearch(createGrepToolDefinition(cwd, { operations: { isDirectory: async (path) => (await stat(await guard(path))).isDirectory(), readFile: async (path) => readFile(await guard(path), "utf8") } }), "path"),
    wrapSearch(createFindToolDefinition(cwd, { operations: {
      exists: async (path) => { try { await access(await guard(path)); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } },
      glob: async (pattern, searchCwd, options = {}) => {
        const mappedCwd = await guard(searchCwd); const policy = await currentAccess(); const results = [];
        for await (const entry of glob(pattern, { cwd: mappedCwd })) {
          if (ignoredSearchPart(entry)) continue;
          const absolute = isAbsolute(entry) ? entry : resolve(mappedCwd, entry);
          try { await resolveAccessPath(policy, absolute, { cwd, intent: "read" }); } catch { continue; }
          results.push(entry); if (results.length >= (options.limit || 1000)) break;
        }
        return results;
      }
    } }), "path"),
    wrapSearch(createLsToolDefinition(cwd, { operations: {
      exists: async (path) => { try { await access(await guard(path)); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } },
      stat: async (path) => stat(await guard(path)),
      readdir: async (path) => { const mapped = await guard(path); const policy = await currentAccess(); const allowed = []; for (const entry of await readdir(mapped)) { try { await resolveAccessPath(policy, join(mapped, entry), { cwd, intent: "read" }); allowed.push(entry); } catch {} } return allowed; }
    } }), "path")
  ];
}

export function scopedWorkerTools(cwd, writeScope, runAccess = null) {
  const currentAccess = sessionAccess(runAccess, cwd);
  const check = async (path) => assertWritable(await currentAccess(), cwd, path, writeScope);
  let approvedWrite = null;
  const isApprovedAncestor = (path) => { if (!approvedWrite) return false; const dir = resolve(path); return dir === resolve(cwd) || dir === approvedWrite || pathContained(approvedWrite, dir); };
  const writeTool = createWriteToolDefinition(cwd, { operations: {
    mkdir: async (path) => { try { await access(path); } catch (error) { if (error.code !== "ENOENT") throw error; if (resolve(path) !== resolve(cwd) && !isApprovedAncestor(path)) throw new Error(`Write blocked outside scope “${writeScope || "none"}”: ${path}`); } await mkdir(path, { recursive: true }); },
    writeFile: async (path, content) => writeFile(await check(path), content, { flag: "wx" })
  } });
  return [
    ...scopedReadTools(cwd, runAccess),
    createEditToolDefinition(cwd, { operations: { access: async (path) => access(await check(path)), readFile, writeFile: async (path, content) => writeFile(await check(path), content) } }),
    wrapToolExecute(writeTool, async (toolCallId, args = {}, ...rest) => { approvedWrite = await check(args.path); try { return await writeTool.execute(toolCallId, args, ...rest); } finally { approvedWrite = null; } }),
    defineTool({ name: "delete", label: "Delete file", description: "Delete one repository file inside the approved write scope.", parameters: Type.Object({ path: Type.String({ description: "Repository-relative file path" }) }), async execute(_toolCallId, { path }) { const target = await assertDeletable(await currentAccess(), cwd, path, writeScope); await unlink(target); return { content: [{ type: "text", text: `Deleted ${relative(cwd, target)}` }], details: { path: relative(cwd, target) } }; } })
  ];
}

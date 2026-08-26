import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createEditToolDefinition, createWriteToolDefinition, defineTool, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assertScopedWrite } from "./git.js";
import { appendBounded, pushBounded } from "./execution.js";
import { flattenSteps, normalizePlan } from "./plan.js";
import { loadProjectConfig, projectConfigPath, projectEnvironment, redactCommandOutput, runProjectCommand } from "./project-config.js";
import { stagePrompt } from "./profiles.js";

const exec = promisify(execFile);
const verificationEntry = ".agent-plan/verify.mjs";
const agentGuidanceEntry = "AGENTS.md";
const architectureEntry = "docs/architecture.md";

const planningInstruction = `You are shaping an executable development plan with the user. Discuss the problem before proposing execution. You may inspect the repository and load discovered skills, but you must not modify files. Organize substantial work into a short, task-specific sequence using workflow_stage and keep its current stage updated. Keep recommendations concrete and concise.`;

const supervisorInstruction = `You are now the persistent supervisor for this plan. The loaded skill is a binding workflow, not optional advice.
- Apply its required sequence and gates to planning and worker review.
- Express that sequence as 2–6 task-specific workflow stages and keep exactly one stage active.
- Update stages whenever the workflow advances, blocks, or completes a phase.
- Never implement repository changes yourself.
- When the workflow requires a user answer, call workflow_checkpoint with kind needs_input.
- When the workflow requires explicit approval before continuing, call workflow_checkpoint with kind awaiting_approval.
- Do not claim a gate has passed until its checkpoint is resolved.
- Review structured worker reports against the workflow. If no gate is required, give a concise review.`;

const planSchemaInstruction = `Create an execution plan from our conversation. Return ONLY valid JSON, with no markdown fence or commentary.

Schema:
{
  "title": "short plan title",
  "summary": "one sentence",
  "harness": "pi",
  "nodes": [
    {
      "id": "stable-kebab-id",
      "type": "group",
      "title": "generic group title",
      "children": [STEP, STEP]
    },
    STEP
  ]
}

STEP:
{
  "id": "stable-kebab-id",
  "type": "step",
  "role": "architecture | implementation",
  "title": "outcome-oriented title",
  "description": "short outcome",
  "prompt": "complete prompt for the implementing agent",
  "contextPolicy": "fresh | seeded | fork",
  "harness": "pi",
  "permission": "none | read | write",
  "writeScope": "comma-separated repository paths, blank unless write",
  "skills": ["explicit skills when useful"],
  "references": ["files or screenshots to include"],
  "requirementIds": ["REQ-stable-id"],
  "capabilityIds": ["CAP-stable-id"],
  "deltaIds": ["DELTA-stable-id"],
  "productContext": "only the concise PRD and implementation-delta context relevant to this step",
  "expectedArtifacts": ["named outputs"],
  "acceptanceCriteria": ["observable criterion"],
  "requiresVisualEvidence": false,
  "dependsOn": ["step-or-group-id"],
  "required": true
}

Rules:
- Steps are generic and task-specific; do not use a fixed workflow template.
- Use a group only when sibling steps can run concurrently and feed a later step.
- Groups may contain steps only; never nest another group.
- A downstream step depending on a group waits for every required child to be accepted.
- Code-writing steps should be serial by default. Deliberately parallel writes must be siblings with disjoint write scopes; they run in isolated worktrees and block if their patches conflict during integration.
- Decompose implementation into a ticket-specific sequence of coherent, human-reviewable behavior slices. Each write step must leave the worktree valid, have a focused diff, and be independently understandable and verifiable.
- Prefer complete vertical outcomes over file-layer steps such as “change types”, “change service”, or “add tests”. Put proportionate tests in the step that delivers the behavior.
- For frontend/backend work, establish one shared contract first, run independently testable conformance implementations as parallel siblings, then add a serial integration step depending on that group. Put cross-branch integration tests in the integration step and continue depth-first with the next vertical outcome.
- Every write plan must use ".agent-plan/verify.mjs" as its single deterministic verification entry point. If it is missing, the first architecture write step creates it with Node standard-library process calls and includes ".agent-plan" in its write scope. The entry point must run the repository's relevant tests, lint, type checks, and builds, fail on any failed command, and remain usable by every later step. Every isolated step must keep its applicable checks green; the downstream integration step owns checks that require multiple parallel branches.
- The first architecture write step also creates or updates docs/architecture.md, AGENTS.md, and .agent-plan/project.json. Store executable commands as argv arrays in project.json; never make the harness parse prose for commands.
- Prefer built-ins and existing dependencies. A small conventional dependency is acceptable when it is clearly the simplest complete solution. Return awaiting_approval before adding a framework, infrastructure component, large package, unusual license, or architecture-shaping dependency.
- Set requiresVisualEvidence to true when acceptance depends on rendered browser behavior or appearance. In that case the verification entry point must capture at least one PNG, JPEG, or WebP into process.env.AGENT_PLAN_EVIDENCE_DIR using the project's existing browser tooling.
- Every serial write step after the first must depend on the preceding write step so implementation pauses for human review in a predictable order.
- Link every step to stable requirement, capability, and delta IDs. Copy only the relevant product context into productContext; do not dump the whole PRD into a worker prompt.
- Every step must have a useful prompt, expected artifact, and acceptance criterion.`;

const requirementsInstruction = `You are beginning a ticket-scoped development workflow. You have no repository tools and must clarify requirements before repository exploration.
1. Use only the ticket, attachments, and supplied living product context. Do not inspect source code.
2. Enhance product intent with a ticket-specific PRD addendum containing stable REQ-* IDs, explicit scope, behavior, edge cases, constraints, and observable acceptance criteria.
3. Ask only consequential product questions whose answers could change the implementation.

Return ONLY valid JSON:
{
  "artifact": "a concise markdown PRD addendum and requirements contract",
  "questions": ["one focused question", "another focused question"]
}`;

const requirementsFollowUpInstruction = `Continue the requirements clarification with the user. You still have no repository tools.
1. Incorporate the user's answers into the complete PRD addendum and requirements contract.
2. Ask only remaining consequential product questions whose answers could change the implementation.
3. Questions may be empty when the contract is ready for the user's explicit approval.

Return ONLY valid JSON:
{
  "artifact": "the complete revised markdown PRD addendum and requirements contract",
  "questions": ["one focused follow-up question"]
}`;

const ticketExplorationInstruction = `The requirements have already been clarified and approved. You may inspect the repository but must not modify it.
1. Validate the supplied capability ledger against relevant code, tests, conventions, and dependency boundaries.
2. Produce a verified implementation delta with stable CAP-* and DELTA-* IDs, classifying behavior as shipped, partial, missing, or conflicting.
3. Never silently reinterpret an approved requirement. Report only technical exceptions that require a user decision.

Return ONLY valid JSON:
{
  "artifact": "a concise markdown implementation delta with concrete repository evidence",
  "questions": ["one blocking technical exception"]
}
Questions should normally be empty.`;

const ticketLookAheadInstruction = `You are the ticket look-ahead agent. Analyze the current ticket alongside the supplied nearby-ticket horizon without repository access.
1. Identify credible shared foundations, domain concepts, architectural conflicts, and sequencing implications.
2. Separate evidence from inference and ignore superficial title similarity.
3. Do not expand the current ticket's approved scope; produce concise constraints and opportunities for the design agent.

Return ONLY valid JSON:
{
  "artifact": "a concise markdown ticket look-ahead with relevant tickets, shared concerns, sequencing, and design implications"
}`;

const ticketDesignInstruction = `${planSchemaInstruction}

Use the supplied ticket look-ahead to preserve likely shared foundations and avoid near-term architectural dead ends, without adding unrelated ticket scope. Also include a top-level "designArtifact" string containing a concise markdown design: chosen approach, alternatives rejected, important files, risks, and verification strategy. The execution plan must start after exploration and clarification; do not add redundant discovery steps.`;

const productContextUpdateInstruction = `Update the living product context after a completed, independently verified ticket. Preserve existing unrelated product intent. Merge the approved PRD addendum, verified implementation delta, accepted outcomes, and final diff into one concise markdown document with:
- stable REQ-* product requirements,
- stable CAP-* capabilities marked shipped, partial, or planned,
- important product decisions and non-goals,
- repository evidence where useful.

Return ONLY valid JSON: { "content": "the complete replacement markdown product context" }.`;

const reviewerCharters = {
  requirements: "Check the implementation against the source ticket or local feature brief, clarifications, approved design, and every acceptance criterion. Find missing or superficially completed behavior.",
  integration: "Inspect correctness and integration boundaries: state, API contracts, persistence, concurrency, error handling, migrations, and maintainability. Follow changed code into its callers and consumers.",
  verification: "Inspect tests and regression risk. Check relevant security, accessibility, performance, configuration, and deployment behavior. Identify claims that are not proven by deterministic checks."
};

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("");
}

function lastAssistantText(session) {
  const messages = session.state?.messages || session.messages || [];
  const message = [...messages].reverse().find((item) => item?.role === "assistant");
  return textFromContent(message?.content);
}

function eventText(value) {
  let text;
  try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
  catch { text = String(value); }
  text ??= String(value ?? "");
  // ponytail: keep SSE/state responsive; the Pi session file remains the unabridged source for unusually large tool results.
  return text.length > 10000 ? `${text.slice(0, 10000)}\n\n[truncated after 10,000 characters]` : text;
}

function safeEvent(event) {
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
    return { type: "text_delta", delta: event.assistantMessageEvent.delta, label: "Writing the response" };
  }
  if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
    return { type: "thinking", label: "Model is reasoning" };
  }
  if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
    return { type: "agent_error", label: event.message.errorMessage || "Model request failed" };
  }
  if (event.type === "message_end" && event.message?.role === "assistant" && event.message.usage) {
    const { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 } = event.message.usage;
    return { type: "usage", input, output, cacheRead, cacheWrite, label: "Usage recorded" };
  }
  if (event.type === "tool_execution_start") return { type: "tool_start", tool: event.toolName, callId: event.toolCallId, args: eventText(event.args), label: `Using ${event.toolName}` };
  if (event.type === "tool_execution_update") return { type: "tool_update", tool: event.toolName, callId: event.toolCallId, detail: eventText(event.partialResult), replace: true, label: `${event.toolName} is running` };
  if (event.type === "bash_execution_update") return { type: "tool_update", tool: "bash", callId: event.id, detail: eventText(event.delta), label: "Command is running" };
  if (event.type === "tool_execution_end") return { type: "tool_end", tool: event.toolName, callId: event.toolCallId, result: eventText(event.result), isError: event.isError, label: event.isError ? `${event.toolName} failed` : `Reviewing ${event.toolName} result` };
  if (event.type === "agent_start" || event.type === "turn_start") return { type: event.type, label: "Model is reasoning" };
  if (event.type === "agent_settled" || event.type === "turn_end") return { type: event.type, label: "Finishing this phase" };
  return null;
}

function bindAbort(session, signal) {
  let aborting;
  const abort = () => { aborting ||= session.abort(); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return async () => {
    signal?.removeEventListener("abort", abort);
    await aborting?.catch(() => {});
  };
}

function parseJsonReply(reply) {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("Planner did not return a JSON plan");
  return normalizePlan(JSON.parse(candidate));
}

function jsonReply(reply) {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  return JSON.parse(fenced || reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
}

function commitField(value, fallback) {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

export function formatTicketHorizon(currentTicket, tickets, limit = 12) {
  const seen = new Set([String(currentTicket?.id || "")]);
  const currentTeam = currentTicket?.team?.id || currentTicket?.team?.name;
  const candidates = (tickets || []).filter((ticket) => {
    const id = String(ticket?.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map((ticket, order) => ({ ticket, order, sameTeam: Boolean(currentTeam && currentTeam === (ticket.team?.id || ticket.team?.name)) }))
    .sort((a, b) => Number(b.sameTeam) - Number(a.sameTeam) || a.order - b.order);
  const rows = candidates.slice(0, limit).map(({ ticket }) => {
    const description = String(ticket.description || "").replace(/\s+/g, " ").trim().slice(0, 240);
    const labels = (ticket.labels || []).map((label) => label.name).filter(Boolean).join(", ");
    return `- ${ticket.identifier || ticket.id} [${ticket.state?.name || "queued"}] ${ticket.title || "Untitled"}${labels ? ` · ${labels}` : ""}${description ? ` — ${description}` : ""}`;
  });
  return `# Nearby ticket horizon\n\n${rows.length ? rows.join("\n") : "No other queued tickets are available."}${candidates.length > limit ? `\n\n${candidates.length - limit} additional queued ticket(s) omitted.` : ""}`;
}

export function formatCommitMessage(value, step) {
  const fallbackRequirement = [step.requirementIds?.join(", "), step.acceptanceCriteria?.join("; ")].filter(Boolean).join(" — ") || "Complete the approved execution-plan slice";
  return `${commitField(value?.subject, `feat: ${step.title}`)}\n\nWhy: ${commitField(value?.why, step.description || step.title)}\nRequirement: ${commitField(value?.requirement, fallbackRequirement)}`;
}

export function stepContext({ plan, step, artifacts }) {
  const artifactText = artifacts.length
    ? artifacts.map((artifact) => `### ${artifact.name}${artifact.sourceStepTitle ? ` (from ${artifact.sourceStepTitle})` : ""}\n${artifact.content || artifact.summary || ""}`).join("\n\n")
    : "No dependency artifacts.";
  const steps = flattenSteps(plan);
  const summarize = (items) => items.length
    ? items.map((item) => `- ${item.title}: ${item.description || "No outcome summary."}`).join("\n")
    : "- None";
  const architectureHorizon = step.role === "architecture" ? `
## Architecture horizon
Design from the repository as it exists now, preserve completed outcomes, and leave the smallest sound path for the remaining plan.

Own the repository verification contract. If ${verificationEntry} is missing or incomplete, create or update it using Node standard-library process calls. It must run every project-specific deterministic check through one command: node ${verificationEntry}. For browser-visible acceptance, make it write screenshots into process.env.AGENT_PLAN_EVIDENCE_DIR. Do not add a dependency only for this wrapper.
Also own ${architectureEntry}, ${agentGuidanceEntry}, and ${projectConfigPath}. Keep human guidance and architecture prose readable, while keeping commands, allowed environment names/files, and port variables machine-readable in project.json.

### Already completed
${summarize(steps.filter((item) => item.status === "accepted"))}

### Current architecture outcome
- ${step.title}: ${step.description || "No outcome summary."}

### Planned after this ticket
${summarize(steps.filter((item) => item.id !== step.id && item.status !== "accepted"))}
` : "";
  return `# Step run

Plan: ${plan.title}
Plan summary: ${plan.summary || "None"}
Step: ${step.title}
Role: ${step.role}
Harness: ${step.harness}
Context policy: ${step.contextPolicy}
Permission: ${step.permission}
Write scope: ${step.writeScope || "none"}
Skills requested: ${step.skills?.join(", ") || "none"}
References: ${step.references?.join(", ") || "none"}
Requirement IDs: ${step.requirementIds?.join(", ") || "none"}
Capability IDs: ${step.capabilityIds?.join(", ") || "none"}
Implementation delta IDs: ${step.deltaIds?.join(", ") || "none"}
${architectureHorizon}

## Relevant product context
${step.productContext || "No step-specific product context was assigned."}

## Dependency artifacts
${artifactText}

## Ticket outcome
${step.description || step.title}

${step.prompt ? `## Planner guidance\n${step.prompt}\n` : ""}

## Expected artifacts
${step.expectedArtifacts?.map((item) => `- ${item}`).join("\n") || "- Concise run result"}

## Acceptance criteria
${step.acceptanceCriteria?.map((item) => `- ${item}`).join("\n") || "- The requested outcome is complete and verified"}

Visual evidence: ${step.requiresVisualEvidence ? `required; make ${verificationEntry} write screenshots into process.env.AGENT_PLAN_EVIDENCE_DIR` : "not required"}

Work only within the stated permission and write scope. Write workers have no arbitrary shell. Use project_command to run a named command from ${projectConfigPath}; the harness controls its working directory, environment allow-list, and timeout. The framework runs ${verificationEntry} after your report. Your final action MUST be the worker_report tool. Use completed when the result is ready for review, needs_input when a question blocks you, or awaiting_approval when explicit approval is required. Put the complete artifact for dependent steps in artifact.`;
}

export function ensureVerificationContractStep(plan, contractExists, projectConfigExists = contractExists) {
  if ((contractExists && projectConfigExists) || flattenSteps(plan).some((step) => step.role === "architecture" && step.permission === "write" && !outsideContractScope(step.writeScope) && [step.prompt, ...(step.expectedArtifacts || []), ...(step.acceptanceCriteria || [])].some((value) => String(value).includes(projectConfigPath)))) return plan;
  const id = findContractId(plan);
  const visual = flattenSteps(plan).some((step) => step.requiresVisualEvidence);
  const nodes = structuredClone(plan.nodes);
  for (const node of nodes) for (const step of node.type === "group" ? node.children : [node]) step.dependsOn = [...new Set([id, ...(step.dependsOn || [])])];
  return normalizePlan({ ...plan, nodes: [{
    id,
    type: "step",
    role: "architecture",
    title: "Establish the repository operating contract",
    description: `Record the architecture, agent guidance, machine-executable commands, environment allow-list, and the repository's deterministic verification entry point.`,
    prompt: `Inspect the repository and create or update ${architectureEntry}, ${agentGuidanceEntry}, ${projectConfigPath}, and ${verificationEntry}. Keep architecture prose separate from machine-readable commands. In project.json, store commands as argv arrays, environment variable names under environment.pass, explicitly approved ignored local env files under environment.files, and port variable names under ports.variables. The verification script must use Node standard-library process calls and propagate every failed test, lint, type-check, and build command. ${visual ? "When AGENT_PLAN_EVIDENCE_DIR is set, use the project's existing browser tooling to write representative screenshots there." : "Do not add browser tooling unless a later step requires visual evidence."}`,
    permission: "write",
    writeScope: ".agent-plan,AGENTS.md,docs",
    acceptanceCriteria: [
      `${architectureEntry} records important boundaries and conventions`,
      `${agentGuidanceEntry} tells later agents how to work in this repository`,
      `${projectConfigPath} declares executable commands separately from prose`,
      `node ${verificationEntry} runs the repository's relevant deterministic checks from one stable entry point`
    ],
    expectedArtifacts: [architectureEntry, agentGuidanceEntry, projectConfigPath, verificationEntry],
    dependsOn: []
  }, ...nodes] });
}

export function projectCommandTool(cwd, signal) {
  return defineTool({
    name: "project_command",
    label: "Project command",
    description: `Run one named argv command declared in ${projectConfigPath}; arbitrary shell strings and extra arguments are not accepted.`,
    promptSnippet: "Run a repository-approved development command",
    promptGuidelines: ["Use this for focused tests, lint, type checks, formatting, and builds declared by the repository."],
    parameters: Type.Object({ name: Type.String() }),
    async execute(_toolCallId, { name }) {
      const result = await runProjectCommand(cwd, name, { signal });
      return { content: [{ type: "text", text: result.output || `${name} ${result.status}` }], details: result, isError: result.status === "failed" };
    }
  });
}

function outsideContractScope(writeScope) {
  return !String(writeScope || "").split(",").map((item) => item.trim()).some((item) => item === ".agent-plan" || item === ".agent-plan/**" || item === "*" || item === "**");
}

function findContractId(plan) {
  const ids = new Set(flattenSteps(plan).map((step) => step.id));
  let id = "verification-contract";
  for (let suffix = 2; ids.has(id); suffix++) id = `verification-contract-${suffix}`;
  return id;
}

function checkpointTool(capture) {
  return defineTool({
    name: "workflow_checkpoint",
    label: "Workflow checkpoint",
    description: "Pause the binding workflow for a user answer or explicit approval.",
    promptSnippet: "Create a blocking workflow checkpoint",
    promptGuidelines: ["Use this whenever a binding workflow requires user input or approval. It terminates the turn."],
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("needs_input"), Type.Literal("awaiting_approval")]),
      title: Type.String(),
      prompt: Type.String(),
      stepId: Type.Optional(Type.String())
    }),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: `Paused for ${params.kind}: ${params.title}` }],
        details: params,
        terminate: true
      };
    }
  });
}

function stageTool(capture) {
  return defineTool({
    name: "workflow_stage",
    label: "Workflow stage",
    description: "Create or update one task-specific stage in the supervisor's visible workflow.",
    promptSnippet: "Create or update a visible workflow stage",
    promptGuidelines: [
      "For substantial tasks, define a concise sequence of 2–6 task-specific stages with workflow_stage as soon as the direction is understood.",
      "Use stable stage IDs, keep exactly one stage active, and update stages when work advances, completes, or blocks.",
      "Stages describe workflow outcomes such as repository research, brief shaping, approval, or execution planning; they are not a fixed template."
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Stable short stage ID" }),
      title: Type.String(),
      status: Type.Union([Type.Literal("pending"), Type.Literal("active"), Type.Literal("completed"), Type.Literal("blocked")]),
      summary: Type.Optional(Type.String())
    }),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: `Workflow stage ${params.id} is ${params.status}` }],
        details: params
      };
    }
  });
}

function workerReportTool(capture) {
  return defineTool({
    name: "worker_report",
    label: "Worker report",
    description: "Return the structured final result of this worker run to the persistent supervisor.",
    promptSnippet: "Report the worker outcome to the supervisor",
    promptGuidelines: ["Always call worker_report as the final action. It terminates the worker turn."],
    parameters: Type.Object({
      status: Type.Union([Type.Literal("completed"), Type.Literal("needs_input"), Type.Literal("awaiting_approval")]),
      summary: Type.String(),
      artifact: Type.String(),
      request: Type.Optional(Type.String())
    }),
    async execute(_toolCallId, params) {
      capture(params);
      return {
        content: [{ type: "text", text: `Reported ${params.status} to supervisor` }],
        details: params,
        terminate: true
      };
    }
  });
}

export function scopedWorkerTools(cwd, writeScope) {
  const check = (path) => assertScopedWrite(cwd, path, writeScope);
  return [
    createEditToolDefinition(cwd, { operations: {
      access: async (path) => access(await check(path)),
      readFile,
      writeFile: async (path, content) => writeFile(await check(path), content)
    } }),
    createWriteToolDefinition(cwd, { operations: {
      mkdir: async (path) => {
        if (resolve(path) !== resolve(cwd)) await check(path);
        await mkdir(path, { recursive: true });
      },
      writeFile: async (path, content) => writeFile(await check(path), content)
    } })
  ];
}

export class PiHarness {
  constructor({ dataDir, publish }) {
    this.dataDir = dataDir;
    this.publish = publish;
    this.sdkPromise = null;
    this.modelRuntimePromise = null;
    this.planning = new Map();
    this.supervisorSignals = [];
    this.supervisorStages = [];
    this.supervisorQueues = new Map();
  }

  async sessionTrace(sessionFile) {
    if (!sessionFile) return { prompt: "", rawOutput: "", events: [] };
    const file = resolve(sessionFile);
    const root = `${resolve(this.dataDir, "pi-sessions")}${sep}`;
    if (!file.startsWith(root)) throw new Error("Session file is outside Pi session storage");
    const trace = { prompt: "", rawOutput: "", events: [] };
    for (const line of (await readFile(file, "utf8")).split("\n").filter(Boolean)) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const message = entry.type === "message" ? entry.message : null;
      if (!message) continue;
      const at = new Date(message.timestamp || entry.timestamp || Date.now()).toISOString();
      if (message.role === "user") trace.prompt = textFromContent(message.content);
      if (message.role === "assistant") for (const part of message.content || []) {
        if (part.type === "text") trace.rawOutput = appendBounded(trace.rawOutput, part.text, 100000);
        if (part.type === "thinking" && part.thinkingSignature) {
          try {
            for (const summary of JSON.parse(part.thinkingSignature).summary || []) if (summary.text) pushBounded(trace.events, { type: "reasoning_summary", detail: summary.text, at }, 200);
          } catch {}
        }
        if (part.type === "toolCall") pushBounded(trace.events, { type: "tool_start", tool: part.name, callId: part.id, args: eventText(part.arguments), at }, 200);
      }
      if (message.role === "toolResult") pushBounded(trace.events, { type: "tool_end", tool: message.toolName, callId: message.toolCallId, result: eventText(textFromContent(message.content)), isError: Boolean(message.isError), at }, 200);
    }
    return trace;
  }

  sdk() {
    this.sdkPromise ||= import("@earendil-works/pi-coding-agent");
    return this.sdkPromise;
  }

  async sessionOptions(profile) {
    if (!profile) return {};
    const { ModelRuntime } = await this.sdk();
    this.modelRuntimePromise ||= ModelRuntime.create();
    const modelRuntime = await this.modelRuntimePromise;
    const model = modelRuntime.getModel(profile.provider, profile.model);
    if (!model) throw new Error(`Pi model not found: ${profile.provider}/${profile.model}`);
    return { modelRuntime, model, thinkingLevel: profile.thinking };
  }

  async applyProfile(session, profile) {
    if (!profile) return;
    const { model, thinkingLevel } = await this.sessionOptions(profile);
    if (session.model?.provider !== model.provider || session.model?.id !== model.id) await session.setModel(model);
    session.setThinkingLevel(thinkingLevel);
  }

  async validateProfiles(profiles) {
    await Promise.all(Object.values(profiles).map((profile) => this.sessionOptions(profile)));
  }

  async models(provider = "openai-codex") {
    const { ModelRuntime } = await this.sdk();
    this.modelRuntimePromise ||= ModelRuntime.create();
    return (await this.modelRuntimePromise).getModels(provider)
      .map(({ id, name, reasoning, contextWindow }) => ({ id, name, reasoning, contextWindow }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async runRepositoryChecks({ cwd, signal, requireVisualEvidence = false }) {
    let command = `node ${verificationEntry}`;
    let args = [join(cwd, verificationEntry)];
    try { await access(args[0]); }
    catch (error) {
      if (error.code !== "ENOENT") return { status: "failed", command, summary: `${verificationEntry} could not be read.`, output: error.message, evidence: [] };
      let packageJson;
      try { packageJson = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")); }
      catch (packageError) {
        const summary = requireVisualEvidence ? `Visual verification requires ${verificationEntry}.` : "No deterministic verification entry point was discovered.";
        return { status: requireVisualEvidence ? "failed" : "skipped", command: null, summary, output: packageError.code === "ENOENT" ? "" : packageError.message, evidence: [] };
      }
      if (!packageJson.scripts?.test) {
        const summary = requireVisualEvidence ? `Visual verification requires ${verificationEntry}.` : "No deterministic verification entry point was discovered.";
        return { status: requireVisualEvidence ? "failed" : "skipped", command: null, summary, output: "", evidence: [] };
      }
      command = "npm test";
      args = ["test"];
    }
    let evidenceDir = null;
    if (requireVisualEvidence) {
      const evidenceRoot = join(this.dataDir, "visual-evidence");
      await mkdir(evidenceRoot, { recursive: true });
      evidenceDir = await mkdtemp(join(evidenceRoot, "run-"));
    }
    const startedAt = Date.now();
    const config = await loadProjectConfig(cwd);
    const environment = { ...(await projectEnvironment(cwd, config)), CI: "1", ...(requireVisualEvidence ? { AGENT_PLAN_EVIDENCE_DIR: evidenceDir } : {}) };
    try {
      const executable = command === "npm test" ? "npm" : process.execPath;
      const { stdout, stderr } = await exec(executable, args, { cwd, signal, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, env: environment });
      const evidence = (evidenceDir ? await readdir(evidenceDir, { withFileTypes: true }) : [])
        .filter((entry) => entry.isFile() && /\.(?:png|jpe?g|webp)$/i.test(entry.name))
        .map((entry) => ({ name: entry.name, path: join(evidenceDir, entry.name) }));
      const output = eventText(redactCommandOutput([stdout, stderr].filter(Boolean).join("\n"), environment));
      if (requireVisualEvidence && !evidence.length) return { status: "failed", command, summary: `${command} passed but produced no visual evidence.`, output, evidence, durationMs: Date.now() - startedAt };
      return { status: "passed", command, summary: `${command} passed${evidence.length ? ` with ${evidence.length} visual artifact${evidence.length === 1 ? "" : "s"}` : ""}.`, output, evidence, durationMs: Date.now() - startedAt };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { status: "failed", command, summary: `${command} failed.`, output: eventText(redactCommandOutput([error.stdout, error.stderr, error.message].filter(Boolean).join("\n"), environment)), evidence: [], durationMs: Date.now() - startedAt };
    }
  }

  async evidenceImages(evidence = []) {
    return Promise.all(evidence.map(async ({ path }) => ({
      type: "image",
      source: {
        type: "base64",
        mediaType: path.toLowerCase().endsWith(".png") ? "image/png" : path.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg",
        data: (await readFile(path)).toString("base64")
      }
    })));
  }

  supervisorTurn(work, key = "shared") {
    const queue = this.supervisorQueues.get(key) || Promise.resolve();
    const turn = queue.then(work);
    this.supervisorQueues.set(key, turn.catch(() => {}));
    return turn;
  }

  reset() {
    for (const item of this.planning.values()) item.session.dispose();
    this.planning.clear();
    this.supervisorSignals = [];
    this.supervisorStages = [];
  }

  async planningSession(cwd, existingFile, sessionKey = cwd, { repositoryAccess = true, profile } = {}) {
    const cached = this.planning.get(sessionKey);
    if (cached?.cwd === cwd) {
      await this.applyProfile(cached.session, profile);
      return cached.session;
    }
    if (cached) cached.session.dispose();
    const { createAgentSession, SessionManager } = await this.sdk();
    const sessionDir = join(this.dataDir, "pi-sessions", "tickets", sessionKey.replace(/[^a-z0-9._-]+/gi, "-"));
    await mkdir(sessionDir, { recursive: true });
    let manager;
    try {
      manager = existingFile ? SessionManager.open(existingFile, sessionDir, cwd) : SessionManager.create(cwd, sessionDir);
    } catch {
      manager = SessionManager.create(cwd, sessionDir);
    }
    const { session } = await createAgentSession({
      ...(await this.sessionOptions(profile)),
      cwd,
      tools: repositoryAccess ? ["read", "grep", "find", "ls", "workflow_stage", "workflow_checkpoint"] : ["workflow_stage", "workflow_checkpoint"],
      customTools: [
        stageTool((stage) => {
          this.supervisorStages.push(stage);
          this.publish({ channel: "workflow", type: "stage_update", stage });
        }),
        checkpointTool((signal) => this.supervisorSignals.push(signal))
      ],
      sessionManager: manager
    });
    session.setSessionName("plan-supervisor");
    this.planning.set(sessionKey, { cwd, session });
    return session;
  }

  async clarifyRequirements({ cwd, ticket, runId, productContext, profile, onEvent, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, null, `${ticket.id}-${runId}-requirements`, { repositoryAccess: false, profile });
      const reply = await this.visibleSupervisorPrompt(session, `${stagePrompt(profile, requirementsInstruction)}\n\n# Living product context\n${productContext}\n\n# Tracker ticket\n${ticket.identifier}: ${ticket.title}\n\n${ticket.description || "No description provided."}`, { publishText: false, onEvent, signal });
      const parsed = jsonReply(reply);
      return {
        artifact: String(parsed.artifact || ""),
        questions: Array.isArray(parsed.questions) ? parsed.questions.map(String).filter(Boolean) : [],
        sessionFile: session.sessionFile
      };
    }, `${ticket.id}:${runId}:requirements`);
  }

  async refineRequirements({ cwd, ticket, runId, sessionFile, answers, profile, onEvent, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile, `${ticket.id}-${runId}-requirements`, { repositoryAccess: false, profile });
      const reply = await this.visibleSupervisorPrompt(session, `${stagePrompt(profile, requirementsFollowUpInstruction)}\n\n# User response\n${answers}`, { publishText: false, onEvent, signal });
      const parsed = jsonReply(reply);
      return {
        artifact: String(parsed.artifact || ""),
        questions: Array.isArray(parsed.questions) ? parsed.questions.map(String).filter(Boolean) : [],
        sessionFile: session.sessionFile
      };
    }, `${ticket.id}:${runId}:requirements`);
  }

  async exploreTicket({ cwd, ticket, sessionFile, runId, productContext, requirements, profile, onEvent, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile, `${ticket.id}-${runId}`, { profile });
      const reply = await this.visibleSupervisorPrompt(session, `${stagePrompt(profile, ticketExplorationInstruction)}\n\n# Living product context\n${productContext}\n\n# Approved PRD addendum\n${requirements}\n\n# Current ticket\n${ticket.identifier}: ${ticket.title}\n\n${ticket.description || "No description provided."}`, { publishText: false, onEvent, signal });
      const parsed = JSON.parse(reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
      return {
        artifact: String(parsed.artifact || ""),
        questions: Array.isArray(parsed.questions) ? parsed.questions.map(String).filter(Boolean) : [],
        sessionFile: session.sessionFile
      };
    }, ticket.id);
  }

  async lookAheadTickets({ cwd, ticket, runId, productContext, requirements, ticketHorizon, profile, onEvent, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, null, `${ticket.id}-${runId}-ticket-lookahead`, { repositoryAccess: false, profile });
      const reply = await this.visibleSupervisorPrompt(session, `${stagePrompt(profile, ticketLookAheadInstruction)}\n\n# Living product context\n${productContext}\n\n# Approved PRD addendum\n${requirements}\n\n${ticketHorizon}\n\n# Current ticket\n${ticket.identifier}: ${ticket.title}\n\n${ticket.description || "No description provided."}`, { publishText: false, onEvent, signal });
      return { artifact: String(jsonReply(reply).artifact || ""), sessionFile: session.sessionFile };
    }, `${ticket.id}:ticket-lookahead`);
  }

  async designTicket({ cwd, ticket, sessionFile, runId, productContext, requirements, exploration, ticketLookAhead, answers, profile, onEvent, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile, `${ticket.id}-${runId}`, { profile });
      const reply = await this.visibleSupervisorPrompt(session, `${stagePrompt(profile, ticketDesignInstruction)}\n\n# Living product context\n${productContext}\n\n# Approved PRD addendum\n${requirements}\n\n# Ticket look-ahead\n${ticketLookAhead}\n\n# Verified implementation delta\n${exploration}\n\n# Technical exception answers\n${answers || "No technical exceptions were raised."}`, { publishText: false, onEvent, signal });
      const parsed = JSON.parse(reply.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1));
      let contractExists = true;
      try { await access(join(cwd, verificationEntry)); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        contractExists = false;
      }
      let projectConfigExists = true;
      try { await access(join(cwd, projectConfigPath)); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        projectConfigExists = false;
      }
      return { plan: ensureVerificationContractStep(normalizePlan(parsed), contractExists, projectConfigExists), artifact: String(parsed.designArtifact || ""), sessionFile: session.sessionFile };
    }, ticket.id);
  }

  drainSupervisorSignals() {
    return this.supervisorSignals.splice(0);
  }

  drainSupervisorStages() {
    return this.supervisorStages.splice(0);
  }

  async visibleSupervisorPrompt(session, prompt, { images = [], publishText = true, onEvent, signal } = {}) {
    let reply = "";
    const unsubscribe = session.subscribe((event) => {
      const safe = safeEvent(event);
      if (!safe) return;
      if (safe.type === "text_delta") reply += safe.delta;
      onEvent?.(safe);
      if (publishText || safe.type !== "text_delta") this.publish({ channel: "chat", ...safe });
    });
    const unbindAbort = bindAbort(session, signal);
    try {
      signal?.throwIfAborted();
      await session.prompt(prompt, { images });
      signal?.throwIfAborted();
      return reply || lastAssistantText(session);
    } finally {
      unsubscribe();
      await unbindAbort();
    }
  }

  async listSkills({ cwd, sessionFile }) {
    const session = await this.planningSession(cwd, sessionFile);
    return session.resourceLoader.getSkills().skills
      .map(({ name, description }) => ({ name, description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async activateWorkflow({ cwd, sessionFile, skillName }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile);
      const skill = session.resourceLoader.getSkills().skills.find((item) => item.name === skillName);
      if (!skill) throw new Error(`Pi skill not found: ${skillName}`);
      this.drainSupervisorSignals();
      this.drainSupervisorStages();
      const reply = await this.visibleSupervisorPrompt(session, `/skill:${skillName} ${supervisorInstruction}`);
      return {
        reply,
        stages: this.drainSupervisorStages(),
        checkpoints: this.drainSupervisorSignals(),
        sessionFile: session.sessionFile
      };
    });
  }

  async continueWorkflow({ cwd, sessionFile, checkpoint, response }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile);
      this.drainSupervisorSignals();
      this.drainSupervisorStages();
      const reply = await this.visibleSupervisorPrompt(session, `The user resolved workflow checkpoint “${checkpoint.title}”. Response: ${response || "Approved"}. Continue the binding workflow. If another gate is required, use workflow_checkpoint.`);
      return {
        reply,
        stages: this.drainSupervisorStages(),
        checkpoints: this.drainSupervisorSignals(),
        sessionFile: session.sessionFile
      };
    });
  }

  async reviewWorkerReport({ cwd, sessionFile, step, report, diff }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile);
      this.drainSupervisorSignals();
      this.drainSupervisorStages();
    await session.prompt(`Review this structured worker report under the active binding workflow, if one is loaded; otherwise use the plan and acceptance criteria.

Step ID: ${step.id}
Step: ${step.title}
Worker: ${step.agentId}
Report: ${JSON.stringify(report)}
Changed files: ${diff.files.join(", ") || "none"}

If user input or approval is required, call workflow_checkpoint and include stepId. Otherwise give a concise review and allow normal user acceptance.`);
      return {
        reply: lastAssistantText(session),
        stages: this.drainSupervisorStages(),
        checkpoints: this.drainSupervisorSignals(),
        sessionFile: session.sessionFile
      };
    });
  }

  async chat({ cwd, sessionFile, message, images = [] }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile);
      this.drainSupervisorSignals();
      this.drainSupervisorStages();
      const prompt = session.state.messages.length ? message : `${planningInstruction}\n\nUser: ${message}`;
      const reply = await this.visibleSupervisorPrompt(session, prompt, { images });
      return {
        reply,
        stages: this.drainSupervisorStages(),
        checkpoints: this.drainSupervisorSignals(),
        sessionFile: session.sessionFile
      };
    });
  }

  async generatePlan({ cwd, sessionFile }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile);
      this.drainSupervisorSignals();
      this.drainSupervisorStages();
      const reply = await this.visibleSupervisorPrompt(session, planSchemaInstruction, { publishText: false });
      const checkpoints = this.drainSupervisorSignals();
      return {
        plan: checkpoints.length ? null : parseJsonReply(reply),
        reply,
        stages: this.drainSupervisorStages(),
        checkpoints,
        sessionFile: session.sessionFile
      };
    });
  }

  async verifyStep({ cwd, ticket, plan, step, design, diff, output, images = [], runId, round, profile, onEvent, signal }) {
    const { createAgentSession, SessionManager } = await this.sdk();
    const sessionDir = join(this.dataDir, "pi-sessions", "tickets", String(ticket.id).replace(/[^a-z0-9._-]+/gi, "-"), String(runId), "verifications", step.id, `round-${round}`);
    await mkdir(sessionDir, { recursive: true });
    const { session } = await createAgentSession({
      ...(await this.sessionOptions(profile)),
      cwd,
      tools: ["read", "grep", "find", "ls"],
      sessionManager: SessionManager.create(cwd, sessionDir)
    });
    session.setSessionName(`verify:${step.id}:round-${round}`);
    const unbindAbort = bindAbort(session, signal);
    let lastThinkingAt = 0;
    const unsubscribe = session.subscribe((event) => {
      const safe = safeEvent(event);
      if (!safe) return;
      if (safe.type === "thinking" && Date.now() - lastThinkingAt < 2000) return;
      if (safe.type === "thinking") lastThinkingAt = Date.now();
      onEvent?.(safe);
    });
    try {
      signal?.throwIfAborted();
      await session.prompt(stagePrompt(profile, `# Fresh implementation-slice verification

Review this slice without relying on the implementation conversation. Inspect repository evidence and run focused deterministic checks when useful.

Ticket: ${ticket.identifier} — ${ticket.title}
Requirement IDs: ${step.requirementIds.join(", ") || "none"}
Capability IDs: ${step.capabilityIds.join(", ") || "none"}
Implementation delta IDs: ${step.deltaIds.join(", ") || "none"}
Relevant product context:
${step.productContext || "No step-specific product context was assigned."}

Approved design:
${design}

Slice: ${step.title}
Step permission: ${step.permission}
Write scope: ${step.writeScope || "none"}
Expected worker artifacts: ${step.expectedArtifacts.join(", ") || "none"}
Acceptance criteria:
${step.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}
Visual evidence required: ${step.requiresVisualEvidence ? "yes — attach the screenshots produced by the verification contract" : "no"}

Worker artifact:
${output}

Changed files: ${diff.files.join(", ") || "none"}
Diff:
${diff.patch || "No textual diff"}

Return ONLY JSON:
{
  "summary": "concise verification result",
  "findings": [{
    "severity": "blocking | warning",
    "category": "correctness | requirements | tests | security | accessibility | performance | maintainability",
    "claim": "specific problem",
    "evidence": [{"file": "path", "line": 1}],
    "suggestedFix": "focused correction",
    "confidence": "high | medium | low"
  }]
}

Every reported finding triggers an automatic correction round. Report concrete defects, unmet acceptance criteria, or missing required evidence; omit optional polish and speculative improvements. Only report findings supported by repository, test, diff, or attached screenshot evidence. When visual evidence is required, inspect every attached screenshot and fail missing, broken, inaccessible, or visibly unfinished states. For a non-write step, its worker artifact is the durable deliverable and an empty repository diff is expected. Require a repository file only when an acceptance criterion explicitly names it. Each suggested correction must be possible within the stated permission and write scope. Do not modify files.`), { images });
      signal?.throwIfAborted();
      const rawOutput = lastAssistantText(session);
      const parsed = jsonReply(rawOutput);
      return { summary: String(parsed.summary || ""), findings: Array.isArray(parsed.findings) ? parsed.findings : [], rawOutput, sessionFile: session.sessionFile };
    } finally {
      unsubscribe();
      await unbindAbort();
      session.dispose();
    }
  }

  async generateCommitMessage({ cwd, ticket, step, diff, runId, profile, signal }) {
    const fallback = formatCommitMessage(null, step);
    try {
      const { createAgentSession, SessionManager } = await this.sdk();
      const sessionDir = join(this.dataDir, "pi-sessions", "tickets", String(ticket.id).replace(/[^a-z0-9._-]+/gi, "-"), String(runId), "commits", step.id);
      await mkdir(sessionDir, { recursive: true });
      const { session } = await createAgentSession({ ...(await this.sessionOptions(profile)), cwd, tools: [], sessionManager: SessionManager.create(cwd, sessionDir) });
      session.setSessionName(`commit:${step.id}`);
      const unbindAbort = bindAbort(session, signal);
      try {
        signal?.throwIfAborted();
        await session.prompt(stagePrompt(profile, `Write one Git commit message for this verified execution-plan step.

Ticket: ${ticket.identifier} — ${ticket.title}
Step: ${step.title}
Outcome: ${step.description || step.title}
Requirement IDs: ${step.requirementIds.join(", ") || "none"}
Acceptance criteria:
${step.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- Complete the approved step"}
Changed files: ${diff.files.join(", ") || "none"}
Diff summary: ${diff.stat || "No repository changes"}

Return ONLY JSON:
{
  "subject": "conventional-commit subject under 72 characters",
  "why": "one sentence explaining why this change exists",
  "requirement": "requirement IDs and the observable requirement satisfied"
}`));
        signal?.throwIfAborted();
        return formatCommitMessage(jsonReply(lastAssistantText(session)), step);
      } finally {
        await unbindAbort();
        session.dispose();
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return fallback;
    }
  }

  async updateProductContext({ cwd, ticket, currentContext, artifacts, diff, runId, profile, onEvent, signal }) {
    const { createAgentSession, SessionManager } = await this.sdk();
    const sessionDir = join(this.dataDir, "pi-sessions", "tickets", String(ticket.id).replace(/[^a-z0-9._-]+/gi, "-"), String(runId), "product-context");
    await mkdir(sessionDir, { recursive: true });
    const { session } = await createAgentSession({ ...(await this.sessionOptions(profile)), cwd, tools: [], sessionManager: SessionManager.create(cwd, sessionDir) });
    session.setSessionName("product-context-update");
    const unbindAbort = bindAbort(session, signal);
    const unsubscribe = session.subscribe((event) => { const safe = safeEvent(event); if (safe) onEvent?.(safe); });
    try {
      signal?.throwIfAborted();
      await session.prompt(`${stagePrompt(profile, productContextUpdateInstruction)}

# Current living product context
${currentContext}

# Completed ticket
${ticket.identifier} — ${ticket.title}

# Approved and verified ticket artifacts
${artifacts.map((artifact) => `## ${artifact.name}\n${artifact.content || ""}`).join("\n\n")}

# Final changed files
${diff.files.join(", ") || "none"}

# Final diff
${diff.patch || "No textual diff"}`);
      signal?.throwIfAborted();
      return String(jsonReply(lastAssistantText(session)).content || "");
    } finally {
      unsubscribe();
      await unbindAbort();
      session.dispose();
    }
  }

  async reviewTicket({ cwd, ticket, plan, artifacts, diff, images = [], role, round, runId, profile, onEvent, signal }) {
    const { createAgentSession, SessionManager } = await this.sdk();
    const sessionDir = join(this.dataDir, "pi-sessions", "tickets", String(ticket.id).replace(/[^a-z0-9._-]+/gi, "-"), String(runId), "reviews", `round-${round}`, role);
    await mkdir(sessionDir, { recursive: true });
    const { session } = await createAgentSession({
      ...(await this.sessionOptions(profile)),
      cwd,
      tools: ["read", "grep", "find", "ls"],
      sessionManager: SessionManager.create(cwd, sessionDir)
    });
    session.setSessionName(`review:${role}:round-${round}`);
    const unbindAbort = bindAbort(session, signal);
    let lastThinkingAt = 0;
    const unsubscribe = session.subscribe((event) => {
      const safe = safeEvent(event);
      if (!safe || (safe.type === "thinking" && Date.now() - lastThinkingAt < 2000)) return;
      if (safe.type === "thinking") lastThinkingAt = Date.now();
      onEvent?.(safe);
    });
    try {
      signal?.throwIfAborted();
      await session.prompt(stagePrompt(profile, `# Independent ${role} review

${reviewerCharters[role]}

Ticket: ${ticket.identifier} — ${ticket.title}
Description: ${ticket.description || "None"}

Approved plan: ${JSON.stringify(plan)}

Persistent context artifacts:
${artifacts.map((artifact) => `## ${artifact.name}\n${artifact.content || ""}`).join("\n\n")}

Combined changed files: ${diff.files.join(", ") || "none"}
Combined diff:
${diff.patch || "No textual diff"}

Return ONLY JSON:
{
  "summary": "concise independent assessment",
  "findings": [{
    "severity": "blocking | warning",
    "category": "correctness | requirements | tests | security | accessibility | performance | maintainability",
    "claim": "specific problem",
    "evidence": [{"file": "path", "line": 1}],
    "acceptanceCriterion": "affected criterion or empty",
    "suggestedFix": "focused correction",
    "confidence": "high | medium | low"
  }]
}

Every reported finding triggers an automatic correction round. Report concrete defects, unmet acceptance criteria, or missing required evidence; omit optional polish and speculative improvements. Only report a finding when you can cite repository, diff, or attached screenshot evidence. Do not modify files.`), { images });
      signal?.throwIfAborted();
      const parsed = jsonReply(lastAssistantText(session));
      return {
        role,
        summary: String(parsed.summary || ""),
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        sessionFile: session.sessionFile
      };
    } finally {
      unsubscribe();
      await unbindAbort();
      session.dispose();
    }
  }

  async runStep({ cwd, plan, step, artifacts, images, forkSessionFile, resumeSessionFile, feedback, onEvent, ticketId = "shared", runId = "legacy", profile, signal }) {
    const { createAgentSession, SessionManager } = await this.sdk();
    const sessionDir = join(this.dataDir, "pi-sessions", "tickets", String(ticketId).replace(/[^a-z0-9._-]+/gi, "-"), String(runId), "steps");
    await mkdir(sessionDir, { recursive: true });
    let manager;
    try {
      manager = resumeSessionFile
        ? SessionManager.open(resumeSessionFile, sessionDir, cwd)
        : step.contextPolicy === "fork" && forkSessionFile
          ? SessionManager.forkFrom(forkSessionFile, cwd, sessionDir)
          : SessionManager.create(cwd, sessionDir);
    } catch {
      manager = SessionManager.create(cwd, sessionDir);
    }
    const tools = step.permission === "write"
      ? ["read", "grep", "find", "ls", "edit", "write"]
      : step.permission === "read" ? ["read", "grep", "find", "ls"] : [];
    let report = null;
    tools.push("worker_report");
    const scopedTools = step.permission === "write" ? [...scopedWorkerTools(cwd, step.writeScope), projectCommandTool(cwd, signal)] : [];
    if (step.permission === "write") tools.push("project_command");
    const { session } = await createAgentSession({
      ...(await this.sessionOptions(profile)),
      cwd,
      tools,
      customTools: [...scopedTools, workerReportTool((value) => { report = value; })],
      sessionManager: manager
    });
    session.setSessionName(step.agentId);
    const unbindAbort = bindAbort(session, signal);
    const availableSkills = session.resourceLoader.getSkills().skills;
    const skillBlocks = [];
    for (const name of step.skills) {
      const skill = availableSkills.find((item) => item.name === name);
      if (!skill) throw new Error(`Pi skill not found: ${name}`);
      const content = await readFile(skill.filePath, "utf8");
      skillBlocks.push(`<skill name="${skill.name}" location="${skill.filePath}">
References are relative to ${skill.baseDir}.

${stripFrontmatter(content).trim()}
</skill>`);
    }
    let output = "";
    const events = [];
    let lastThinkingAt = 0;
    const unsubscribe = session.subscribe((event) => {
      const safe = safeEvent(event);
      if (!safe) return;
      if (safe.type === "thinking" && Date.now() - lastThinkingAt < 2000) return;
      if (safe.type === "thinking") lastThinkingAt = Date.now();
      if (safe.type === "text_delta") output += safe.delta;
      else pushBounded(events, { ...safe, at: new Date().toISOString() }, 100);
      onEvent?.(safe);
    });
    try {
      signal?.throwIfAborted();
      const correction = feedback ? `# Review feedback\n\n${feedback}\n\nCorrect only the requested issues, preserve accepted behavior, run focused verification, and finish with worker_report.` : "";
      const guidance = profile?.prompt ? `# Configured stage guidance\n${profile.prompt}` : "";
      const prompt = [skillBlocks.join("\n\n"), guidance, stepContext({ plan, step, artifacts }), correction].filter(Boolean).join("\n\n");
      onEvent?.({ type: "prompt", label: "Prompt rendered", content: prompt });
      await session.prompt(prompt, { images });
      signal?.throwIfAborted();
      const rawOutput = output || lastAssistantText(session);
      return {
        prompt,
        rawOutput,
        output: report?.artifact || rawOutput,
        report: report || { status: "completed", summary: rawOutput, artifact: rawOutput },
        sessionFile: session.sessionFile,
        events
      };
    } finally {
      unsubscribe();
      await unbindAbort();
      session.dispose();
    }
  }
}

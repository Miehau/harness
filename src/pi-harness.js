import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createEditToolDefinition, createWriteToolDefinition, defineTool, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assertScopedWrite, diffOutline, normalizeReviewMap } from "./git.js";
import { appendBounded, pushBounded } from "./execution.js";
import { parseModelOutput } from "./model-output.js";
import { defaultReviewBudget, flattenSteps, normalizePlan, planReviewViolations } from "./plan.js";
import { loadProjectConfig, projectConfigPath, projectEnvironment, redactCommandOutput, runProjectCommand } from "./project-config.js";
import { stagePrompt } from "./profiles.js";
import { compactReviewPacket } from "./review-packet.js";
import { visualEvidenceMedia } from "./artifacts.js";

const exec = promisify(execFile);
const verificationEntry = ".agent-plan/verify.mjs";
export const MAX_VERIFICATION_ACTIONS = 20;
export const MAX_VERIFICATION_MS = 5 * 60 * 1000;

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
  "designArtifact": "concise markdown design when requested, otherwise blank",
  "harness": "pi",
  "nodes": [
    {
      "id": "stable-kebab-id",
      "type": "group",
      "title": "outcome-oriented group title",
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
  "expectedFiles": ["concrete repository files likely to change"],
  "estimatedChangedLines": 0,
  "reviewBudget": { "maxFiles": ${defaultReviewBudget.maxFiles}, "maxChangedLines": ${defaultReviewBudget.maxChangedLines}, "justification": "blank unless this is an indivisible exception" },
  "skills": ["exact available skill names when useful"],
  "references": ["repository-relative files the worker should inspect"],
  "requirementIds": ["REQ-stable-id"],
  "capabilityIds": ["CAP-stable-id"],
  "deltaIds": ["DELTA-stable-id"],
  "productContext": "only the concise PRD and implementation-delta context relevant to this step",
  "expectedArtifacts": ["named outputs"],
  "acceptanceCriteria": ["observable criterion"],
  "requiresVisualEvidence": false,
  "requiresVideoEvidence": false,
  "dependsOn": ["step-or-group-id"],
  "required": true
}

Rules:
- Steps are task-specific; do not use a fixed workflow template.
- Use a group only when sibling steps can run concurrently and feed a later step.
- Groups may contain steps only; never nest another group.
- A downstream step depending on a group waits for every required child to be accepted.
- Code-writing steps should be serial by default. Deliberately parallel writes must be siblings with disjoint write scopes; they run in isolated worktrees and block if their patches conflict during integration.
- Decompose implementation into a ticket-specific sequence of coherent, human-reviewable behavior slices. Each write step must leave the worktree valid, have a focused diff, and be independently understandable and verifiable.
- Keep each ordinary write step within ${defaultReviewBudget.maxFiles} reviewable files and ${defaultReviewBudget.maxChangedLines} changed lines. List expectedFiles and estimate changed lines from repository evidence. A larger indivisible step requires a concrete reviewBudget.justification; never enlarge the numbers merely to make a broad step pass.
- Ordinary planned write steps must use finite write scopes. Do not use "*" or "**" unless reviewBudget.justification explains why the change is genuinely indivisible.
- Prefer complete vertical outcomes over file-layer steps such as “change types”, “change service”, or “add tests”. Put proportionate tests in the step that delivers the behavior.
- Default to serial vertical slices. Use a shared-contract plus parallel-conformance shape only when both sides are independently testable, have disjoint write scopes, and parallel execution materially reduces risk or latency. Put cross-branch integration tests in the dependent integration step.
- Every write plan must use ".agent-plan/verify.mjs" as its single deterministic verification entry point. If it is missing, the first architecture write step creates it with Node standard-library process calls and includes only ".agent-plan" in its write scope. The entry point must run the repository's relevant tests, lint, type checks, and builds, fail on any failed command, and remain usable by every later step. Every isolated step must keep its applicable checks green; the downstream integration step owns checks that require multiple parallel branches.
- The verification bootstrap also creates or updates .agent-plan/project.json. Store executable commands as argv arrays in project.json; never make the harness parse prose for commands. Do not combine this bootstrap with product code, docs/architecture.md, AGENTS.md, or other documentation. Add documentation in a separate ticket-specific step only when the approved requirements directly justify it.
- Prefer built-ins and existing dependencies. A small conventional dependency is acceptable when it is clearly the simplest complete solution. Never introduce a framework, infrastructure component, large package, unusual license, or architecture-shaping dependency unless the supplied technical-exception answers explicitly approve it.
- Set requiresVisualEvidence to true when acceptance depends on rendered browser behavior or appearance. In that case the verification entry point must capture at least one PNG, JPEG, or WebP screenshot into process.env.AGENT_PLAN_EVIDENCE_DIR using the project's existing browser tooling. Set requiresVideoEvidence to true only when acceptance specifically needs interaction proof; that requires both a screenshot and at least one real WebM or MP4. Never turn screenshots into a video.
- Every serial write step after the first must depend on the preceding write step so implementation pauses for human review in a predictable order.
- Link every step to stable requirement, capability, and delta IDs. Copy only the relevant product context into productContext; do not dump the whole PRD into a worker prompt.
- Use only skill names from the supplied available-skill catalog. Use an empty array when none applies.
- Every step must have a useful prompt, expected artifact, and acceptance criterion.`;

const requirementsInstruction = `You are beginning a ticket-scoped development workflow. You have no repository tools and must clarify requirements before repository exploration.
1. Use only the ticket and supplied living product context. Do not inspect source code.
2. Enhance product intent with a ticket-specific PRD addendum containing stable REQ-* IDs, explicit scope, behavior, edge cases, constraints, and observable acceptance criteria.
3. Questions are a last resort. Leave questions empty when the ticket, product context, or a conservative minimal interpretation supplies a safe answer.
4. Ask at most three questions only when competing product outcomes would materially change user-visible behavior or scope and choosing incorrectly risks meaningful rework or harm.
5. Never ask the user to choose implementation mechanics before repository exploration, including script shape, command composition, naming, libraries, or fail-fast versus aggregate execution.

Return ONLY valid JSON:
{
  "artifact": "a concise markdown PRD addendum and requirements contract",
  "questions": ["one focused question", "another focused question"]
}`;

const requirementsFollowUpInstruction = `Continue the requirements clarification with the user. You still have no repository tools.
1. Incorporate the user's answers into the complete PRD addendum and requirements contract.
2. Apply conservative minimal defaults for anything inferable from the ticket or product context.
3. Ask at most three remaining questions only when competing product outcomes would materially change user-visible behavior or scope and choosing incorrectly risks meaningful rework or harm.
4. Never ask the user to choose implementation mechanics before repository exploration. Questions should normally be empty.

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

Use the supplied ticket look-ahead to preserve likely shared foundations and avoid near-term architectural dead ends, without adding unrelated ticket scope. Set designArtifact to a concise markdown design covering the chosen approach, alternatives rejected, important files, risks, and verification strategy. The execution plan must start after exploration and clarification; do not add redundant discovery steps.`;

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

const findingRubric = `Severity rubric:
- critical: credible credential exposure, destructive access, data loss, or a failure that makes the core ticket unsafe to ship
- high: an acceptance criterion or security boundary is broken, or likely user behavior is materially incorrect with no practical workaround
- medium: a bounded correctness, regression, test, accessibility, performance, or maintainability defect with concrete user or operator impact
- low: polish, optional hardening, speculative risk, or preference

Report only critical, high, or medium findings. Omit low-severity observations.`;

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

function availableSkillNames(session) {
  return session.resourceLoader.getSkills().skills.map((skill) => skill.name).sort();
}

function assertAvailablePlanSkills(plan, names) {
  const available = new Set(names);
  const missing = [...new Set(flattenSteps(plan).flatMap((step) => step.skills || []).filter((name) => !available.has(name)))];
  if (missing.length) throw new Error(`Plan requested unavailable skills: ${missing.join(", ")}`);
  return plan;
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
  return normalizePlan(parseModelOutput(reply, { title: "nonEmptyString", nodes: "nonEmptyArray" }, "Planner output"));
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

${!outsideContractScope(step.writeScope) ? `
Own the repository verification contract. If ${verificationEntry} is missing or incomplete, create or update it using Node standard-library process calls. It must run every project-specific deterministic check through one command: node ${verificationEntry}. For browser-visible acceptance, make it write screenshots into process.env.AGENT_PLAN_EVIDENCE_DIR. For interaction-recording acceptance, make it write a real WebM or MP4 there; never make a video from screenshots. Do not add a dependency only for this wrapper.
Also own ${projectConfigPath}, keeping commands, allowed environment names/files, and port variables machine-readable. Do not modify architecture or agent-guidance documents unless the approved ticket has a separate, explicit documentation step.
` : ""}

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
Expected files: ${step.expectedFiles?.join(", ") || "none specified"}
Estimated changed lines: ${step.estimatedChangedLines || "not estimated"}
Review budget: ${step.reviewBudget ? `${step.reviewBudget.maxFiles} files / ${step.reviewBudget.maxChangedLines} changed lines${step.reviewBudget.justification ? ` (${step.reviewBudget.justification})` : ""}` : "default"}
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

Visual evidence: ${step.requiresVideoEvidence ? `required; make ${verificationEntry} write both a screenshot and a real WebM or MP4 interaction recording into process.env.AGENT_PLAN_EVIDENCE_DIR (never make a video from screenshots)` : step.requiresVisualEvidence ? `required; make ${verificationEntry} write PNG, JPEG, or WebP screenshots into process.env.AGENT_PLAN_EVIDENCE_DIR` : "not required"}

Work only within the stated permission and write scope. Expected files are a planning estimate, not an additional permission boundary; inspect every listed reference before changing files. Write workers have no arbitrary shell. Use project_command to run a named command from ${projectConfigPath}; the harness controls its working directory, environment allow-list, and timeout. ${step.permission === "write" ? "After the final edit, use review_note for up to five non-obvious changed sections where intent, an invariant, risk, or test evidence will reduce reviewer effort. Point at exact changed lines. Write one to three informative, direct sentences: explain what the changed block does now, then why its non-obvious decision matters. Do not paraphrase obvious code." : ""} The framework runs ${verificationEntry} after your report. Your final action MUST be the worker_report tool. Use completed when the result is ready for review, needs_input only when one concrete user answer or action is unavoidable, or awaiting_approval when explicit approval is required. Never request broader access for a path already listed in the write scope. Report dependency or command failures separately from permission issues, include the exact failed command and useful output in the artifact, and make at most one concrete request. Put the complete artifact for dependent steps in artifact.`;
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
    title: "Establish repository verification contract",
    description: `Record machine-executable commands, the environment allow-list, and the repository's deterministic verification entry point.`,
    prompt: `Inspect the repository and create or update ${projectConfigPath} and ${verificationEntry}. In project.json, store commands as argv arrays, environment variable names under environment.pass, explicitly approved ignored local env files under environment.files, and port variable names under ports.variables. The verification script must use Node standard-library process calls and propagate every failed test, lint, type-check, and build command. Do not modify product code, architecture documentation, or agent guidance. ${visual ? "When AGENT_PLAN_EVIDENCE_DIR is set, use the project's existing browser tooling to write representative screenshots there. When a later step requires video evidence, write a real WebM or MP4 interaction recording; never make a video from screenshots." : "Do not add browser tooling unless a later step requires visual evidence."}`,
    permission: "write",
    writeScope: ".agent-plan",
    expectedFiles: [projectConfigPath, verificationEntry],
    estimatedChangedLines: 100,
    acceptanceCriteria: [
      `${projectConfigPath} declares executable commands separately from prose`,
      `node ${verificationEntry} runs the repository's relevant deterministic checks from one stable entry point`
    ],
    expectedArtifacts: [projectConfigPath, verificationEntry],
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

function reviewNoteTool(capture) {
  return defineTool({
    name: "review_note",
    label: "Review note",
    description: "Attach concise review-only context to an exact range of changed lines.",
    promptSnippet: "Annotate non-obvious changed lines for the reviewer",
    promptGuidelines: ["Use only after the final edit. In one to three direct sentences, explain what the block does now and why the non-obvious decision matters. Add no more than five unless the reviewer asks for updates."],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Existing rn- ID when updating a note after review feedback" })),
      path: Type.String({ description: "Repository-relative changed file path" }),
      side: Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]),
      startLine: Type.Integer({ minimum: 1 }),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
      kind: Type.Union([Type.Literal("intent"), Type.Literal("invariant"), Type.Literal("risk"), Type.Literal("test")]),
      text: Type.String({ description: "One to three direct sentences explaining what the block does now and why the non-obvious decision matters" })
    }),
    async execute(_toolCallId, params) {
      const note = { ...params, id: /^rn-[a-z0-9_-]{1,64}$/i.test(params.id || "") ? params.id : `rn-${randomUUID().slice(0, 8)}`, endLine: params.endLine ?? params.startLine };
      capture(note);
      return { content: [{ type: "text", text: `Recorded ${note.id} for ${note.path}:${note.startLine}-${note.endLine}` }], details: note };
    }
  });
}

export function scopedWorkerTools(cwd, writeScope) {
  const check = (path) => assertScopedWrite(cwd, path, writeScope);
  const scopedDescendant = (path) => {
    const directory = relative(resolve(cwd), resolve(path)).split(sep).join("/");
    return String(writeScope || "").split(",").map((item) => item.trim().replace(/^\.\//, "").replace(/\/\*\*?$/, "")).find((item) => item.startsWith(`${directory}/`));
  };
  return [
    createEditToolDefinition(cwd, { operations: {
      access: async (path) => access(await check(path)),
      readFile,
      writeFile: async (path, content) => writeFile(await check(path), content)
    } }),
    createWriteToolDefinition(cwd, { operations: {
      mkdir: async (path) => {
        try { await access(path); }
        catch (error) {
          if (error.code !== "ENOENT") throw error;
          if (resolve(path) !== resolve(cwd)) await check(scopedDescendant(path) || path);
        }
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
    this.sessionGuidance = new WeakMap();
  }

  async sessionTrace(sessionFile, { after, before } = {}) {
    if (!sessionFile) return { prompt: "", prompts: [], rawOutput: "", events: [] };
    const file = resolve(sessionFile);
    const root = `${resolve(this.dataDir, "pi-sessions")}${sep}`;
    if (!file.startsWith(root)) throw new Error("Session file is outside Pi session storage");
    const trace = { prompt: "", prompts: [], rawOutput: "", events: [] };
    for (const line of (await readFile(file, "utf8")).split("\n").filter(Boolean)) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const message = entry.type === "message" ? entry.message : null;
      if (!message) continue;
      const at = new Date(message.timestamp || entry.timestamp || Date.now()).toISOString();
      if ((after && at < after) || (before && at > before)) continue;
      if (message.role === "user") {
        trace.prompt = textFromContent(message.content);
        trace.prompts.push({ prompt: trace.prompt, at });
      }
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

  configuredPrompt(session, profile, instruction) {
    if (!profile?.prompt) return instruction;
    const key = `${profile.id || "stage"}\0${profile.prompt}`;
    if (this.sessionGuidance.get(session) === key) return instruction;
    this.sessionGuidance.set(session, key);
    return stagePrompt(profile, instruction);
  }

  async validateProfiles(profiles) {
    await Promise.all(Object.values(profiles).map((profile) => this.sessionOptions(profile)));
  }

  async models(provider) {
    const { ModelRuntime } = await this.sdk();
    this.modelRuntimePromise ||= ModelRuntime.create();
    const runtime = await this.modelRuntimePromise;
    const models = provider ? runtime.getModels(provider) : runtime.getModels();
    return models
      .map((model) => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow
      }))
      .sort((left, right) => left.id.localeCompare(right.id) || String(left.provider || "").localeCompare(String(right.provider || "")));
  }

  async runRepositoryChecks({ cwd, signal, requireVisualEvidence = false, requireVideoEvidence = false }) {
    requireVisualEvidence ||= requireVideoEvidence;
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
        .filter((entry) => entry.isFile())
        .map((entry) => ({ name: entry.name, path: join(evidenceDir, entry.name) }))
        .map((item) => ({ ...item, ...visualEvidenceMedia(item.path) }))
        .filter((item) => item.mediaType);
      const output = eventText(redactCommandOutput([stdout, stderr].filter(Boolean).join("\n"), environment));
      if (requireVisualEvidence && !evidence.some((item) => item.mediaKind === "image")) return { status: "failed", command, summary: `${command} passed but produced no screenshot evidence.`, output, evidence, durationMs: Date.now() - startedAt };
      if (requireVideoEvidence && !evidence.some((item) => item.mediaKind === "video")) return { status: "failed", command, summary: `${command} passed but produced no video evidence.`, output, evidence, durationMs: Date.now() - startedAt };
      return { status: "passed", command, summary: `${command} passed${evidence.length ? ` with ${evidence.length} visual artifact${evidence.length === 1 ? "" : "s"}` : ""}.`, output, evidence, durationMs: Date.now() - startedAt };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { status: "failed", command, summary: `${command} failed.`, output: eventText(redactCommandOutput([error.stdout, error.stderr, error.message].filter(Boolean).join("\n"), environment)), evidence: [], durationMs: Date.now() - startedAt };
    }
  }

  async evidenceImages(evidence = []) {
    return Promise.all(evidence.filter((item) => item.mediaKind === "image").map(async ({ path, mediaType }) => ({
      type: "image",
      source: {
        type: "base64",
        mediaType,
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

  supervisorRunKey(ticketId, runId) {
    return `${ticketId}-${runId}`;
  }

  reset() {
    for (const item of this.planning.values()) {
      try { item.session.dispose(); } catch {}
    }
    this.planning.clear();
    this.supervisorQueues.clear();
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

  async clarifyRequirements({ cwd, ticket, runId, sessionFile, productContext, profile, onEvent, onSessionFile, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile, `${ticket.id}-${runId}-requirements`, { repositoryAccess: false, profile });
      await onSessionFile?.(session.sessionFile);
      const reply = await this.visibleSupervisorPrompt(session, `${this.configuredPrompt(session, profile, requirementsInstruction)}\n\n# Living product context\n${productContext}\n\n# Tracker ticket\n${ticket.identifier}: ${ticket.title}\n\n${ticket.description || "No description provided."}`, { publishText: false, onEvent, signal });
      const parsed = parseModelOutput(reply, { artifact: "nonEmptyString", questions: "array" }, "Requirements output");
      return {
        artifact: String(parsed.artifact || ""),
        questions: Array.isArray(parsed.questions) ? parsed.questions.map(String).filter(Boolean) : [],
        sessionFile: session.sessionFile
      };
    }, `${ticket.id}:${runId}:requirements`);
  }

  async refineRequirements({ cwd, ticket, runId, sessionFile, answers, profile, onEvent, onSessionFile, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile, `${ticket.id}-${runId}-requirements`, { repositoryAccess: false, profile });
      await onSessionFile?.(session.sessionFile);
      const reply = await this.visibleSupervisorPrompt(session, `${this.configuredPrompt(session, profile, requirementsFollowUpInstruction)}\n\n# User response\n${answers}`, { publishText: false, onEvent, signal });
      const parsed = parseModelOutput(reply, { artifact: "nonEmptyString", questions: "array" }, "Requirements output");
      return {
        artifact: String(parsed.artifact || ""),
        questions: Array.isArray(parsed.questions) ? parsed.questions.map(String).filter(Boolean) : [],
        sessionFile: session.sessionFile
      };
    }, `${ticket.id}:${runId}:requirements`);
  }

  async exploreTicket({ cwd, ticket, sessionFile, runId, productContext, requirements, profile, onEvent, onSessionFile, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile, `${ticket.id}-${runId}`, { profile });
      await onSessionFile?.(session.sessionFile);
      const reply = await this.visibleSupervisorPrompt(session, `${this.configuredPrompt(session, profile, ticketExplorationInstruction)}\n\n# Living product context\n${productContext}\n\n# Approved PRD addendum\n${requirements}\n\n# Current ticket\n${ticket.identifier}: ${ticket.title}\n\n${ticket.description || "No description provided."}`, { publishText: false, onEvent, signal });
      const parsed = parseModelOutput(reply, { artifact: "nonEmptyString", questions: "array" }, "Exploration output");
      return {
        artifact: String(parsed.artifact || ""),
        questions: Array.isArray(parsed.questions) ? parsed.questions.map(String).filter(Boolean) : [],
        sessionFile: session.sessionFile
      };
    }, this.supervisorRunKey(ticket.id, runId));
  }

  async lookAheadTickets({ cwd, ticket, runId, productContext, requirements, ticketHorizon, profile, onEvent, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, null, `${ticket.id}-${runId}-ticket-lookahead`, { repositoryAccess: false, profile });
      const reply = await this.visibleSupervisorPrompt(session, `${this.configuredPrompt(session, profile, ticketLookAheadInstruction)}\n\n# Living product context\n${productContext}\n\n# Approved PRD addendum\n${requirements}\n\n${ticketHorizon}\n\n# Current ticket\n${ticket.identifier}: ${ticket.title}\n\n${ticket.description || "No description provided."}`, { publishText: false, onEvent, signal });
      return { artifact: parseModelOutput(reply, { artifact: "nonEmptyString" }, "Ticket look-ahead output").artifact, sessionFile: session.sessionFile };
    }, `${ticket.id}:ticket-lookahead`);
  }

  async designTicket({ cwd, ticket, sessionFile, runId, productContext, requirements, exploration, ticketLookAhead, answers, profile, onEvent, onSessionFile, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile, `${ticket.id}-${runId}`, { profile });
      await onSessionFile?.(session.sessionFile);
      const skillNames = availableSkillNames(session);
      const reply = await this.visibleSupervisorPrompt(session, `${this.configuredPrompt(session, profile, ticketDesignInstruction)}\n\n# Available skills\n${skillNames.length ? skillNames.map((name) => `- ${name}`).join("\n") : "- None"}\n\n# Living product context\n${productContext}\n\n# Approved PRD addendum\n${requirements}\n\n# Ticket look-ahead\n${ticketLookAhead}\n\n# Verified implementation delta\n${exploration}\n\n# Technical exception answers\n${answers || "No technical exceptions were raised."}`, { publishText: false, onEvent, signal });
      const parsed = parseModelOutput(reply, { title: "nonEmptyString", nodes: "nonEmptyArray", designArtifact: "nonEmptyString" }, "Design output");
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
      let plan = ensureVerificationContractStep(normalizePlan(parsed), contractExists, projectConfigExists);
      let violations = planReviewViolations(plan);
      if (violations.length) {
        const revision = await this.visibleSupervisorPrompt(session, `Revise the complete JSON plan so every implementation step is a coherent review unit. Resolve each deterministic violation below by splitting behavior slices or adding a concrete indivisibility justification; do not merely raise a budget. Return the complete JSON plan only.\n\n${violations.map((item) => `- ${item}`).join("\n")}`, { publishText: false, onEvent, signal });
        Object.assign(parsed, parseModelOutput(revision, { title: "nonEmptyString", nodes: "nonEmptyArray", designArtifact: "nonEmptyString" }, "Revised design output"));
        plan = ensureVerificationContractStep(normalizePlan(parsed), contractExists, projectConfigExists);
        violations = planReviewViolations(plan);
      }
      if (violations.length) throw new Error(`Planner returned oversized review steps: ${violations.join("; ")}`);
      assertAvailablePlanSkills(plan, skillNames);
      return { plan, artifact: String(parsed.designArtifact || ""), sessionFile: session.sessionFile };
    }, this.supervisorRunKey(ticket.id, runId));
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
      onEvent?.({ type: "prompt", label: "Prompt rendered", content: prompt });
      await session.prompt(prompt, { images });
      signal?.throwIfAborted();
      return reply || lastAssistantText(session);
    } finally {
      unsubscribe();
      await unbindAbort();
    }
  }

  async listSkills({ cwd, sessionFile, sessionKey }) {
    const session = await this.planningSession(cwd, sessionFile, sessionKey);
    return session.resourceLoader.getSkills().skills
      .map(({ name, description }) => ({ name, description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async activateWorkflow({ cwd, sessionFile, sessionKey, skillName, profile, onEvent, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile, sessionKey, { profile });
      const skill = session.resourceLoader.getSkills().skills.find((item) => item.name === skillName);
      if (!skill) throw new Error(`Pi skill not found: ${skillName}`);
      this.drainSupervisorSignals();
      this.drainSupervisorStages();
      const reply = await this.visibleSupervisorPrompt(session, `/skill:${skillName} ${supervisorInstruction}`, { onEvent, signal });
      return {
        reply,
        stages: this.drainSupervisorStages(),
        checkpoints: this.drainSupervisorSignals(),
        sessionFile: session.sessionFile
      };
    }, sessionKey || "shared");
  }

  async continueWorkflow({ cwd, sessionFile, sessionKey, checkpoint, response, profile, onEvent, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, sessionFile, sessionKey, { profile });
      this.drainSupervisorSignals();
      this.drainSupervisorStages();
      const reply = await this.visibleSupervisorPrompt(session, `The user resolved workflow checkpoint “${checkpoint.title}”. Response: ${response || "Approved"}. Continue the binding workflow. If another gate is required, use workflow_checkpoint.`, { onEvent, signal });
      return {
        reply,
        stages: this.drainSupervisorStages(),
        checkpoints: this.drainSupervisorSignals(),
        sessionFile: session.sessionFile
      };
    }, sessionKey || "shared");
  }

  async reviewWorkerReport({ sessionFile, step, report, diff }) {
    // This runs only after deterministic checks and the independent verifier pass.
    // Keep the review evidence-based: a second model review can invent a technical
    // blocker and incorrectly turn it into a user decision instead of a correction.
    const summary = String(report?.summary || "Completed the requested outcome.").trim();
    const changedFiles = diff?.files?.length ? `${diff.files.length} changed file${diff.files.length === 1 ? "" : "s"}` : "no changed files";
    return {
      reply: `Independent verification passed for ${step.title}. Worker report: ${summary} (${changedFiles}).`,
      stages: [],
      checkpoints: [],
      sessionFile
    };
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
      const skillNames = availableSkillNames(session);
      const reply = await this.visibleSupervisorPrompt(session, `${planSchemaInstruction}\n\n# Available skills\n${skillNames.length ? skillNames.map((name) => `- ${name}`).join("\n") : "- None"}`, { publishText: false });
      const checkpoints = this.drainSupervisorSignals();
      const plan = checkpoints.length ? null : parseJsonReply(reply);
      if (plan) assertAvailablePlanSkills(plan, skillNames);
      return {
        plan,
        reply,
        stages: this.drainSupervisorStages(),
        checkpoints,
        sessionFile: session.sessionFile
      };
    });
  }

  async verifyStep({ cwd, ticket, plan, step, design, diff, output, checks, images = [], runId, round, focusFindings = [], profile, onEvent, signal }) {
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
    let actionCount = 0;
    let budgetError = null;
    let budgetAbort;
    const stopForBudget = (message) => {
      if (budgetError) return;
      budgetError = new Error(message);
      budgetAbort = session.abort();
    };
    const budgetTimer = setTimeout(() => stopForBudget(`Verification exceeded its ${MAX_VERIFICATION_MS / 60000}-minute time budget.`), MAX_VERIFICATION_MS);
    const unsubscribe = session.subscribe((event) => {
      const safe = safeEvent(event);
      if (!safe) return;
      if (safe.type === "tool_start" && ++actionCount > MAX_VERIFICATION_ACTIONS) stopForBudget(`Verification exceeded its ${MAX_VERIFICATION_ACTIONS}-action inspection budget.`);
      if (safe.type === "thinking" && Date.now() - lastThinkingAt < 2000) return;
      if (safe.type === "thinking") lastThinkingAt = Date.now();
      onEvent?.(safe);
    });
    try {
      signal?.throwIfAborted();
      await session.prompt(this.configuredPrompt(session, profile, `# Fresh implementation-slice verification

Review this slice without relying on the implementation conversation. Inspect repository evidence. The deterministic gate has already run; use its result below rather than attempting to rerun it.

${focusFindings.length ? `This is a correction verification. Re-check the findings below and regressions directly introduced by their fixes. Do not start a new broad audit or report unrelated pre-existing issues.\n\nPrevious findings:\n${JSON.stringify(focusFindings, null, 2)}` : "This is the initial verification pass for this slice."}

Keep inspection inside the current working directory. Do not search home directories, sibling repositories, editor caches, or other dependency installations. Use no more than 20 repository read, search, find, or list actions.

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
Visual evidence required: ${step.requiresVideoEvidence ? "yes — attach both the screenshot and real WebM or MP4 interaction recording produced by the verification contract" : step.requiresVisualEvidence ? "yes — attach the screenshots produced by the verification contract" : "no"}

Worker artifact:
${output}

Changed files: ${diff.files.join(", ") || "none"}
Diff:
${diff.patch || "No textual diff"}

Deterministic gate:
${JSON.stringify({ status: checks?.status || "unknown", command: checks?.command || null, summary: checks?.summary || "", output: eventText(checks?.output || "") }, null, 2)}

Return ONLY JSON:
{
  "summary": "concise verification result",
  "findings": [{
    "severity": "critical | high | medium",
    "category": "correctness | requirements | tests | security | accessibility | performance | maintainability",
    "claim": "specific problem",
    "evidence": [{"file": "path", "line": 1}],
    "suggestedFix": "focused correction",
    "confidence": "high | medium | low"
  }]
}

${findingRubric}

Every reported finding triggers an automatic correction round. Report concrete defects, unmet acceptance criteria, or missing required evidence; omit optional polish and speculative improvements. Only report findings supported by repository, test, diff, or attached screenshot evidence. When visual evidence is required, inspect every attached screenshot and fail missing, broken, inaccessible, or visibly unfinished states. For a non-write step, its worker artifact is the durable deliverable and an empty repository diff is expected. Require a repository file only when an acceptance criterion explicitly names it. Each suggested correction must be possible within the stated permission and write scope. Do not modify files.`), { images });
      if (budgetError) throw budgetError;
      signal?.throwIfAborted();
      const rawOutput = lastAssistantText(session);
      const parsed = parseModelOutput(rawOutput, { summary: "nonEmptyString", findings: "array" }, "Verification output");
      return { summary: String(parsed.summary || ""), findings: Array.isArray(parsed.findings) ? parsed.findings : [], rawOutput, sessionFile: session.sessionFile };
    } finally {
      clearTimeout(budgetTimer);
      unsubscribe();
      await budgetAbort?.catch(() => {});
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
        await session.prompt(this.configuredPrompt(session, profile, `Write one Git commit message for this verified execution-plan step.

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
        return formatCommitMessage(parseModelOutput(lastAssistantText(session), { subject: "nonEmptyString", why: "nonEmptyString", requirement: "nonEmptyString" }, "Commit-message output"), step);
      } finally {
        await unbindAbort();
        session.dispose();
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      return fallback;
    }
  }

  async generateReviewMap({ cwd, ticket, step, diff, runId, profile, signal }) {
    return this.supervisorTurn(async () => {
      const session = await this.planningSession(cwd, null, `${ticket.id}-${runId}-${step.id}-review-map`, { repositoryAccess: false, profile });
      const outline = diffOutline(diff.patch);
      const reply = await this.visibleSupervisorPrompt(session, this.configuredPrompt(session, profile, `Create a concise semantic navigation map for this canonical Git diff. Group related behavior into 2–7 review intents. This is navigation metadata only: do not rewrite, summarize away, or invent changes. Assign each numbered hunk exactly once. Return ONLY valid JSON:\n{\n  "groups": [{ "title": "short intent", "summary": "what a reviewer should verify", "items": [{ "fileIndex": 0, "hunks": [0] }] }]\n}\n\n# Step\n${step.title}\n${step.description || ""}\n\n# Numbered files and hunks\n${JSON.stringify(outline, null, 2)}\n\n# Canonical diff\n${diff.patch}`), { publishText: false, signal });
      return normalizeReviewMap(parseModelOutput(reply, { groups: "array" }, "Review-map output"), diff.patch);
    }, `${ticket.id}:${runId}:${step.id}:review-map`);
  }

  async updateProductContext({ cwd, ticket, currentContext, artifacts, diff, runId, profile, onEvent, signal }) {
    const { createAgentSession, SessionManager } = await this.sdk();
    const sessionDir = join(this.dataDir, "pi-sessions", "tickets", String(ticket.id).replace(/[^a-z0-9._-]+/gi, "-"), String(runId), "product-context");
    await mkdir(sessionDir, { recursive: true });
    const { session } = await createAgentSession({ ...(await this.sessionOptions(profile)), cwd, tools: [], sessionManager: SessionManager.create(cwd, sessionDir) });
    session.setSessionName("product-context-update");
    const unbindAbort = bindAbort(session, signal);
    const unsubscribe = session.subscribe((event) => { const safe = safeEvent(event); if (safe) onEvent?.(safe); });
    const prompt = `${this.configuredPrompt(session, profile, productContextUpdateInstruction)}

# Current living product context
${currentContext}

# Completed ticket
${ticket.identifier} — ${ticket.title}

# Approved and verified ticket artifacts
${artifacts.map((artifact) => `## ${artifact.name}\n${artifact.content || ""}`).join("\n\n")}

# Final changed files
${diff.files.join(", ") || "none"}

# Final diff
${diff.patch || "No textual diff"}`;
    try {
      signal?.throwIfAborted();
      onEvent?.({ type: "prompt", label: "Prompt rendered", content: prompt });
      await session.prompt(prompt);
      signal?.throwIfAborted();
      return parseModelOutput(lastAssistantText(session), { content: "nonEmptyString" }, "Product-context output").content;
    } finally {
      unsubscribe();
      await unbindAbort();
      session.dispose();
    }
  }

  async reviewTicket({ cwd, ticket, plan, artifacts, diff, checks, images = [], role, round, runId, profile, onEvent, signal }) {
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
    const packet = compactReviewPacket({ ticket, plan, artifacts, diff, checks });
    const prompt = this.configuredPrompt(session, profile, `# Independent ${role} review

${reviewerCharters[role]} The deterministic gate has already run; use the supplied result rather than attempting to rerun it.

# Compact review packet
${JSON.stringify(packet, null, 2)}

Return ONLY JSON:
{
  "summary": "concise independent assessment",
  "findings": [{
    "severity": "critical | high | medium",
    "category": "correctness | requirements | tests | security | accessibility | performance | maintainability",
    "claim": "specific problem",
    "evidence": [{"file": "path", "line": 1}],
    "acceptanceCriterion": "affected criterion or empty",
    "suggestedFix": "focused correction",
    "confidence": "high | medium | low"
  }]
}

${findingRubric}

Every reported finding triggers an automatic correction round. Report concrete defects, unmet acceptance criteria, or missing required evidence; omit optional polish and speculative improvements. Only report a finding when you can cite repository, diff, or attached screenshot evidence. Do not modify files.`);
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
      onEvent?.({ type: "prompt", label: "Prompt rendered", content: prompt });
      await session.prompt(prompt, { images });
      signal?.throwIfAborted();
      const parsed = parseModelOutput(lastAssistantText(session), { summary: "nonEmptyString", findings: "array" }, "Independent-review output");
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

  async runStep({ cwd, plan, step, artifacts, images, forkSessionFile, resumeSessionFile, feedback, onEvent, onSessionFile, ticketId = "shared", runId = "legacy", profile, signal }) {
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
    const reviewNotes = [];
    tools.push("worker_report");
    const scopedTools = step.permission === "write" ? [...scopedWorkerTools(cwd, step.writeScope), projectCommandTool(cwd, signal), reviewNoteTool((note) => reviewNotes.push(note))] : [];
    if (step.permission === "write") tools.push("project_command", "review_note");
    const { session } = await createAgentSession({
      ...(await this.sessionOptions(profile)),
      cwd,
      tools,
      customTools: [...scopedTools, workerReportTool((value) => { report = value; })],
      sessionManager: manager
    });
    session.setSessionName(step.agentId);
    await onSessionFile?.(session.sessionFile);
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
      const continuation = feedback
        ? resumeSessionFile
          ? `The user responded to this worker session.\n\n${feedback}\n\nContinue from the existing conversation. Your final action MUST be the worker_report tool.`
          : `# Review feedback\n\n${feedback}\n\nCorrect only the requested issues, preserve accepted behavior, run focused verification, and finish with worker_report.`
        : resumeSessionFile
          ? "Continue the interrupted work from this existing session. Your final action MUST be the worker_report tool."
          : "";
      const prompt = resumeSessionFile
        ? continuation
        : [skillBlocks.join("\n\n"), this.configuredPrompt(session, profile, stepContext({ plan, step, artifacts })), continuation].filter(Boolean).join("\n\n");
      onEvent?.({ type: "prompt", label: "Prompt rendered", content: prompt });
      await session.prompt(prompt, { images });
      signal?.throwIfAborted();
      const rawOutput = output || lastAssistantText(session);
      if (!report) throw new Error("Worker did not finish with the required worker_report tool");
      return {
        prompt,
        rawOutput,
        output: report.artifact,
        report,
        reviewNotes,
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

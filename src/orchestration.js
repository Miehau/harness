import { assertSupervisorDecision, delegatedResumeAllowed, runProject, supervisorPolicy } from "./supervisor.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { freezeRunAccess, readProjectPolicy } from "./access-policy.js";
import { createTicketRun } from "./execution.js";
import { compactRun } from "./inspection.js";
import { normalizeUiImpact } from "./plan.js";
import { boundedText, redactRecord } from "./redaction.js";
import { freeTextTicket } from "../public/ui-model.js";

const CHECKPOINT_PROMPT_LIMIT = 4000;
const CHECKPOINT_QUESTION_LIMIT = 4000;

function orchestratorCheckpoint(run, compactCheckpoint) {
  if (!compactCheckpoint) return compactCheckpoint;
  const checkpoint = { ...compactCheckpoint };
  if (typeof run.checkpoint?.prompt === "string" && run.checkpoint.prompt) {
    const prompt = boundedText(run.checkpoint.prompt, CHECKPOINT_PROMPT_LIMIT);
    checkpoint.prompt = prompt.value;
    checkpoint.promptTruncated = prompt.truncated;
    checkpoint.promptTotal = prompt.total;
  }
  if (Array.isArray(run.checkpoint?.questions) && run.checkpoint.questions.length) {
    const questions = run.checkpoint.questions.map((question) => boundedText(String(question), CHECKPOINT_QUESTION_LIMIT));
    checkpoint.questions = questions.map((question) => question.value);
    checkpoint.questionsTruncated = questions.some((question) => question.truncated);
  }
  return checkpoint;
}

function orchestratorProof(map) {
  const criteria = (map?.criteria || []).map((criterion) => {
    const evidence = Array.isArray(criterion.current?.evidence) ? criterion.current.evidence : [];
    return {
      id: criterion.id,
      text: boundedText(criterion.text || "", 240).value,
      status: criterion.current?.status || "not_yet_verified",
      evidenceValidity: criterion.current?.evidenceValidity || "missing",
      mediaIds: evidence.filter((item) => item?.type === "media" && item.artifactId).map((item) => item.artifactId),
      stepId: criterion.stepId || null
    };
  });
  if (!criteria.length) return null;
  return {
    eligible: Boolean(map.eligibility?.eligible),
    blockingReasons: (map.eligibility?.blockingReasons || []).map((reason) => boundedText(`${reason.criterionId} [${reason.code}]: ${reason.message}`, 240).value),
    criteria
  };
}

const actionScope = new AsyncLocalStorage();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Invalid ${label} fields`);
}
function text(value, label, limit = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`${label} must be non-empty text up to ${limit} characters`);
  return value.trim();
}
function strings(value = [], label) {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`${label} must be an array of up to 100 strings`);
  return value.map((item) => text(item, label));
}
function assertExpected(run, expected) {
  if (!run || run.runId !== expected.runId || run.status !== expected.status || (run.checkpoint?.id || null) !== expected.checkpointId) throw new Error("Stale run or checkpoint; inspect the same ticket again before deciding");
}

// Claim a decision inside the same serialized write that first changes its run.
// Later background work retains the existing runner's ownership checks.
export async function guardOrchestratorUpdate(draft, change) {
  const action = actionScope.getStore();
  if (!action || action.claimed) return change(draft);
  const target = draft.ticketRuns[action.ticketId];
  const duplicate = action.requestId && target?.orchestratorDecisions?.find((item) => item.requestId === action.requestId);
  if (duplicate) {
    if (duplicate.payloadHash !== action.payloadHash || (duplicate.supervisorProject || null) !== action.supervisorProject) throw new Error("Decision requestId was already used for different content");
    const error = new Error("Decision already consumed");
    error.decisionReplay = true;
    throw error;
  }
  assertExpected(target, action.expected);
  assertSupervisorDecision(draft, target, action);
  await change(draft);
  const run = draft.ticketRuns[action.ticketId];
  if (!run || run.runId !== action.expected.runId) throw new Error("Decision cannot replace its target run");
  (run.orchestratorDecisions ||= []).push({
    ...redactRecord({ id: action.id, action: action.action, authority: action.authority, expected: action.expected, input: action.input, at: new Date().toISOString() }),
    ...(action.requestId ? { requestId: action.requestId, payloadHash: action.payloadHash, outcome: "consumed" } : {}),
    ...(action.supervisorProject ? { supervisorProject: action.supervisorProject, policyRevision: action.policyRevision } : {})
  });
  action.claimed = true;
}

export function createOrchestratorService({ state, tickets, dataDir }) {
  function observe(ticketId, runId, supervisorProject = null) {
    const snapshot = state.read();
    const run = snapshot.ticketRuns[ticketId]?.runId === runId ? snapshot.ticketRuns[ticketId]
      : Object.values(snapshot.retainedRuns || {}).find((item) => item.id === ticketId && item.runId === runId);
    if (!run) throw new Error("Requested ticket run is not retained");
    if (supervisorProject && runProject(run) !== supervisorProject) throw new Error("Run is outside supervisor project");
    const compact = compactRun(run);
    const proof = orchestratorProof(compact.proofMap);
    const proofMediaIds = new Set(proof?.criteria.flatMap((criterion) => criterion.mediaIds));
    const archived = snapshot.ticketRuns[ticketId]?.runId !== runId;
    const base = `/api/tickets/${encodeURIComponent(ticketId)}/runs/${encodeURIComponent(runId)}`;
    const kind = run.checkpoint?.kind;
    const delegatedActions = !archived && delegatedResumeAllowed(snapshot, run, supervisorProject || runProject(run)) ? ["resume"] : [];
    const actions = archived ? [] : run.status === "draft" ? ["start"] : kind === "requirements_review" || ["technical_input", "needs_input"].includes(kind) || (kind === "awaiting_approval" && (run.checkpoint?.stepId || run.checkpoint?.source === "supervisor")) ? ["answer"]
      : kind === "evidence_review" ? ["approve-proof", "revise-proof"] : kind === "awaiting_approval" ? ["approve", ...(run.plan?.uiImpact?.level === "material" ? ["revise-proposal"] : [])]
      : run.status === "awaiting_step_review" ? ["accept", "revise-step"] : ["paused", "interrupted", "needs_attention", "failed"].includes(run.status) ? ["resume", ...(run.plan?.uiImpact?.level === "material" ? ["revise-proposal"] : [])] : [];
    return { version: 1, ticketId, runId, archived, status: run.status, expected: { runId, status: run.status, checkpointId: run.checkpoint?.id || null },
      ticket: compact.ticket, checkpoint: orchestratorCheckpoint(run, compact.checkpoint), uiImpact: compact.uiImpact, uiProposal: compact.uiProposal, metrics: compact.metrics,
      proof, lastError: compact.lastError || null,
      retentionCleanup: run.retentionCleanup ? { status: run.retentionCleanup.status, completedAt: run.retentionCleanup.completedAt || null, error: run.retentionCleanup.error || null } : null,
      delegatedActions, delegation: supervisorPolicy(snapshot, supervisorProject || runProject(run)),
      requiredAction: compact.checkpoint?.title || (run.status === "draft" ? "Start this draft when instructed" : compact.lastError || null), actions: supervisorProject ? delegatedActions : actions,
      decisions: (run.orchestratorDecisions || []).slice(-20),
      artifacts: (run.artifacts || []).filter((artifact, index, all) => index >= all.length - 30 || proofMediaIds.has(artifact.id) || artifact.id === run.uiProposal?.artifactId || run.checkpoint?.evidenceArtifactIds?.includes(artifact.id)).map(({ id, name, kind }) => ({ id, name, kind, content: `${base}/artifacts/${encodeURIComponent(id)}/content`, ...(kind === "ui-proposal" ? { preview: `${base}/artifacts/${encodeURIComponent(id)}/preview` } : kind === "visual-evidence" ? { media: `${base}/artifacts/${encodeURIComponent(id)}/media` } : {}) })) };
  }

  async function submit(input) {
    object(input, ["idempotencyKey", "title", "requirements", "acceptanceCriteria", "exclusions", "dependencies", "uiImpact", "origin"], "submission");
    const key = text(input.idempotencyKey, "idempotencyKey", 200);
    const payload = { title: text(input.title, "title", 240), requirements: strings(input.requirements, "requirements"), acceptanceCriteria: strings(input.acceptanceCriteria, "acceptanceCriteria"), exclusions: strings(input.exclusions, "exclusions"), dependencies: strings(input.dependencies, "dependencies"), ...(input.uiImpact ? { uiImpact: normalizeUiImpact(input.uiImpact) } : {}) };
    if (!payload.requirements.length || !payload.acceptanceCriteria.length) throw new Error("Provide requirements and acceptance criteria before submitting a draft");
    if (JSON.stringify(payload).length > 80000) throw new Error("Submission exceeds 80000 characters");
    if (input.uiImpact) { object(input.uiImpact, ["level", "reason"], "UI impact"); text(input.uiImpact.reason, "UI impact reason", 1000); }
    const origin = text(input.origin, "origin", 120);
    const before = state.read();
    const access = await freezeRunAccess({ primaryCwd: before.workspace.cwd, policy: await readProjectPolicy(before, before.workspace.cwd) });
    const receiptKey = hash([before.workspace.cwd, key]);
    const payloadHash = hash(payload);
    let receipt;
    let created = false;
    await state.update((draft) => {
      if (draft.workspace.cwd !== before.workspace.cwd) throw new Error("Workspace changed during submission; retry in the intended project");
      draft.orchestratorSubmissions ||= {};
      receipt = draft.orchestratorSubmissions[receiptKey];
      if (receipt) { if (receipt.payloadHash !== payloadHash) throw new Error("Idempotency key was already used for different ticket content"); return; }
      const description = [payload.title, ...[["Requirements", payload.requirements], ["Acceptance criteria", payload.acceptanceCriteria], ["Exclusions", payload.exclusions], ["Dependencies", payload.dependencies]].filter(([,items]) => items.length).map(([title, items]) => `## ${title}\n${items.map((item) => `- ${item}`).join("\n")}`), ...(payload.uiImpact ? [`## UI impact\n${payload.uiImpact.level}: ${payload.uiImpact.reason}`] : [])].join("\n\n");
      const ticket = { ...freeTextTicket(description, randomUUID()), title: payload.title };
      const run = createTicketRun(ticket, draft.stageProfiles, { status: "draft", access, proofStorageRoot: dataDir,
        submission: { ...payload, origin, workspaceCwd: before.workspace.cwd }, ...(payload.uiImpact ? { uiImpactProvisional: payload.uiImpact } : {}) });
      for (const stage of run.stages) stage.status = "pending";
      draft.ticketRuns[ticket.id] = run;
      receipt = { ticketId: ticket.id, runId: run.runId, payloadHash, origin, createdAt: new Date().toISOString() };
      draft.orchestratorSubmissions[receiptKey] = receipt;
      created = true;
    });
    return { version: 1, created, ticketId: receipt.ticketId, runId: receipt.runId };
  }

  async function act(ticketId, input, supervisorProject = null) {
    object(input, ["action", "expected", "authority", "input", "requestId"], "decision");
    object(input.expected, ["runId", "checkpointId", "status"], "expected identity");
    text(input.expected.runId, "runId", 200); text(input.expected.status, "status", 100);
    if (input.expected.checkpointId !== null) text(input.expected.checkpointId, "checkpointId", 200);
    object(input.authority, ["mode", "actor", "reason"], "authority");
    if (!["user", "delegated"].includes(input.authority.mode)) throw new Error("Record a relayed user decision or explicit delegation");
    text(input.authority.actor, "authority.actor", 120);
    if (input.authority.mode === "delegated" || input.authority.reason !== undefined) text(input.authority.reason, "delegation reason", 1000);
    const allowed = { start: [], answer: ["answers"], approve: ["auto", "proposalRevision"], "approve-proof": [], "revise-proposal": ["feedback", "proposalRevision"], "revise-proof": ["feedback", "criterionIds"], accept: ["stepId", "auto"], "revise-step": ["stepId", "feedback", "criterionIds"], resume: [] };
    if (!Object.hasOwn(allowed, input.action)) throw new Error("Unknown orchestrator action");
    const payload = input.input || {};
    object(payload, allowed[input.action], "action input");
    if (payload.auto !== undefined && typeof payload.auto !== "boolean") throw new Error("auto must be boolean");
    for (const field of ["feedback", "stepId", "proposalRevision"]) if (payload[field] !== undefined) text(payload[field], field);
    if (payload.answers !== undefined && (typeof payload.answers !== "string" || payload.answers.length > 8000)) throw new Error("answers must be text up to 8000 characters");
    if (payload.criterionIds !== undefined) strings(payload.criterionIds, "criterionIds");
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId))) throw new Error("requestId must be 1–128 letters, digits, underscores or hyphens");
    if (supervisorProject && (!input.requestId || input.authority.mode !== "delegated")) throw new Error("Supervisor requires requestId and delegated authority");
    const snapshot = state.read();
    const run = snapshot.ticketRuns[ticketId];
    const payloadHash = hash([input.action, input.expected.runId, input.expected.status, input.expected.checkpointId, input.authority.mode, input.authority.actor, input.authority.reason || null, allowed[input.action].map((field) => [field, payload[field] ?? null]), supervisorProject]);
    const recorded = [run, ...Object.values(snapshot.retainedRuns || {})].find((item) => item?.id === ticketId && item.runId === input.expected.runId);
    const prior = input.requestId && recorded?.orchestratorDecisions?.find((item) => item.requestId === input.requestId);
    if (prior) {
      if (prior.payloadHash !== payloadHash || (prior.supervisorProject || null) !== supervisorProject) throw new Error("Decision requestId was already used for different content");
      return { ...observe(ticketId, input.expected.runId, supervisorProject), decisionReceipt: { requestId: input.requestId, outcome: "consumed", replayed: true } };
    }
    assertExpected(run, input.expected);
    assertSupervisorDecision(snapshot, run, { ...input, supervisorProject });
    if (!observe(ticketId, run.runId).actions.includes(input.action)) throw new Error("This action is not available at the current checkpoint");
    const context = { id: randomUUID(), ticketId, ...input, input: payload, supervisorProject, payloadHash, claimed: false };
    let replayed = false;
    try { await actionScope.run(context, async () => {
      if (input.action === "start") { if (run.status !== "draft") throw new Error("Only a submitted draft can be started with this action"); await tickets.begin(ticketId, { ticket: run.ticket }); }
      else if (input.action === "answer") await tickets.clarify(ticketId, payload);
      else if (input.action === "approve") await tickets.approvePlan(ticketId, payload);
      else if (input.action === "approve-proof") await tickets.finishHandoff(ticketId);
      else if (input.action === "revise-proposal") await tickets.reviseProposal(ticketId, payload);
      else if (input.action === "revise-proof") await tickets.changeEvidence(ticketId, payload);
      else if (["accept", "revise-step"].includes(input.action)) { text(payload.stepId, "stepId", 200); await tickets.decideStep(ticketId, payload.stepId, input.action === "accept" ? "accept" : "changes", payload); }
      else await tickets.resume(ticketId);
    }); } catch (error) { if (!error.decisionReplay) throw error; replayed = true; }
    return { ...observe(ticketId, input.expected.runId, supervisorProject), ...(input.requestId ? { decisionReceipt: { requestId: input.requestId, outcome: context.claimed || replayed ? "consumed" : "inspect", replayed } } : {}) };
  }
  return { submit, observe, act };
}

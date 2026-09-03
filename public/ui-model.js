export function inspectionSelection(projection, selection = {}) {
  const stages = projection?.stages || [];
  const workers = projection?.workers || [];
  const attempts = projection?.attempts || [];
  const explicitStage = stages.find((item) => item.id === selection.stageId) || null;
  const attempt = attempts.find((item) => item.id === selection.attemptId)
    || attempts.filter((item) => item.workerId === selection.workerId).at(-1)
    || (!selection.stageId && attempts.find((item) => item.id === projection?.focus?.attemptId))
    || null;
  const worker = workers.find((item) => item.id === (attempt?.workerId || selection.workerId))
    || (!selection.stageId && workers.find((item) => item.id === projection?.focus?.workerId))
    || null;
  const stage = stages.find((item) => item.id === (attempt?.stageId || worker?.stageId || selection.stageId))
    || (!selection.stageId && stages.find((item) => item.id === projection?.focus?.stageId))
    || explicitStage;
  return { stageId: stage?.id || null, workerId: worker?.id || null, attemptId: attempt?.id || null };
}

// A durable selection wins while it still exists. Only a missing record follows the
// server-provided focus order (active, actionable, then latest completion).
export function restoreInspectionSelection(projection, selection = {}) {
  const stages = projection?.stages || [];
  const workers = projection?.workers || [];
  const attempts = projection?.attempts || [];
  const hasSelection = Boolean(selection.stageId || selection.workerId || selection.attemptId);
  const retainedAttempt = attempts.find((item) => item.id === selection.attemptId);
  const retainedWorker = workers.find((item) => item.id === selection.workerId);
  const retainedStage = stages.find((item) => item.id === selection.stageId);
  const retained = selection.attemptId ? retainedAttempt : selection.workerId ? retainedWorker : retainedStage;
  const resolved = inspectionSelection(projection, retained ? selection : {});
  return {
    selection: resolved,
    preserved: Boolean(retained),
    disappeared: hasSelection && !retained,
    reason: retained ? "preserved" : projection?.focus?.reason || "empty"
  };
}

export function inspectionTransitionAnnouncement(previous, projection, selection = {}) {
  if (!previous || !projection) return null;
  const previousAttempt = (previous.attempts || []).find((item) => item.id === selection.attemptId);
  const currentAttempt = (projection.attempts || []).find((item) => item.id === selection.attemptId);
  if (previousAttempt && !currentAttempt) return "The selected record is no longer available; the inspector moved to current work.";
  if (previousAttempt && currentAttempt && previousAttempt.lifecycle === "active" && currentAttempt.lifecycle !== "active") {
    return `The selected attempt ${currentAttempt.lifecycle === "completed" ? "completed" : "stopped"}. Retained history is still available.`;
  }
  const previousWorker = (previous.workers || []).find((item) => item.id === selection.workerId);
  const worker = (projection.workers || []).find((item) => item.id === selection.workerId);
  if (previousWorker && worker && previousWorker.attemptIds.at(-1) !== worker.attemptIds.at(-1)) {
    const latest = (projection.attempts || []).find((item) => item.id === worker.attemptIds.at(-1));
    if (latest?.lifecycle === "active") return "A correction attempt started for the selected worker. Earlier attempts remain available.";
  }
  return null;
}

export function inspectionResourceLabel(resource = {}) {
  return ({ available: "Available", loading: "Loading…", unavailable: "Unavailable", not_retained: "Not retained", not_recorded: "Not recorded", not_started: "Not started", not_yet_available: "Not yet available", not_applicable: "Not applicable", truncated: "Truncated" })[resource.state] || "Unavailable";
}

export function inspectionSummary({ worker = null, attempt = null } = {}) {
  const item = attempt || worker;
  if (!item) return { status: "not_started", latestAction: "Not started", blocker: null, evidence: { state: "not_started" }, nextAction: { kind: "none", label: "No action available" } };
  return {
    status: item.status,
    latestAction: item.latestAction || "No activity recorded",
    blocker: item.blocker || null,
    evidence: item.evidence || { state: "not_started" },
    nextAction: item.nextAction || worker?.nextAction || { kind: "none", label: "No action available" }
  };
}

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
  return artifacts.filter((artifact) => artifact.stageId === stageId || (stageId === "verify" && artifact.stageId?.startsWith("review-round-")) || (stageId === "handoff" && artifact.kind === "visual-evidence"));
}

const proofMedia = { png: "image", jpg: "image", jpeg: "image", webp: "image", webm: "video", mp4: "video" };

function proofEvidenceNavigation(run, locator = {}) {
  const ticketId = encodeURIComponent(run?.id || "");
  if (locator.validity && locator.validity !== "valid") return {
    ...locator,
    unavailable: true,
    label: locator.reason ? `Evidence unavailable: ${locator.reason.replaceAll("_", " ")}` : "Evidence unavailable"
  };
  if (["artifact", "media"].includes(locator.type) && locator.artifactId) {
    const artifactId = encodeURIComponent(locator.artifactId);
    return {
      type: locator.type,
      artifactId: locator.artifactId,
      route: `/api/tickets/${ticketId}/artifacts/${artifactId}`,
      mediaUrl: locator.type === "media" ? `/api/tickets/${ticketId}/artifacts/${artifactId}/media` : null,
      label: locator.type === "media" ? "Open media" : "Open artifact"
    };
  }
  if (locator.type === "check" || locator.type === "diff") {
    const params = new URLSearchParams({ scope: locator.scope || "step" });
    if (locator.stepId) params.set("stepId", locator.stepId);
    if (locator.attemptId) params.set("attemptId", locator.attemptId);
    if (locator.reviewId) params.set("reviewId", locator.reviewId);
    const isDiff = locator.type === "diff";
    return {
      ...locator,
      label: isDiff ? (locator.scope === "final" ? "Open final diff" : "Open diff") : "Open check output",
      route: `/api/tickets/${ticketId}/proof/${isDiff ? "diff" : "check-output"}?${params}`,
      tab: isDiff ? "diff" : "run"
    };
  }
  return { ...locator, label: "Evidence unavailable" };
}

function projectedEligibility(criteria) {
  const blockingReasons = criteria.flatMap((criterion) => {
    const current = criterion.current || {};
    if (current.status !== "verified") return [{ criterionId: criterion.id, criterion: criterion.text, code: `status_${current.status || "unresolved"}`, message: current.explanation?.summary || "Criterion is unresolved." }];
    if (current.evidenceValidity !== "valid") return [{ criterionId: criterion.id, criterion: criterion.text, code: `evidence_${current.evidenceValidity || "missing"}`, message: "Criterion evidence is not currently valid." }];
    return [];
  });
  return { eligible: blockingReasons.length === 0, blockingReasons };
}

/** Turns the server's proof projection into ordered, actionable presentation data. */
export function proofMapView(run, { stepId = null, requiredOnly = false } = {}) {
  const proof = run?.proofMap || { criteria: [], compatibility: true };
  const criteria = (proof.criteria || [])
    .filter((criterion) => (!stepId || criterion.stepId === stepId) && (!requiredOnly || criterion.stepRequired !== false))
    .map((criterion) => {
      const current = structuredClone(criterion.current || { status: "not_yet_verified", evidenceValidity: "missing", evidence: [] });
      if (current.status === "unresolved") current.status = "not_yet_verified";
      const state = current.status === "verified" && current.evidenceValidity === "stale" ? "stale"
        : current.status === "verified" && current.evidenceValidity !== "valid" ? "missing-evidence"
          : current.status || "not_yet_verified";
      const resultLabel = ({ verified: "Verified", failed: "Failed", blocked: "Blocked", not_yet_verified: "Not yet verified" })[current.status] || "Not yet verified";
      const evidenceLabel = ({ valid: "Evidence valid", stale: "Evidence stale", missing: "Evidence missing" })[current.evidenceValidity] || "Evidence missing";
      const label = ({ verified: "Verified", failed: "Failed", blocked: "Blocked", not_yet_verified: "Not yet verified", stale: "Stale evidence", "missing-evidence": "Missing evidence" })[state] || resultLabel;
      return {
        ...structuredClone(criterion), current, state, label, resultLabel, evidenceLabel,
        evidence: (current.evidence || []).map((locator) => proofEvidenceNavigation(run, locator)),
        history: (criterion.history || []).map((item) => ({
          ...structuredClone(item),
          status: item.status === "unresolved" ? "not_yet_verified" : item.status,
          evidence: (item.evidence || []).map((locator) => proofEvidenceNavigation(run, locator))
        }))
      };
    });
  return { compatibility: Boolean(proof.compatibility), approvedAt: proof.approvedAt || null, criteria, eligibility: proof.compatibility ? { eligible: true, blockingReasons: [] } : projectedEligibility(criteria) };
}

export function finalReview(run) {
  const extension = (name = "") => String(name).split(".").at(-1).toLowerCase();
  const review = run?.reviews?.at(-1);
  const reviews = review?.reviews || [];
  const checks = reviews.find((item) => item.role === "deterministic")?.checks;
  const proofArtifacts = run?.checkpoint?.kind === "evidence_review" && Array.isArray(run.checkpoint.media) ? run.checkpoint.media : (run?.artifacts || []).filter((artifact) => artifact.kind === "visual-evidence");
  return {
    criteria: proofMapView(run),
    proof: proofArtifacts.map((artifact) => ({
      ...artifact,
      media: proofMedia[extension(artifact.name)] || null,
      mediaUrl: artifact.mediaUrl || (run?.id && run?.runId && artifact.id ? `/api/tickets/${encodeURIComponent(run.id)}/runs/${encodeURIComponent(run.runId)}/artifacts/${encodeURIComponent(artifact.id)}/media` : null)
    })).filter((artifact) => artifact.media),
    checks: checks ? { status: checks.status, summary: checks.summary, command: checks.command } : null,
    reviews: reviews.filter((item) => item.role !== "deterministic").map((item) => ({ role: item.role, summary: item.summary }))
  };
}

export function preferredStepId(plan, currentId) {
  const steps = (plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children : [node]);
  if (steps.some((step) => step.id === currentId)) return currentId;
  return steps.find((step) => ["needs_input", "awaiting_approval"].includes(step.status))?.id || steps.find((step) => step.status === "review_ready")?.id || steps[0]?.id || null;
}

export function preferredStageId(stages = [], currentId) {
  if (stages.some((stage) => stage.id === currentId)) return currentId;
  return stages.find((stage) => ["blocked", "failed", "needs_attention", "paused"].includes(stage.status))?.id || stages.find((stage) => stage.status === "active")?.id || stages.find((stage) => stage.status !== "completed")?.id || stages.at(-1)?.id || null;
}

export function stageDetailModel(run, stageId) {
  const stages = run?.stages || [];
  const stageIndex = stages.findIndex((stage) => stage.id === stageId);
  if (stageIndex < 0) return null;
  const stage = stages[stageIndex];
  const allSteps = flattenPlanSteps(run?.plan);
  const steps = allSteps.filter((step) => (step.stageId || "implement") === stage.id);
  const stepIds = new Set(steps.map((step) => step.id));
  const stepById = new Map(allSteps.map((step) => [step.id, step]));
  const groupChildren = new Map((run?.plan?.nodes || [])
    .filter((node) => node.type === "group")
    .map((group) => [group.id, (group.children || []).filter((step) => step.required !== false).map((step) => step.id)]));
  const dependencies = { internal: [], external: [] };
  const seen = new Set();
  for (const step of steps) for (const dependencyId of step.dependsOn || []) {
    for (const from of groupChildren.get(dependencyId) || [dependencyId]) {
      const key = `${from}:${step.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = stepById.get(from);
      dependencies[stepIds.has(from) ? "internal" : "external"].push({ from, to: step.id, title: source?.title || from, status: source?.status || null });
    }
  }
  return {
    stage: { id: stage.id, title: stage.title, status: stage.status, position: stageIndex + 1, total: stages.length },
    stepIndex: steps.map((step, index) => ({ id: step.id, title: step.title, status: step.status, position: index + 1 })),
    dependencies
  };
}

const cleanupOutcomeCopy = new Set(["running", "not-required", "complete", "incomplete", "unsupported"]);

/**
 * Shapes durable process-containment evidence for the run inspector without
 * reducing unresolved cleanup to a generic worker error.
 */
export function cleanupInspectorModel(run) {
  const cleanup = run?.cleanup || {};
  const executions = Array.isArray(cleanup.executions) ? cleanup.executions.map((execution) => ({
    executionId: String(execution?.executionId || "unknown-execution"),
    outcome: cleanupOutcomeCopy.has(execution?.outcome) ? execution.outcome : "incomplete",
    stepId: execution?.stepId || null,
    attemptId: execution?.attemptId || null,
    ownership: execution?.ownership || null,
    platform: execution?.platform || null,
    startedAt: execution?.startedAt || null,
    completedAt: execution?.completedAt || null,
    triggers: Array.isArray(execution?.triggers) ? execution.triggers : [],
    discovered: Array.isArray(execution?.discovered) ? execution.discovered : [],
    actions: Array.isArray(execution?.actions) ? execution.actions : [],
    unresolved: Array.isArray(execution?.unresolved) ? execution.unresolved : [],
    diagnostics: Array.isArray(execution?.diagnostics) ? execution.diagnostics : []
  })) : [];
  const outcome = cleanupOutcomeCopy.has(cleanup.outcome)
    ? cleanup.outcome
    : executions.some((execution) => execution.outcome === "incomplete") ? "incomplete"
      : executions.some((execution) => execution.outcome === "unsupported") ? "unsupported"
        : executions.some((execution) => execution.outcome === "complete") ? "complete" : "not-required";
  const labels = {
    running: "Cleanup in progress",
    complete: "Cleanup complete",
    incomplete: "Cleanup incomplete",
    unsupported: "Cleanup unsupported",
    "not-required": "No cleanup required"
  };
  return {
    outcome,
    label: labels[outcome],
    advisory: outcome === "incomplete" || outcome === "unsupported",
    updatedAt: cleanup.updatedAt || null,
    executionCount: executions.length,
    executions
  };
}

export function stepInspectorSummary(step) {
  const attempts = step?.attempts || [];
  const latest = [...attempts].reverse().find((attempt) => attempt.verification) || attempts.at(-1);
  const findings = latest?.verification?.findings || [];
  const needsAttention = ["needs_attention", "failed", "interrupted", "cancelled"].includes(step?.status);
  const finding = firstLine(step?.lastError || findings[0]?.claim || findings[0]?.message || (typeof findings[0] === "string" ? findings[0] : "") || latest?.violations?.[0], "The worker needs attention before the workflow can continue.");
  return {
    needsAttention,
    finding,
    findings,
    findingCount: Math.max(findings.length, needsAttention ? 1 : 0),
    criteria: step?.acceptanceCriteria || [],
    artifactCount: step?.artifacts?.length || 0,
    attemptCount: attempts.length
  };
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
  if (tool === "workflow_stage") return firstLine(values.title, "Workflow stage");
  if (tool === "worker_report") {
    const status = values.status ? ` · ${values.status}` : "";
    const summary = firstLine(values.summary);
    return `Worker report${status}${summary ? ` — ${summary}` : ""}`;
  }
  const label = ({ bash: "Command", read: "Read", grep: "Search", find: "Find", ls: "List", edit: "Edit", write: "Write" })[tool] || tool.replaceAll("_", " ");
  const subject = firstLine(values.command || values.cmd || values.path || values.pattern || values.query);
  return subject ? `${label} · ${subject}` : label;
}

function toolStatus(tool, args) {
  if (tool !== "workflow_stage") return null;
  try { return JSON.parse(args || "{}").status || null; } catch { return null; }
}

function phaseNote(title) {
  if (/post-merge repository checks/i.test(title)) return "Proving the integrated result still passes the repository's configured checks before delivery completes.";
  if (/repository checks/i.test(title)) return "Proving this worker's changes pass the repository's configured checks before review.";
  if (/^Verifying /i.test(title)) return "Checking the worker output, diff, and test results against this step's acceptance criteria.";
  if (/supervisor reviewing worker report/i.test(title)) return "Checking the worker's report and diff against the active workflow before accepting the result.";
  if (/drafting the requirement-linked commit/i.test(title)) return "Recording the verified outcome and the requirement it satisfies in the commit history.";
  if (/merge conflicts detected/i.test(title)) return "Reconciling the verified ticket changes with the target branch before integration can continue.";
  if (/automated merge started/i.test(title)) return "Integrating the verified ticket branch into the selected repository.";
  return "";
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
      const item = { key: event.callId || `${event.tool}:${items.length}`, tool: event.tool, title: `${event.actor ? `${event.actor} · ` : ""}${toolTitle(event.tool, event.args)}`, at: event.at, args: event.args || "", output: "", result: "", status: toolStatus(event.tool, event.args) || "running", isError: false };
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
      else Object.assign(item, { result: event.result || "", status: event.isError ? "failed" : toolStatus(item.tool, item.args) || "finished", isError: Boolean(event.isError) });
      continue;
    }
    if (event.type === "agent_error") items.push({ key: `error:${items.length}`, title: `${event.actor ? `${event.actor} · ` : ""}Model request failed`, at: event.at, result: event.label || "Unknown model error", status: "failed", isError: true });
    if (["thinking", "phase"].includes(event.type)) items.push({ key: `reasoning:${items.length}`, title: `Reasoning · ${event.actor ? `${event.actor} · ` : ""}${event.label || "working"}`, at: event.at, result: event.type === "phase" ? event.detail || phaseNote(event.label || "") : "", status: "summary", isError: false });
    if (event.type === "reasoning_summary") items.push({ key: `reasoning:${items.length}`, title: `Reasoning · ${event.actor ? `${event.actor} · ` : ""}${firstLine(event.detail, "summary")}`, at: event.at, result: event.detail || "", status: "summary", isError: false });
  }
  return items.map((item) => ({ ...item, hasDetails: Boolean(item.args || item.output || item.result) }));
}

export function eventGroups(events = [], persistedGroups = []) {
  if (persistedGroups.some((group) => Array.isArray(group.events))) {
    return persistedGroups.map((group, index) => {
      const items = eventTimeline((group.events || []).filter((event) => !["phase", "reasoning_summary", "thinking"].includes(event.type)));
      return {
        key: group.key || `saved:${index}`,
        title: group.title || "Agent activity",
        note: group.note || phaseNote(group.title || ""),
        at: group.at || items[0]?.at || "",
        endedAt: group.endedAt || items.at(-1)?.at || group.at || "",
        items,
        isError: Boolean(group.isError) || group.status === "failed",
        status: group.status || (group.isError ? "failed" : "complete")
      };
    }).filter((group) => group.items.length || group.note || group.title !== "Agent activity");
  }
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

export function recentActivity(events = [], limit = 4) {
  return eventGroups(events).flatMap((group) => group.items).slice(-limit).reverse();
}

function findingDetails(findings) {
  return findings.map((finding, index) => `### Finding ${index + 1} · ${finding.severity || "issue"}\n\n${finding.claim || "Unspecified finding"}${finding.suggestedFix ? `\n\n**Suggested fix:** ${finding.suggestedFix}` : ""}`).join("\n\n");
}

function milestoneText(value, fallback = "") {
  return String(value || fallback).replace(/(^|[\s"'`(])(?:~\/|\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z]:\\[^\s"'`),;]+)/g, "$1[path]");
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
    if (stage.status === "active" && run?.status === "fixing") {
      const findings = run.reviews?.at(-1)?.actionableFindings || [];
      items.push({ title: "Focused correction in progress.", status: "fixing", at: stage.updatedAt, detail: findingDetails(findings) || "Correcting the latest actionable review findings." });
    } else if (stage.status === "active") items.push({ title: `Review round ${(run?.reviews?.length || 0) + 1} started.`, status: "running", at: stage.updatedAt, detail: "Reviewing the combined implementation after the latest fixes." });
    if (stage.status === "completed") items.push({ title: "Agent review completed.", status: "complete", at: stage.updatedAt, detail: stage.summary });
    return items;
  }
  if (stage?.id === "handoff") {
    const items = activity?.startedAt ? [{ title: "Handoff started.", status: "started", at: activity.startedAt, detail: "Preparing the final product-context update and repository integration." }] : [];
    const proposal = (run?.artifacts || []).find((artifact) => artifact.kind === "product-context-update");
    if (proposal) items.push({ title: "Product context update prepared.", status: run.checkpoint?.kind === "product_context_review" ? "awaiting approval" : "approved", at: proposal.createdAt, detail: proposal.content });
    const evidence = (run?.artifacts || []).filter((artifact) => artifact.kind === "visual-evidence");
    if (evidence.length) items.push({
      title: "Visual evidence attached as proof.",
      status: `${evidence.length} shot${evidence.length === 1 ? "" : "s"}`,
      at: evidence.at(-1)?.createdAt,
      detail: evidence.map((shot) => `- \`${shot.name}\``).join("\n")
    });
    const merge = run?.merge;
    if (merge?.queuedAt) items.push({ title: "Added to merge queue.", status: merge.status === "queued" ? `position ${merge.position}` : "started", at: merge.queuedAt, detail: `Target repository selected\n\nTicket branch: \`${merge.branch}\`` });
    if (merge?.startedAt) items.push({ title: "Automated merge started.", status: "merging", at: merge.startedAt, detail: "Git is merging in an isolated integration worktree; the opened repository remains untouched until verification passes." });
    if (merge?.resolverStartedAt) items.push({ title: "Merge conflicts found.", status: `${merge.conflicts?.length || 0} conflict${merge.conflicts?.length === 1 ? "" : "s"}`, at: merge.resolverStartedAt, detail: (merge.conflicts || []).map((file) => `- \`${milestoneText(file)}\``).join("\n") });
    if (merge?.resolverCompletedAt) items.push({ title: "Conflict-resolution agent completed.", status: "resolved", at: merge.resolverCompletedAt, detail: milestoneText(merge.resolutionArtifact?.content, "Conflicts resolved in the isolated integration worktree.") });
    if (merge?.verifiedAt) items.push({ title: "Merged result verified.", status: merge.checks?.status || "passed", at: merge.verifiedAt, detail: milestoneText(merge.checks?.summary, "Repository checks passed.") });
    if (merge?.failedAt) items.push({ title: "Merge queue blocked.", status: "needs attention", at: merge.failedAt, detail: milestoneText(merge.error) });
    if (run?.integration) items.push({ title: "Changes integrated into the working directory.", status: "complete", at: run.integration.integratedAt, detail: `Commit: \`${run.integration.commit}\`` });
    return items;
  }
  return [];
}

export function runHeartbeat(active, live = {}, now = Date.now()) {
  if (!active) return null;
  const saved = active.activity || active;
  const elapsed = Math.max(0, Math.floor((now - Date.parse(active.startedAt || saved.startedAt)) / 1000));
  const idle = Math.max(0, Math.floor((now - Date.parse(live.lastAt || saved.lastEventAt || active.lastEventAt || active.startedAt || saved.startedAt)) / 1000));
  const warning = Boolean(live.warning || saved.warning || active.warning);
  return {
    label: live.label || saved.lastEvent || active.lastEvent || "Agent is running",
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

const youRunStatuses = new Set(["needs_attention", "failed", "interrupted", "paused", "awaiting_approval", "awaiting_evidence_review", "awaiting_input", "awaiting_requirements"]);
const youStepStatuses = new Set(["needs_attention", "failed", "interrupted", "review_ready", "needs_input", "awaiting_approval"]);
const youCheckpointKinds = new Set(["requirements_review", "evidence_review", "awaiting_approval", "needs_input", "technical_input", "step_review", "needs_attention", "product_context_review", "review_blocked"]);
const liveStepStatuses = new Set(["running", "fixing"]);
const railStepStatuses = new Set(["running", "fixing", "needs_attention", "failed", "interrupted", "review_ready", "needs_input", "awaiting_approval", "ready"]);

export function flattenPlanSteps(plan) {
  return (plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children || [] : [node]);
}

export function fleetLane(run) {
  if (!run || ["completed", "cancelled"].includes(run.status)) return "idle";
  const steps = flattenPlanSteps(run.plan);
  if (youRunStatuses.has(run.status) || youCheckpointKinds.has(run.checkpoint?.kind) || steps.some((step) => youStepStatuses.has(step.status))) return "you";
  return "running";
}

function fleetState(run) {
  if (!run) return { tone: "idle", label: "queued" };
  const steps = flattenPlanSteps(run.plan);
  if (steps.some((step) => step.status === "review_ready") || run.checkpoint?.kind === "step_review") return { tone: "rev", label: "review" };
  if (run.checkpoint?.kind === "evidence_review") return { tone: "rev", label: "final review" };
  if (run.checkpoint?.kind === "awaiting_approval" && !run.checkpoint.stepId) return { tone: "gate", label: "plan gate" };
  if (run.status === "awaiting_approval" && !run.checkpoint?.stepId) return { tone: "gate", label: "plan gate" };
  const lane = fleetLane(run);
  if (lane === "you") return { tone: "you", label: ["interrupted", "paused"].includes(run.status) ? run.status : "needs you" };
  if (lane === "running") return { tone: "run", label: "running" };
  return { tone: "idle", label: run.status === "completed" ? "done" : "queued" };
}

function currentStage(run) {
  const stages = run?.stages || [];
  return stages.find((stage) => ["active", "blocked", "paused"].includes(stage.status)) || stages.filter((stage) => stage.status === "completed").at(-1) || null;
}

function lastActivityAt(run) {
  const times = [];
  for (const value of [run?.updatedAt, run?.checkpoint?.createdAt, run?.createdAt]) if (value) times.push(value);
  for (const stage of run?.stages || []) if (stage.updatedAt) times.push(stage.updatedAt);
  for (const step of flattenPlanSteps(run?.plan)) {
    const attempt = step.attempts?.at(-1);
    if (attempt?.completedAt) times.push(attempt.completedAt);
    if (attempt?.startedAt) times.push(attempt.startedAt);
    for (const event of attempt?.events || []) if (event.at) times.push(event.at);
  }
  return times.sort().at(-1) || null;
}

export function formatIdle(iso, now = Date.now(), live = false) {
  if (!iso) return "";
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  const label = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
  return live ? `live ${label}` : `${label} idle`;
}

function agentProgress(status) {
  if (status === "accepted") return 100;
  if (status === "review_ready") return 84;
  if (["needs_attention", "failed", "interrupted"].includes(status)) return 70;
  if (liveStepStatuses.has(status)) return 60;
  if (status === "awaiting_approval" || status === "needs_input") return 50;
  return 16;
}

function agentTone(status) {
  if (["needs_attention", "failed", "interrupted"].includes(status)) return "you";
  if (status === "review_ready") return "rev";
  if (status === "awaiting_approval" || status === "needs_input") return "gate";
  if (liveStepStatuses.has(status)) return "run";
  return "idle";
}

function agentName(step) {
  return String(step.agentId || "").replace(/^worker:/, "") || String(step.title || step.id || "agent").split(/\s+/).at(-1).toLowerCase();
}

function agentMeta(step) {
  const attempts = step.attempts?.length || 0;
  if (["needs_attention", "failed", "fixing"].includes(step.status) && attempts) return `${attempts} att`;
  if (liveStepStatuses.has(step.status)) return "live";
  if (step.status === "review_ready") return "ready";
  if (step.status === "awaiting_approval") return "gate";
  if (step.status === "ready") return "queued";
  return step.status.replaceAll("_", " ");
}

export function fleetTicketView(ticket, run, { selected = false, now = Date.now() } = {}) {
  const state = fleetState(run);
  const lane = fleetLane(run);
  const stage = currentStage(run);
  const steps = flattenPlanSteps(run?.plan).filter((step) => railStepStatuses.has(step.status));
  const focus = steps.filter((step) => step.status !== "ready");
  const live = lane === "running" || steps.some((step) => liveStepStatuses.has(step.status));
  const nested = selected && focus.length ? steps : [];
  return {
    id: ticket.id,
    lane,
    tone: state.tone,
    stateLabel: state.label,
    selected,
    stageLabel: stage?.id || (run ? "queued" : "idle"),
    agentCount: steps.length,
    idle: formatIdle(lastActivityAt(run), now, live && lane === "running"),
    stages: (run?.stages || []).map((item) => ({
      id: item.id,
      kind: item.status === "completed" ? "done" : item.status === "active" || item.status === "blocked" ? "now" : "pending"
    })),
    agents: nested.map((step) => ({
      id: step.id,
      name: agentName(step),
      tone: agentTone(step.status),
      progress: agentProgress(step.status),
      meta: agentMeta(step)
    }))
  };
}

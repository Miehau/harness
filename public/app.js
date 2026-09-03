import { renderMarkdown } from "/markdown.js";
import { artifactsForStage, cleanupInspectorModel, eventGroups, executionGraph, finalReview, fleetTicketView, formatOutput, freeTextTicket, inspectionResourceLabel, inspectionSummary, inspectionTransitionAnnouncement, parseDiff, preferredStageId, preferredStepId, proofMapView, restartOptions, restoreInspectionSelection, reviewNotesForRows, runHeartbeat, runMetrics, stageDetailModel, stageMilestones, stepInspectorSummary } from "/ui-model.js";

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

let state = null;
let ticketSources = { configured: false, viewer: null, sources: [], tickets: [] };
let piModels = [];
const viewVersion = 4;
let savedView = {};
try { savedView = JSON.parse(localStorage.getItem("agent-plan-view") || "{}"); } catch {}
const currentView = savedView.version === viewVersion;
// Saved selection is intentionally not restored: the first inspection must follow
// current work, not a potentially stale accepted or blocked record from a past visit.
let selectedStepId = null;
let selectedStageId = null;
let selectedStageKey = null;
let selectedWorkerId = null;
let selectedAttemptId = null;
let selectedRunId = null;
let activeTab = currentView && ["activity", "details", "overview", "run", "diff", "artifacts", "ticket", "prompt", "output", "checks", "trace", "cleanup"].includes(savedView.activeTab) ? savedView.activeTab : "activity";
let selectedArtifactId = null;
let deliberateSelection = false;
let transportState = "connected";
let transportTimer = null;
let hasConnected = false;
let diffExpanded = false;
let toastTimer;
let clearTimer;
let clearArmed = false;
let forgetTimer;
let forgetArmed = null;
let cleanupArmed = false;
let retention = { items: [], totalBytes: 0 };
let trackerSettings = null;
let pendingTicketSelections = 0;
let latestTicketSelection = 0;
let lastClarificationKey = null;
const liveRuns = new Map();
const liveStages = new Map();
const sessionTraces = new Map();
const stagePromptTraces = new Map();
const appendLiveOutput = (value, delta) => `${value || ""}${delta || ""}`.slice(-100000);
const pendingSessionTraces = new Set();
const pendingStagePromptTraces = new Set();
const diffModels = new Map();
const inspections = new Map();
const pendingInspections = new Set();
const attemptDetails = new Map();
const pendingAttemptDetails = new Set();
const profileIds = ["requirements", "exploration", "architecture", "implementation", "verification", "commit", "handoff"];
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function rememberView() {
  localStorage.setItem("agent-plan-view", JSON.stringify({ version: viewVersion, ticketId: state?.selectedTicketId || null, selectedStepId, selectedStageId, selectedStageKey, selectedWorkerId, selectedAttemptId, selectedRunId, activeTab }));
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed: ${response.status}`);
  return result;
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
}

function renderProfiles() {
  const cards = profileIds.map((id) => {
    const profile = state.stageProfiles[id];
    const label = escapeHtml(profile.label);
    const models = piModels.some((model) => model.id === profile.model) ? piModels : [{ id: profile.model, name: profile.model }, ...piModels];
    return `<fieldset class="profile-card" data-profile="${id}"><legend>${label}</legend><label for="${id}-model">Model<select id="${id}-model" name="${id}-model" required>${models.map((model) => `<option value="${escapeHtml(model.id)}" ${profile.model === model.id ? "selected" : ""}>${escapeHtml(model.name || model.id)}</option>`).join("")}</select></label><label for="${id}-thinking">Reasoning<select id="${id}-thinking" name="${id}-thinking">${thinkingLevels.map((level) => `<option value="${level}" ${profile.thinking === level ? "selected" : ""}>${level === "off" ? "none" : level}</option>`).join("")}</select></label><label class="profile-prompt" for="${id}-prompt">Agent instructions<textarea id="${id}-prompt" name="${id}-prompt" rows="5">${escapeHtml(profile.prompt)}</textarea></label></fieldset>`;
  }).join("");
  $("#profile-fields").innerHTML = cards;
  $("#project-mode").value = state.settings?.projectMode || "manual";
  $("#poll-interval-seconds").value = state.settings?.pollIntervalSeconds || 60;
  const providers = [...new Set(piModels.map((model) => model.provider).filter(Boolean))];
  const providerLabel = document.querySelector(".profiles-provider");
  if (providerLabel) providerLabel.textContent = providers.length ? `Provider: ${providers.join(", ")}` : "Pi models";
}

function runIdentity(run) { return run?.id && run?.runId ? `${run.id}:${run.runId}` : null; }
function runsForTicket(id) {
  if (!id) return [];
  const current = state?.ticketRuns?.[id];
  return [
    ...(current ? [current] : []),
    ...Object.values(state?.retainedRuns || {}).filter((run) => run.id === id && run.runId !== current?.runId)
  ];
}
function runFor(id = state?.selectedTicketId) {
  const runs = runsForTicket(id);
  return runs.find((run) => run.runId === selectedRunId) || runs[0] || null;
}
function isArchivedRun(run) { return Boolean(run && state?.ticketRuns?.[run.id]?.runId !== run.runId); }
function sameRun(left, right) { return runIdentity(left) === runIdentity(right); }
function selectedTicket() { return ticketSources.tickets.find((ticket) => ticket.id === state?.selectedTicketId) || runFor()?.ticket || null; }
function flattenSteps(plan = runFor()?.plan) { return (plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children : [node]); }
function nodeById(id, plan = runFor()?.plan) {
  for (const node of plan?.nodes || []) {
    if (node.id === id) return node;
    const child = node.children?.find((item) => item.id === id);
    if (child) return child;
  }
  return null;
}

function inspectionFor(run = runFor()) {
  return run ? inspections.get(runIdentity(run))?.projection || null : null;
}

function inspectionAttempt(id, projection = inspectionFor()) {
  return projection?.attempts?.find((item) => item.id === id) || null;
}

function inspectionWorker(id, projection = inspectionFor()) {
  return projection?.workers?.find((item) => item.id === id) || null;
}

function canonicalSelection() {
  return {
    stageId: selectedStageKey || (selectedStageId && `stage:${selectedStageId}`),
    workerId: selectedWorkerId || (selectedStepId && `worker:${selectedStepId}`),
    attemptId: selectedAttemptId
  };
}

function syncInspectionSelection(projection = inspectionFor(), previous = null) {
  const before = canonicalSelection();
  const restored = restoreInspectionSelection(projection, deliberateSelection ? before : {});
  const selected = restored.selection;
  selectedWorkerId = selected.workerId;
  selectedAttemptId = selected.attemptId;
  selectedRunId = projection?.runId || null;
  if (selected.workerId) selectedStepId = inspectionWorker(selected.workerId, projection)?.stepId || null;
  else selectedStepId = null;
  if (selected.stageId) { selectedStageKey = selected.stageId; selectedStageId = selected.stageId.replace(/^stage:/, ""); }
  else { selectedStageKey = null; selectedStageId = null; }
  if (restored.disappeared) {
    deliberateSelection = false;
    notify("The selected record is no longer available; showing current work.");
  }
  const announcement = inspectionTransitionAnnouncement(previous, projection, before);
  if (announcement && !restored.disappeared) notify(announcement);
}

function loadInspection(run = runFor()) {
  const key = runIdentity(run);
  if (!run || pendingInspections.has(key) || inspections.get(key)?.revision === state?.revision) return;
  pendingInspections.add(key);
  const path = isArchivedRun(run)
    ? `/api/tickets/${encodeURIComponent(run.id)}/runs/${encodeURIComponent(run.runId)}/inspection`
    : `/api/tickets/${encodeURIComponent(run.id)}/inspection`;
  api(path).then((projection) => {
    const previous = inspections.get(key)?.projection || null;
    inspections.set(key, { revision: projection.revision, projection });
    if (sameRun(run, runFor())) { syncInspectionSelection(projection, previous); rememberView(); render(); }
  }).catch((error) => {
    inspections.set(key, { revision: state?.revision, error: error.message, projection: null });
    if (sameRun(run, runFor())) renderInspector();
  }).finally(() => pendingInspections.delete(key));
}

function attemptDetailKey(run, attempt) {
  return JSON.stringify([run.id, run.runId, attempt.workerId, attempt.attemptId]);
}

function loadAttemptDetails(run, attempt) {
  if (!run || !run.runId || !attempt?.attemptId) return;
  const key = attemptDetailKey(run, attempt);
  if (pendingAttemptDetails.has(key) || attemptDetails.has(key)) return;
  pendingAttemptDetails.add(key);
  api(`/api/tickets/${encodeURIComponent(run.id)}/runs/${encodeURIComponent(run.runId)}/steps/${encodeURIComponent(attempt.workerId.replace(/^worker:/, ""))}/attempts/${encodeURIComponent(attempt.attemptId)}/details`)
    .then((detail) => { attemptDetails.set(key, { detail }); if (sameRun(run, runFor()) && attempt.id === selectedAttemptId) renderInspector(); })
    .catch((error) => { attemptDetails.set(key, { error: error.message }); if (sameRun(run, runFor()) && attempt.id === selectedAttemptId) renderInspector(); })
    .finally(() => pendingAttemptDetails.delete(key));
}

function statusIcon(status) {
  return ({ completed: "✓", accepted: "✓", active: "↻", running: "↻", fixing: "↻", pending: "○", blocked: "?", review_ready: "◉", awaiting_approval: "◉", needs_input: "?", failed: "×", needs_attention: "!", interrupted: "!", paused: "Ⅱ", cancelled: "×", ready: "•" })[status] || "·";
}

function statusLabel(run) {
  if (!run) return "not started";
  return run.status.replaceAll("_", " ");
}

function transportLabel() {
  return transportState === "connected" ? "Live updates connected" : transportState === "stale"
    ? "Live updates stale — reconnecting; workflow is not failed" : "Live updates disconnected — reconnecting; workflow is not failed";
}

function inspectorTabs(tabs, selected) {
  return `<nav class="tabs inspector-tabs" role="tablist" aria-label="Inspector sections">${tabs.map(([id, label]) => `<button class="tab ${selected === id ? "active" : ""}" type="button" role="tab" aria-selected="${selected === id}" aria-controls="inspector-panel" tabindex="${selected === id ? "0" : "-1"}" data-tab="${id}">${label}</button>`).join("")}</nav>`;
}

function inspectorPanel(content) {
  return `<div id="inspector-panel" class="tab-panel" role="tabpanel" tabindex="0">${content}</div>`;
}

function compactNumber(value) { return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value || 0); }
function byteSize(value) { return value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(1)} GB`; }
function duration(value) { const hours = Math.floor(value / 3600); const minutes = Math.floor((value % 3600) / 60); return hours ? `${hours}h ${minutes}m` : `${minutes}m`; }

function renderRetention() {
  const target = $("#retention-list");
  $("#retention-total").textContent = `${retention.items.length} retained · ${byteSize(retention.totalBytes)}`;
  const projects = [...new Set(retention.items.map((item) => item.project))];
  $("#retention-project").innerHTML = `<option value="">Any project</option>${projects.map((project) => `<option>${escapeHtml(project)}</option>`).join("")}`;
  target.innerHTML = retention.items.length ? retention.items.map((item) => `<label class="retention-row"><input type="checkbox" data-retention-ticket="${escapeHtml(item.ticketId)}"><span><strong>${escapeHtml(item.identifier)} · ${escapeHtml(item.title)}</strong><small>${escapeHtml(item.project)} · ${escapeHtml(item.status)} · ${item.archived ? "archived" : "in queue"} · ${item.artifactCount} artifacts</small></span><b>${byteSize(item.bytes)}</b></label>`).join("") : `<div class="retention-empty">No retained runs.</div>`;
  $("#cleanup-retention").disabled = true;
}

async function openRetention() {
  retention = await api("/api/retention");
  cleanupArmed = false;
  $("#cleanup-retention").textContent = "Clean selected";
  renderRetention();
  $("#retention-dialog").showModal();
}

async function openTrackerSettings() {
  trackerSettings = await api("/api/tracker-settings");
  const form = $("#tracker-form");
  form.reset();
  form.elements.jiraBaseUrl.value = trackerSettings.jira.baseUrl;
  form.elements.jiraEmail.value = trackerSettings.jira.email;
  form.elements.jiraEpicKey.value = trackerSettings.jira.epicKey;
  $("#linear-credential-status").textContent = trackerSettings.linear.configured ? (trackerSettings.linear.stored ? "saved" : "from environment") : "not configured";
  $("#jira-credential-status").textContent = trackerSettings.jira.configured ? (trackerSettings.jira.stored ? "saved" : "from environment") : "not configured";
  $("#tracker-dialog").showModal();
}

function renderTrackerStatus() {
  const button = $("#tracker-settings");
  if (!button) return;
  if (!ticketSources.configured) {
    button.textContent = "Trackers";
    return;
  }
  const errors = ticketSources.sources.filter((source) => source.error).map((source) => `${source.provider}: ${source.error}`);
  button.textContent = errors.length ? "Trackers · error" : `${ticketSources.tickets.length} tracker${ticketSources.tickets.length === 1 ? "" : "s"}`;
}

function ticketCard(ticket) {
  const run = runFor(ticket.id);
  const view = fleetTicketView(ticket, run, { selected: ticket.id === state.selectedTicketId });
  const stages = view.stages.map((stage) => `<i class="${stage.kind}${stage.kind === "now" ? ` ${view.tone}` : ""}"></i>`).join("");
  const agents = view.agents.map((agent) => `<button class="rail-agent ${agent.id === selectedStepId ? "on" : ""}" type="button" data-rail-step="${escapeHtml(agent.id)}" data-ticket="${escapeHtml(ticket.id)}"><span class="dot ${agent.tone} ${agent.tone === "run" ? "pulse" : ""}"></span><span>${escapeHtml(agent.name)}<span class="bar ${agent.tone}"><i style="width:${agent.progress}%"></i></span></span><span>${escapeHtml(agent.meta)}</span></button>`).join("");
  return `<article class="ticket-card tone-${view.tone} ${view.selected ? "selected" : ""}">
    <button class="ticket-main" type="button" data-ticket="${escapeHtml(ticket.id)}">
      <span class="ticket-row"><span class="dot ${view.tone}"></span><b>${escapeHtml(ticket.identifier)}</b><span class="st ${view.tone}">${escapeHtml(view.stateLabel)}</span></span>
      <strong>${escapeHtml(ticket.title)}</strong>
      ${view.stages.length ? `<span class="stage-cells">${stages}</span>` : ""}
      <span class="ticket-meta"><span>${escapeHtml(view.stageLabel)}${view.agentCount ? ` · ${view.agentCount} agent${view.agentCount === 1 ? "" : "s"}` : ""}</span><span>${escapeHtml(view.idle)}</span></span>
    </button>
    ${run && !view.live ? `<div class="ticket-actions"><button class="text-button" type="button" data-forget-ticket="${escapeHtml(ticket.id)}">Forget run</button></div>` : ""}
    ${agents ? `<div class="rail-agents">${agents}</div>` : ""}
  </article>`;
}

function queueTickets() {
  const byId = new Map();
  for (const ticket of ticketSources.tickets) byId.set(ticket.id, ticket);
  for (const run of [...Object.values(state.ticketRuns || {}), ...Object.values(state.retainedRuns || {})]) if (run.ticket) byId.set(run.ticket.id, run.ticket);
  return [...byId.values()];
}

function renderTickets() {
  renderTrackerStatus();
  const query = $("#ticket-search").value.trim().toLowerCase();
  const tickets = queueTickets().filter((ticket) => `${ticket.identifier} ${ticket.title}`.toLowerCase().includes(query));
  const groups = [
    ["you", "Needs you"],
    ["running", "Running"],
    ["idle", "Idle / queued"]
  ].map(([lane, label]) => {
    const items = tickets.filter((ticket) => fleetTicketView(ticket, runFor(ticket.id)).lane === lane);
    return { lane, label, items };
  }).filter((group) => group.items.length);
  const empty = ticketSources.configured
    ? `<div class="ticket-empty large">No tickets match. <kbd>n</kbd> new task.</div>`
    : `<div class="ticket-empty large">No tickets — <kbd>n</kbd> new task · configure trackers.</div>`;
  $("#ticket-list").innerHTML = groups.length
    ? groups.map((group) => `<section class="ticket-group"><header><span>${group.label}</span><b>${group.items.length}</b></header>${group.items.map(ticketCard).join("")}</section>`).join("")
    : empty;
  $("#run-capacity").textContent = `${Object.values(state.ticketRuns || {}).filter((run) => !["completed", "failed", "needs_attention", "cancelled", "interrupted", "paused"].includes(run.status)).length} running`;
}

function workflowStageName(stage) {
  return ({ requirements: "Clarify", explore: "Explore", design: "Plan", implement: "Implement", verify: "Verify", handoff: "Handoff" })[stage.id] || stage.title;
}

function workflowStateLabel(status) {
  return ({ completed: "done", active: "running", pending: "waiting", blocked: "needs input", failed: "error", needs_attention: "needs input" })[status] || status.replaceAll("_", " ");
}

function stagesHtml(run) {
  if (!run) return "";
  const projected = inspectionFor(run)?.stages;
  const stages = projected?.map((stage) => ({ ...stage, id: stage.stageId, displayStatus: stage.lifecycle })) || run.stages;
  const selectedStage = selectedStageKey || (selectedStageId && `stage:${selectedStageId}`);
  const hasSelectedStage = stages.some((stage) => `stage:${stage.id}` === selectedStage);
  return `<section class="workflow-stages"><header><span class="eyebrow">Workflow map</span><span class="stage-count">${stages.filter((stage) => (stage.displayStatus || stage.status) === "completed").length}/${stages.length} complete</span></header><ol role="tablist" aria-label="Workflow stages">${stages.map((stage, index) => { const status = stage.displayStatus || stage.status; const selected = `stage:${stage.id}` === selectedStage; return `<li class="stage-${escapeHtml(status)} ${selected ? "selected" : ""}"><button class="workflow-stage" type="button" role="tab" aria-selected="${selected}" aria-controls="inspector" tabindex="${selected || (!hasSelectedStage && index === 0) ? "0" : "-1"}" data-stage="${escapeHtml(stage.id)}" title="${escapeHtml(stage.title)}"><span class="stage-marker" aria-hidden="true">${statusIcon(status)}</span><span class="stage-copy"><strong><em>${index + 1}.</em>${escapeHtml(workflowStageName(stage))}</strong><small>${escapeHtml(workflowStateLabel(status))}</small></span></button></li>`; }).join("")}</ol></section>`;
}

function clarificationHistoryHtml(run) {
  const history = run?.clarificationHistory || [];
  if (!history.length) return "";
  return `<section class="clarification-thread" aria-label="Chat history"><span class="eyebrow">Chat history</span>${history.map((item) => {
    const questions = item.questions?.length ? `<ol>${item.questions.map((question) => `<li>${escapeHtml(question)}</li>`).join("")}</ol>` : `<p>${escapeHtml(item.title || "Approval requested")}</p>`;
    return `<div class="chat-message agent"><strong>Agent</strong>${questions}</div><div class="chat-message user"><strong>You</strong><p>${escapeHtml(item.answer || "Approved without changes.")}</p></div>`;
  }).join("")}</section>`;
}

function checkpointHtml(run) {
  const checkpoint = run?.checkpoint;
  const history = clarificationHistoryHtml(run);
  if (!checkpoint) return history ? `${history}<div class="clarification-replying" role="status"><span></span>Agent is replying…</div>` : "";
  if (checkpoint.kind === "requirements_review") {
    const questions = checkpoint.questions || [];
    return `${history}<form class="checkpoint clarification" data-clarify="${escapeHtml(run.id)}" data-checkpoint-id="${escapeHtml(checkpoint.id)}"><div class="checkpoint-icon">?</div><div class="checkpoint-copy"><span class="eyebrow">Requirements gate · repository not accessed</span><strong>${escapeHtml(checkpoint.title)}</strong><details class="requirements-contract" open><summary>Review requirements contract</summary><div class="artifact-body">${renderMarkdown(checkpoint.prompt || "")}</div></details>${questions.map((question, index) => `<label>${index + 1}. ${escapeHtml(question)}<textarea name="answer-${index}" rows="2" required></textarea></label>`).join("")}${questions.length ? "" : `<label>Optional correction<textarea name="answer-0" rows="2" placeholder="Approve as written, or add a correction…"></textarea></label>`}</div><button class="button success" type="submit">${questions.length ? "Send answers" : "Approve requirements"}</button></form>`;
  }
  if (["needs_input", "technical_input"].includes(checkpoint.kind)) {
    const questions = checkpoint.questions?.length ? checkpoint.questions : [checkpoint.prompt || "How should this continue?"];
    const eyebrow = checkpoint.stepId ? "Worker decision gate" : checkpoint.source === "supervisor" ? "Supervisor workflow gate" : "Technical decision gate";
    return `<form class="checkpoint clarification" data-clarify="${escapeHtml(run.id)}" data-checkpoint-id="${escapeHtml(checkpoint.id)}"><div class="checkpoint-icon">?</div><div class="checkpoint-copy"><span class="eyebrow">${eyebrow}</span><strong>${escapeHtml(checkpoint.title)}</strong>${questions.map((question, index) => `<label>${index + 1}. ${escapeHtml(question)}<textarea name="answer-${index}" rows="2" required></textarea></label>`).join("")}</div><button class="button primary" type="submit">Continue</button></form>`;
  }
  if (checkpoint.kind === "awaiting_approval" && (checkpoint.stepId || checkpoint.source === "supervisor")) {
    const questions = checkpoint.questions || [];
    const eyebrow = checkpoint.stepId ? "Worker approval gate" : "Supervisor workflow gate";
    return `<form class="checkpoint clarification" data-clarify="${escapeHtml(run.id)}" data-checkpoint-id="${escapeHtml(checkpoint.id)}"><div class="checkpoint-icon">✓</div><div class="checkpoint-copy"><span class="eyebrow">${eyebrow}</span><strong>${escapeHtml(checkpoint.title)}</strong>${checkpoint.prompt ? `<p>${escapeHtml(checkpoint.prompt)}</p>` : ""}${questions.map((question, index) => `<label>${index + 1}. ${escapeHtml(question)}<textarea name="answer-${index}" rows="2" required></textarea></label>`).join("")}${questions.length ? "" : `<label>Optional note<textarea name="answer-0" rows="2" placeholder="Approve as written, or add a note…"></textarea></label>`}</div><button class="button success" type="submit">Approve</button></form>`;
  }
  if (checkpoint.kind === "step_review") {
    return "";
  }
  if (checkpoint.kind === "evidence_review") {
    const review = finalReview(run);
    const proof = review.proof.map((artifact) => {
      const url = artifact.url || artifact.mediaUrl;
      const media = url && artifact.media === "image" ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(artifact.name)}">` : url && artifact.media === "video" ? `<video controls preload="metadata" aria-label="${escapeHtml(artifact.name)}"><source src="${escapeHtml(url)}"></video>` : "";
      const preview = media && url && artifact.media === "image" ? `<a class="proof-preview" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="Open and zoom ${escapeHtml(artifact.name)}">${media}</a>` : media;
      const actions = url ? `<span class="proof-actions"><a class="button" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open / zoom</a>${artifact.id ? `<button class="button" type="button" data-open-artifact="${escapeHtml(artifact.id)}">Default app ↗</button>` : ""}</span>` : "";
      return `<figure class="proof-item">${preview || `<div class="proof-unavailable">Preview unavailable</div>`}<figcaption><strong>${escapeHtml(artifact.name)}</strong>${artifact.summary ? `<span>${escapeHtml(artifact.summary)}</span>` : ""}${!url ? `<small>Media URL unavailable</small>` : ""}${actions}</figcaption></figure>`;
    }).join("") || `<div class="run-empty">No supported visual proof was attached.</div>`;
    const checks = review.checks ? `<section class="final-review-summary"><span class="eyebrow">Automated checks</span><strong class="status-${escapeHtml(review.checks.status || "completed")}">${escapeHtml(review.checks.status || "completed")}</strong><p>${escapeHtml(review.checks.summary || review.checks.command || "Completed")}</p></section>` : "";
    const reviews = review.reviews.length ? `<section class="final-review-summary"><span class="eyebrow">Independent review</span>${review.reviews.map((item) => `<p><strong>${escapeHtml(item.role)}</strong> ${escapeHtml(item.summary || "Completed")}</p>`).join("")}</section>` : "";
    return `<section class="final-review" aria-labelledby="final-review-title"><header><span class="eyebrow">Final proof review</span><h2 id="final-review-title">${escapeHtml(checkpoint.title || "Review proof before delivery")}</h2><p>Review the delivered experience and final verification before approving delivery.</p></header><section class="proof-gallery" aria-label="Visual proof">${proof}</section>${criterionProofHtml(run)}${checks || reviews ? `<div class="final-review-summaries">${checks}${reviews}</div>` : ""}<footer><details class="review-feedback"><summary>Request changes</summary><form data-request-evidence-changes="${escapeHtml(run.id)}"><textarea name="feedback" rows="3" placeholder="Describe what the proof shows should change…" required></textarea>${correctionCriterionPicker(run)}<button class="button" type="submit">Send changes</button></form></details><button class="button success" type="button" data-approve-evidence="${escapeHtml(run.id)}" ${review.criteria.eligibility.eligible ? "" : "disabled"}>Approve &amp; deliver</button></footer></section>`;
  }
  if (checkpoint.kind === "product_context_review") {
    return `<div class="checkpoint"><div class="checkpoint-icon">✓</div><div class="checkpoint-copy"><span class="eyebrow">Product-context gate</span><strong>${escapeHtml(checkpoint.title)}</strong><details class="requirements-contract"><summary>Review proposed PRD and capability update</summary><div class="artifact-body">${renderMarkdown(checkpoint.prompt || "")}</div></details></div><button class="button success" type="button" data-approve-context="${escapeHtml(run.id)}">Approve & complete</button></div>`;
  }
  if (checkpoint.kind === "review_blocked") {
    return `<div class="checkpoint"><div class="checkpoint-icon">!</div><div class="checkpoint-copy"><span class="eyebrow">Final review blocked</span><strong>${escapeHtml(checkpoint.title)}</strong><p>${checkpoint.findings?.length || 0} blocking finding${checkpoint.findings?.length === 1 ? "" : "s"} require human attention.</p></div></div>`;
  }
  return `<div class="checkpoint"><div class="checkpoint-icon">✓</div><div class="checkpoint-copy"><span class="eyebrow">Plan approval gate</span><strong>${escapeHtml(checkpoint.title)}</strong><p>Manual pauses at every verified batch. Auto accepts verified commits and runs the whole graph.</p></div><div class="checkpoint-actions"><button class="button" type="button" data-edit-plan="${escapeHtml(run.id)}">Edit graph JSON</button><button class="button" type="button" data-approve-ticket="${escapeHtml(run.id)}">Run manually</button><button class="button success" type="button" data-auto-ticket="${escapeHtml(run.id)}">Auto run graph</button></div></div>`;
}

function workflowCheckpointsHtml(run) {
  const pending = (run?.workflow?.checkpoints || []).filter((checkpoint) => checkpoint.status === "pending" && checkpoint.blocking === false && checkpoint.id !== run?.checkpoint?.id);
  if (!pending.length) return "";
  return `<div class="checkpoint-list">${pending.map((checkpoint) => {
    const needsInput = checkpoint.kind === "needs_input";
    return `<form class="checkpoint clarification" data-continue-workflow="${escapeHtml(run.id)}" data-checkpoint-id="${escapeHtml(checkpoint.id)}"><div class="checkpoint-icon">${needsInput ? "?" : "✓"}</div><div class="checkpoint-copy"><span class="eyebrow">Supervisor workflow gate</span><strong>${escapeHtml(checkpoint.title)}</strong><p>${escapeHtml(checkpoint.prompt || "")}</p>${needsInput ? `<label>Response<textarea name="response" rows="2" required></textarea></label>` : ""}</div><button class="button ${needsInput ? "primary" : "success"}" type="submit">${needsInput ? "Continue" : "Approve"}</button></form>`;
  }).join("")}</div>`;
}

function checkpointUsesWorkspace(run) {
  return ["requirements_review", "evidence_review"].includes(run?.checkpoint?.kind)
    || Boolean(run?.clarificationHistory?.length && run.status === "clarifying");
}

function renderHeader() {
  const target = $("#ticket-header");
  const ticket = selectedTicket();
  const run = runFor();
  if (!ticket) {
    target.innerHTML = `<div class="plan-heading"><div><span class="eyebrow">No ticket selected</span><h2>Load a local fixture or choose tracker work</h2><p>Local fixtures start from an empty repository and use their authored ticket graph.</p></div></div>`;
    return;
  }
  const preview = Object.values(run?.previews || {}).at(-1);
  const metrics = runMetrics(run);
  const restartPoints = restartOptions(run);
  const restartable = run && !["preparing", "clarifying", "exploring", "planning", "running", "fixing", "verifying", "reviewing", "queued_for_merge", "merging", "resolving_conflicts", "verifying_merge", "rebasing", "waiting_for_checks", "addressing_feedback", "waiting_for_merge", "completed"].includes(run.status) && !run.merge && !run.integration;
  const usage = run ? `<span class="usage-strip"><span>${duration(metrics.durationSeconds)}</span><span>${metrics.calls} calls</span><span>${compactNumber(metrics.input + metrics.cacheRead + metrics.cacheWrite)} in</span><span>${compactNumber(metrics.output)} out</span><span>${metrics.correctionRounds} corrections</span></span>` : "";
  const action = isArchivedRun(run)
    ? `<span class="run-pill">archived · inspection only</span>`
    : !run
      ? `<button class="button primary" data-start-ticket="${escapeHtml(ticket.id)}">Start workflow</button>`
    : `${["interrupted", "cancelled", "needs_attention", "failed", "paused"].includes(run.status) && !run.checkpoint && (run.plan || run.stages?.some((stage) => ["active", "blocked", "paused"].includes(stage.status) && ["requirements", "explore", "design"].includes(stage.id))) ? `<button class="button primary" data-resume-ticket="${escapeHtml(run.id)}">Resume run</button>` : ""}${restartable && restartPoints.length ? `<button class="button" data-restart-ticket="${escapeHtml(run.id)}">Restart from…</button>` : ""}${restartable ? `<button class="button danger" data-start-fresh="${escapeHtml(run.id)}">Start fresh</button>` : ""}${["preparing", "clarifying", "exploring", "planning", "running", "fixing", "verifying", "reviewing"].includes(run.status) ? `<button class="button" data-pause-ticket="${escapeHtml(run.id)}">Pause run</button><button class="button danger" data-cancel-ticket="${escapeHtml(run.id)}">Cancel run</button>` : ""}${run.auto ? `<span class="run-pill">auto</span>` : ""}<span class="run-pill status-${escapeHtml(run.status)}">${escapeHtml(statusLabel(run))}</span>${preview?.status === "stopped" ? `<span class="branch-pill">preview stopped</span>` : preview ? `<a class="branch-pill" href="${escapeHtml(preview.url)}" target="_blank" rel="noreferrer">preview :${preview.port} ↗</a>` : ""}${run.merge?.change?.url ? `<a class="branch-pill" href="${escapeHtml(run.merge.change.url)}" target="_blank" rel="noreferrer">remote review ↗</a>` : run.workspace?.branch?.trim() ? `<span class="branch-pill">${escapeHtml(run.workspace.branch)}</span>` : ""}`;
  const reviewAction = !isArchivedRun(run) && run?.checkpoint?.kind === "step_review"
    ? `<button class="button primary" type="button" data-select-step="${escapeHtml(run.checkpoint.stepId)}">Review step</button>`
    : "";
  const restartAudit = run?.restartHistory?.at(-1);
  const restartBanner = restartAudit
    ? `<div class="recovery-banner"><strong>Restarted from ${escapeHtml(restartAudit.target.replace(":", " · "))}</strong><span>${escapeHtml(new Date(restartAudit.at).toLocaleString())} · audit ${escapeHtml(restartAudit.id)}</span></div>`
    : run?.startedFreshFrom ? `<div class="recovery-banner"><strong>Fresh run</strong><span>Previous run ${escapeHtml(run.startedFreshFrom.runId)} was archived with a restart audit.</span></div>` : "";
  const pauseAudit = run?.pauseHistory?.at(-1);
  const pauseBanner = pauseAudit ? `<div class="recovery-banner"><strong>${run.status === "paused" ? "Run paused" : "Resumed from pause"}</strong><span>${escapeHtml(new Date(pauseAudit.at).toLocaleString())} · ${escapeHtml(pauseAudit.steps.length ? `${pauseAudit.steps.length} worker session${pauseAudit.steps.length === 1 ? "" : "s"} saved` : `${pauseAudit.stageId || "workflow"} session saved`)} · audit ${escapeHtml(pauseAudit.id)}</span></div>` : "";
  const histories = runsForTicket(ticket.id);
  const historySelector = histories.length > 1 ? `<label class="run-history"><span>Execution history</span><select data-run-history aria-label="Execution history">${histories.map((item) => `<option value="${escapeHtml(item.runId)}" ${item.runId === run?.runId ? "selected" : ""}>${item.runId === state.ticketRuns?.[ticket.id]?.runId ? "Current" : "Archived"} · ${escapeHtml(item.runId)} · ${escapeHtml(item.status)}</option>`).join("")}</select></label>` : "";
  target.innerHTML = `<div class="plan-heading ticket-heading"><div><span class="eyebrow">${escapeHtml(ticket.identifier)} · ${escapeHtml(ticket.state.name)}</span><h2>${escapeHtml(ticket.title)}</h2><p>${escapeHtml(ticket.description || "No ticket description provided.")}</p>${usage}${historySelector}</div><div class="plan-actions">${action}${reviewAction}<span class="transport-status ${escapeHtml(transportState)}" role="status">${escapeHtml(transportLabel())}</span></div></div>${isArchivedRun(run) ? `<div class="recovery-banner"><strong>Archived execution</strong><span>Read-only inspection of run ${escapeHtml(run.runId)}.</span></div>` : `${workflowCheckpointsHtml(run)}${run?.checkpoint && !checkpointUsesWorkspace(run) ? checkpointHtml(run) : ""}`}${pauseBanner}${restartBanner}${cleanupAdvisoryHtml(run)}${run?.recovery?.message ? `<div class="recovery-banner"><strong>Restart recovery</strong><span>${escapeHtml(run.recovery.message)}</span></div>` : ""}${run?.trackerSyncError ? `<div class="error-banner">${escapeHtml(run.trackerSyncError)}</div>` : ""}${run?.lastError ? `<div class="error-banner">${escapeHtml(run.lastError)}</div>` : ""}`;
}

function openRestartDialog(target = null) {
  const run = runFor();
  const options = [
    { value: "fresh", label: "Start fresh", detail: "Archive this run and begin again with a new run ID and clean workspace." },
    ...restartOptions(run)
  ];
  const select = $("#restart-target");
  select.innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("");
  select.value = target && options.some((option) => option.value === target) ? target : options.find((option) => option.value !== "fresh")?.value || "fresh";
  select.dataset.options = JSON.stringify(options);
  $("#restart-run-id").value = run.id;
  $("#restart-confirm").checked = false;
  renderRestartImpact();
  $("#restart-dialog").showModal();
}

function renderRestartImpact() {
  const select = $("#restart-target");
  const option = JSON.parse(select.dataset.options || "[]").find((item) => item.value === select.value);
  $("#restart-impact").textContent = `${option?.detail || ""} Existing artifacts and a machine-readable restart audit are retained.`;
}

function attemptIndexHtml(step) {
  const projection = inspectionFor();
  const worker = projection?.workers?.find((item) => item.stepId === step.id);
  const attempts = (worker?.attemptIds || []).map((id) => inspectionAttempt(id, projection)).filter(Boolean);
  if (!attempts.length) return "";
  const hasSelectedAttempt = attempts.some((attempt) => attempt.id === selectedAttemptId);
  return `<div class="attempt-index" role="tablist" aria-label="${escapeHtml(step.title)} attempts">${attempts.map((attempt, index) => { const selected = attempt.id === selectedAttemptId; return `<button type="button" role="tab" aria-selected="${selected}" aria-controls="inspector-panel" tabindex="${selected || (!hasSelectedAttempt && index === 0) ? "0" : "-1"}" class="attempt-chip status-${escapeHtml(attempt.status)} ${selected ? "selected" : ""}" data-attempt="${escapeHtml(attempt.id)}" data-worker="${escapeHtml(worker.id)}" title="Select retained attempt ${index + 1}">Attempt ${index + 1} · ${escapeHtml(attempt.lifecycle)}</button>`; }).join("")}</div>`;
}

function stepHtml(step, tabbable = true, fallbackTabbable = false) {
  const selected = step.id === selectedStepId ? "selected" : "";
  const tabAttributes = tabbable ? `role="tab" aria-selected="${selected === "selected"}" aria-controls="inspector-panel" tabindex="${selected || fallbackTabbable ? "0" : "-1"}"` : "";
  const profile = runFor()?.stageProfiles?.[step.role || "implementation"];
  const budget = step.permission === "write" && step.reviewBudget ? ` · ≤${step.reviewBudget.maxFiles} files/${step.reviewBudget.maxChangedLines} lines` : "";
  const dependencies = (step.dependsOn || []).map((id) => nodeById(id, runFor()?.plan)?.title || id);
  const dependency = dependencies.length ? `<span class="step-dependency">After ${escapeHtml(dependencies.join(" · "))}</span>` : "";
  return `<div class="step-with-attempts"><button class="step status-${escapeHtml(step.status)} ${selected}" type="button" ${tabAttributes} data-step="${escapeHtml(step.id)}"><span class="state-icon">${statusIcon(step.status)}</span><span class="step-copy"><span class="step-title">${escapeHtml(step.title)}</span><span class="step-meta">${escapeHtml(profile ? `${profile.model}/${profile.thinking}` : step.agentId)} · ${escapeHtml(step.contextPolicy)} · ${escapeHtml(step.permission)}${escapeHtml(budget)}</span>${dependency}</span><span class="status-label">${escapeHtml(step.status.replaceAll("_", " "))}</span></button>${attemptIndexHtml(step)}</div>`;
}

function graphUnitHtml(unit) {
  const node = unit.node;
  if (node.type !== "group") return `<div class="graph-node" data-graph-node="${escapeHtml(node.id)}">${stepHtml(node, false)}</div>`;
  const childIds = new Set(node.children.map((child) => child.id));
  const parallel = !node.children.some((child) => child.dependsOn.some((id) => childIds.has(id)));
  return `<section class="graph-node graph-group" data-graph-node="${escapeHtml(node.id)}"><header><div><span class="graph-group-kicker">${parallel ? "parallel" : "sequence"}</span><strong>${escapeHtml(node.title)}</strong></div><span class="stage-count">${node.children.length} agents</span></header><div class="graph-group-children">${node.children.map((step) => stepHtml(step, false)).join("")}</div></section>`;
}

function stageSteps(run, stage) {
  const detail = stage && stageDetailModel(run, stage.id);
  const byId = new Map(flattenSteps(run?.plan).map((step) => [step.id, step]));
  return (detail?.stepIndex || []).map((step) => byId.get(step.id)).filter(Boolean);
}

function stageDependencies(run, stage) {
  const dependencies = stage && stageDetailModel(run, stage.id)?.dependencies;
  return [...(dependencies?.internal || []), ...(dependencies?.external || [])];
}

function stageContextHtml(run, stage) {
  const index = run.stages.findIndex((item) => item.id === stage.id) + 1;
  const steps = stageSteps(run, stage);
  const dependencies = stageDependencies(run, stage);
  const artifacts = artifactsForStage(run.artifacts, stage.id);
  return `<section class="stage-context"><div><span class="eyebrow">Stage ${index} of ${run.stages.length}</span><h1>${escapeHtml(stage.title)}</h1><p>${escapeHtml(stage.summary || "Waiting to start")}</p></div><div class="stage-context-meta"><span>${steps.length} worker${steps.length === 1 ? "" : "s"}</span><span>${dependencies.length} dependenc${dependencies.length === 1 ? "y" : "ies"}</span><span>${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"}</span></div></section>`;
}

function stageWorkerMapHtml(run, stage) {
  const steps = stageSteps(run, stage);
  if (!steps.length) {
    const message = stage.id === "implement"
      ? "The implementation plan has not created workers yet."
      : "This stage is investigated through its activity and saved artifacts.";
    return `<section class="stage-work-surface"><header><span class="eyebrow">Stage work</span><span class="stage-count">${escapeHtml(workflowStateLabel(stage.status))}</span></header><div class="run-empty">${message}</div></section>`;
  }
  const graph = executionGraph({ nodes: steps });
  const attention = steps.filter((step) => ["needs_attention", "failed", "interrupted", "cancelled"].includes(step.status));
  const reviews = steps.filter((step) => step.status === "review_ready");
  const focus = attention.length
    ? `<section class="execution-focus attention"><span class="eyebrow">Current focus</span><strong>Resolve ${attention.length === 1 ? "the worker" : `${attention.length} workers`} that need${attention.length === 1 ? "s" : ""} attention</strong><small>Select a highlighted worker to review the blocker and evidence.</small></section>`
    : reviews.length ? `<section class="execution-focus"><span class="eyebrow">Current focus</span><strong>Review ${reviews.length === 1 ? "the verified worker" : `${reviews.length} verified workers`}</strong><small>Accept or request a focused correction before the next batch starts.</small></section>` : "";
  const columns = graph.columns.map((column, index) => `<section class="graph-column"><span class="graph-stage-label">Batch ${index + 1}</span>${column.map(graphUnitHtml).join("")}</section>`).join("");
  return `<section class="stage-work-surface">${focus}<header><span class="eyebrow">Steps in this stage</span><span class="stage-count">${steps.length} workers</span></header><div class="stage-worker-map" role="tablist" aria-label="Workers in ${escapeHtml(stage.title)}">${steps.map((step, index) => stepHtml(step, true, !steps.some((item) => item.id === selectedStepId) && index === 0)).join("")}</div><details class="execution-graph-secondary"><summary>View dependency batches <span>${graph.columns.length} batches</span></summary><div class="execution-graph-scroll"><div id="execution-graph" class="execution-graph"><div class="graph-columns">${columns}</div></div></div></details></section>`;
}

function stageStepIndexHtml(run, stage) {
  const steps = stageSteps(run, stage);
  if (!steps.length) return "";
  return `<section class="stage-step-index"><header><span class="eyebrow">Step index</span><span>${steps.length} workers</span></header><ol>${steps.map((step) => `<li><button class="status-${escapeHtml(step.status)}" type="button" data-step="${escapeHtml(step.id)}"><span class="state-icon" aria-hidden="true">${statusIcon(step.status)}</span><span><strong>${escapeHtml(step.title)}</strong><small>${escapeHtml(step.agentId)}</small></span><em>${escapeHtml(step.status.replaceAll("_", " "))}</em></button></li>`).join("")}</ol></section>`;
}

function stageDependencyMapHtml(run, stage) {
  const steps = stageSteps(run, stage);
  if (!steps.length) return "";
  const byId = new Map(steps.map((step) => [step.id, step]));
  const dependencies = stageDependencies(run, stage);
  const map = dependencies.length
    ? `<ol>${dependencies.map(({ from, to, title }) => `<li><button type="button" data-step="${escapeHtml(from)}">${escapeHtml(title || byId.get(from)?.title || from)}</button><span aria-hidden="true">→</span><button type="button" data-step="${escapeHtml(to)}">${escapeHtml(byId.get(to)?.title || to)}</button></li>`).join("")}</ol>`
    : `<p>All workers in this stage can run independently.</p>`;
  return `<section class="stage-dependency-map"><header><span class="eyebrow">Dependency map</span><span>${dependencies.length} link${dependencies.length === 1 ? "" : "s"}</span></header>${map}</section>`;
}

function renderPlanTree() {
  const target = $("#plan-tree");
  const run = runFor();
  const stage = run?.stages?.find((item) => item.id === (selectedStageId || (selectedStepId ? "implement" : null)));
  const stageSurface = run ? `${stagesHtml(run)}${stage ? stageContextHtml(run, stage) : ""}` : "";
  if (isArchivedRun(run)) {
    target.innerHTML = `${stageSurface}<div class="empty"><div><strong>Archived execution</strong>Select a workflow stage or retained attempt to inspect this read-only run.</div></div>`;
    return;
  }
  if (checkpointUsesWorkspace(run)) {
    target.innerHTML = `${stageSurface}<section class="stage-checkpoint-workspace"><span class="eyebrow">Workflow stage · ${escapeHtml(run.stages?.find((stage) => ["blocked", "active", "paused"].includes(stage.status))?.title || (run.checkpoint?.kind === "evidence_review" ? "Final proof review" : "Clarify requirements"))}</span>${checkpointHtml(run)}</section>`;
    const clarificationKey = `${run.id}:${run.clarificationHistory?.length || 0}:${run.checkpoint?.id || run.status}`;
    if (target.querySelector(".clarification-thread") && clarificationKey !== lastClarificationKey) {
      lastClarificationKey = clarificationKey;
      requestAnimationFrame(() => target.scrollTo({ top: target.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
    }
    return;
  }
  if (!run?.plan) {
    const copy = run ? (run.status === "awaiting_requirements" ? "Approve the requirements above before repository exploration." : run.status === "awaiting_input" ? "Answer the technical question above." : "Exploration and design will produce the graph here.") : "Start the selected ticket to clarify requirements.";
    target.innerHTML = `${stageSurface}<div class="empty"><div><strong>No execution graph yet</strong>${copy}</div></div>`;
    return;
  }
  target.innerHTML = `${stageSurface}${stage ? stageWorkerMapHtml(run, stage) : ""}`;
}

function cachedTrace(run, step) {
  const cached = sessionTraces.get(`${runIdentity(run)}:${step.id}`);
  return cached && cached.sessionFile === step.sessionFile ? cached.trace : null;
}

function stagePromptSignature(run, stage) {
  const stepSessions = stage.id === "implement" ? (run.plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children : [node]).map((step) => [step.id, step.status, step.sessionFile]) : [];
  const reviewSessions = stage.id === "verify" ? (run.reviews || []).flatMap((review) => (review.reviews || []).map((item) => [review.round, item.role, item.sessionFile])) : [];
  return JSON.stringify([stage.status, stage.updatedAt, run.requirementsSessionFile, run.sessionFile, stepSessions, reviewSessions]);
}

function cachedStagePrompts(run, stage) {
  const cached = stagePromptTraces.get(`${runIdentity(run)}:${stage.id}`);
  return cached?.signature === stagePromptSignature(run, stage) ? cached.prompts : null;
}

function cachedStagePromptTrace(run, stage) {
  const cached = stagePromptTraces.get(`${runIdentity(run)}:${stage.id}`);
  return cached?.signature === stagePromptSignature(run, stage) ? cached.trace : null;
}

function stagePromptPanel(run, stage) {
  const saved = cachedStagePrompts(run, stage);
  const trace = cachedStagePromptTrace(run, stage);
  const live = liveStages.get(`${run.id}:${stage.id}`)?.prompts || [];
  const prompts = [...(saved || []), ...live.map((item) => ({ prompt: item.content, at: item.at, title: item.actor || stage.title, status: stage.status }))]
    .filter((item, index, all) => item.prompt && all.findIndex((candidate) => candidate.prompt === item.prompt) === index);
  if (!prompts.length) return saved ? `<div class="run-empty">${trace?.state === "unavailable" ? "The retained review trace is currently unavailable." : "No agent prompt has been recorded for this stage yet."}</div>` : `<div class="run-empty">Loading recorded stage prompts…</div>`;
  return `<div class="stage-prompts">${prompts.map((item, index) => `<article class="artifact"><header><span class="artifact-name">${escapeHtml(item.title || `Prompt ${index + 1}`)}</span><span class="artifact-source status-${escapeHtml(item.status || stage.status)}">${escapeHtml((item.status || stage.status).replaceAll("_", " "))}</span></header>${item.at ? `<code class="artifact-path">${escapeHtml(new Date(item.at).toLocaleString())}</code>` : ""}<div class="artifact-body">${renderMarkdown(item.prompt)}</div></article>`).join("")}</div>`;
}

function currentLiveRun(run, step) {
  const live = liveRuns.get(`${run.id}:${step.id}`);
  return live?.runId === step.attempts?.at(-1)?.runId ? null : live;
}

function heartbeatContent(pulse) {
  return `<span class="heartbeat-dot"></span><div><strong data-heartbeat-label>${escapeHtml(pulse.label)}</strong><small data-heartbeat-note>${pulse.elapsed}s elapsed · last activity ${pulse.idle ? `${pulse.idle}s ago` : "now"}${pulse.note ? ` · ${escapeHtml(pulse.note)}` : ""}</small></div>`;
}

function heartbeatHtml(pulse) {
  return pulse ? `<section class="run-heartbeat ${pulse.state}" data-run-heartbeat>${heartbeatContent(pulse)}</section>` : "";
}

function eventHtml(item) {
  const heading = `<span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.status)}</small></span><time>${escapeHtml((item.at || "").slice(11, 19))}</time>`;
  if (!item.hasDetails) return `<div class="run-event unavailable ${item.isError ? "warning" : ""}">${heading}<em>Legacy run — input and output were not recorded</em></div>`;
  const detail = [["Input", item.args], ["Live output", item.output], ["Result", item.result]].filter(([, value]) => value).map(([label, value]) => `<div class="event-block"><label>${label}</label><pre>${escapeHtml(formatOutput(value))}</pre></div>`).join("");
  return `<details class="run-event ${item.isError ? "warning" : ""}" data-event-key="${escapeHtml(item.key)}"><summary>${heading}</summary>${detail}</details>`;
}

function groupDuration(group) {
  const seconds = Math.floor((Date.parse(group.endedAt) - Date.parse(group.at)) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function timelineHtml(events, active = false, persistedGroups = []) {
  const groups = eventGroups(events, persistedGroups).reverse();
  return groups.map((group, index) => {
    const current = active && index === 0;
    const duration = groupDuration(group);
    const meta = [group.items.length ? `${group.items.length} action${group.items.length === 1 ? "" : "s"}` : "", duration, current ? "active" : group.status || (group.isError ? "failed" : "complete")].filter(Boolean).join(" · ");
    const note = group.note ? `<div class="activity-group-note">${renderMarkdown(group.note)}</div>` : "";
    return `<details class="activity-group ${current ? "current" : ""} ${group.isError ? "warning" : ""}" data-group-key="${escapeHtml(group.key)}" ${current ? "open" : ""}><summary><span><b>${escapeHtml(group.title)}</b><small>${meta}</small></span><time>${escapeHtml((group.at || "").slice(11, 19))}</time></summary><div class="activity-group-body">${note}${group.items.map(eventHtml).join("")}</div></details>`;
  }).join("") || `<div class="run-empty">The agent has not started a focused activity yet.</div>`;
}

function milestoneTimelineHtml(items) {
  return `<ol class="stage-timeline">${items.map((item) => {
    const heading = `<span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.status)}</small></span><time>${escapeHtml((item.at || "").slice(11, 19))}</time>`;
    return `<li><span class="timeline-marker"></span>${item.detail ? `<details><summary>${heading}</summary><div class="timeline-detail">${renderMarkdown(item.detail)}</div></details>` : `<div class="timeline-row">${heading}</div>`}</li>`;
  }).join("")}</ol>`;
}

function stageActivityPanel(run, stage) {
  const live = liveStages.get(`${run.id}:${stage.id}`);
  const activity = live || stage.activity || {};
  const milestones = stageMilestones(run, stage);
  const history = stage.id === "requirements" && !checkpointUsesWorkspace(run) ? clarificationHistoryHtml(run) : "";
  if (!live && !stage.activity && !milestones.length) return history || `<div class="run-empty stage-empty">No model activity was recorded for this stage.</div>`;
  const active = stage.status === "active";
  const pulse = active ? heartbeatHtml(runHeartbeat({ startedAt: activity.startedAt || stage.updatedAt, lastEventAt: activity.lastEventAt || stage.updatedAt, lastEvent: activity.lastEvent || stage.summary, warning: activity.warning }, live)) : "";
  const activityTimeline = timelineHtml(activity.events || [], active, activity.groups);
  const milestoneTimeline = milestones.length ? `<details class="stage-milestones"><summary>Workflow milestones <span>${milestones.length}</span></summary>${milestoneTimelineHtml(milestones)}</details>` : "";
  return `<div class="stage-activity">${history}${pulse}<section class="run-events"><span class="eyebrow">Saved activity · ${eventGroups(activity.events || [], activity.groups).length} groups</span><div>${activityTimeline}</div></section>${milestoneTimeline}</div>`;
}

function rawOutputFor(run, step) {
  const attempt = step.attempts?.at(-1);
  const live = currentLiveRun(run, step);
  const active = run.activeRuns?.[step.id];
  return live?.output || active?.activity?.rawOutput || cachedTrace(run, step)?.rawOutput || [attempt?.rawOutput, attempt?.verification?.rawOutput].filter(Boolean).join("\n\n") || "";
}

function stepEvents(run, step) {
  const attempt = step.attempts?.at(-1);
  const trace = cachedTrace(run, step);
  const live = currentLiveRun(run, step);
  const active = run.activeRuns?.[step.id];
  return [...(active?.activity?.events || trace?.events || attempt?.events || []), ...(live?.events || [])];
}

function correctionFindingsHtml(step) {
  const findings = stepInspectorSummary(step).findings;
  if (!findings.length) return "";
  const title = step.status === "fixing" ? "Issues being fixed" : "Latest verification issues";
  return `<section class="correction-findings"><header><div><span class="eyebrow">Verification feedback</span><strong>${title}</strong></div><span>${findings.length}</span></header><ol>${findings.map((finding) => {
    const evidence = (finding.evidence || []).map((item) => `${item.file || "unknown"}${item.line ? `:${item.line}` : ""}`).join(" · ");
    return `<li><div><span class="finding-severity severity-${escapeHtml(finding.severity || "issue")}">${escapeHtml(finding.severity || "issue")}</span>${evidence ? `<code>${escapeHtml(evidence)}</code>` : ""}</div><strong>${escapeHtml(finding.claim || finding.message || String(finding))}</strong>${finding.suggestedFix ? `<p><b>Requested fix</b>${escapeHtml(finding.suggestedFix)}</p>` : ""}</li>`;
  }).join("")}</ol></section>`;
}

function runPanel(step) {
  const run = runFor();
  const attempt = step.attempts?.at(-1);
  const active = run.activeRuns?.[step.id];
  const heartbeat = heartbeatHtml(runHeartbeat(active, liveRuns.get(`${run.id}:${step.id}`)));
  const events = stepEvents(run, step);
  const rawOutput = rawOutputFor(run, step);
  const raw = `<details class="raw-output" data-load-session-trace="${escapeHtml(step.id)}"><summary>Raw assistant output</summary><pre data-run-raw-output>${escapeHtml(formatOutput(rawOutput || (step.sessionFile ? "Open to load the full session transcript." : "No assistant text yet. Open event details below to inspect tool calls and their output.")))}</pre></details>`;
  const progress = active?.activity?.lastEvent || active?.lastEvent || (attempt ? `${step.attempts.length} attempt${step.attempts.length === 1 ? "" : "s"}` : "waiting");
  const purpose = step.productContext || step.acceptanceCriteria?.[0];
  const why = purpose ? `<article class="artifact"><header><span class="artifact-name">Why this worker is running</span></header><div class="artifact-body"><p>${escapeHtml(purpose)}</p></div></article>` : "";
  return `${step.lastError ? `<div class="error-banner">${escapeHtml(step.lastError)}</div>` : ""}<div class="run-summary"><span class="run-state status-${escapeHtml(step.status)}">${escapeHtml(step.status.replaceAll("_", " "))}</span><strong>${escapeHtml(step.agentId)}</strong><span>${escapeHtml(progress)}</span></div>${heartbeat}${correctionFindingsHtml(step)}${why}<section class="run-events"><span class="eyebrow">Saved activity · grouped by focus</span><div data-run-events>${timelineHtml(events, Boolean(active), active?.activity?.groups || attempt?.activityGroups)}</div></section>${raw}`;
}

function proofEvidenceHtml(evidence) {
  if (evidence.unavailable) return `<span class="proof-control unavailable" title="${escapeHtml(evidence.reason || "Evidence cannot be resolved")}">${escapeHtml(evidence.label)}</span>`;
  if (evidence.mediaUrl) return `<a class="proof-control" href="${escapeHtml(evidence.mediaUrl)}" target="_blank" rel="noreferrer">${escapeHtml(evidence.label)} ↗</a>`;
  if (evidence.route) return `<a class="proof-control" href="${escapeHtml(evidence.route)}" target="_blank" rel="noreferrer">${escapeHtml(evidence.label)} ↗</a>`;
  if (evidence.artifactId) return `<span class="proof-control unavailable">${escapeHtml(evidence.label)}</span>`;
  if (evidence.stepId) return `<button class="proof-control" type="button" data-proof-step="${escapeHtml(evidence.stepId)}" data-proof-tab="${escapeHtml(evidence.tab || "run")}">${escapeHtml(evidence.label)}</button>`;
  return `<span class="proof-control unavailable">${escapeHtml(evidence.label)}</span>`;
}

function criterionProofHtml(run, options = {}) {
  const proof = proofMapView(run, options);
  const gate = options.gate ? proofMapView(run, options.gate) : proof;
  const compatibility = proof.compatibility ? `<p class="proof-compatibility">Legacy run: criteria are shown unresolved until explicit proof is recorded.</p>` : "";
  const blockers = gate.eligibility.blockingReasons.map((reason) => `<li><code>${escapeHtml(reason.criterionId)}</code> ${escapeHtml(reason.message)}</li>`).join("");
  const list = proof.criteria.map((criterion) => {
    const history = criterion.history?.length ? `<details><summary>${criterion.history.length} prior result${criterion.history.length === 1 ? "" : "s"}</summary><ol>${criterion.history.map((item) => `<li><strong>${escapeHtml(item.status || "not_yet_verified")}</strong> · ${escapeHtml(item.evidenceValidity || "missing")} · ${escapeHtml(item.explanation?.summary || "No explanation")}${item.invalidationReason ? ` · ${escapeHtml(item.invalidationReason)}` : ""}${item.evidence?.length ? `<div class="proof-controls">${item.evidence.map(proofEvidenceHtml).join("")}</div>` : ""}</li>`).join("")}</ol></details>` : "";
    const evidence = criterion.evidence.length ? `<div class="proof-controls">${criterion.evidence.map(proofEvidenceHtml).join("")}</div>` : `<span class="proof-no-evidence">No evidence reference recorded.</span>`;
    return `<article class="criterion-proof proof-${escapeHtml(criterion.state)}"><header><span class="proof-statuses"><span class="proof-state">${escapeHtml(criterion.resultLabel)}</span><span class="proof-evidence evidence-${escapeHtml(criterion.current.evidenceValidity || "missing")}">${escapeHtml(criterion.evidenceLabel)}</span></span><code>${escapeHtml(criterion.id)}</code></header><strong>${escapeHtml(criterion.text)}</strong><small>${escapeHtml(criterion.stepTitle || criterion.stepId)}</small><p>${escapeHtml(criterion.current.explanation?.summary || "No structured result was reported.")}</p>${evidence}${history}</article>`;
  }).join("") || `<div class="run-empty">No approved acceptance criteria were recorded.</div>`;
  return `<section class="criterion-proof-map"><header><div><span class="eyebrow">Criterion proof</span><strong>${proof.criteria.length} criterion${proof.criteria.length === 1 ? "" : "ia"}</strong></div><span class="proof-eligibility ${gate.eligibility.eligible ? "eligible" : "blocked"}">${gate.eligibility.eligible ? "ready" : "blocked"}</span></header>${compatibility}${!gate.eligibility.eligible ? `<ul class="proof-blockers">${blockers}</ul>` : ""}<div class="criterion-proof-list">${list}</div></section>`;
}

function correctionCriterionPicker(run, options = {}) {
  const criteria = proofMapView(run, options).criteria;
  return criteria.length ? `<fieldset class="criterion-picker"><legend>Affected criteria</legend>${criteria.map((criterion) => `<label><input type="checkbox" name="criterionId" value="${escapeHtml(criterion.id)}">${escapeHtml(criterion.text)}</label>`).join("")}</fieldset>` : "";
}

function cleanupList(items, empty, render) {
  return items.length ? `<ul>${items.map(render).join("")}</ul>` : `<p class="cleanup-empty">${escapeHtml(empty)}</p>`;
}

function cleanupInspectorHtml(run) {
  const cleanup = cleanupInspectorModel(run);
  const executionHtml = cleanup.executions.map((execution) => {
    const identities = [
      ...execution.discovered,
      ...execution.unresolved.filter((item) => item?.pid && !execution.discovered.some((known) => known.pid === item.pid))
    ];
    const platform = execution.platform
      ? `${execution.platform.name || "unknown platform"} · ${execution.platform.supported ? "supported" : "unsupported"}${execution.platform.reason ? ` · ${execution.platform.reason}` : ""}`
      : "Platform support was not recorded";
    const title = `${execution.executionId}${execution.stepId ? ` · ${execution.stepId}` : ""}`;
    return `<details class="cleanup-execution" ${cleanup.advisory ? "open" : ""}><summary><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(execution.outcome)}</small></span><time>${escapeHtml((execution.completedAt || execution.startedAt || "").replace("T", " ").slice(0, 19) || "not recorded")}</time></summary><div class="cleanup-evidence"><dl><div><dt>Platform</dt><dd>${escapeHtml(platform)}</dd></div><div><dt>Ownership</dt><dd>${escapeHtml(execution.ownership?.tokenPresent ? "ownership token established" : "ownership token not recorded")}</dd></div><div><dt>Started</dt><dd>${escapeHtml(execution.startedAt || "not recorded")}</dd></div><div><dt>Completed</dt><dd>${escapeHtml(execution.completedAt || "not recorded")}</dd></div></dl><section><span>Lifecycle triggers</span>${cleanupList(execution.triggers, "No lifecycle trigger was recorded.", (trigger) => `<li><code>${escapeHtml(trigger.trigger || "unspecified")}</code> ${escapeHtml(trigger.at || "")}</li>`)}</section><section><span>Affected processes</span>${cleanupList(identities, "No attributable process was discovered.", (identity) => `<li><code>pid ${escapeHtml(identity.pid || "unknown")}</code> · parent ${escapeHtml(identity.ppid ?? identity.identity?.ppid ?? "unknown")} · started ${escapeHtml(identity.startTime || identity.identity?.startTime || "unknown")}</li>`)}</section><section><span>Attempted actions</span>${cleanupList(execution.actions, "No process signal was attempted.", (action) => `<li><code>${escapeHtml(action.signal || "action")}</code> pid ${escapeHtml(action.pid || "unknown")} · ${escapeHtml(action.status || "recorded")}${action.error ? ` · ${escapeHtml(action.error)}` : ""}${action.at ? ` · ${escapeHtml(action.at)}` : ""}</li>`)}</section><section><span>Unresolved evidence</span>${cleanupList(execution.unresolved, "No unresolved process evidence.", (item) => `<li><strong>${escapeHtml(item.reason || "unresolved")}</strong>${item.pid ? ` · pid ${escapeHtml(item.pid)}` : ""}${item.error ? ` · ${escapeHtml(item.error)}` : ""}</li>`)}</section><section><span>Diagnostics</span>${cleanupList(execution.diagnostics, "No diagnostics were recorded.", (diagnostic) => `<li>${escapeHtml(diagnostic)}</li>`)}</section></div></details>`;
  }).join("") || `<div class="run-empty">No worker execution has registered process containment yet.</div>`;
  return `<section class="cleanup-inspector ${cleanup.advisory ? "advisory" : "neutral"}"><header><div><span class="eyebrow">Process containment</span><h3>${escapeHtml(cleanup.label)}</h3><p>${cleanup.advisory ? "Cleanup did not establish a successful result. Review the retained process evidence before continuing." : "Durable process-cleanup evidence remains available for this run."}</p></div><span class="cleanup-outcome">${escapeHtml(cleanup.outcome)}</span></header>${cleanup.updatedAt ? `<time class="cleanup-updated">Updated ${escapeHtml(cleanup.updatedAt)}</time>` : ""}<div class="cleanup-executions">${executionHtml}</div></section>`;
}

function cleanupAdvisoryHtml(run) {
  const cleanup = cleanupInspectorModel(run);
  if (!cleanup.advisory) return "";
  return `<section class="cleanup-advisory" role="alert"><span class="eyebrow">Cleanup advisory</span><strong>${escapeHtml(cleanup.label)}</strong><p>Process cleanup is not confirmed. Open the Cleanup inspector for affected process identities, lifecycle triggers, and diagnostic reasons.</p></section>`;
}

function overviewPanel(step) {
  const run = runFor();
  const summary = stepInspectorSummary(step);
  const attempt = step.attempts?.at(-1);
  const status = step.status.replaceAll("_", " ");
  const dependencies = (step.dependsOn || []).map((id) => nodeById(id, run.plan)?.title || id);
  const report = attempt?.report?.summary || step.lastError || "No worker outcome has been recorded yet.";
  const outcome = summary.needsAttention
    ? "This worker needs a decision before the workflow can continue."
    : step.status === "accepted" ? "Completed successfully and accepted into the ticket worktree."
      : step.status === "review_ready" ? "Verification passed. The worker is ready for your review."
        : ["running", "fixing"].includes(step.status) ? "The worker is actively progressing this step."
          : "The worker is waiting for its dependencies or next action.";
  const attention = summary.needsAttention ? `<section class="attention-summary"><span class="eyebrow">What needs attention</span><strong>${escapeHtml(summary.finding)}</strong><div class="attention-actions"><button class="button attention-action" type="button" data-tab="run">See failure details</button><button class="button primary" type="button" data-resume-ticket="${escapeHtml(run.id)}">Retry worker</button></div></section>` : "";
  const criteria = criterionProofHtml(run, { stepId: step.id });
  const action = summary.needsAttention ? "Retry this worker" : step.status === "review_ready" ? "Review and accept" : "None";
  return `<section class="worker-overview ${summary.needsAttention ? "needs-attention" : ""}">${attention}<div class="worker-outcome"><span class="eyebrow">Worker outcome</span><p>${escapeHtml(report)}</p><dl><div><dt>Result</dt><dd class="status-${escapeHtml(step.status)}">${escapeHtml(status)}</dd></div><div><dt>Action needed</dt><dd>${action}</dd></div><div><dt>Attempts</dt><dd>${summary.attemptCount || (run.activeRuns?.[step.id] ? "In progress" : "—")}</dd></div>${dependencies.length ? `<div><dt>After</dt><dd>${escapeHtml(dependencies.join(" · "))}</dd></div>` : ""}</dl></div><div class="inspector-disclosures">${summary.findingCount ? `<button type="button" data-tab="run"><span>Findings</span><b>${summary.findingCount}</b><i>›</i></button>` : ""}${criteria}<button type="button" data-tab="artifacts"><span>Artifacts</span><b>${summary.artifactCount}</b><i>›</i></button><button type="button" data-tab="run"><span>Grouped activity</span><i>›</i></button><button type="button" data-tab="prompt"><span>Agent prompt</span><i>›</i></button><button type="button" data-tab="ticket"><span>Ticket context</span><i>›</i></button></div></section>`;
}

function refreshLiveRun({ events = false } = {}) {
  if (activeTab !== "run") return;
  const run = runFor();
  const step = nodeById(selectedStepId);
  const panel = $("#inspector .tab-panel");
  if (!run || !step || !panel) return;
  const live = liveRuns.get(`${run.id}:${step.id}`);
  const pulse = runHeartbeat(run.activeRuns?.[step.id], live);
  const heartbeat = panel.querySelector("[data-run-heartbeat]");
  if (heartbeat && pulse) {
    heartbeat.className = `run-heartbeat ${pulse.state}`;
    heartbeat.innerHTML = heartbeatContent(pulse);
  }
  const raw = panel.querySelector("[data-run-raw-output]");
  if (raw) raw.textContent = formatOutput(rawOutputFor(run, step) || "No assistant text yet. Open event details below to inspect tool calls and their output.");
  if (!events) return;
  const target = panel.querySelector("[data-run-events]");
  if (!target) return;
  const open = new Set([...target.querySelectorAll("details.run-event[open]")].map((item) => item.dataset.eventKey));
  const openGroups = new Set([...target.querySelectorAll("details.activity-group[open]")].map((item) => item.dataset.groupKey));
  target.innerHTML = timelineHtml(stepEvents(run, step), Boolean(run.activeRuns?.[step.id]), run.activeRuns?.[step.id]?.activity?.groups || step.attempts?.at(-1)?.activityGroups);
  for (const item of target.querySelectorAll("details.run-event")) item.open = open.has(item.dataset.eventKey);
  for (const item of target.querySelectorAll("details.activity-group:not(.current)")) item.open = openGroups.has(item.dataset.groupKey);
}

function reviewNoteCard(note, feedbackFormId) {
  const lines = `${note.side === "LEFT" ? "old" : "new"} lines ${note.startLine}${note.endLine === note.startLine ? "" : `–${note.endLine}`}`;
  const editor = feedbackFormId ? `<div class="review-note-editor"><textarea rows="2" data-review-note-feedback="${escapeHtml(note.id)}" placeholder="What should change in this code?"></textarea><button class="button" type="button" data-add-note-review="${escapeHtml(note.id)}" data-review-form="${escapeHtml(feedbackFormId)}">Queue code change</button></div>` : "";
  return `<aside class="review-note ${escapeHtml(note.kind)}" data-review-note-id="${escapeHtml(note.id)}" data-review-form="${escapeHtml(feedbackFormId || "")}"><header><strong>${escapeHtml(note.kind)}</strong><span>${escapeHtml(note.id)} · ${escapeHtml(lines)}</span></header><p>${escapeHtml(note.text)}</p>${editor}</aside>`;
}

function diffRows(rows, notes = [], feedbackFormId = null) {
  const after = new Map();
  for (const note of notes) {
    let index = -1;
    rows.forEach((row, candidate) => {
      const line = note.side === "LEFT" ? row.old : row.new;
      if (Number.isInteger(line) && line >= note.startLine && line <= note.endLine) index = candidate;
    });
    if (index >= 0) after.set(index, [...(after.get(index) || []), note]);
  }
  return `<div class="diff-code">${rows.map((row, index) => `<div class="diff-line ${row.kind}"><span>${row.old}</span><span>${row.new}</span><code>${escapeHtml(row.text)}</code></div>${(after.get(index) || []).map((note) => reviewNoteCard(note, feedbackFormId)).join("")}`).join("")}</div>`;
}

function compactDiffLabel(diff) {
  if (!diff?.files?.length) return "No changed files";
  return `${diff.files.length} file${diff.files.length === 1 ? "" : "s"} · +${diff.additions || 0} −${diff.deletions || 0}`;
}

function diffPanel(record, { id = `diff-${diffModels.size + 1}`, budget = null, reviewMap = null, reviewNotes = [], mapStepId = null, feedbackStepId = null, artifactId = null, actions = true } = {}) {
  if (!record?.available) return `<div class="empty compact"><div><strong>No repository changes</strong>This scope has a clean tree comparison.</div></div>`;
  const feedbackFormId = feedbackStepId ? `review-notes-${String(id).replace(/[^a-z0-9_-]/gi, "-")}` : null;
  const parsed = parseDiff(record.patch);
  for (const file of parsed.files) {
    for (const hunk of file.hunks) hunk.reviewNotes = [];
    for (const note of reviewNotesForRows(reviewNotes, file.name, file.rows)) {
      file.hunks.find((hunk) => reviewNotesForRows([note], file.name, hunk.rows).length)?.reviewNotes.push(note);
    }
  }
  diffModels.set(id, { ...parsed, reviewNotes, feedbackFormId });
  const indexed = parsed.files.map((file, index) => ({ file, index })).sort((left, right) => (right.file.additions + right.file.deletions) - (left.file.additions + left.file.deletions));
  const warning = [
    record.truncated ? `<div class="diff-warning">This stored patch was truncated at 600 KB. File totals remain complete, but the visible patch is partial.</div>` : "",
    budget?.exceeded ? `<div class="diff-warning danger"><strong>Review budget exceeded.</strong> ${escapeHtml(budget.reasons.join("; "))}. Auto-accept is disabled.</div>` : "",
    reviewNotes.some((note) => note.status === "stale") ? `<div class="diff-warning">Some agent review notes became stale after rewriting and are hidden.</div>` : ""
  ].join("");
  const map = reviewMap?.groups?.length ? `<section class="review-map"><header><span class="eyebrow">Semantic review map</span><span>Navigation only · Git remains canonical</span></header>${reviewMap.groups.map((group) => `<article><strong>${escapeHtml(group.title)}</strong><p>${escapeHtml(group.summary || "")}</p><div>${group.items.map((item) => `<button type="button" data-diff-jump="${escapeHtml(id)}" data-diff-file-name="${escapeHtml(item.file)}" data-diff-hunk-index="${Number(item.hunk || 0)}">${escapeHtml(item.file)}${Number.isInteger(item.hunk) ? ` · hunk ${item.hunk + 1}` : ""}</button>`).join("")}</div></article>`).join("")}</section>` : mapStepId ? `<button class="button diff-map-generate" type="button" data-generate-review-map="${escapeHtml(mapStepId)}">Generate semantic review map</button>` : "";
  const toolbar = actions ? `<div class="diff-actions"><button class="button" type="button" data-expand-diff>${diffExpanded ? "Collapse" : "Expand"}</button>${artifactId ? `<button class="button" type="button" data-open-artifact="${escapeHtml(artifactId)}">Default app ↗</button>` : ""}</div>` : "";
  const noteCount = reviewNotes.filter((note) => note.status === "current").length;
  const rewriteRequest = feedbackFormId && noteCount ? `<form id="${escapeHtml(feedbackFormId)}" class="review-note-bulk" data-request-note-changes="${escapeHtml(feedbackStepId)}"><div><strong>Code change requests</strong><span data-review-queue-count>No code changes queued yet.</span></div><button class="button" type="submit" data-send-note-review disabled>Send code change requests</button></form>` : "";
  return `${toolbar}${warning}<div class="diff-overview"><div><strong>${record.files.length} changed files</strong><span>Canonical Git diff${noteCount ? ` · ${noteCount} agent note${noteCount === 1 ? "" : "s"}` : ""}</span></div><div class="diff-total"><b>+${record.additions ?? parsed.additions}</b><i>−${record.deletions ?? parsed.deletions}</i></div></div>${map}<nav class="diff-index" aria-label="Changed files">${indexed.map(({ file, index }) => `<button type="button" data-diff-jump="${escapeHtml(id)}" data-diff-file-index="${index}"><span>${escapeHtml(file.name)}</span><b>+${file.additions}</b><i>−${file.deletions}</i></button>`).join("")}</nav><div class="diff-files">${parsed.files.map((file, fileIndex) => `<details class="diff-file" data-diff-view="${escapeHtml(id)}" data-diff-file-index="${fileIndex}" ${fileIndex === indexed[0]?.index ? "open" : ""}><summary><span class="diff-file-name">${escapeHtml(file.name)}</span><span class="diff-numbers">${file.binary ? `<em>binary</em>` : `<b>+${file.additions}</b><i>−${file.deletions}</i>`}</span></summary><div class="diff-hunks">${file.hunks.map((hunk, hunkIndex) => `<details class="diff-hunk" data-diff-view="${escapeHtml(id)}" data-diff-file-index="${fileIndex}" data-diff-hunk-index="${hunkIndex}" ${fileIndex === indexed[0]?.index && hunkIndex === 0 ? "open data-hydrated=\"true\"" : ""}><summary><span>${escapeHtml(hunk.context || hunk.header)}</span><span class="diff-numbers"><b>+${hunk.additions}</b><i>−${hunk.deletions}</i></span></summary>${fileIndex === indexed[0]?.index && hunkIndex === 0 ? diffRows(hunk.rows, hunk.reviewNotes, feedbackFormId) : ""}</details>`).join("") || `<div class="run-empty">No textual hunks.</div>`}</div></details>`).join("")}</div>${rewriteRequest}`;
}

function stepDiffPanel(step) {
  const attempts = (step.attempts || []).filter((attempt) => attempt.diff?.available);
  const patchArtifact = [...(runFor()?.artifacts || [])].reverse().find((artifact) => artifact.stepId === step.id && artifact.kind === "git-diff");
  return `${diffPanel(step.diff, { id: `step-${step.id}`, budget: step.reviewBudgetResult, reviewMap: step.reviewMap, reviewNotes: step.reviewNotes, mapStepId: step.id, feedbackStepId: step.status === "review_ready" ? step.id : null, artifactId: patchArtifact?.id })}${attempts.length ? `<details class="attempt-diffs"><summary>Attempt deltas <span>${attempts.length}</span></summary>${attempts.map((attempt, index) => `<details><summary>${escapeHtml(attempt.attemptId || `Attempt ${index + 1}`)} · ${escapeHtml(compactDiffLabel(attempt.diff))}</summary>${diffPanel(attempt.diff, { id: `step-${step.id}-attempt-${index}`, actions: false })}</details>`).join("")}</details>` : ""}`;
}

const artifactBodies = new Map();
const pendingArtifactBodies = new Set();
function artifactBodyKey(ticketId, runId, artifactId) {
  return JSON.stringify([ticketId, runId || "current", artifactId]);
}
function artifactRoute(run, artifactId, suffix = "") {
  return `/api/tickets/${encodeURIComponent(run.id)}/runs/${encodeURIComponent(run.runId)}/artifacts/${encodeURIComponent(artifactId)}${suffix}`;
}
function hydrateArtifact(run, artifact) {
  const key = artifactBodyKey(run?.id, run?.runId, artifact?.id);
  if (!run?.id || !run?.runId || !artifact?.id || artifact.content != null || artifactBodies.has(key) || pendingArtifactBodies.has(key)) return;
  pendingArtifactBodies.add(key);
  api(artifactRoute(run, artifact.id, "/content")).then((result) => {
    artifactBodies.set(key, result);
    render();
  }).catch(() => {}).finally(() => pendingArtifactBodies.delete(key));
}
function artifactBody(artifact, run = runFor()) {
  return artifact.content != null ? { state: artifact.state === "truncated" ? "truncated" : "available", content: artifact.content } : artifactBodies.get(artifactBodyKey(run?.id, run?.runId, artifact?.id));
}

function artifactPreview(artifact) {
  const resource = artifactBody(artifact);
  const content = resource?.content;
  if (artifact.kind === "visual-evidence") return artifact.summary ? `<p>${escapeHtml(artifact.summary)}</p>` : `<div class="run-empty">No written summary was recorded for this evidence.</div>`;
  if (!resource) return `<div class="run-empty">Loading artifact…</div>`;
  if (resource.state !== "available" && resource.state !== "truncated") return resourceStateHtml(resource, "Artifact content");
  const truncation = resource.state === "truncated" ? `<div class="diff-warning">This retained artifact is truncated in the dashboard. Open the artifact for its full retained file.</div>` : "";
  if (artifact.kind === "git-diff") return `${truncation}${diffPanel({ available: true, patch: content }, { id: `artifact-${artifact.id}`, actions: false })}`;
  if (artifact.name.endsWith(".json")) return `${truncation}<pre><code data-language="json">${escapeHtml(formatOutput(content))}</code></pre>`;
  return `${truncation}${renderMarkdown(content)}`;
}

function artifactsPanel(step, artifacts = step ? step.artifacts || [] : runFor()?.artifacts || []) {
  const run = runFor();
  if (!artifacts.length) return `<div class="run-empty">No persisted artifacts yet.</div>`;
  if (!artifacts.some((artifact) => artifact.id === selectedArtifactId)) selectedArtifactId = artifacts[0].id;
  const selected = artifacts.find((artifact) => artifact.id === selectedArtifactId) || artifacts[0];
  if (selected.kind !== "visual-evidence" && artifactBody(selected, run) == null) hydrateArtifact(run, selected);
  return `<div class="artifact-browser"><nav class="artifact-index" aria-label="Persisted artifacts">${artifacts.map((artifact) => `<button type="button" data-select-artifact="${escapeHtml(artifact.id)}" aria-pressed="${artifact.id === selected.id}"><span><strong>${escapeHtml(artifact.name)}</strong><small>${escapeHtml(artifact.kind)}</small></span><i>${artifact.id === selected.id ? "●" : ""}</i></button>`).join("")}</nav><article class="artifact artifact-preview"><header><button class="artifact-name artifact-open" type="button" data-open-artifact="${escapeHtml(selected.id)}" title="Open in default app">${escapeHtml(selected.name)} ↗</button><span class="artifact-source">${escapeHtml(selected.kind)}</span></header><div class="artifact-body">${artifactPreview(selected)}</div></article></div>`;
}

function stageDetailsPanel(run, stage, profile, artifacts) {
  const index = run.stages.findIndex((item) => item.id === stage.id);
  const next = run.stages[index + 1];
  const milestones = stageMilestones(run, stage);
  return `<section class="stage-details"><p>${escapeHtml(stage.summary || "Waiting to start")}</p><dl><div><dt>Workflow step</dt><dd>${index + 1} of ${run.stages.length}</dd></div><div><dt>Agent profile</dt><dd>${escapeHtml(profile ? `${profile.model} · ${profile.thinking}` : "system")}</dd></div><div><dt>Saved artifacts</dt><dd>${artifacts.length}</dd></div><div><dt>Next</dt><dd>${escapeHtml(next?.title || "Complete")}</dd></div></dl>${stageStepIndexHtml(run, stage)}${stageDependencyMapHtml(run, stage)}${stage.diff?.available ? `<details class="stage-diff"><summary>Repository changes <span>${escapeHtml(compactDiffLabel(stage.diff))}</span></summary><div class="tab-panel">${diffPanel(stage.diff, { id: `stage-${stage.id}` })}</div></details>` : ""}${profile?.prompt ? `<details class="stage-guidance"><summary>Stage instructions</summary><div class="artifact-body">${renderMarkdown(profile.prompt)}</div></details>` : ""}${milestones.length ? `<details class="stage-milestones"><summary>Workflow milestones <span>${milestones.length}</span></summary>${milestoneTimelineHtml(milestones)}</details>` : ""}</section>`;
}

function resourceFallbackHtml(resource) {
  return resource?.artifact?.id && resource?.artifact?.name ? `<button class="button" type="button" data-view-artifact="${escapeHtml(resource.artifact.id)}">View retained ${escapeHtml(resource.artifact.name)}</button>` : "";
}

function resourceStateHtml(resource, label) {
  const state = resource?.state || "unavailable";
  return `<div class="attempt-resource-state state-${escapeHtml(state)}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(inspectionResourceLabel({ state }))}</span>${resourceFallbackHtml(resource)}</div>`;
}

function truncatedResourceWarning(resource, tab) {
  const label = tab === "activity" ? "Activity" : tab === "checks" ? "Check output" : tab === "trace" ? "Trace" : tab[0].toUpperCase() + tab.slice(1);
  const count = (value) => Number(value || 0).toLocaleString();
  const summary = tab === "activity"
    ? `Showing ${count(resource.returned ?? resource.items?.length)} of ${count(resource.total)} recorded events.`
    : tab === "trace"
      ? `Showing ${count(resource.returned?.events)} of ${count(resource.total?.events)} events, ${count(resource.returned?.prompts)} of ${count(resource.total?.prompts)} prompts, and ${count(resource.returned?.output)} retained output characters.`
      : `Showing ${count(resource.returned ?? resource.content?.length)} retained characters.`;
  const fallback = resourceFallbackHtml(resource);
  return `<div class="attempt-truncation-warning" role="status"><strong>${escapeHtml(label)} is truncated</strong><span>${escapeHtml(summary)} This is partial content.${fallback ? " A retained artifact is available." : " No additional retained fallback is available."}</span>${fallback}</div>`;
}

function attemptDetailContent(detail, tab) {
  if (!detail) return resourceStateHtml({ state: "loading" }, "Attempt details");
  if (detail.error) return resourceStateHtml({ state: "unavailable" }, detail.error);
  const resource = detail[tab] || { state: "unavailable" };
  if (resource.state !== "available" && resource.state !== "truncated") return resourceStateHtml(resource, tab);
  const warning = resource.state === "truncated" ? truncatedResourceWarning(resource, tab) : "";
  if (tab === "activity") return `${warning}<section class="run-events"><span class="eyebrow">Recorded activity · ${resource.total || resource.items?.length || 0} events</span><div>${(resource.items || []).map((item) => `<article class="attempt-event ${item.isError ? "warning" : ""}"><strong>${escapeHtml(item.label || item.type || "Activity")}</strong><small>${escapeHtml(item.at || "time not recorded")}</small>${item.detail || item.result ? `<pre>${escapeHtml(formatOutput(item.detail || item.result))}</pre>` : ""}</article>`).join("") || resourceStateHtml({ state: "not_retained" }, "Activity")}</div></section>`;
  if (tab === "artifacts") return resource.items?.length ? `${warning}${artifactsPanel(null, resource.items)}` : resourceStateHtml(resource, "Artifacts");
  if (tab === "diff") return `${warning}${diffPanel({ available: true, patch: resource.content || "", files: resource.files || [], stat: resource.stat || "", truncated: resource.state === "truncated" }, { id: `attempt-${selectedAttemptId}`, actions: false })}`;
  if (tab === "checks") return `${warning}<section class="attempt-checks"><dl><div><dt>Status</dt><dd>${escapeHtml(resource.status || "not recorded")}</dd></div><div><dt>Command</dt><dd>${escapeHtml(resource.command || "not retained")}</dd></div><div><dt>Summary</dt><dd>${escapeHtml(resource.summary || "No check summary retained")}</dd></div></dl>${resource.output ? `<pre>${escapeHtml(formatOutput(resource.output))}</pre>` : resourceStateHtml(resource, "Check output")}</section>`;
  if (tab === "trace") return `${warning}<section class="attempt-trace"><span class="eyebrow">Trace availability</span>${resource.content?.rawOutput ? `<pre>${escapeHtml(formatOutput(resource.content.rawOutput))}</pre>` : resourceStateHtml(resource, "Trace")}</section>`;
  return `${warning}<article class="artifact"><div class="artifact-body">${renderMarkdown(resource.content || "")}</div></article>`;
}

function liveAttemptDetail(run, step, attempt, detail) {
  const live = liveRuns.get(`${run.id}:${step?.id}`);
  if (attempt.lifecycle !== "active" || !live || live.runId !== attempt.runId) return detail;
  const events = live.events.slice(-100).map((event) => ({ ...event, label: event.label || event.type }));
  return {
    ...(detail || {}),
    prompt: live.prompt ? {
      state: live.promptTruncated ? "truncated" : "available", content: live.prompt,
      returned: live.prompt.length, total: live.promptTotal || live.prompt.length
    } : detail?.prompt,
    activity: events.length ? { state: live.events.length > 100 ? "truncated" : "available", items: events, returned: events.length, total: live.events.length } : detail?.activity,
    output: live.output ? { state: live.output.length > 20000 ? "truncated" : "available", content: live.output.slice(-20000), returned: live.output.slice(-20000).length, total: live.output.length } : detail?.output
  };
}

function liveInspectionSummary(run, step, attempt, summary) {
  const live = liveRuns.get(`${run.id}:${step?.id}`);
  if (attempt.lifecycle !== "active" || !live?.label || live.runId !== attempt.runId) return summary;
  return { ...summary, latestAction: live.label, latestActionAt: live.lastAt };
}

function canonicalAttemptInspector(run, step, projection, worker, attempt) {
  let summary = inspectionSummary({ worker, attempt });
  summary = liveInspectionSummary(run, step, attempt, summary);
  const stored = attemptDetails.get(attemptDetailKey(run, attempt));
  loadAttemptDetails(run, attempt);
  const detail = liveAttemptDetail(run, step, attempt, stored?.detail || (stored?.error ? { error: stored.error } : null));
  const tab = ["overview", "activity", "prompt", "output", "checks", "diff", "artifacts", "trace"].includes(activeTab) ? activeTab : "overview";
  const attempts = worker.attemptIds.map((id) => inspectionAttempt(id, projection)).filter(Boolean);
  const evidence = summary.evidence;
  // The canonical projection is immediately useful; detail only supplements it
  // with a bounded failure message after the attempt-detail request completes.
  const terminationReason = attempt.terminationReason || detail?.terminationReason || "not recorded";
  const failureKind = attempt.failureKind || detail?.failureKind;
  const failurePhase = attempt.failurePhase || detail?.failurePhase;
  const provenance = [failureKind, failurePhase].filter(Boolean).join(" · ") || "not recorded";
  const panel = tab === "overview" ? `<section class="attempt-overview"><dl><div><dt>Status</dt><dd>${escapeHtml(summary.status || "not started")}</dd></div><div><dt>Latest action</dt><dd>${escapeHtml(summary.latestAction)}</dd></div><div><dt>Verification</dt><dd>${escapeHtml(evidence.state || "not started")}${evidence.missing?.length ? ` · missing ${escapeHtml(evidence.missing.join(", "))}` : ""}</dd></div><div><dt>Next action</dt><dd>${escapeHtml(summary.nextAction.label)}</dd></div><div><dt>Started</dt><dd>${escapeHtml(attempt.timing?.startedAt || "not recorded")}</dd></div><div><dt>Ended</dt><dd>${escapeHtml(attempt.timing?.completedAt || "in progress")}</dd></div><div><dt>Termination</dt><dd>${escapeHtml(terminationReason)}</dd></div><div><dt>Failure provenance</dt><dd>${escapeHtml(provenance)}</dd></div></dl>${summary.blocker ? `<section class="attempt-blocker"><span class="eyebrow">Primary blocker · ${escapeHtml(summary.blocker.type)}</span><strong>${escapeHtml(summary.blocker.summary)}</strong></section>` : ""}</section>` : attemptDetailContent(detail, tab);
  return `<div class="inspector-shell worker-inspector"><header class="inspector-header"><div><span class="eyebrow">Worker · ${escapeHtml(worker.role)} · retained attempt</span><h2>${escapeHtml(worker.title)}</h2><p>${escapeHtml(worker.purpose)}</p></div><span class="run-pill status-${escapeHtml(summary.status)}">${escapeHtml(summary.status)}</span></header><section class="attempt-selector"><label for="attempt-selector">Attempt</label><select id="attempt-selector" data-attempt-select>${attempts.map((item, index) => `<option value="${escapeHtml(item.id)}" ${item.id === attempt.id ? "selected" : ""}>Attempt ${index + 1} · ${escapeHtml(item.lifecycle)} · ${escapeHtml(item.status)}</option>`).join("")}</select></section><section class="attempt-answer"><span class="eyebrow">Current answer</span><strong>${escapeHtml(summary.latestAction)}</strong>${summary.blocker ? `<small>${escapeHtml(summary.blocker.summary)}</small>` : ""}</section>${inspectorTabs([["overview", "Overview"], ["activity", "Activity"], ["prompt", "Prompt"], ["output", "Output"], ["checks", "Checks"], ["diff", "Diff"], ["artifacts", "Artifacts"], ["trace", "Trace"]], tab)}${inspectorPanel(panel)}</div>`;
}

function renderInspector() {
  diffModels.clear();
  const target = $("#inspector");
  const openEvents = new Set([...target.querySelectorAll("details.run-event[open]")].map((item) => item.dataset.eventKey));
  const openGroups = new Set([...target.querySelectorAll("details.activity-group[open]")].map((item) => item.dataset.groupKey));
  const run = runFor();
  const stage = run?.stages?.find((item) => item.id === selectedStageId);
  const step = nodeById(selectedStepId);
  if (!run) { target.innerHTML = `<div class="empty"><div><strong>Ticket details</strong>Select a tracker ticket, then start its workflow.</div></div>`; return; }
  const projection = inspectionFor(run);
  if (!projection) {
    loadInspection(run);
  } else {
    const attempt = inspectionAttempt(selectedAttemptId, projection);
    const worker = inspectionWorker(selectedWorkerId || attempt?.workerId, projection);
    if (attempt && worker && (!selectedStageId || selectedStepId)) { target.innerHTML = canonicalAttemptInspector(run, nodeById(worker.stepId), projection, worker, attempt); return; }
  }
  if (stage) {
    const profileId = ({ explore: "exploration", design: "architecture", implement: "implementation", verify: "verification" })[stage.id] || stage.id;
    const profile = run.stageProfiles?.[profileId];
    const artifacts = artifactsForStage(run.artifacts, stage.id);
    const index = run.stages.findIndex((item) => item.id === stage.id) + 1;
    const stageTab = ["activity", "prompt", "artifacts", "details", "cleanup"].includes(activeTab) ? activeTab : "activity";
    if (stageTab === "prompt") loadStagePrompts(run, stage);
    const panel = stageTab === "activity" ? stageActivityPanel(run, stage) : stageTab === "prompt" ? stagePromptPanel(run, stage) : stageTab === "artifacts" ? artifactsPanel(null, artifacts) : stageTab === "cleanup" ? cleanupInspectorHtml(run) : stageDetailsPanel(run, stage, profile, artifacts);
    target.innerHTML = `<div class="inspector-shell worker-inspector"><header class="inspector-header"><div><span class="eyebrow">Workflow stage · ${index}</span><h2>${escapeHtml(stage.title)}</h2><p>${escapeHtml(stage.summary || "Waiting to start")}</p></div><span class="run-pill status-${escapeHtml(stage.status)}">${escapeHtml(workflowStateLabel(stage.status))}</span></header>${inspectorTabs([["activity", "Activity"], ["prompt", "Prompt"], ["artifacts", "Artifacts"], ["details", "Details"], ["cleanup", "Cleanup"]], stageTab)}${inspectorPanel(panel)}<footer class="inspector-footer"><span>Run details retained locally</span><span>${escapeHtml(stage.updatedAt ? new Date(stage.updatedAt).toLocaleString() : "not started")}</span></footer></div>`;
    for (const item of target.querySelectorAll("details.run-event")) item.open = openEvents.has(item.dataset.eventKey);
    for (const item of target.querySelectorAll("details.activity-group:not(.current)")) item.open = openGroups.has(item.dataset.groupKey);
    return;
  }
  if (!step) {
    target.innerHTML = `<div class="inspector-shell"><header class="inspector-header"><div><span class="eyebrow">Isolated ticket run</span><h2>Persistent artifacts</h2></div><span class="run-pill status-${escapeHtml(run.status)}">${escapeHtml(statusLabel(run))}</span></header><div class="tab-panel">${cleanupInspectorHtml(run)}${artifactsPanel(null)}</div><footer class="inspector-footer"><span>Run details retained locally</span><span>sessions stored separately</span></footer></div>`;
    return;
  }
  const workerTab = ["overview", "run", "diff", "artifacts", "ticket", "prompt", "cleanup"].includes(activeTab) ? activeTab : "run";
  const promptArtifact = workerTab === "prompt" ? [...(run.artifacts || [])].reverse().find((artifact) => artifact.stepId === step.id && artifact.kind === "agent-prompt") : null;
  if (workerTab === "prompt") {
    loadSessionTrace(run, step);
    if (promptArtifact) hydrateArtifact(run, promptArtifact);
  }
  const promptResource = artifactBody(promptArtifact || {});
  const renderedPrompt = liveRuns.get(`${run.id}:${step.id}`)?.prompt || run.activeRuns?.[step.id]?.prompt || cachedTrace(run, step)?.prompt || promptResource?.content || null;
  const promptPanel = renderedPrompt != null
    ? `<div class="artifact"><header><span class="artifact-name">Rendered agent prompt</span></header>${promptResource?.state === "truncated" ? `<div class="diff-warning">This retained prompt is truncated in the dashboard.</div>` : ""}<div class="artifact-body">${renderMarkdown(renderedPrompt)}</div></div>`
    : promptResource ? resourceStateHtml(promptResource, "Rendered agent prompt") : `<div class="run-empty">Prompt has not been rendered yet.</div>`;
  const stepArtifacts = run.artifacts.filter((artifact) => artifact.stepId === step.id);
  const panel = workerTab === "overview" ? overviewPanel(step)
    : workerTab === "diff" ? stepDiffPanel(step)
      : workerTab === "artifacts" ? artifactsPanel(null, stepArtifacts)
        : workerTab === "ticket" ? artifactsPanel(null)
          : workerTab === "prompt" ? promptPanel
            : workerTab === "cleanup" ? cleanupInspectorHtml(run)
              : runPanel(step);
  const isolated = Boolean(step.workspace?.isolated);
  const changeLabel = step.vcsChange ? ` · jj ${step.vcsChange.changeId.slice(0, 8)} · rev ${step.vcsChange.commitId.slice(0, 8)}` : "";
  const reviewActions = !isArchivedRun(run) && step.status === "review_ready" ? run.auto
    ? `<section class="step-review-actions"><p>Auto mode is accepting this verified step. No action is needed.</p></section>`
    : (() => { const proof = proofMapView(run, { stepId: step.id }); return `<section class="step-review-actions"><p>${step.reviewBudgetResult?.exceeded ? `<strong>Manual review required:</strong> ${escapeHtml(step.reviewBudgetResult.reasons.join("; "))}.` : proof.eligibility.eligible ? "Accepting commits this step. The next batch starts after every verified item at this barrier is accepted." : `Proof gate blocked: ${escapeHtml(proof.eligibility.blockingReasons.map((reason) => reason.message).join(" "))}`}</p><details class="review-feedback"><summary>Request changes</summary><form data-request-changes="${escapeHtml(step.id)}"><textarea name="feedback" rows="3" placeholder="Describe a focused correction…" required></textarea>${correctionCriterionPicker(run, { stepId: step.id })}<button class="button" type="submit">Send changes</button></form></details><button class="button" type="button" data-accept-step="${escapeHtml(step.id)}" ${proof.eligibility.eligible ? "" : "disabled"}>Accept commit</button><button class="button success" type="button" data-auto-accept-step="${escapeHtml(step.id)}" ${proof.eligibility.eligible ? "" : "disabled"}>Accept & auto-run</button></section>`; })() : "";
  const outputLabel = isolated ? "Isolated parallel commit · accepting cherry-picks it into the ticket worktree" : "Working directory";
  const tabs = [["run","Activity"],["overview","Details"],["artifacts","Artifacts"],["diff","Diff"],["cleanup","Cleanup"]];
  const auxiliary = ({ ticket: "Ticket", prompt: "Prompt" })[workerTab];
  target.innerHTML = `<div class="inspector-shell worker-inspector"><header class="inspector-header"><div><span class="eyebrow">Current worker · ${escapeHtml(step.agentId)}</span><h2>${escapeHtml(step.title)}</h2><p>${escapeHtml(step.status === "accepted" ? "Completed successfully." : step.status === "review_ready" ? "Ready for review." : stepInspectorSummary(step).needsAttention ? "Needs attention before the workflow can continue." : step.description || "Worker summary and evidence.")}</p></div><span class="run-pill status-${escapeHtml(step.status)}">${escapeHtml(step.status.replaceAll("_", " "))}</span></header>${inspectorTabs(auxiliary ? [...tabs, [workerTab, auxiliary]] : tabs, workerTab)}${inspectorPanel(panel)}${reviewActions}<footer class="inspector-footer"><span>${outputLabel}${run.workspace?.cwd ? "" : " pending approval"}</span><span title="${escapeHtml(`${step.contextPolicy} context · ${step.permission} permission · ${step.status.replaceAll("_", " ")}${changeLabel}`)}">${escapeHtml(step.contextPolicy)} · ${escapeHtml(step.permission)}</span></footer></div>`;
  for (const item of target.querySelectorAll("details.run-event")) item.open = openEvents.has(item.dataset.eventKey);
  for (const item of target.querySelectorAll("details.activity-group:not(.current)")) item.open = openGroups.has(item.dataset.groupKey);
}

async function loadSessionTrace(run, step) {
  if (isArchivedRun(run)) return;
  const key = `${runIdentity(run)}:${step.id}`;
  const sessionFile = step.sessionFile;
  const requestKey = `${key}:${sessionFile}`;
  if (!sessionFile || cachedTrace(run, step) || pendingSessionTraces.has(requestKey)) return;
  pendingSessionTraces.add(requestKey);
  try {
    const trace = await api(`/api/tickets/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(step.id)}/session-trace`);
    if (nodeById(step.id, runFor()?.plan)?.sessionFile !== sessionFile) return;
    sessionTraces.set(key, { sessionFile, trace });
    if (run.id === runFor()?.id && step.id === selectedStepId) {
      if (activeTab === "run") refreshLiveRun({ events: true });
      else if (activeTab === "prompt") renderInspectorPreservingContext();
    }
  } catch (error) {
    sessionTraces.set(key, { sessionFile, trace: { prompt: "", rawOutput: "", events: [] } });
    notify(error.message);
  }
  finally { pendingSessionTraces.delete(requestKey); }
}

async function loadStagePrompts(run, stage) {
  const key = `${runIdentity(run)}:${stage.id}`;
  const signature = stagePromptSignature(run, stage);
  const requestKey = `${key}:${signature}`;
  if (cachedStagePrompts(run, stage) || pendingStagePromptTraces.has(requestKey)) return;
  pendingStagePromptTraces.add(requestKey);
  try {
    const result = await api(`/api/tickets/${encodeURIComponent(run.id)}/runs/${encodeURIComponent(run.runId)}/stages/${encodeURIComponent(stage.id)}/prompts`);
    stagePromptTraces.set(key, { signature, prompts: result.prompts || [], trace: result.trace || null });
    if (run.id === runFor()?.id && stage.id === selectedStageId && activeTab === "prompt") renderInspectorPreservingContext();
  } catch (error) {
    stagePromptTraces.set(key, { signature, prompts: [] });
    notify(error.message);
  } finally { pendingStagePromptTraces.delete(requestKey); }
}

function hydrateDiffHunk(target) {
  if (!target || target.dataset.hydrated) return;
  const model = diffModels.get(target.dataset.diffView);
  const hunk = model?.files?.[Number(target.dataset.diffFileIndex)]?.hunks?.[Number(target.dataset.diffHunkIndex)];
  if (!hunk) return;
  target.insertAdjacentHTML("beforeend", diffRows(hunk.rows, hunk.reviewNotes, model.feedbackFormId));
  target.dataset.hydrated = "true";
}

function jumpToDiff(target) {
  const view = target.dataset.diffJump;
  const model = diffModels.get(view);
  let fileIndex = Number(target.dataset.diffFileIndex);
  if (!Number.isInteger(fileIndex) && target.dataset.diffFileName) fileIndex = model?.files?.findIndex((file) => file.name === target.dataset.diffFileName);
  const file = [...document.querySelectorAll("details.diff-file")].find((item) => item.dataset.diffView === view && Number(item.dataset.diffFileIndex) === fileIndex);
  if (!file) return;
  file.open = true;
  const hunkIndex = Number(target.dataset.diffHunkIndex);
  const hunks = [...file.querySelectorAll("details.diff-hunk")];
  const hunk = Number.isInteger(hunkIndex) ? hunks.find((item) => Number(item.dataset.diffHunkIndex) === hunkIndex) : hunks[0];
  if (hunk) { hunk.open = true; hydrateDiffHunk(hunk); }
  (hunk || file).scrollIntoView({ behavior: "smooth", block: "start" });
}

function setDiffExpanded(expanded) {
  diffExpanded = expanded;
  $("#inspector")?.classList.toggle("diff-expanded", expanded);
  document.body.classList.toggle("diff-expanded-open", expanded);
  for (const button of document.querySelectorAll("[data-expand-diff]")) button.textContent = expanded ? "Collapse" : "Expand";
}

document.addEventListener("toggle", (event) => {
  const rawOutput = event.target.closest?.("details[data-load-session-trace]");
  if (rawOutput?.open) {
    const run = runFor();
    const step = nodeById(rawOutput.dataset.loadSessionTrace);
    if (run && step) loadSessionTrace(run, step);
    return;
  }
  const hunk = event.target.closest?.("details.diff-hunk");
  if (hunk?.open) { hydrateDiffHunk(hunk); return; }
  const file = event.target.closest?.("details.diff-file");
  if (file?.open) {
    const first = file.querySelector("details.diff-hunk");
    if (first) { first.open = true; hydrateDiffHunk(first); }
  }
}, true);
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && diffExpanded) setDiffExpanded(false); });

function clarificationDraft() {
  const form = document.querySelector("form[data-clarify]");
  if (!form) return null;
  const focused = document.activeElement?.form === form ? document.activeElement : null;
  return {
    checkpointId: form.dataset.checkpointId,
    answers: [...new FormData(form).entries()],
    focus: focused ? { name: focused.name, start: focused.selectionStart, end: focused.selectionEnd } : null
  };
}

function restoreClarificationDraft(draft) {
  if (!draft) return;
  const form = document.querySelector(`form[data-clarify][data-checkpoint-id="${CSS.escape(draft.checkpointId)}"]`);
  if (!form) return;
  for (const [name, value] of draft.answers) form.elements[name].value = value;
  const focused = draft.focus && form.elements[draft.focus.name];
  if (focused) { focused.focus(); focused.setSelectionRange(draft.focus.start, draft.focus.end); }
}

function disclosureKey(item, index) {
  return JSON.stringify([item.className, item.dataset.groupKey, item.dataset.eventKey, item.dataset.diffView, item.dataset.diffFileIndex, item.dataset.diffHunkIndex, index]);
}

function renderContext() {
  const headerActionKeys = ["startTicket", "resumeTicket", "restartTicket", "startFresh", "pauseTicket", "cancelTicket", "selectStep", "approveTicket", "autoTicket"];
  const focus = document.activeElement?.closest?.("[data-rail-step], [data-ticket], [data-attempt-select], [data-stage], [data-step], [data-attempt], [data-tab], button[data-start-ticket], button[data-resume-ticket], button[data-restart-ticket], button[data-start-fresh], button[data-pause-ticket], button[data-cancel-ticket], button[data-select-step], button[data-approve-ticket], button[data-auto-ticket]");
  const focusData = focus?.dataset;
  const headerAction = Object.entries(focusData || {}).find(([key]) => headerActionKeys.includes(key));
  const headerSelector = headerAction && `[data-${headerAction[0].replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${CSS.escape(headerAction[1])}"]`;
  const focusSelector = headerSelector || (focusData?.railStep ? `[data-rail-step="${CSS.escape(focusData.railStep)}"][data-ticket="${CSS.escape(focusData.ticket)}"]`
    : focusData?.ticket ? `[data-ticket="${CSS.escape(focusData.ticket)}"]`
      : focusData && "attemptSelect" in focusData ? "[data-attempt-select]"
        : focusData?.stage ? `[data-stage="${CSS.escape(focusData.stage)}"]`
          : focusData?.step ? `[data-step="${CSS.escape(focusData.step)}"]`
            : focusData?.attempt ? `[data-attempt="${CSS.escape(focusData.attempt)}"]`
              : focusData?.tab ? `[role="tab"][data-tab="${CSS.escape(focusData.tab)}"]` : null);
  const details = (root) => [...root.querySelectorAll("details[open]")].map(disclosureKey);
  return {
    planScroll: $("#plan-tree")?.scrollTop || 0,
    inspectorScroll: $("#inspector")?.scrollTop || 0,
    planDetails: details($("#plan-tree")), inspectorDetails: details($("#inspector")), focusSelector
  };
}

function restoreRenderContext(context) {
  const restoreDetails = (root, keys) => [...root.querySelectorAll("details")].forEach((item, index) => { item.open = keys.includes(disclosureKey(item, index)); });
  const plan = $("#plan-tree");
  const inspector = $("#inspector");
  restoreDetails(plan, context.planDetails);
  restoreDetails(inspector, context.inspectorDetails);
  plan.scrollTop = context.planScroll;
  inspector.scrollTop = context.inspectorScroll;
  context.focusSelector && document.querySelector(context.focusSelector)?.focus({ preventScroll: true });
}

function renderInspectorPreservingContext() {
  const context = renderContext();
  renderInspector();
  restoreRenderContext(context);
}

function render() {
  if (!state) return;
  const context = renderContext();
  const draft = clarificationDraft();
  $("#workspace-path").value = state.workspace?.cwd || "";
  // The workspace location is selected only in the explicit picker; its normal
  // dashboard control must not disclose a local filesystem path.
  $("#workspace-path-display").textContent = "Local workspace";
  $("#workspace-settings").title = "Select repository";
  const run = runFor();
  loadInspection(run);
  if (!deliberateSelection && !inspectionFor(run) && !selectedStageId && !selectedStepId) selectedStageId = preferredStageId(run?.stages);
  if (checkpointUsesWorkspace(run) && !selectedStageId) {
    selectedStepId = null;
    selectedStageId = run.stages?.find((stage) => ["blocked", "active", "paused"].includes(stage.status))?.id || run.stages?.[0]?.id || null;
  }
  if (!selectedStageId && !selectedStepId && !inspectionFor(run)) selectedStageId = preferredStageId(run?.stages);
  if (!selectedStageId && !selectedStepId && !inspectionFor(run)) selectedStepId = preferredStepId(run?.plan, selectedStepId);
  renderTickets();
  renderHeader();
  renderPlanTree();
  renderInspector();
  restoreRenderContext(context);
  restoreClarificationDraft(draft);
}

function renderSelection() {
  for (const agent of document.querySelectorAll(".rail-agent")) {
    agent.classList.toggle("on", agent.dataset.ticket === state.selectedTicketId && agent.dataset.railStep === selectedStepId);
  }
  renderPlanTree();
  renderInspector();
}

function selectTicket(ticketId, stepId = null, persist = true) {
  state.selectedTicketId = ticketId;
  deliberateSelection = Boolean(stepId);
  selectedStepId = stepId;
  selectedStageId = null;
  selectedStageKey = null;
  selectedWorkerId = stepId ? `worker:${stepId}` : null;
  selectedAttemptId = null;
  selectedRunId = null;
  selectedArtifactId = null;
  activeTab = stepId ? "run" : "activity";
  const cachedProjection = inspectionFor(runFor(ticketId));
  if (cachedProjection) syncInspectionSelection(cachedProjection);
  rememberView();
  render();
  if (!persist) return;
  const selection = ++latestTicketSelection;
  pendingTicketSelections++;
  const request = persist
    ? api(`/api/tickets/${encodeURIComponent(ticketId)}/select`, { method: "POST", body: "{}" })
    : api("/api/state").then((next) => ({ ...next, run: next.ticketRuns?.[ticketId] }));
  request
    .then((result) => {
      if (selection !== latestTicketSelection) return;
      if (!persist) state = result;
      else {
        state.selectedTicketId = result.selectedTicketId;
        if (result.run) state.ticketRuns[ticketId] = result.run;
      }
      selectedStepId = stepId;
      selectedStageId = null;
      selectedArtifactId = null;
      activeTab = stepId ? "run" : "activity";
      rememberView();
      render();
    })
    .catch(async (error) => {
      try { if (selection === latestTicketSelection) { state = await api("/api/state"); render(); } }
      catch {}
      notify(error.message);
    })
    .finally(() => { pendingTicketSelections--; });
}

async function refreshTickets() {
  $("#refresh-tickets").classList.add("spinning");
  try { ticketSources = await api("/api/tickets"); render(); }
  catch (error) { ticketSources = { configured: false, viewer: null, sources: [], tickets: [] }; notify(error.message); render(); }
  finally { $("#refresh-tickets").classList.remove("spinning"); }
}

function reviewCards(formId) {
  return [...document.querySelectorAll(".review-note")].filter((card) => card.dataset.reviewForm === formId);
}

function updateReviewQueue(formId) {
  const form = document.getElementById(formId);
  if (!form) return;
  const count = reviewCards(formId).filter((card) => card.dataset.queued === "true").length;
  form.querySelector("[data-review-queue-count]").textContent = count ? `${count} code change${count === 1 ? "" : "s"} ready to send.` : "No code changes queued yet.";
  form.querySelector("[data-send-note-review]").disabled = !count;
}

document.addEventListener("click", async (event) => {
  const addNote = event.target.closest("[data-add-note-review]");
  if (addNote) {
    const card = addNote.closest(".review-note");
    const queued = card.dataset.queued === "true";
    if (!queued && !card.querySelector("textarea").value.trim()) { notify("Describe the rewrite first"); return; }
    card.dataset.queued = queued ? "false" : "true";
    card.classList.toggle("queued", !queued);
    addNote.textContent = queued ? "Queue code change" : "Undo";
    updateReviewQueue(addNote.dataset.reviewForm);
    return;
  }
  if (event.target.closest("[data-expand-diff]")) { setDiffExpanded(!diffExpanded); return; }
  const diffJump = event.target.closest("[data-diff-jump]");
  if (diffJump) { jumpToDiff(diffJump); return; }
  const generateReviewMap = event.target.closest("[data-generate-review-map]");
  if (generateReviewMap) {
    generateReviewMap.disabled = true;
    generateReviewMap.textContent = "Generating review map…";
    try {
      const result = await api(`/api/tickets/${encodeURIComponent(runFor().id)}/steps/${encodeURIComponent(generateReviewMap.dataset.generateReviewMap)}/review-map`, { method: "POST", body: "{}" });
      state = result.state;
      render();
      notify("Semantic review map generated");
    } catch (error) { generateReviewMap.disabled = false; generateReviewMap.textContent = "Generate semantic review map"; notify(error.message); }
    return;
  }
  if (event.target.closest("#tracker-settings")) {
    try { await openTrackerSettings(); } catch (error) { notify(error.message); }
    return;
  }
  if (event.target.closest("#retention-open")) {
    try { await openRetention(); } catch (error) { notify(error.message); }
    return;
  }
  if (event.target.closest("#retention-close")) { $("#retention-dialog").close(); return; }
  const retentionSelect = event.target.closest("[data-retention-select]");
  if (retentionSelect) {
    const mode = retentionSelect.dataset.retentionSelect;
    const project = $("#retention-project").value;
    const cutoff = Number(mode) ? Date.now() - Number(mode) * 86400000 : null;
    for (const checkbox of $("#retention-list").querySelectorAll("[data-retention-ticket]")) {
      const item = retention.items.find((candidate) => candidate.ticketId === checkbox.dataset.retentionTicket);
      checkbox.checked = mode === "all" || (mode === "project" && project && item.project === project) || (cutoff && Date.parse(item.completedAt || item.createdAt || Date.now()) < cutoff);
    }
    cleanupArmed = false;
    const selected = [...$("#retention-list").querySelectorAll("[data-retention-ticket]:checked")];
    $("#cleanup-retention").disabled = !selected.length;
    $("#cleanup-retention").textContent = "Clean selected";
    return;
  }
  const retentionCheck = event.target.closest("[data-retention-ticket]");
  if (retentionCheck) {
    cleanupArmed = false;
    const selected = [...$("#retention-list").querySelectorAll("[data-retention-ticket]:checked")];
    $("#cleanup-retention").disabled = !selected.length;
    $("#cleanup-retention").textContent = "Clean selected";
    return;
  }
  const cleanup = event.target.closest("#cleanup-retention");
  if (cleanup) {
    const ticketIds = [...$("#retention-list").querySelectorAll("[data-retention-ticket]:checked")].map((item) => item.dataset.retentionTicket);
    const bytes = retention.items.filter((item) => ticketIds.includes(item.ticketId)).reduce((total, item) => total + item.bytes, 0);
    if (!cleanupArmed) {
      cleanupArmed = true;
      cleanup.textContent = `Confirm ${byteSize(bytes)} cleanup`;
      return;
    }
    cleanup.disabled = true;
    try {
      const result = await api("/api/retention/cleanup", { method: "POST", body: JSON.stringify({ ticketIds, confirmed: true }) });
      state = result.state;
      retention = result.inventory;
      renderRetention(); render();
      notify(`${result.cleaned.length} retained run${result.cleaned.length === 1 ? "" : "s"} cleaned`);
    } catch (error) { notify(error.message); cleanup.disabled = false; }
    return;
  }
  const viewArtifact = event.target.closest("[data-view-artifact]");
  if (viewArtifact) {
    selectedArtifactId = viewArtifact.dataset.viewArtifact;
    activeTab = "artifacts";
    rememberView(); renderInspector();
    return;
  }
  const openArtifact = event.target.closest("[data-open-artifact]");
  if (openArtifact) {
    const run = runFor();
    try { await api(artifactRoute(run, openArtifact.dataset.openArtifact, "/open"), { method: "POST", body: "{}" }); notify("Opened in the default app"); }
    catch (error) { notify(error.message); }
    return;
  }
  const clearButton = event.target.closest("#clear-queue");
  if (clearButton) {
    if (!clearArmed) {
      clearArmed = true;
      clearButton.textContent = "Confirm";
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => { clearArmed = false; clearButton.textContent = "Clear"; }, 4000);
      return;
    }
    clearTimeout(clearTimer);
    clearArmed = false;
    clearButton.disabled = true;
    clearButton.textContent = "Clearing…";
    try {
      const before = new Set([...Object.keys(state.ticketRuns || {}), ...ticketSources.tickets.map((ticket) => ticket.id)]);
      const result = await api("/api/queue/clear", { method: "POST", body: "{}" });
      state = result.state;
      ticketSources.tickets = ticketSources.tickets.filter((ticket) => state.ticketRuns[ticket.id]);
      const cleared = before.size - new Set([...Object.keys(state.ticketRuns), ...ticketSources.tickets.map((ticket) => ticket.id)]).size;
      selectedStepId = null; selectedStageId = null; rememberView(); render(); notify(`${cleared} queue item${cleared === 1 ? "" : "s"} removed`);
    } catch (error) { notify(error.message); }
    finally { clearButton.disabled = false; clearButton.textContent = "Clear"; }
    return;
  }
  const forget = event.target.closest("[data-forget-ticket]");
  if (forget) {
    const id = forget.dataset.forgetTicket;
    if (forgetArmed !== id) {
      forgetArmed = id;
      forget.textContent = "Confirm forget";
      clearTimeout(forgetTimer);
      forgetTimer = setTimeout(() => { forgetArmed = null; renderTickets(); }, 4000);
      return;
    }
    clearTimeout(forgetTimer);
    forgetArmed = null;
    forget.disabled = true;
    try {
      const result = await api(`/api/tickets/${encodeURIComponent(id)}/forget`, { method: "POST", body: JSON.stringify({ confirmed: true }) });
      state = result.state;
      ticketSources.tickets = ticketSources.tickets.filter((ticket) => ticket.id !== id);
      selectedStepId = null; selectedStageId = null; selectedArtifactId = null; rememberView(); render(); notify("Run forgotten");
    } catch (error) { forget.disabled = false; notify(error.message); }
    return;
  }
  const railStep = event.target.closest("[data-rail-step]");
  if (railStep) {
    if (railStep.dataset.ticket !== state.selectedTicketId) {
      selectTicket(railStep.dataset.ticket, railStep.dataset.railStep);
      return;
    }
    deliberateSelection = true;
    selectedStepId = railStep.dataset.railStep;
    selectedStageId = null;
    selectedWorkerId = `worker:${selectedStepId}`;
    selectedStageKey = inspectionWorker(selectedWorkerId)?.stageId || null;
    selectedAttemptId = inspectionWorker(selectedWorkerId)?.attemptIds.at(-1) || null;
    selectedRunId = inspectionFor()?.runId || null;
    selectedArtifactId = null;
    activeTab = "overview";
    rememberView();
    renderSelection();
    return;
  }
  const ticketButton = event.target.closest("[data-ticket]");
  if (ticketButton) {
    selectTicket(ticketButton.dataset.ticket);
    return;
  }
  const start = event.target.closest("[data-start-ticket]");
  if (start) {
    const ticket = ticketSources.tickets.find((item) => item.id === start.dataset.startTicket);
    try { await api(`/api/tickets/${encodeURIComponent(ticket.id)}/start`, { method: "POST", body: JSON.stringify({ ticket }) }); notify(`${ticket.identifier} requirements clarification started`); }
    catch (error) { notify(error.message); }
    return;
  }
  const resume = event.target.closest("[data-resume-ticket]");
  if (resume) {
    try {
      activeTab = "run"; rememberView(); renderInspector();
      await api(`/api/tickets/${encodeURIComponent(resume.dataset.resumeTicket)}/resume`, { method: "POST", body: "{}" });
      notify("Worker retry started");
    }
    catch (error) { notify(error.message); }
    return;
  }
  const restart = event.target.closest("[data-restart-ticket]");
  if (restart) { openRestartDialog(); return; }
  const fresh = event.target.closest("[data-start-fresh]");
  if (fresh) { openRestartDialog("fresh"); return; }
  const pause = event.target.closest("[data-pause-ticket]");
  if (pause) {
    try { await api(`/api/tickets/${encodeURIComponent(pause.dataset.pauseTicket)}/pause`, { method: "POST", body: "{}" }); notify("Run paused; session and activity saved"); }
    catch (error) { notify(error.message); }
    return;
  }
  const cancel = event.target.closest("[data-cancel-ticket]");
  if (cancel) {
    try { await api(`/api/tickets/${encodeURIComponent(cancel.dataset.cancelTicket)}/cancel`, { method: "POST", body: "{}" }); notify("Run cancelled"); }
    catch (error) { notify(error.message); }
    return;
  }
  const approve = event.target.closest("[data-approve-ticket]");
  if (approve) {
    try { await api(`/api/tickets/${encodeURIComponent(approve.dataset.approveTicket)}/approve`, { method: "POST", body: "{}" }); notify("Plan approved; agents are running"); }
    catch (error) { notify(error.message); }
    return;
  }
  const auto = event.target.closest("[data-auto-ticket]");
  if (auto) {
    try { await api(`/api/tickets/${encodeURIComponent(auto.dataset.autoTicket)}/approve`, { method: "POST", body: JSON.stringify({ auto: true }) }); notify("Auto mode started; verified commits will advance automatically"); }
    catch (error) { notify(error.message); }
    return;
  }
  const editPlan = event.target.closest("[data-edit-plan]");
  if (editPlan) {
    $("#plan-json").value = JSON.stringify(runFor(editPlan.dataset.editPlan)?.plan, null, 2);
    $("#plan-json-error").textContent = "";
    $("#plan-dialog").showModal();
    return;
  }
  const approveContext = event.target.closest("[data-approve-context]");
  if (approveContext) {
    try { await api(`/api/tickets/${encodeURIComponent(approveContext.dataset.approveContext)}/context/approve`, { method: "POST", body: "{}" }); notify("Context approved; added to the merge queue"); }
    catch (error) { notify(error.message); }
    return;
  }
  const approveEvidence = event.target.closest("[data-approve-evidence]");
  if (approveEvidence) {
    approveEvidence.disabled = true;
    approveEvidence.textContent = "Delivering…";
    try { await api(`/api/tickets/${encodeURIComponent(approveEvidence.dataset.approveEvidence)}/evidence/approve`, { method: "POST", body: "{}" }); notify("Proof approved; delivery started"); }
    catch (error) { approveEvidence.disabled = false; approveEvidence.textContent = "Approve & deliver"; notify(error.message); }
    return;
  }
  const proofStep = event.target.closest("[data-proof-step]");
  if (proofStep) { selectedStepId = proofStep.dataset.proofStep; selectedStageId = null; activeTab = proofStep.dataset.proofTab || "run"; rememberView(); render(); return; }
  const selectStep = event.target.closest("[data-select-step]");
  if (selectStep) { deliberateSelection = true; selectedStepId = selectStep.dataset.selectStep; selectedStageId = null; selectedWorkerId = `worker:${selectedStepId}`; selectedStageKey = inspectionWorker(selectedWorkerId)?.stageId || null; selectedAttemptId = inspectionWorker(selectedWorkerId)?.attemptIds.at(-1) || null; selectedRunId = inspectionFor()?.runId || null; activeTab = "overview"; rememberView(); render(); return; }
  const autoAcceptStep = event.target.closest("[data-auto-accept-step]");
  if (autoAcceptStep) {
    autoAcceptStep.disabled = true;
    autoAcceptStep.textContent = "Starting auto mode…";
    try { await api(`/api/tickets/${encodeURIComponent(runFor().id)}/steps/${encodeURIComponent(autoAcceptStep.dataset.autoAcceptStep)}/accept`, { method: "POST", body: JSON.stringify({ auto: true }) }); notify("Step accepted; later verified commits will advance automatically"); }
    catch (error) { autoAcceptStep.disabled = false; autoAcceptStep.textContent = "Accept & auto-run"; notify(error.message); }
    return;
  }
  const acceptStep = event.target.closest("[data-accept-step]");
  if (acceptStep) {
    acceptStep.disabled = true;
    acceptStep.textContent = "Accepting…";
    try { await api(`/api/tickets/${encodeURIComponent(runFor().id)}/steps/${encodeURIComponent(acceptStep.dataset.acceptStep)}/accept`, { method: "POST", body: "{}" }); notify("Step accepted; continuing to the next slice"); }
    catch (error) { acceptStep.disabled = false; acceptStep.textContent = "Accept commit"; notify(error.message); }
    return;
  }
  const stage = event.target.closest("[data-stage]");
  if (stage) { deliberateSelection = true; selectedStageId = stage.dataset.stage; selectedStageKey = `stage:${selectedStageId}`; selectedStepId = null; selectedWorkerId = null; selectedAttemptId = null; selectedRunId = inspectionFor()?.runId || null; selectedArtifactId = null; activeTab = "activity"; rememberView(); renderSelection(); return; }
  const attemptButton = event.target.closest("[data-attempt]");
  if (attemptButton) { deliberateSelection = true; selectedAttemptId = attemptButton.dataset.attempt; selectedWorkerId = attemptButton.dataset.worker; selectedStepId = inspectionWorker(selectedWorkerId)?.stepId || selectedStepId; selectedStageId = null; selectedStageKey = inspectionAttempt(selectedAttemptId)?.stageId || null; selectedRunId = inspectionFor()?.runId || null; selectedArtifactId = null; activeTab = "overview"; rememberView(); renderSelection(); return; }
  const step = event.target.closest("[data-step]");
  if (step) { deliberateSelection = true; selectedStepId = step.dataset.step; selectedStageId = null; selectedWorkerId = `worker:${step.dataset.step}`; selectedStageKey = inspectionWorker(selectedWorkerId)?.stageId || null; selectedAttemptId = inspectionWorker(selectedWorkerId)?.attemptIds.at(-1) || null; selectedRunId = inspectionFor()?.runId || null; selectedArtifactId = null; activeTab = "overview"; rememberView(); renderSelection(); return; }
  const artifact = event.target.closest("[data-select-artifact]");
  if (artifact) { selectedArtifactId = artifact.dataset.selectArtifact; renderInspector(); return; }
  const tab = event.target.closest("[data-tab]");
  if (tab) { activeTab = tab.dataset.tab; rememberView(); renderInspector(); }
  if (event.target.closest("#workspace-settings")) $("#workspace-dialog").showModal();
  if (event.target.closest("#pick-workspace")) {
    try { $("#workspace-path").value = (await api("/api/workspace/pick", { method: "POST", body: "{}" })).cwd; }
    catch (error) { if (!/cancelled/i.test(error.message)) notify(error.message); }
  }
  if (event.target.closest("#free-text-open")) $("#free-text-dialog").showModal();
  if (event.target.closest("#local-load-open")) {
    $("#free-text-dialog").close();
    $("#local-load-dialog").showModal();
  }
  if (event.target.closest("#profile-settings")) { renderProfiles(); $("#profiles-dialog").showModal(); }
  if (event.target.closest("#close-profiles")) $("#profiles-dialog").close();
  if (event.target.closest("[data-close-plan]")) $("#plan-dialog").close();
  const queueToggle = event.target.closest("#toggle-ticket-pane");
  if (queueToggle) {
    const collapsed = $(".ticket-layout").classList.toggle("sidebar-collapsed");
    queueToggle.setAttribute("aria-expanded", String(!collapsed));
    queueToggle.setAttribute("aria-label", collapsed ? "Show tickets" : "Hide tickets");
    queueToggle.title = collapsed ? "Show tickets" : "Hide tickets";
    queueToggle.textContent = collapsed ? "›" : "‹";
    requestAnimationFrame(() => runFor()?.plan && renderPlanTree());
  }
});

document.addEventListener("change", (event) => {
  const history = event.target.closest("[data-run-history]");
  if (history) {
    selectedRunId = history.value;
    deliberateSelection = false;
    selectedStepId = null;
    selectedStageId = null;
    selectedStageKey = null;
    selectedWorkerId = null;
    selectedAttemptId = null;
    selectedArtifactId = null;
    activeTab = "activity";
    const cachedProjection = inspectionFor(runFor());
    if (cachedProjection) syncInspectionSelection(cachedProjection);
    rememberView();
    render();
    return;
  }
  const selector = event.target.closest("[data-attempt-select]");
  if (!selector) return;
  deliberateSelection = true;
  const projection = inspectionFor();
  const attempt = inspectionAttempt(selector.value, projection);
  selectedAttemptId = attempt?.id || null;
  selectedWorkerId = attempt?.workerId || null;
  selectedStepId = inspectionWorker(selectedWorkerId, projection)?.stepId || selectedStepId;
  selectedStageId = null;
  selectedStageKey = attempt?.stageId || null;
  selectedRunId = projection?.runId || null;
  activeTab = "overview";
  rememberView();
  renderSelection();
});

document.addEventListener("keydown", (event) => {
  const tab = event.target.closest?.('[role="tab"]');
  const tablist = tab?.closest?.('[role="tablist"]');
  if (!tab || !tablist || event.altKey || event.ctrlKey || event.metaKey) return;
  const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: "first", End: "last" };
  if (!(event.key in keys)) return;
  event.preventDefault();
  const tabs = [...tablist.querySelectorAll(':scope > [role="tab"], :scope > * > [role="tab"]')];
  const index = tabs.indexOf(tab);
  const nextIndex = keys[event.key] === "first" ? 0 : keys[event.key] === "last" ? tabs.length - 1 : (index + keys[event.key] + tabs.length) % tabs.length;
  const next = tabs[nextIndex];
  const label = tablist.getAttribute("aria-label");
  next?.click();
  requestAnimationFrame(() => document.querySelector(`[role="tablist"][aria-label="${CSS.escape(label)}"] [role="tab"][aria-selected="true"]`)?.focus({ preventScroll: true }));
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "restart-form") {
    event.preventDefault();
    const data = new FormData(event.target);
    const ticketId = data.get("ticketId");
    const target = data.get("target");
    const submit = event.target.querySelector("button[type=submit]");
    submit.disabled = true;
    $("#restart-dialog").close();
    try {
      await api(`/api/tickets/${encodeURIComponent(ticketId)}/restart`, { method: "POST", body: JSON.stringify({ target, confirmed: data.get("confirmed") === "on" }) });
      selectedStepId = null; selectedStageId = null; activeTab = "activity"; rememberView();
      notify(target === "fresh" ? "Fresh run started; the previous run was archived" : "Checkpoint restored; restart launched");
    } catch (error) { notify(error.message); }
    finally { submit.disabled = false; }
    return;
  }
  if (event.target.id === "tracker-form") {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const input = {
      linearApiKey: data.get("linearApiKey"), clearLinear: data.get("clearLinear") === "on",
      clearJira: data.get("clearJira") === "on"
    };
    if (trackerSettings?.jira.stored || data.get("jiraApiToken")) Object.assign(input, {
      jiraBaseUrl: data.get("jiraBaseUrl"), jiraEmail: data.get("jiraEmail"),
      jiraApiToken: data.get("jiraApiToken"), jiraEpicKey: data.get("jiraEpicKey")
    });
    try {
      const result = await api("/api/tracker-settings", { method: "POST", body: JSON.stringify(input) });
      trackerSettings = result.settings;
      ticketSources = result.ticketSources;
      $("#tracker-dialog").close(); render(); notify("Tracker credentials saved and connection refreshed");
    } catch (error) { notify(error.message); }
    return;
  }
  if (event.target.id === "workspace-form") {
    event.preventDefault();
    try { state = await api("/api/workspace", { method: "POST", body: JSON.stringify({ cwd: $("#workspace-path").value }) }); $("#workspace-dialog").close(); await refreshTickets(); }
    catch (error) { notify(error.message); }
    return;
  }
  if (event.target.id === "free-text-form") {
    event.preventDefault();
    try {
      const ticket = freeTextTicket(new FormData(event.target).get("description"), crypto.randomUUID());
      await api(`/api/tickets/${encodeURIComponent(ticket.id)}/start`, { method: "POST", body: JSON.stringify({ ticket }) });
      $("#free-text-dialog").close(); event.target.reset(); notify(`${ticket.identifier} requirements clarification started`);
    } catch (error) { notify(error.message); }
    return;
  }
  if (event.target.id === "profiles-form") {
    event.preventDefault();
    const data = new FormData(event.target);
    const profiles = Object.fromEntries(profileIds.map((id) => [id, {
      model: data.get(`${id}-model`), thinking: data.get(`${id}-thinking`), prompt: data.get(`${id}-prompt`)
    }]));
    try {
      const settings = {
        projectMode: data.get("projectMode"),
        pollIntervalSeconds: Number(data.get("pollIntervalSeconds"))
      };
      state = await api("/api/stage-profiles", { method: "POST", body: JSON.stringify({ profiles, settings }) });
      $("#profiles-dialog").close(); render(); notify("Stage profiles saved for new runs");
    } catch (error) { notify(error.message); }
    return;
  }
  if (event.target.id === "plan-form") {
    event.preventDefault();
    try {
      const plan = JSON.parse($("#plan-json").value);
      state = await api(`/api/tickets/${encodeURIComponent(runFor().id)}/plan`, { method: "POST", body: JSON.stringify({ plan }) });
      $("#plan-dialog").close();
      render();
      notify("Execution graph saved and validated");
    } catch (error) { $("#plan-json-error").textContent = error.message; }
    return;
  }
  const continueWorkflow = event.target.dataset.continueWorkflow;
  if (continueWorkflow) {
    event.preventDefault();
    const responseText = String(new FormData(event.target).get("response") || "Approved");
    try {
      const result = await api(`/api/tickets/${encodeURIComponent(continueWorkflow)}/workflow/continue`, { method: "POST", body: JSON.stringify({ checkpointId: event.target.dataset.checkpointId, response: responseText }) });
      state = result.state;
      render();
      notify("Supervisor workflow continued");
    } catch (error) { notify(error.message); }
    return;
  }
  if (event.target.id === "local-load") {
    event.preventDefault();
    const path = new FormData(event.target).get("path");
    try {
      const result = await api("/api/local/load", { method: "POST", body: JSON.stringify({ path }) });
      state = result.state; selectedStepId = null; selectedStageId = null; activeTab = "activity"; rememberView();
      $("#local-load-dialog").close();
      render(); notify("Local zero-state fixture loaded");
    } catch (error) { notify(error.message); }
    return;
  }
  const ticketId = event.target.dataset.clarify;
  if (ticketId) {
    event.preventDefault();
    const answers = [...new FormData(event.target).entries()].filter(([, value]) => String(value).trim()).map(([key, value]) => `${Number(key.split("-")[1]) + 1}. ${value}`).join("\n\n");
    const requirementsReview = runFor(ticketId)?.checkpoint?.kind === "requirements_review";
    try { await api(`/api/tickets/${encodeURIComponent(ticketId)}/clarify`, { method: "POST", body: JSON.stringify({ answers }) }); notify(requirementsReview ? (answers ? "Answers sent; requirements are being revised" : "Requirements approved; isolated exploration started") : "Technical decision sent; design is being prepared"); }
    catch (error) { notify(error.message); }
  }
  const noteStepId = event.target.dataset.requestNoteChanges;
  if (noteStepId) {
    event.preventDefault();
    const noteRequests = reviewCards(event.target.id).filter((card) => card.dataset.queued === "true").map((card) => ({ id: card.dataset.reviewNoteId, feedback: card.querySelector("textarea").value.trim() }));
    if (!noteRequests.length) { notify("Add at least one section to the review"); return; }
    if (noteRequests.some((request) => !request.feedback)) { notify("Describe each queued rewrite"); return; }
    try { await api(`/api/tickets/${encodeURIComponent(runFor().id)}/steps/${encodeURIComponent(noteStepId)}/changes`, { method: "POST", body: JSON.stringify({ noteRequests }) }); notify(`Review sent for ${noteRequests.length} section${noteRequests.length === 1 ? "" : "s"}`); }
    catch (error) { notify(error.message); }
    return;
  }
  const stepId = event.target.dataset.requestChanges;
  if (stepId) {
    event.preventDefault();
    const form = new FormData(event.target);
    const feedback = form.get("feedback");
    const criterionIds = form.getAll("criterionId");
    if (!criterionIds.length) { notify("Select every criterion affected by this correction"); return; }
    try { await api(`/api/tickets/${encodeURIComponent(runFor().id)}/steps/${encodeURIComponent(stepId)}/changes`, { method: "POST", body: JSON.stringify({ feedback, criterionIds }) }); notify("Focused correction started"); }
    catch (error) { notify(error.message); }
  }
  const evidenceTicketId = event.target.dataset.requestEvidenceChanges;
  if (evidenceTicketId) {
    event.preventDefault();
    const form = new FormData(event.target);
    const feedback = form.get("feedback");
    const criterionIds = form.getAll("criterionId");
    if (!criterionIds.length) { notify("Select every criterion affected by this correction"); return; }
    try { await api(`/api/tickets/${encodeURIComponent(evidenceTicketId)}/evidence/changes`, { method: "POST", body: JSON.stringify({ feedback, criterionIds }) }); notify("Proof changes sent; correction and verification restarted"); }
    catch (error) { notify(error.message); }
  }
});

$("#refresh-tickets").addEventListener("click", refreshTickets);
$("#ticket-search").addEventListener("input", renderTickets);
$("#restart-target").addEventListener("change", renderRestartImpact);

document.addEventListener("keydown", (event) => {
  if (event.key !== "n" || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest("input, textarea, select, [contenteditable]")) return;
  if (document.querySelector("dialog[open]")) return;
  event.preventDefault();
  $("#free-text-dialog").showModal();
});

function setTransportState(next, announcement = null) {
  if (transportState === next) return;
  transportState = next;
  const status = $(".transport-status");
  if (status) {
    status.className = `transport-status ${transportState}`;
    status.textContent = transportLabel();
  }
  if (announcement) notify(announcement);
}

const events = new EventSource("/api/events");
events.onopen = () => {
  clearTimeout(transportTimer);
  const reconnected = hasConnected && transportState !== "connected";
  hasConnected = true;
  setTransportState("connected", reconnected ? "Live updates reconnected." : null);
};
events.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === "state") {
    const wasActive = state?.ticketRuns?.[state.selectedTicketId]?.activeRuns?.[selectedStepId];
    state = event.state;
    if (wasActive && !state.ticketRuns?.[state.selectedTicketId]?.activeRuns?.[selectedStepId]) {
      const run = runFor();
      const attempt = inspectionAttempt(selectedAttemptId);
      if (run && attempt) attemptDetails.delete(attemptDetailKey(run, attempt));
    }
    render();
    return;
  }
  if (event.type === "selection") {
    state.revision = event.revision;
    if (!pendingTicketSelections && event.selectedTicketId !== state.selectedTicketId) selectTicket(event.selectedTicketId, null, false);
    return;
  }
  if (event.type === "tickets") { ticketSources = event.ticketSources; render(); return; }
  if (event.channel === "run" && event.ticketId && event.stepId) {
    const key = `${event.ticketId}:${event.stepId}`;
    let live = liveRuns.get(key) || { events: [], output: "" };
    if (live.runId && live.runId !== event.runId) live = { events: [], output: "" };
    live.runId = event.runId;
    if (event.type === "prompt") {
      live.prompt = event.content;
      live.promptTruncated = Boolean(event.truncated);
      live.promptTotal = Number(event.total) || live.prompt.length;
    }
    else if (event.type === "text_delta") live.output = appendLiveOutput(live.output, event.delta);
    else live.events.push({ ...event, at: new Date().toISOString() });
    live.events = live.events.slice(-200);
    if (event.type !== "thinking" || !live.label) live.label = event.label || live.label;
    live.lastAt = new Date().toISOString();
    live.warning = event.type === "agent_error" || (event.type === "tool_end" && event.isError);
    liveRuns.set(key, live);
    if (event.ticketId === state.selectedTicketId && event.stepId === selectedStepId) {
      if (event.type === "prompt" && activeTab === "prompt") renderInspectorPreservingContext();
      else if (selectedAttemptId && activeTab !== "run") renderInspectorPreservingContext();
      else refreshLiveRun({ events: ["tool_start", "tool_update", "tool_end", "agent_error"].includes(event.type) });
    }
  }
  if (event.channel === "stage" && event.ticketId && event.stageId) {
    const key = `${event.ticketId}:${event.stageId}`;
    const persisted = state.ticketRuns?.[event.ticketId]?.stages?.find((stage) => stage.id === event.stageId)?.activity;
    let live = liveStages.get(key) || { events: [...(persisted?.events || [])], output: persisted?.rawOutput || "", startedAt: persisted?.startedAt || new Date().toISOString() };
    if (live.runId && live.runId !== event.runId) live = { events: [], output: "", startedAt: new Date().toISOString() };
    live.runId = event.runId;
    if (event.type === "prompt") live.prompts = [...(live.prompts || []), { ...event, at: new Date().toISOString() }].slice(-20);
    else if (event.type === "text_delta") live.output = appendLiveOutput(live.output, event.delta);
    else live.events.push(event);
    live.events = live.events.slice(-200);
    live.lastAt = new Date().toISOString();
    live.label = event.label || live.label;
    live.warning = event.type === "agent_error" || (event.type === "tool_end" && event.isError);
    liveStages.set(key, live);
    if (event.ticketId === state.selectedTicketId && event.stageId === selectedStageId) {
      if (event.type !== "text_delta") renderInspectorPreservingContext();
    }
  }
};
events.onerror = () => {
  // EventSource may emit repeated errors while reconnecting. Keep the first
  // disconnect deadline so transport can become visibly stale after 15 seconds.
  if (transportState !== "connected") return;
  setTransportState("disconnected", "Live updates disconnected; reconnecting. Workflow state is retained and is not failed.");
  transportTimer = setTimeout(() => setTransportState("stale", "Live updates are stale; reconnecting. Workflow state is retained and is not failed."), 15000);
};

state = await api("/api/state");
try { piModels = (await api("/api/models")).models || []; }
catch (error) { notify(error.message); }
await refreshTickets();
render();
window.addEventListener("resize", () => runFor()?.plan && renderPlanTree());
setInterval(refreshLiveRun, 1000);

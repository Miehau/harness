import { renderMarkdown } from "/markdown.js";
import { artifactsForStage, eventGroups, executionGraph, formatOutput, freeTextTicket, parseDiff, preferredStepId, recentActivity, restartOptions, reviewNotesForRows, runHeartbeat, runMetrics, stageMilestones, stepInspectorSummary } from "/ui-model.js";

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

let state = null;
let ticketSources = { configured: false, viewer: null, sources: [], tickets: [] };
let codexModels = [];
let savedView = {};
try { savedView = JSON.parse(localStorage.getItem("agent-plan-view") || "{}"); } catch {}
let selectedStepId = savedView.selectedStepId || null;
let selectedStageId = savedView.selectedStageId || null;
let activeTab = ["overview", "run", "diff", "artifacts", "ticket", "prompt"].includes(savedView.activeTab) ? savedView.activeTab : "overview";
let diffExpanded = false;
let toastTimer;
let clearTimer;
let clearArmed = false;
let cleanupArmed = false;
let retention = { items: [], totalBytes: 0 };
let trackerSettings = null;
let piSkills = [];
let piSkillsFor = null;
const selectedTicketIds = new Set();
const liveRuns = new Map();
const liveStages = new Map();
const sessionTraces = new Map();
const appendLiveOutput = (value, delta) => `${value || ""}${delta || ""}`.slice(-100000);
const pendingSessionTraces = new Set();
const diffModels = new Map();
const profileIds = ["requirements", "exploration", "architecture", "implementation", "verification", "commit", "handoff"];
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function rememberView() {
  localStorage.setItem("agent-plan-view", JSON.stringify({ selectedStepId, selectedStageId, activeTab }));
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
    const models = codexModels.some((model) => model.id === profile.model) ? codexModels : [{ id: profile.model, name: profile.model }, ...codexModels];
    return `<fieldset class="profile-card" data-profile="${id}"><legend>${label}</legend><label for="${id}-model">Model<select id="${id}-model" name="${id}-model" required>${models.map((model) => `<option value="${escapeHtml(model.id)}" ${profile.model === model.id ? "selected" : ""}>${escapeHtml(model.name || model.id)}</option>`).join("")}</select></label><label for="${id}-thinking">Reasoning<select id="${id}-thinking" name="${id}-thinking">${thinkingLevels.map((level) => `<option value="${level}" ${profile.thinking === level ? "selected" : ""}>${level === "off" ? "none" : level}</option>`).join("")}</select></label><label class="profile-prompt" for="${id}-prompt">Agent instructions<textarea id="${id}-prompt" name="${id}-prompt" rows="5">${escapeHtml(profile.prompt)}</textarea></label></fieldset>`;
  }).join("");
  $("#profile-fields").innerHTML = cards;
  $("#max-concurrent-tickets").value = state.settings?.maxConcurrentTickets || 2;
  $("#project-mode").value = state.settings?.projectMode || "manual";
  $("#poll-interval-seconds").value = state.settings?.pollIntervalSeconds || 60;
}

function runFor(id = state?.selectedTicketId) { return id ? state?.ticketRuns?.[id] || null : null; }
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

function statusIcon(status) {
  return ({ accepted: "✓", running: "↻", fixing: "↻", review_ready: "◉", failed: "×", needs_attention: "!", interrupted: "!", cancelled: "×", ready: "•" })[status] || "·";
}

function statusLabel(run) {
  if (!run) return "not started";
  return run.status.replaceAll("_", " ");
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
  const target = $("#tracker-status");
  if (!ticketSources.configured) {
    target.innerHTML = `<button id="tracker-settings" class="source-button" type="button"><span><strong>Ticket trackers</strong><small>Add Linear or Jira credentials</small></span><b>Configure</b></button>`;
    return;
  }
  const errors = ticketSources.sources.filter((source) => source.error).map((source) => `${source.provider}: ${source.error}`);
  target.innerHTML = `<button id="tracker-settings" class="source-button connected" type="button"><span class="connection-dot"></span><span>${escapeHtml(ticketSources.viewer?.name || "Trackers configured")}</span><small>${errors.length ? escapeHtml(errors.join(" · ")) : `${ticketSources.tickets.length} active ticket${ticketSources.tickets.length === 1 ? "" : "s"}`}</small></button>`;
}

function ticketCard(ticket) {
  const run = runFor(ticket.id);
  const selected = ticket.id === state.selectedTicketId ? "selected" : "";
  const priority = ticket.priority ? `<span>P${ticket.priority}</span>` : "";
  const selectable = !run && ["linear", "jira"].includes(ticket.provider);
  return `<div class="ticket-entry">${selectable ? `<input class="ticket-check" type="checkbox" data-check-ticket="${escapeHtml(ticket.id)}" aria-label="Select ${escapeHtml(ticket.identifier)}" ${selectedTicketIds.has(ticket.id) ? "checked" : ""}>` : ""}<button class="ticket-card ${selected}" type="button" data-ticket="${escapeHtml(ticket.id)}">
    <span class="ticket-row"><b>${escapeHtml(ticket.identifier)}</b>${priority}<i class="tracker-state-dot" style="--state-color:${escapeHtml(ticket.state.color || "#777")}"></i></span>
    <strong>${escapeHtml(ticket.title)}</strong>
    <span class="ticket-meta">${escapeHtml(ticket.state.name)} · ${escapeHtml(ticket.team?.name || ticket.provider || "Tracker")} · ${escapeHtml(statusLabel(run))}</span>
    ${run ? `<span class="ticket-progress"><i style="width:${runProgress(run)}%"></i></span>` : ""}
  </button></div>`;
}

function runProgress(run) {
  if (run.status === "completed") return 100;
  const stages = run.stages || [];
  return stages.length ? Math.round(stages.filter((stage) => stage.status === "completed").length / stages.length * 100) : 0;
}

function renderTickets() {
  renderTrackerStatus();
  const query = $("#ticket-search").value.trim().toLowerCase();
  const tickets = ticketSources.tickets.filter((ticket) => `${ticket.identifier} ${ticket.title}`.toLowerCase().includes(query));
  const local = Object.values(state.ticketRuns || {})
    .filter((run) => run.ticket?.source === "local")
    .map((run) => run.ticket)
    .filter((ticket) => `${ticket.identifier} ${ticket.title}`.toLowerCase().includes(query));
  const groups = [
    ["started", "In progress"],
    ["unstarted", "Todo"],
    ["backlog", "Backlog"]
  ];
  const trackerHtml = groups.map(([type, label]) => {
    const items = tickets.filter((ticket) => ticket.state.type === type);
    return `<section class="ticket-group"><header><span>${label}</span><b>${items.length}</b></header>${items.map(ticketCard).join("") || `<div class="ticket-empty">No ${label.toLowerCase()} tickets</div>`}</section>`;
  }).join("");
  const localHtml = `<section class="ticket-group"><header><span>Local runs</span><b>${local.length}</b></header>${local.map(ticketCard).join("") || `<div class="ticket-empty">Load feature.md and plan.json to start.</div>`}</section>`;
  $("#ticket-list").innerHTML = localHtml + (ticketSources.configured ? trackerHtml : `<div class="ticket-empty large">Add Linear or Jira credentials to load active tickets.</div>`);
  for (const id of [...selectedTicketIds]) if (!ticketSources.tickets.some((ticket) => ticket.id === id && !runFor(id))) selectedTicketIds.delete(id);
  const selectedStart = $("#start-selected");
  selectedStart.disabled = selectedTicketIds.size === 0;
  selectedStart.textContent = selectedTicketIds.size ? `Start ${selectedTicketIds.size} selected` : "Start selected";
  const occupied = Object.values(state.ticketRuns || {}).filter((run) => !["completed", "failed", "needs_attention", "cancelled", "interrupted"].includes(run.status)).length;
  $("#run-capacity").textContent = `${occupied} / ${state.settings?.maxConcurrentTickets || 2} occupied · ${state.settings?.projectMode || "manual"}`;
}

function stagesHtml(run) {
  if (!run) return "";
  return `<section class="workflow-stages"><header><span class="eyebrow">Ticket workflow</span><span class="stage-count">${run.stages.filter((stage) => stage.status === "completed").length}/${run.stages.length} complete</span></header><ol>${run.stages.map((stage, index) => `<li class="stage-${escapeHtml(stage.status)} ${stage.id === selectedStageId ? "selected" : ""}"><button class="workflow-stage" type="button" data-stage="${escapeHtml(stage.id)}" aria-pressed="${stage.id === selectedStageId}"><span class="stage-marker">${stage.status === "completed" ? "✓" : index + 1}</span><span class="stage-copy"><strong>${escapeHtml(stage.title)}</strong><small>${escapeHtml(stage.summary || "Waiting")}</small></span><span class="stage-status">${escapeHtml(stage.status)}</span></button></li>`).join("")}</ol></section>`;
}

function checkpointHtml(run) {
  const checkpoint = run?.checkpoint;
  if (!checkpoint) return "";
  if (checkpoint.kind === "requirements_review") {
    const questions = checkpoint.questions || [];
    return `<form class="checkpoint clarification" data-clarify="${escapeHtml(run.id)}" data-checkpoint-id="${escapeHtml(checkpoint.id)}"><div class="checkpoint-icon">?</div><div class="checkpoint-copy"><span class="eyebrow">Requirements gate · repository not accessed</span><strong>${escapeHtml(checkpoint.title)}</strong><details class="requirements-contract" open><summary>Review requirements contract</summary><div class="artifact-body">${renderMarkdown(checkpoint.prompt || "")}</div></details>${questions.map((question, index) => `<label>${index + 1}. ${escapeHtml(question)}<textarea name="answer-${index}" rows="2" required></textarea></label>`).join("")}${questions.length ? "" : `<label>Optional correction<textarea name="answer-0" rows="2" placeholder="Approve as written, or add a correction…"></textarea></label>`}</div><button class="button success" type="submit">${questions.length ? "Send answers" : "Approve requirements"}</button></form>`;
  }
  if (["needs_input", "technical_input"].includes(checkpoint.kind)) {
    return `<form class="checkpoint clarification" data-clarify="${escapeHtml(run.id)}" data-checkpoint-id="${escapeHtml(checkpoint.id)}"><div class="checkpoint-icon">?</div><div class="checkpoint-copy"><span class="eyebrow">Technical decision gate</span><strong>${escapeHtml(checkpoint.title)}</strong>${checkpoint.questions.map((question, index) => `<label>${index + 1}. ${escapeHtml(question)}<textarea name="answer-${index}" rows="2" required></textarea></label>`).join("")}</div><button class="button primary" type="submit">Continue</button></form>`;
  }
  if (checkpoint.kind === "step_review") {
    return "";
  }
  if (checkpoint.kind === "product_context_review") {
    return `<div class="checkpoint"><div class="checkpoint-icon">✓</div><div class="checkpoint-copy"><span class="eyebrow">Product-context gate</span><strong>${escapeHtml(checkpoint.title)}</strong><details class="requirements-contract"><summary>Review proposed PRD and capability update</summary><div class="artifact-body">${renderMarkdown(checkpoint.prompt || "")}</div></details></div><button class="button success" type="button" data-approve-context="${escapeHtml(run.id)}">Approve & complete</button></div>`;
  }
  if (checkpoint.kind === "review_blocked") {
    return `<div class="checkpoint"><div class="checkpoint-icon">!</div><div class="checkpoint-copy"><span class="eyebrow">Final review blocked</span><strong>${escapeHtml(checkpoint.title)}</strong><p>${checkpoint.findings?.length || 0} blocking finding${checkpoint.findings?.length === 1 ? "" : "s"} require human attention.</p></div></div>`;
  }
  return `<div class="checkpoint"><div class="checkpoint-icon">✓</div><div class="checkpoint-copy"><span class="eyebrow">Plan approval gate</span><strong>${escapeHtml(checkpoint.title)}</strong><p>Manual pauses at every verified batch. Auto accepts verified commits and runs the whole graph.</p></div><div class="checkpoint-actions"><button class="button" type="button" data-edit-plan="${escapeHtml(run.id)}">Edit graph JSON</button><button class="button" type="button" data-approve-ticket="${escapeHtml(run.id)}">Run manually</button><button class="button success" type="button" data-auto-ticket="${escapeHtml(run.id)}">Auto run graph</button></div></div>`;
}

function supervisorControlHtml(run) {
  if (!run) return "";
  const bound = run.workflow?.skillName || "";
  const options = piSkills.length
    ? `<option value="">${bound ? "Change Pi skill…" : "Bind Pi skill…"}</option>${piSkills.map((skill) => `<option value="${escapeHtml(skill.name)}" ${skill.name === bound ? "selected" : ""}>${escapeHtml(skill.name)}</option>`).join("")}`
    : `<option value="">No Pi skills discovered</option>`;
  return `<form class="supervisor-control" data-bind-workflow="${escapeHtml(run.id)}"><span class="agent-badge supervisor"><span class="agent-dot"></span>${bound ? escapeHtml(bound) : "Supervisor"}</span><select name="skillName" aria-label="Pi skill">${options}</select><button class="button" type="submit" ${piSkills.length ? "" : "disabled"}>${bound ? "Bind" : "Bind skill"}</button></form>`;
}

function workflowCheckpointsHtml(run) {
  const pending = (run?.workflow?.checkpoints || []).filter((checkpoint) => checkpoint.status === "pending");
  if (!pending.length) return "";
  return `<div class="checkpoint-list">${pending.map((checkpoint) => {
    const needsInput = checkpoint.kind === "needs_input";
    return `<form class="checkpoint clarification" data-continue-workflow="${escapeHtml(run.id)}" data-checkpoint-id="${escapeHtml(checkpoint.id)}"><div class="checkpoint-icon">${needsInput ? "?" : "✓"}</div><div class="checkpoint-copy"><span class="eyebrow">Supervisor workflow gate</span><strong>${escapeHtml(checkpoint.title)}</strong><p>${escapeHtml(checkpoint.prompt || "")}</p>${needsInput ? `<label>Response<textarea name="response" rows="2" required></textarea></label>` : ""}</div><button class="button ${needsInput ? "primary" : "success"}" type="submit">${needsInput ? "Continue" : "Approve"}</button></form>`;
  }).join("")}</div>`;
}

async function refreshSkills(run) {
  const key = run?.id || null;
  if (piSkillsFor === key) return;
  piSkillsFor = key;
  if (!key) { piSkills = []; return; }
  try {
    const result = await api(`/api/tickets/${encodeURIComponent(key)}/skills`);
    if (piSkillsFor !== key) return;
    piSkills = result.skills || [];
    render();
  } catch (error) {
    if (piSkillsFor === key) { piSkills = []; notify(error.message); }
  }
}

function checkpointUsesWorkspace(run) {
  return run?.checkpoint?.kind === "requirements_review";
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
  const action = !run
    ? `<button class="button primary" data-start-ticket="${escapeHtml(ticket.id)}">Start workflow</button>`
    : `${["interrupted", "cancelled", "needs_attention"].includes(run.status) && !run.checkpoint && (run.plan || run.stages?.some((stage) => stage.status === "active" && ["requirements", "explore", "design"].includes(stage.id))) ? `<button class="button primary" data-resume-ticket="${escapeHtml(run.id)}">Resume run</button>` : ""}${restartable && restartPoints.length ? `<button class="button" data-restart-ticket="${escapeHtml(run.id)}">Restart from…</button>` : ""}${restartable ? `<button class="button danger" data-start-fresh="${escapeHtml(run.id)}">Start fresh</button>` : ""}${["running", "fixing", "verifying", "reviewing"].includes(run.status) ? `<button class="button danger" data-cancel-ticket="${escapeHtml(run.id)}">Cancel run</button>` : ""}${run.auto ? `<span class="run-pill">auto</span>` : ""}<span class="run-pill status-${escapeHtml(run.status)}">${escapeHtml(statusLabel(run))}</span>${preview?.status === "stopped" ? `<span class="branch-pill">preview stopped</span>` : preview ? `<a class="branch-pill" href="${escapeHtml(preview.url)}" target="_blank" rel="noreferrer">preview :${preview.port} ↗</a>` : ""}${run.merge?.change?.url ? `<a class="branch-pill" href="${escapeHtml(run.merge.change.url)}" target="_blank" rel="noreferrer">remote review ↗</a>` : run.workspace ? `<span class="branch-pill">${escapeHtml(run.workspace.branch)}</span>` : ""}`;
  const reviewAction = run?.checkpoint?.kind === "step_review"
    ? `<button class="button primary" type="button" data-select-step="${escapeHtml(run.checkpoint.stepId)}">Review step</button>`
    : "";
  const restartAudit = run?.restartHistory?.at(-1);
  const restartBanner = restartAudit
    ? `<div class="recovery-banner"><strong>Restarted from ${escapeHtml(restartAudit.target.replace(":", " · "))}</strong><span>${escapeHtml(new Date(restartAudit.at).toLocaleString())} · audit ${escapeHtml(restartAudit.id)}</span></div>`
    : run?.startedFreshFrom ? `<div class="recovery-banner"><strong>Fresh run</strong><span>Previous run ${escapeHtml(run.startedFreshFrom.runId)} was archived with a restart audit.</span></div>` : "";
  target.innerHTML = `<div class="plan-heading ticket-heading"><div><span class="eyebrow">${escapeHtml(ticket.identifier)} · ${escapeHtml(ticket.state.name)}</span><h2>${escapeHtml(ticket.title)}</h2><p>${escapeHtml(ticket.description || "No ticket description provided.")}</p>${usage}</div><div class="plan-actions">${supervisorControlHtml(run)}${action}${reviewAction}</div></div>${stagesHtml(run)}${workflowCheckpointsHtml(run)}${checkpointUsesWorkspace(run) ? "" : checkpointHtml(run)}${restartBanner}${run?.recovery?.message ? `<div class="recovery-banner"><strong>Restart recovery</strong><span>${escapeHtml(run.recovery.message)}</span></div>` : ""}${run?.trackerSyncError ? `<div class="error-banner">${escapeHtml(run.trackerSyncError)}</div>` : ""}${run?.lastError ? `<div class="error-banner">${escapeHtml(run.lastError)}</div>` : ""}`;
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

function stepHtml(step) {
  const selected = step.id === selectedStepId ? "selected" : "";
  const profile = runFor()?.stageProfiles?.[step.role || "implementation"];
  const budget = step.permission === "write" && step.reviewBudget ? ` · ≤${step.reviewBudget.maxFiles} files/${step.reviewBudget.maxChangedLines} lines` : "";
  return `<button class="step status-${escapeHtml(step.status)} ${selected}" data-step="${escapeHtml(step.id)}"><span class="state-icon">${statusIcon(step.status)}</span><span class="step-copy"><span class="step-title">${escapeHtml(step.title)}</span><span class="step-meta">${escapeHtml(profile ? `${profile.model}/${profile.thinking}` : step.agentId)} · ${escapeHtml(step.contextPolicy)} · ${escapeHtml(step.permission)}${escapeHtml(budget)}</span></span><span class="status-label">${escapeHtml(step.status.replaceAll("_", " "))}</span></button>`;
}

function graphUnitHtml(unit) {
  const node = unit.node;
  if (node.type !== "group") return `<div class="graph-node" data-graph-node="${escapeHtml(node.id)}">${stepHtml(node)}</div>`;
  const childIds = new Set(node.children.map((child) => child.id));
  const parallel = !node.children.some((child) => child.dependsOn.some((id) => childIds.has(id)));
  return `<section class="graph-node graph-group" data-graph-node="${escapeHtml(node.id)}"><header><div><span class="graph-group-kicker">${parallel ? "parallel" : "sequence"}</span><strong>${escapeHtml(node.title)}</strong></div><span class="stage-count">${node.children.length} agents</span></header><div class="graph-group-children">${node.children.map(stepHtml).join("")}</div></section>`;
}

function drawEdges(edges) {
  const graph = $("#execution-graph");
  const svg = graph && $(".graph-edges", graph);
  if (!graph || !svg) return;
  const bounds = graph.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${graph.scrollWidth} ${graph.scrollHeight}`);
  svg.innerHTML = `<defs><marker id="graph-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"></path></marker></defs>` + edges.map(({ from, to }) => {
    const source = graph.querySelector(`[data-graph-node="${CSS.escape(from)}"]`)?.getBoundingClientRect();
    const target = graph.querySelector(`[data-graph-node="${CSS.escape(to)}"]`)?.getBoundingClientRect();
    if (!source || !target) return "";
    const x1 = source.left + source.width / 2 - bounds.left;
    const y1 = source.bottom - bounds.top;
    const x2 = target.left + target.width / 2 - bounds.left;
    const y2 = target.top - bounds.top;
    const curve = Math.max(18, (y2 - y1) / 2);
    return `<path d="M${x1} ${y1}C${x1} ${y1 + curve},${x2} ${y2 - curve},${x2} ${y2}" marker-end="url(#graph-arrow)"></path>`;
  }).join("");
}

function renderPlanTree() {
  const target = $("#plan-tree");
  const run = runFor();
  if (checkpointUsesWorkspace(run)) {
    target.innerHTML = `<section class="stage-checkpoint-workspace"><span class="eyebrow">Workflow stage · ${escapeHtml(run.stages?.find((stage) => stage.status === "blocked" || stage.status === "active")?.title || "Clarify requirements")}</span>${checkpointHtml(run)}</section>`;
    return;
  }
  if (!run?.plan) {
    const copy = run ? (run.status === "awaiting_requirements" ? "Approve the requirements above before repository exploration." : run.status === "awaiting_input" ? "Answer the technical question above." : "Exploration and design will produce the graph here.") : "Start the selected ticket to clarify requirements.";
    target.innerHTML = `<div class="empty"><div><strong>No execution graph yet</strong>${copy}</div></div>`;
    return;
  }
  const graph = executionGraph(run.plan);
  const steps = flattenSteps(run.plan);
  const attention = steps.filter((step) => ["needs_attention", "failed", "interrupted", "cancelled"].includes(step.status));
  const reviews = steps.filter((step) => step.status === "review_ready");
  const focus = attention.length
    ? `<section class="execution-focus attention"><span class="eyebrow">Current focus</span><strong>Resolve ${attention.length === 1 ? "the worker" : `${attention.length} workers`} that need${attention.length === 1 ? "s" : ""} attention</strong><small>Select a highlighted worker to review the blocker and evidence.</small></section>`
    : reviews.length ? `<section class="execution-focus"><span class="eyebrow">Current focus</span><strong>Review ${reviews.length === 1 ? "the verified worker" : `${reviews.length} verified workers`}</strong><small>Accept or request a focused correction before the next batch starts.</small></section>` : "";
  const columns = graph.columns.map((column, index) => `<section class="graph-column"><span class="graph-stage-label">Stage ${index + 1}</span>${column.map(graphUnitHtml).join("")}</section>`).join("");
  target.innerHTML = `${focus}<div class="tree-heading"><span class="eyebrow">Execution timeline</span><span class="eyebrow">${attention.length ? `${attention.length} need attention` : reviews.length ? `${reviews.length} awaiting review` : "verified batches are review barriers"}</span></div><div class="execution-graph-scroll"><div id="execution-graph" class="execution-graph"><svg class="graph-edges"></svg><div class="graph-columns">${columns}</div></div></div>`;
  requestAnimationFrame(() => drawEdges(graph.edges));
}

function cachedTrace(run, step) {
  const cached = sessionTraces.get(`${run.id}:${step.id}`);
  return cached && cached.sessionFile === step.sessionFile ? cached.trace : null;
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

function timelineHtml(events, active = false) {
  const groups = eventGroups(events).reverse();
  return groups.map((group, index) => {
    const current = active && index === 0;
    const duration = groupDuration(group);
    const meta = [`${group.items.length} action${group.items.length === 1 ? "" : "s"}`, duration, current ? "active" : group.isError ? "failed" : "complete"].filter(Boolean).join(" · ");
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
  if (!live && !stage.activity && !milestones.length) return `<div class="run-empty stage-empty">No model activity was recorded for this stage.</div>`;
  const active = stage.status === "active";
  const pulse = active ? heartbeatHtml(runHeartbeat({ startedAt: activity.startedAt || stage.updatedAt, lastEventAt: activity.lastEventAt || stage.updatedAt, lastEvent: activity.lastEvent || stage.summary, warning: activity.warning }, live)) : "";
  return `<div class="stage-activity">${pulse}<section class="run-events"><span class="eyebrow">Timeline</span><div>${milestones.length ? milestoneTimelineHtml(milestones) : timelineHtml(activity.events || [], active)}</div></section></div>`;
}

function rawOutputFor(run, step) {
  const attempt = step.attempts?.at(-1);
  const live = currentLiveRun(run, step);
  return live?.output || cachedTrace(run, step)?.rawOutput || [attempt?.rawOutput, attempt?.verification?.rawOutput].filter(Boolean).join("\n\n") || "";
}

function stepEvents(run, step) {
  const attempt = step.attempts?.at(-1);
  const trace = cachedTrace(run, step);
  const live = currentLiveRun(run, step);
  return [...(trace?.events || attempt?.events || []), ...(live?.events || [])];
}

function runPanel(step) {
  const run = runFor();
  const attempt = step.attempts?.at(-1);
  const active = run.activeRuns?.[step.id];
  const heartbeat = heartbeatHtml(runHeartbeat(active, liveRuns.get(`${run.id}:${step.id}`)));
  const events = stepEvents(run, step);
  const raw = `<section class="raw-output"><span class="eyebrow">Raw assistant output</span><pre data-run-raw-output>${escapeHtml(formatOutput(rawOutputFor(run, step) || "No assistant text yet. Open event details below to inspect tool calls and their output."))}</pre></section>`;
  return `${step.lastError ? `<div class="error-banner">${escapeHtml(step.lastError)}</div>` : ""}<div class="run-summary"><span class="run-state status-${escapeHtml(step.status)}">${escapeHtml(step.status.replaceAll("_", " "))}</span><strong>${escapeHtml(step.agentId)}</strong><span>${attempt ? `${step.attempts.length} attempt${step.attempts.length === 1 ? "" : "s"}` : "waiting"}</span></div>${heartbeat}${raw}<section class="run-events"><span class="eyebrow">Activity · grouped by focus</span><div data-run-events>${timelineHtml(events, Boolean(active))}</div></section>`;
}

function workerActivityHtml(run, step) {
  const active = run.activeRuns?.[step.id];
  const pulse = runHeartbeat(active, liveRuns.get(`${run.id}:${step.id}`));
  const items = recentActivity(stepEvents(run, step));
  const rows = items.map((item) => `<div class="worker-activity-row ${item.isError ? "warning" : ""}"><span>${escapeHtml(item.title)}</span><small>${escapeHtml(item.status)} · ${escapeHtml((item.at || "").slice(11, 19))}</small></div>`).join("");
  return `<section class="worker-activity" data-worker-activity><header><div><span class="eyebrow">${active ? "Live activity" : "Latest activity"}</span><strong>${escapeHtml(pulse?.label || items[0]?.title || "No worker actions recorded yet")}</strong></div><button class="button" type="button" data-tab="run">Open full activity →</button></header>${pulse ? heartbeatHtml(pulse) : ""}<div class="worker-activity-list">${rows || `<div class="run-empty">Waiting for the worker's first action.</div>`}</div></section>`;
}

function overviewPanel(step) {
  const run = runFor();
  const summary = stepInspectorSummary(step);
  const status = step.status.replaceAll("_", " ");
  const outcome = summary.needsAttention
    ? "This worker needs a decision before the workflow can continue."
    : step.status === "accepted" ? "Completed successfully and accepted into the ticket worktree."
      : step.status === "review_ready" ? "Verification passed. The worker is ready for your review."
        : ["running", "fixing"].includes(step.status) ? "The worker is actively progressing this step."
          : "The worker is waiting for its dependencies or next action.";
  const attention = summary.needsAttention ? `<section class="attention-summary"><span class="eyebrow">What needs attention</span><strong>${escapeHtml(summary.finding)}</strong><div class="attention-actions"><button class="button attention-action" type="button" data-tab="run">See failure details</button><button class="button primary" type="button" data-resume-ticket="${escapeHtml(run.id)}">Retry worker</button></div></section>` : "";
  const criteria = `<details class="inspector-disclosure"><summary><span>Acceptance criteria</span><b>${summary.criteria.length}</b></summary><div class="criteria-list">${summary.criteria.map((criterion) => `<div><span>○</span>${escapeHtml(criterion)}</div>`).join("") || `<p>No explicit criteria were recorded.</p>`}</div></details>`;
  const action = summary.needsAttention ? "Retry this worker" : step.status === "review_ready" ? "Review and accept" : "None";
  return `<section class="worker-overview ${summary.needsAttention ? "needs-attention" : ""}">${attention}${workerActivityHtml(run, step)}<div class="worker-outcome"><span class="eyebrow">Decision</span><p>${escapeHtml(outcome)}</p><dl><div><dt>Result</dt><dd class="status-${escapeHtml(step.status)}">${escapeHtml(status)}</dd></div><div><dt>Action needed</dt><dd>${action}</dd></div><div><dt>Attempts</dt><dd>${summary.attemptCount || (run.activeRuns?.[step.id] ? "In progress" : "—")}</dd></div></dl></div><div class="inspector-disclosures">${summary.findingCount ? `<button type="button" data-tab="run"><span>Findings</span><b>${summary.findingCount}</b><i>›</i></button>` : ""}${criteria}<button type="button" data-tab="artifacts"><span>Artifacts</span><b>${summary.artifactCount}</b><i>›</i></button><button type="button" data-tab="run"><span>Full activity and output</span><i>›</i></button><button type="button" data-tab="prompt"><span>Agent prompt</span><i>›</i></button><button type="button" data-tab="ticket"><span>Ticket context</span><i>›</i></button></div></section>`;
}

function refreshWorkerActivity() {
  if (activeTab !== "overview") return;
  const run = runFor();
  const step = nodeById(selectedStepId);
  const target = $("[data-worker-activity]");
  if (run && step && target) target.outerHTML = workerActivityHtml(run, step);
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
  target.innerHTML = timelineHtml(stepEvents(run, step), Boolean(run.activeRuns?.[step.id]));
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
  const toolbar = actions ? `<div class="diff-actions"><button class="button" type="button" data-expand-diff>${diffExpanded ? "Collapse" : "Expand"}</button>${artifactId ? `<button class="button" type="button" data-open-artifact="${escapeHtml(artifactId)}">Zed ↗</button>` : ""}</div>` : "";
  const noteCount = reviewNotes.filter((note) => note.status === "current").length;
  const rewriteRequest = feedbackFormId && noteCount ? `<form id="${escapeHtml(feedbackFormId)}" class="review-note-bulk" data-request-note-changes="${escapeHtml(feedbackStepId)}"><div><strong>Code change requests</strong><span data-review-queue-count>No code changes queued yet.</span></div><button class="button" type="submit" data-send-note-review disabled>Send code change requests</button></form>` : "";
  return `${toolbar}${warning}<div class="diff-overview"><div><strong>${record.files.length} changed files</strong><span>Canonical Git diff${noteCount ? ` · ${noteCount} agent note${noteCount === 1 ? "" : "s"}` : ""}</span></div><div class="diff-total"><b>+${record.additions ?? parsed.additions}</b><i>−${record.deletions ?? parsed.deletions}</i></div></div>${map}<nav class="diff-index" aria-label="Changed files">${indexed.map(({ file, index }) => `<button type="button" data-diff-jump="${escapeHtml(id)}" data-diff-file-index="${index}"><span>${escapeHtml(file.name)}</span><b>+${file.additions}</b><i>−${file.deletions}</i></button>`).join("")}</nav><div class="diff-files">${parsed.files.map((file, fileIndex) => `<details class="diff-file" data-diff-view="${escapeHtml(id)}" data-diff-file-index="${fileIndex}" ${fileIndex === indexed[0]?.index ? "open" : ""}><summary><span class="diff-file-name">${escapeHtml(file.name)}</span><span class="diff-numbers">${file.binary ? `<em>binary</em>` : `<b>+${file.additions}</b><i>−${file.deletions}</i>`}</span></summary><div class="diff-hunks">${file.hunks.map((hunk, hunkIndex) => `<details class="diff-hunk" data-diff-view="${escapeHtml(id)}" data-diff-file-index="${fileIndex}" data-diff-hunk-index="${hunkIndex}" ${fileIndex === indexed[0]?.index && hunkIndex === 0 ? "open data-hydrated=\"true\"" : ""}><summary><span>${escapeHtml(hunk.context || hunk.header)}</span><span class="diff-numbers"><b>+${hunk.additions}</b><i>−${hunk.deletions}</i></span></summary>${fileIndex === indexed[0]?.index && hunkIndex === 0 ? diffRows(hunk.rows, hunk.reviewNotes, feedbackFormId) : ""}</details>`).join("") || `<div class="run-empty">No textual hunks.</div>`}</div></details>`).join("")}</div>${rewriteRequest}`;
}

function stepDiffPanel(step) {
  const attempts = (step.attempts || []).filter((attempt) => attempt.diff?.available);
  const patchArtifact = [...(runFor()?.artifacts || [])].reverse().find((artifact) => artifact.stepId === step.id && artifact.kind === "git-diff");
  return `${diffPanel(step.diff, { id: `step-${step.id}`, budget: step.reviewBudgetResult, reviewMap: step.reviewMap, reviewNotes: step.reviewNotes, mapStepId: step.id, feedbackStepId: step.status === "review_ready" ? step.id : null, artifactId: patchArtifact?.id })}${attempts.length ? `<details class="attempt-diffs"><summary>Attempt deltas <span>${attempts.length}</span></summary>${attempts.map((attempt, index) => `<details><summary>${escapeHtml(attempt.attemptId || `Attempt ${index + 1}`)} · ${escapeHtml(compactDiffLabel(attempt.diff))}</summary>${diffPanel(attempt.diff, { id: `step-${step.id}-attempt-${index}`, actions: false })}</details>`).join("")}</details>` : ""}`;
}

function artifactsPanel(step, artifacts = step ? step.artifacts || [] : runFor()?.artifacts || []) {
  return `<div class="artifact-list">${artifacts.map((artifact) => `<article class="artifact"><header><button class="artifact-name artifact-open" type="button" data-open-artifact="${escapeHtml(artifact.id)}" title="Open in Zed">${escapeHtml(artifact.name)} ↗</button><span class="artifact-source">${escapeHtml(artifact.kind)}</span></header><code class="artifact-path">${escapeHtml(artifact.path || "")}</code><div class="artifact-body">${artifact.name.endsWith(".json") ? `<pre><code data-language="json">${escapeHtml(formatOutput(artifact.content))}</code></pre>` : renderMarkdown(artifact.content)}</div></article>`).join("") || `<div class="run-empty">No persisted artifacts yet.</div>`}</div>`;
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
  if (stage) {
    const profileId = ({ explore: "exploration", design: "architecture", implement: "implementation", verify: "verification" })[stage.id] || stage.id;
    const profile = run.stageProfiles?.[profileId];
    const artifacts = artifactsForStage(run.artifacts, stage.id);
    target.innerHTML = `<div class="inspector-shell"><header class="inspector-header"><div><span class="eyebrow">Workflow stage</span><h2>${escapeHtml(stage.title)}</h2></div><span class="run-pill status-${escapeHtml(stage.status)}">${escapeHtml(stage.status)}</span></header><div class="stage-overview"><div><span class="eyebrow">Latest update</span><strong>${escapeHtml(stage.summary || "Waiting to start")}</strong></div>${profile ? `<div><span class="eyebrow">Agent profile</span><strong>${escapeHtml(profile.model)} · ${escapeHtml(profile.thinking)}</strong></div>` : ""}<div><span class="eyebrow">Artifacts</span><strong>${artifacts.length}</strong></div></div>${stage.diff?.available ? `<details class="stage-diff"><summary>Repository changes <span>${escapeHtml(compactDiffLabel(stage.diff))}</span></summary><div class="tab-panel">${diffPanel(stage.diff, { id: `stage-${stage.id}` })}</div></details>` : ""}${profile?.prompt ? `<details class="stage-guidance"><summary>Stage instructions</summary><div class="artifact-body">${renderMarkdown(profile.prompt)}</div></details>` : ""}${stageActivityPanel(run, stage)}<details class="stage-artifacts"><summary>Artifacts <span>${artifacts.length}</span></summary><div class="tab-panel">${artifactsPanel(null, artifacts)}</div></details><footer class="inspector-footer"><span>${escapeHtml(run.workspace?.cwd || "worktree pending")}</span><span>${escapeHtml(stage.updatedAt ? new Date(stage.updatedAt).toLocaleString() : "not started")}</span></footer></div>`;
    for (const item of target.querySelectorAll("details.run-event")) item.open = openEvents.has(item.dataset.eventKey);
    for (const item of target.querySelectorAll("details.activity-group:not(.current)")) item.open = openGroups.has(item.dataset.groupKey);
    return;
  }
  if (!step) {
    target.innerHTML = `<div class="inspector-shell"><header class="inspector-header"><div><span class="eyebrow">Isolated ticket run</span><h2>Persistent artifacts</h2></div><span class="run-pill status-${escapeHtml(run.status)}">${escapeHtml(statusLabel(run))}</span></header><div class="tab-panel">${artifactsPanel(null)}</div><footer class="inspector-footer"><span>${escapeHtml(run.workspace?.cwd || "worktree pending")}</span><span>sessions stored separately</span></footer></div>`;
    return;
  }
  loadSessionTrace(run, step);
  const renderedPrompt = liveRuns.get(`${run.id}:${step.id}`)?.prompt || run.activeRuns?.[step.id]?.prompt || cachedTrace(run, step)?.prompt || [...(run.artifacts || [])].reverse().find((artifact) => artifact.stepId === step.id && artifact.kind === "agent-prompt")?.content || "Prompt has not been rendered yet.";
  const panels = { overview: overviewPanel(step), run: runPanel(step), diff: stepDiffPanel(step), artifacts: artifactsPanel(step), ticket: artifactsPanel(null), prompt: `<div class="artifact"><header><span class="artifact-name">Rendered agent prompt</span></header><div class="artifact-body">${renderMarkdown(renderedPrompt)}</div></div>` };
  const isolated = Boolean(step.workspace?.isolated);
  const outputCwd = step.workspace?.cwd || run.workspace?.cwd || state.workspace.cwd;
  const changeLabel = step.vcsChange ? ` · jj ${step.vcsChange.changeId.slice(0, 8)} · rev ${step.vcsChange.commitId.slice(0, 8)}` : "";
  const reviewActions = step.status === "review_ready" ? run.auto
    ? `<section class="step-review-actions"><p>Auto mode is accepting this verified step. No action is needed.</p></section>`
    : `<section class="step-review-actions"><p>${step.reviewBudgetResult?.exceeded ? `<strong>Manual review required:</strong> ${escapeHtml(step.reviewBudgetResult.reasons.join("; "))}.` : "Accepting commits this step. The next batch starts after every verified item at this barrier is accepted."}</p><details class="review-feedback"><summary>Request changes</summary><form data-request-changes="${escapeHtml(step.id)}"><textarea name="feedback" rows="3" placeholder="Describe a focused correction…" required></textarea><button class="button" type="submit">Send changes</button></form></details><button class="button success" type="button" data-accept-step="${escapeHtml(step.id)}">Accept commit</button></section>` : "";
  const outputLabel = isolated ? "Isolated parallel commit · accepting cherry-picks it into the ticket worktree" : "Working directory";
  const tabs = [["overview","Overview"],["diff","Evidence"],["artifacts","Artifacts"],["run","Output"]];
  const auxiliary = ({ ticket: "Ticket", prompt: "Prompt" })[activeTab];
  target.innerHTML = `<div class="inspector-shell worker-inspector"><header class="inspector-header"><div><span class="eyebrow">Current worker · ${escapeHtml(step.agentId)}</span><h2>${escapeHtml(step.title)}</h2><p>${escapeHtml(step.status === "accepted" ? "Completed successfully." : step.status === "review_ready" ? "Ready for review." : stepInspectorSummary(step).needsAttention ? "Needs attention before the workflow can continue." : "Worker summary and evidence.")}</p></div><span class="run-pill status-${escapeHtml(step.status)}">${escapeHtml(step.status.replaceAll("_", " "))}</span></header><nav class="tabs inspector-tabs">${tabs.map(([id,label]) => `<button class="tab ${activeTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`).join("")}${auxiliary ? `<button class="tab active auxiliary" data-tab="${escapeHtml(activeTab)}">${escapeHtml(auxiliary)}</button>` : ""}</nav><div class="tab-panel">${panels[activeTab]}</div>${reviewActions}<footer class="inspector-footer"><span>${outputLabel} · ${escapeHtml(outputCwd)}${run.workspace?.cwd ? "" : " (after approval)"}</span><span title="${escapeHtml(`${step.contextPolicy} context · ${step.permission} permission · ${step.status.replaceAll("_", " ")}${changeLabel}`)}">${escapeHtml(step.contextPolicy)} · ${escapeHtml(step.permission)}</span></footer></div>`;
  for (const item of target.querySelectorAll("details.run-event")) item.open = openEvents.has(item.dataset.eventKey);
  for (const item of target.querySelectorAll("details.activity-group:not(.current)")) item.open = openGroups.has(item.dataset.groupKey);
}

async function loadSessionTrace(run, step) {
  const key = `${run.id}:${step.id}`;
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
      else if (activeTab === "prompt") renderInspector();
    }
  } catch (error) {
    sessionTraces.set(key, { sessionFile, trace: { prompt: "", rawOutput: "", events: [] } });
    notify(error.message);
  }
  finally { pendingSessionTraces.delete(requestKey); }
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

function render() {
  if (!state) return;
  const draft = clarificationDraft();
  $("#workspace-path").value = state.workspace.cwd;
  $("#workspace-path-display").textContent = state.workspace.cwd;
  $("#workspace-settings").title = state.workspace.cwd;
  const run = runFor();
  if (selectedStageId && !run?.stages?.some((stage) => stage.id === selectedStageId)) { selectedStageId = null; rememberView(); }
  if (checkpointUsesWorkspace(run) && !selectedStageId) {
    selectedStepId = null;
    selectedStageId = run.stages?.find((stage) => stage.status === "blocked" || stage.status === "active")?.id || run.stages?.[0]?.id || null;
    rememberView();
  }
  if (!selectedStageId) selectedStepId = preferredStepId(run?.plan, selectedStepId);
  renderTickets();
  renderHeader();
  renderPlanTree();
  renderInspector();
  restoreClarificationDraft(draft);
  if (run?.id !== piSkillsFor) refreshSkills(run);
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
  const openArtifact = event.target.closest("[data-open-artifact]");
  if (openArtifact) {
    try { await api(`/api/tickets/${encodeURIComponent(runFor().id)}/artifacts/${encodeURIComponent(openArtifact.dataset.openArtifact)}/open`, { method: "POST", body: "{}" }); notify("Opened in Zed"); }
    catch (error) { notify(error.message); }
    return;
  }
  const clearButton = event.target.closest("#clear-queue");
  if (clearButton) {
    if (!clearArmed) {
      clearArmed = true;
      clearButton.textContent = "Confirm clear";
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => { clearArmed = false; clearButton.textContent = "Clear queue"; }, 4000);
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
    finally { clearButton.disabled = false; clearButton.textContent = "Clear queue"; }
    return;
  }
  const ticketCheck = event.target.closest("[data-check-ticket]");
  if (ticketCheck) {
    if (ticketCheck.checked) selectedTicketIds.add(ticketCheck.dataset.checkTicket);
    else selectedTicketIds.delete(ticketCheck.dataset.checkTicket);
    renderTickets();
    return;
  }
  const startSelected = event.target.closest("#start-selected");
  if (startSelected) {
    const ticketIds = [...selectedTicketIds];
    try {
      await api("/api/tickets/start", { method: "POST", body: JSON.stringify({ ticketIds }) });
      selectedTicketIds.clear();
      renderTickets();
      notify(`${ticketIds.length} ticket workflow${ticketIds.length === 1 ? "" : "s"} started`);
    } catch (error) { notify(error.message); }
    return;
  }
  const ticketButton = event.target.closest("[data-ticket]");
  if (ticketButton) {
    state = await api(`/api/tickets/${encodeURIComponent(ticketButton.dataset.ticket)}/select`, { method: "POST", body: "{}" });
    selectedStepId = null; selectedStageId = null; activeTab = "overview"; rememberView(); render(); return;
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
  const selectStep = event.target.closest("[data-select-step]");
  if (selectStep) { selectedStepId = selectStep.dataset.selectStep; selectedStageId = null; activeTab = "diff"; rememberView(); render(); return; }
  const acceptStep = event.target.closest("[data-accept-step]");
  if (acceptStep) {
    acceptStep.disabled = true;
    acceptStep.textContent = "Accepting…";
    try { await api(`/api/tickets/${encodeURIComponent(runFor().id)}/steps/${encodeURIComponent(acceptStep.dataset.acceptStep)}/accept`, { method: "POST", body: "{}" }); notify("Step accepted; continuing to the next slice"); }
    catch (error) { acceptStep.disabled = false; acceptStep.textContent = "Accept commit"; notify(error.message); }
    return;
  }
  const stage = event.target.closest("[data-stage]");
  if (stage) { selectedStageId = stage.dataset.stage; selectedStepId = null; rememberView(); render(); return; }
  const step = event.target.closest("[data-step]");
  if (step) { selectedStepId = step.dataset.step; selectedStageId = null; activeTab = "overview"; rememberView(); render(); return; }
  const tab = event.target.closest("[data-tab]");
  if (tab) { activeTab = tab.dataset.tab; rememberView(); renderInspector(); }
  if (event.target.closest("#workspace-settings")) $("#workspace-dialog").showModal();
  if (event.target.closest("#pick-workspace")) {
    try { $("#workspace-path").value = (await api("/api/workspace/pick", { method: "POST", body: "{}" })).cwd; }
    catch (error) { if (!/cancelled/i.test(error.message)) notify(error.message); }
  }
  if (event.target.closest("#free-text-open")) $("#free-text-dialog").showModal();
  if (event.target.closest("#profile-settings")) { renderProfiles(); $("#profiles-dialog").showModal(); }
  if (event.target.closest("#close-profiles")) $("#profiles-dialog").close();
  if (event.target.closest("[data-close-plan]")) $("#plan-dialog").close();
  const queueToggle = event.target.closest("#toggle-ticket-pane");
  if (queueToggle) {
    const collapsed = $(".ticket-layout").classList.toggle("sidebar-collapsed");
    queueToggle.setAttribute("aria-expanded", String(!collapsed));
    queueToggle.setAttribute("aria-label", collapsed ? "Show work queue" : "Hide work queue");
    queueToggle.title = collapsed ? "Show work queue" : "Hide work queue";
    queueToggle.textContent = collapsed ? "›" : "‹";
    requestAnimationFrame(() => runFor()?.plan && renderPlanTree());
  }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "restart-form") {
    event.preventDefault();
    const data = new FormData(event.target);
    const ticketId = data.get("ticketId");
    const target = data.get("target");
    const submit = event.target.querySelector("button[type=submit]");
    submit.disabled = true;
    try {
      await api(`/api/tickets/${encodeURIComponent(ticketId)}/restart`, { method: "POST", body: JSON.stringify({ target, confirmed: data.get("confirmed") === "on" }) });
      $("#restart-dialog").close();
      selectedStepId = null; selectedStageId = null; activeTab = "overview"; rememberView();
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
    try { state = await api("/api/workspace", { method: "POST", body: JSON.stringify({ cwd: $("#workspace-path").value }) }); $("#workspace-dialog").close(); piSkillsFor = null; await refreshTickets(); }
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
        maxConcurrentTickets: Number(data.get("maxConcurrentTickets")),
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
  const bindWorkflow = event.target.closest("[data-bind-workflow]");
  if (bindWorkflow) {
    event.preventDefault();
    const skillName = new FormData(bindWorkflow).get("skillName");
    if (!skillName) { notify("Choose a Pi skill to bind"); return; }
    try {
      const result = await api(`/api/tickets/${encodeURIComponent(bindWorkflow.dataset.bindWorkflow)}/workflow`, { method: "POST", body: JSON.stringify({ skillName }) });
      state = result.state;
      render();
      notify(`Bound ${skillName} as the supervisor workflow`);
    } catch (error) { notify(error.message); }
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
      state = result.state; selectedStepId = null; selectedStageId = null; activeTab = "overview"; rememberView(); render(); notify("Local zero-state fixture loaded");
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
    try { await api(`/api/tickets/${encodeURIComponent(runFor().id)}/steps/${encodeURIComponent(stepId)}/changes`, { method: "POST", body: JSON.stringify({ feedback }) }); notify("Focused correction started"); }
    catch (error) { notify(error.message); }
  }
});

$("#refresh-tickets").addEventListener("click", refreshTickets);
$("#ticket-search").addEventListener("input", renderTickets);
$("#restart-target").addEventListener("change", renderRestartImpact);

const events = new EventSource("/api/events");
events.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === "state") { state = event.state; render(); return; }
  if (event.type === "tickets") { ticketSources = event.ticketSources; render(); return; }
  if (event.channel === "run" && event.ticketId && event.stepId) {
    const key = `${event.ticketId}:${event.stepId}`;
    let live = liveRuns.get(key) || { events: [], output: "" };
    if (live.runId && live.runId !== event.runId) live = { events: [], output: "" };
    live.runId = event.runId;
    if (event.type === "prompt") live.prompt = event.content;
    else if (event.type === "text_delta") live.output = appendLiveOutput(live.output, event.delta);
    else live.events.push({ ...event, at: new Date().toISOString() });
    live.events = live.events.slice(-200);
    if (event.type !== "thinking" || !live.label) live.label = event.label || live.label;
    live.lastAt = new Date().toISOString();
    live.warning = event.type === "agent_error" || (event.type === "tool_end" && event.isError);
    liveRuns.set(key, live);
    if (event.ticketId === state.selectedTicketId && event.stepId === selectedStepId) {
      if (event.type === "prompt" && activeTab === "prompt") renderInspector();
      else if (activeTab === "overview") refreshWorkerActivity();
      else refreshLiveRun({ events: ["tool_start", "tool_update", "tool_end", "agent_error"].includes(event.type) });
    }
  }
  if (event.channel === "stage" && event.ticketId && event.stageId) {
    const key = `${event.ticketId}:${event.stageId}`;
    const persisted = state.ticketRuns?.[event.ticketId]?.stages?.find((stage) => stage.id === event.stageId)?.activity;
    let live = liveStages.get(key) || { events: [...(persisted?.events || [])], output: persisted?.rawOutput || "", startedAt: persisted?.startedAt || new Date().toISOString() };
    if (live.runId && live.runId !== event.runId) live = { events: [], output: "", startedAt: new Date().toISOString() };
    live.runId = event.runId;
    if (event.type === "text_delta") live.output = appendLiveOutput(live.output, event.delta);
    else live.events.push(event);
    live.events = live.events.slice(-200);
    live.lastAt = new Date().toISOString();
    live.label = event.label || live.label;
    live.warning = event.type === "agent_error" || (event.type === "tool_end" && event.isError);
    liveStages.set(key, live);
    if (event.ticketId === state.selectedTicketId && event.stageId === selectedStageId) {
      if (event.type !== "text_delta") renderInspector();
    }
  }
};
events.onerror = () => notify("Live connection lost; reconnecting…");

state = await api("/api/state");
try { codexModels = (await api("/api/models")).models || []; } catch (error) { notify(error.message); }
await refreshTickets();
render();
window.addEventListener("resize", () => runFor()?.plan && renderPlanTree());
setInterval(() => { refreshLiveRun(); refreshWorkerActivity(); }, 1000);

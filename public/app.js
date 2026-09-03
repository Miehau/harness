import { renderMarkdown } from "/markdown.js";
import { artifactsForStage, eventGroups, executionGraph, finalReview, fleetTicketView, formatOutput, freeTextTicket, parseDiff, preferredStageId, preferredStepId, restartOptions, reviewNotesForRows, runHeartbeat, runMetrics, stageDetailModel, stageMilestones, stepInspectorSummary } from "/ui-model.js";

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

let state = null;
let ticketSources = { configured: false, viewer: null, sources: [], tickets: [] };
let piModels = [];
const viewVersion = 2;
let savedView = {};
try { savedView = JSON.parse(localStorage.getItem("agent-plan-view") || "{}"); } catch {}
const currentView = savedView.version === viewVersion;
let selectedStepId = currentView ? savedView.selectedStepId || null : null;
let selectedStageId = currentView ? savedView.selectedStageId || null : null;
let activeTab = currentView && ["activity", "details", "overview", "run", "diff", "artifacts", "ticket", "prompt"].includes(savedView.activeTab) ? savedView.activeTab : "activity";
let selectedArtifactId = null;
let diffExpanded = false;
let toastTimer;
let clearTimer;
let clearArmed = false;
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
const profileIds = ["requirements", "exploration", "architecture", "implementation", "verification", "commit", "handoff"];
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function rememberView() {
  localStorage.setItem("agent-plan-view", JSON.stringify({ version: viewVersion, selectedStepId, selectedStageId, activeTab }));
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
  return ({ completed: "✓", accepted: "✓", active: "↻", running: "↻", fixing: "↻", pending: "○", blocked: "?", review_ready: "◉", awaiting_approval: "◉", needs_input: "?", failed: "×", needs_attention: "!", interrupted: "!", paused: "Ⅱ", cancelled: "×", ready: "•" })[status] || "·";
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
    ${agents ? `<div class="rail-agents">${agents}</div>` : ""}
  </article>`;
}

function queueTickets() {
  const byId = new Map();
  for (const ticket of ticketSources.tickets) byId.set(ticket.id, ticket);
  for (const run of Object.values(state.ticketRuns || {})) if (run.ticket) byId.set(run.ticket.id, run.ticket);
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
  return `<section class="workflow-stages"><header><span class="eyebrow">Workflow map</span><span class="stage-count">${run.stages.filter((stage) => stage.status === "completed").length}/${run.stages.length} complete</span></header><ol>${run.stages.map((stage, index) => `<li class="stage-${escapeHtml(stage.status)} ${stage.id === selectedStageId ? "selected" : ""}"><button class="workflow-stage" type="button" data-stage="${escapeHtml(stage.id)}" aria-pressed="${stage.id === selectedStageId}" title="${escapeHtml(stage.title)}"><span class="stage-marker" aria-hidden="true">${statusIcon(stage.status)}</span><span class="stage-copy"><strong><em>${index + 1}.</em>${escapeHtml(workflowStageName(stage))}</strong><small>${escapeHtml(workflowStateLabel(stage.status))}</small></span></button></li>`).join("")}</ol></section>`;
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
      return `<figure class="proof-item">${media || `<div class="proof-unavailable">Preview unavailable</div>`}<figcaption><strong>${escapeHtml(artifact.name)}</strong>${artifact.summary ? `<span>${escapeHtml(artifact.summary)}</span>` : ""}${!url ? `<small>Media URL unavailable</small>` : ""}</figcaption></figure>`;
    }).join("") || `<div class="run-empty">No supported visual proof was attached.</div>`;
    const checks = review.checks ? `<section class="final-review-summary"><span class="eyebrow">Automated checks</span><strong class="status-${escapeHtml(review.checks.status || "completed")}">${escapeHtml(review.checks.status || "completed")}</strong><p>${escapeHtml(review.checks.summary || review.checks.command || "Completed")}</p></section>` : "";
    const reviews = review.reviews.length ? `<section class="final-review-summary"><span class="eyebrow">Independent review</span>${review.reviews.map((item) => `<p><strong>${escapeHtml(item.role)}</strong> ${escapeHtml(item.summary || "Completed")}</p>`).join("")}</section>` : "";
    return `<section class="final-review" aria-labelledby="final-review-title"><header><span class="eyebrow">Final proof review</span><h2 id="final-review-title">${escapeHtml(checkpoint.title || "Review proof before delivery")}</h2><p>Review the delivered experience and final verification before approving delivery.</p></header><section class="proof-gallery" aria-label="Visual proof">${proof}</section>${checks || reviews ? `<div class="final-review-summaries">${checks}${reviews}</div>` : ""}<footer><details class="review-feedback"><summary>Request changes</summary><form data-request-evidence-changes="${escapeHtml(run.id)}"><textarea name="feedback" rows="3" placeholder="Describe what the proof shows should change…" required></textarea><button class="button" type="submit">Send changes</button></form></details><button class="button success" type="button" data-approve-evidence="${escapeHtml(run.id)}">Approve &amp; deliver</button></footer></section>`;
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
  const action = !run
    ? `<button class="button primary" data-start-ticket="${escapeHtml(ticket.id)}">Start workflow</button>`
    : `${["interrupted", "cancelled", "needs_attention", "failed", "paused"].includes(run.status) && !run.checkpoint && (run.plan || run.stages?.some((stage) => ["active", "blocked", "paused"].includes(stage.status) && ["requirements", "explore", "design"].includes(stage.id))) ? `<button class="button primary" data-resume-ticket="${escapeHtml(run.id)}">Resume run</button>` : ""}${restartable && restartPoints.length ? `<button class="button" data-restart-ticket="${escapeHtml(run.id)}">Restart from…</button>` : ""}${restartable ? `<button class="button danger" data-start-fresh="${escapeHtml(run.id)}">Start fresh</button>` : ""}${["preparing", "clarifying", "exploring", "planning", "running", "fixing", "verifying", "reviewing"].includes(run.status) ? `<button class="button" data-pause-ticket="${escapeHtml(run.id)}">Pause run</button>` : ""}${run.auto ? `<span class="run-pill">auto</span>` : ""}<span class="run-pill status-${escapeHtml(run.status)}">${escapeHtml(statusLabel(run))}</span>${preview?.status === "stopped" ? `<span class="branch-pill">preview stopped</span>` : preview ? `<a class="branch-pill" href="${escapeHtml(preview.url)}" target="_blank" rel="noreferrer">preview :${preview.port} ↗</a>` : ""}${run.merge?.change?.url ? `<a class="branch-pill" href="${escapeHtml(run.merge.change.url)}" target="_blank" rel="noreferrer">remote review ↗</a>` : run.workspace ? `<span class="branch-pill">${escapeHtml(run.workspace.branch)}</span>` : ""}`;
  const reviewAction = run?.checkpoint?.kind === "step_review"
    ? `<button class="button primary" type="button" data-select-step="${escapeHtml(run.checkpoint.stepId)}">Review step</button>`
    : "";
  const restartAudit = run?.restartHistory?.at(-1);
  const restartBanner = restartAudit
    ? `<div class="recovery-banner"><strong>Restarted from ${escapeHtml(restartAudit.target.replace(":", " · "))}</strong><span>${escapeHtml(new Date(restartAudit.at).toLocaleString())} · audit ${escapeHtml(restartAudit.id)}</span></div>`
    : run?.startedFreshFrom ? `<div class="recovery-banner"><strong>Fresh run</strong><span>Previous run ${escapeHtml(run.startedFreshFrom.runId)} was archived with a restart audit.</span></div>` : "";
  const pauseAudit = run?.pauseHistory?.at(-1);
  const pauseBanner = pauseAudit ? `<div class="recovery-banner"><strong>${run.status === "paused" ? "Run paused" : "Resumed from pause"}</strong><span>${escapeHtml(new Date(pauseAudit.at).toLocaleString())} · ${escapeHtml(pauseAudit.steps.length ? `${pauseAudit.steps.length} worker session${pauseAudit.steps.length === 1 ? "" : "s"} saved` : `${pauseAudit.stageId || "workflow"} session saved`)} · audit ${escapeHtml(pauseAudit.id)}</span></div>` : "";
  target.innerHTML = `<div class="plan-heading ticket-heading"><div><span class="eyebrow">${escapeHtml(ticket.identifier)} · ${escapeHtml(ticket.state.name)}</span><h2>${escapeHtml(ticket.title)}</h2><p>${escapeHtml(ticket.description || "No ticket description provided.")}</p>${usage}</div><div class="plan-actions">${action}${reviewAction}</div></div>${workflowCheckpointsHtml(run)}${run?.checkpoint && !checkpointUsesWorkspace(run) ? checkpointHtml(run) : ""}${pauseBanner}${restartBanner}${run?.recovery?.message ? `<div class="recovery-banner"><strong>Restart recovery</strong><span>${escapeHtml(run.recovery.message)}</span></div>` : ""}${run?.trackerSyncError ? `<div class="error-banner">${escapeHtml(run.trackerSyncError)}</div>` : ""}${run?.lastError ? `<div class="error-banner">${escapeHtml(run.lastError)}</div>` : ""}`;
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
  const dependencies = (step.dependsOn || []).map((id) => nodeById(id, runFor()?.plan)?.title || id);
  const dependency = dependencies.length ? `<span class="step-dependency">After ${escapeHtml(dependencies.join(" · "))}</span>` : "";
  return `<button class="step status-${escapeHtml(step.status)} ${selected}" data-step="${escapeHtml(step.id)}"><span class="state-icon">${statusIcon(step.status)}</span><span class="step-copy"><span class="step-title">${escapeHtml(step.title)}</span><span class="step-meta">${escapeHtml(profile ? `${profile.model}/${profile.thinking}` : step.agentId)} · ${escapeHtml(step.contextPolicy)} · ${escapeHtml(step.permission)}${escapeHtml(budget)}</span>${dependency}</span><span class="status-label">${escapeHtml(step.status.replaceAll("_", " "))}</span></button>`;
}

function graphUnitHtml(unit) {
  const node = unit.node;
  if (node.type !== "group") return `<div class="graph-node" data-graph-node="${escapeHtml(node.id)}">${stepHtml(node)}</div>`;
  const childIds = new Set(node.children.map((child) => child.id));
  const parallel = !node.children.some((child) => child.dependsOn.some((id) => childIds.has(id)));
  return `<section class="graph-node graph-group" data-graph-node="${escapeHtml(node.id)}"><header><div><span class="graph-group-kicker">${parallel ? "parallel" : "sequence"}</span><strong>${escapeHtml(node.title)}</strong></div><span class="stage-count">${node.children.length} agents</span></header><div class="graph-group-children">${node.children.map(stepHtml).join("")}</div></section>`;
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
  return `<section class="stage-work-surface">${focus}<header><span class="eyebrow">Steps in this stage</span><span class="stage-count">${steps.length} workers</span></header><div class="stage-worker-map">${steps.map(stepHtml).join("")}</div><details class="execution-graph-secondary"><summary>View dependency batches <span>${graph.columns.length} batches</span></summary><div class="execution-graph-scroll"><div id="execution-graph" class="execution-graph"><div class="graph-columns">${columns}</div></div></div></details></section>`;
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
  const cached = sessionTraces.get(`${run.id}:${step.id}`);
  return cached && cached.sessionFile === step.sessionFile ? cached.trace : null;
}

function stagePromptSignature(run, stage) {
  const stepSessions = stage.id === "implement" ? (run.plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children : [node]).map((step) => [step.id, step.status, step.sessionFile]) : [];
  const reviewSessions = stage.id === "verify" ? (run.reviews || []).flatMap((review) => (review.reviews || []).map((item) => [review.round, item.role, item.sessionFile])) : [];
  return JSON.stringify([stage.status, stage.updatedAt, run.requirementsSessionFile, run.sessionFile, stepSessions, reviewSessions]);
}

function cachedStagePrompts(run, stage) {
  const cached = stagePromptTraces.get(`${run.id}:${stage.id}`);
  return cached?.signature === stagePromptSignature(run, stage) ? cached.prompts : null;
}

function stagePromptPanel(run, stage) {
  const saved = cachedStagePrompts(run, stage);
  const live = liveStages.get(`${run.id}:${stage.id}`)?.prompts || [];
  const prompts = [...(saved || []), ...live.map((item) => ({ prompt: item.content, at: item.at, title: item.actor || stage.title, status: stage.status }))]
    .filter((item, index, all) => item.prompt && all.findIndex((candidate) => candidate.prompt === item.prompt) === index);
  if (!prompts.length) return saved ? `<div class="run-empty">No agent prompt has been recorded for this stage yet.</div>` : `<div class="run-empty">Loading recorded stage prompts…</div>`;
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
  const criteria = `<details class="inspector-disclosure"><summary><span>Acceptance criteria</span><b>${summary.criteria.length}</b></summary><div class="criteria-list">${summary.criteria.map((criterion) => `<div><span>○</span>${escapeHtml(criterion)}</div>`).join("") || `<p>No explicit criteria were recorded.</p>`}</div></details>`;
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

const artifactBodies = new Map();
const pendingArtifactBodies = new Set();
function hydrateArtifact(ticketId, artifact) {
  if (!ticketId || !artifact?.id || artifact.content != null || artifactBodies.has(artifact.id) || pendingArtifactBodies.has(artifact.id)) return;
  pendingArtifactBodies.add(artifact.id);
  api(`/api/tickets/${encodeURIComponent(ticketId)}/artifacts/${encodeURIComponent(artifact.id)}`).then((result) => {
    artifactBodies.set(artifact.id, result.content);
    render();
  }).catch(() => {}).finally(() => pendingArtifactBodies.delete(artifact.id));
}
function artifactBody(artifact) {
  return artifact.content != null ? artifact.content : artifactBodies.get(artifact.id);
}

function artifactPreview(artifact) {
  const content = artifactBody(artifact);
  if (artifact.kind === "visual-evidence") return artifact.summary ? `<p>${escapeHtml(artifact.summary)}</p>` : `<div class="run-empty">No written summary was recorded for this evidence.</div>`;
  if (content == null) return `<div class="run-empty">Loading artifact…</div>`;
  if (artifact.kind === "git-diff") return diffPanel({ available: true, patch: content }, { id: `artifact-${artifact.id}`, actions: false });
  if (artifact.name.endsWith(".json")) return `<pre><code data-language="json">${escapeHtml(formatOutput(content))}</code></pre>`;
  return renderMarkdown(content);
}

function artifactsPanel(step, artifacts = step ? step.artifacts || [] : runFor()?.artifacts || []) {
  const ticketId = runFor()?.id;
  if (!artifacts.length) return `<div class="run-empty">No persisted artifacts yet.</div>`;
  if (!artifacts.some((artifact) => artifact.id === selectedArtifactId)) selectedArtifactId = artifacts[0].id;
  const selected = artifacts.find((artifact) => artifact.id === selectedArtifactId) || artifacts[0];
  if (selected.kind !== "visual-evidence" && artifactBody(selected) == null) hydrateArtifact(ticketId, selected);
  return `<div class="artifact-browser"><nav class="artifact-index" aria-label="Persisted artifacts">${artifacts.map((artifact) => `<button type="button" data-select-artifact="${escapeHtml(artifact.id)}" aria-pressed="${artifact.id === selected.id}"><span><strong>${escapeHtml(artifact.name)}</strong><small>${escapeHtml(artifact.kind)}</small></span><i>${artifact.id === selected.id ? "●" : ""}</i></button>`).join("")}</nav><article class="artifact artifact-preview"><header><button class="artifact-name artifact-open" type="button" data-open-artifact="${escapeHtml(selected.id)}" title="Open in Zed">${escapeHtml(selected.name)} ↗</button><span class="artifact-source">${escapeHtml(selected.kind)}</span></header><code class="artifact-path">${escapeHtml(selected.path || "")}</code><div class="artifact-body">${artifactPreview(selected)}</div></article></div>`;
}

function stageDetailsPanel(run, stage, profile, artifacts) {
  const index = run.stages.findIndex((item) => item.id === stage.id);
  const next = run.stages[index + 1];
  const milestones = stageMilestones(run, stage);
  return `<section class="stage-details"><p>${escapeHtml(stage.summary || "Waiting to start")}</p><dl><div><dt>Workflow step</dt><dd>${index + 1} of ${run.stages.length}</dd></div><div><dt>Agent profile</dt><dd>${escapeHtml(profile ? `${profile.model} · ${profile.thinking}` : "system")}</dd></div><div><dt>Saved artifacts</dt><dd>${artifacts.length}</dd></div><div><dt>Next</dt><dd>${escapeHtml(next?.title || "Complete")}</dd></div></dl>${stageStepIndexHtml(run, stage)}${stageDependencyMapHtml(run, stage)}${stage.diff?.available ? `<details class="stage-diff"><summary>Repository changes <span>${escapeHtml(compactDiffLabel(stage.diff))}</span></summary><div class="tab-panel">${diffPanel(stage.diff, { id: `stage-${stage.id}` })}</div></details>` : ""}${profile?.prompt ? `<details class="stage-guidance"><summary>Stage instructions</summary><div class="artifact-body">${renderMarkdown(profile.prompt)}</div></details>` : ""}${milestones.length ? `<details class="stage-milestones"><summary>Workflow milestones <span>${milestones.length}</span></summary>${milestoneTimelineHtml(milestones)}</details>` : ""}</section>`;
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
    const index = run.stages.findIndex((item) => item.id === stage.id) + 1;
    const stageTab = ["activity", "prompt", "artifacts", "details"].includes(activeTab) ? activeTab : "activity";
    if (stageTab === "prompt") loadStagePrompts(run, stage);
    const panel = stageTab === "activity" ? stageActivityPanel(run, stage) : stageTab === "prompt" ? stagePromptPanel(run, stage) : stageTab === "artifacts" ? artifactsPanel(null, artifacts) : stageDetailsPanel(run, stage, profile, artifacts);
    target.innerHTML = `<div class="inspector-shell worker-inspector"><header class="inspector-header"><div><span class="eyebrow">Workflow stage · ${index}</span><h2>${escapeHtml(stage.title)}</h2><p>${escapeHtml(stage.summary || "Waiting to start")}</p></div><span class="run-pill status-${escapeHtml(stage.status)}">${escapeHtml(workflowStateLabel(stage.status))}</span></header><nav class="tabs inspector-tabs">${[["activity", "Activity"], ["prompt", "Prompt"], ["artifacts", "Artifacts"], ["details", "Details"]].map(([id, label]) => `<button class="tab ${stageTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`).join("")}</nav><div class="tab-panel">${panel}</div><footer class="inspector-footer"><span>${escapeHtml(run.workspace?.cwd || "worktree pending")}</span><span>${escapeHtml(stage.updatedAt ? new Date(stage.updatedAt).toLocaleString() : "not started")}</span></footer></div>`;
    for (const item of target.querySelectorAll("details.run-event")) item.open = openEvents.has(item.dataset.eventKey);
    for (const item of target.querySelectorAll("details.activity-group:not(.current)")) item.open = openGroups.has(item.dataset.groupKey);
    return;
  }
  if (!step) {
    target.innerHTML = `<div class="inspector-shell"><header class="inspector-header"><div><span class="eyebrow">Isolated ticket run</span><h2>Persistent artifacts</h2></div><span class="run-pill status-${escapeHtml(run.status)}">${escapeHtml(statusLabel(run))}</span></header><div class="tab-panel">${artifactsPanel(null)}</div><footer class="inspector-footer"><span>${escapeHtml(run.workspace?.cwd || "worktree pending")}</span><span>sessions stored separately</span></footer></div>`;
    return;
  }
  const workerTab = ["overview", "run", "diff", "artifacts", "ticket", "prompt"].includes(activeTab) ? activeTab : "run";
  const promptArtifact = workerTab === "prompt" ? [...(run.artifacts || [])].reverse().find((artifact) => artifact.stepId === step.id && artifact.kind === "agent-prompt") : null;
  if (workerTab === "prompt") {
    loadSessionTrace(run, step);
    if (promptArtifact) hydrateArtifact(run.id, promptArtifact);
  }
  const renderedPrompt = liveRuns.get(`${run.id}:${step.id}`)?.prompt || run.activeRuns?.[step.id]?.prompt || cachedTrace(run, step)?.prompt || artifactBody(promptArtifact || {}) || "Prompt has not been rendered yet.";
  const stepArtifacts = run.artifacts.filter((artifact) => artifact.stepId === step.id);
  const panel = workerTab === "overview" ? overviewPanel(step)
    : workerTab === "diff" ? stepDiffPanel(step)
      : workerTab === "artifacts" ? artifactsPanel(null, stepArtifacts)
        : workerTab === "ticket" ? artifactsPanel(null)
          : workerTab === "prompt" ? `<div class="artifact"><header><span class="artifact-name">Rendered agent prompt</span></header><div class="artifact-body">${renderMarkdown(renderedPrompt)}</div></div>`
            : runPanel(step);
  const isolated = Boolean(step.workspace?.isolated);
  const outputCwd = step.workspace?.cwd || run.workspace?.cwd || state.workspace.cwd;
  const changeLabel = step.vcsChange ? ` · jj ${step.vcsChange.changeId.slice(0, 8)} · rev ${step.vcsChange.commitId.slice(0, 8)}` : "";
  const reviewActions = step.status === "review_ready" ? run.auto
    ? `<section class="step-review-actions"><p>Auto mode is accepting this verified step. No action is needed.</p></section>`
    : `<section class="step-review-actions"><p>${step.reviewBudgetResult?.exceeded ? `<strong>Manual review required:</strong> ${escapeHtml(step.reviewBudgetResult.reasons.join("; "))}.` : "Accepting commits this step. The next batch starts after every verified item at this barrier is accepted."}</p><details class="review-feedback"><summary>Request changes</summary><form data-request-changes="${escapeHtml(step.id)}"><textarea name="feedback" rows="3" placeholder="Describe a focused correction…" required></textarea><button class="button" type="submit">Send changes</button></form></details><button class="button" type="button" data-accept-step="${escapeHtml(step.id)}">Accept commit</button><button class="button success" type="button" data-auto-accept-step="${escapeHtml(step.id)}">Accept & auto-run</button></section>` : "";
  const outputLabel = isolated ? "Isolated parallel commit · accepting cherry-picks it into the ticket worktree" : "Working directory";
  const tabs = [["run","Activity"],["overview","Details"],["artifacts","Artifacts"],["diff","Diff"]];
  const auxiliary = ({ ticket: "Ticket", prompt: "Prompt" })[workerTab];
  target.innerHTML = `<div class="inspector-shell worker-inspector"><header class="inspector-header"><div><span class="eyebrow">Current worker · ${escapeHtml(step.agentId)}</span><h2>${escapeHtml(step.title)}</h2><p>${escapeHtml(step.status === "accepted" ? "Completed successfully." : step.status === "review_ready" ? "Ready for review." : stepInspectorSummary(step).needsAttention ? "Needs attention before the workflow can continue." : step.description || "Worker summary and evidence.")}</p></div><span class="run-pill status-${escapeHtml(step.status)}">${escapeHtml(step.status.replaceAll("_", " "))}</span></header><nav class="tabs inspector-tabs">${tabs.map(([id,label]) => `<button class="tab ${workerTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`).join("")}${auxiliary ? `<button class="tab active auxiliary" data-tab="${escapeHtml(workerTab)}">${escapeHtml(auxiliary)}</button>` : ""}</nav><div class="tab-panel">${panel}</div>${reviewActions}<footer class="inspector-footer"><span>${outputLabel} · ${escapeHtml(outputCwd)}${run.workspace?.cwd ? "" : " (after approval)"}</span><span title="${escapeHtml(`${step.contextPolicy} context · ${step.permission} permission · ${step.status.replaceAll("_", " ")}${changeLabel}`)}">${escapeHtml(step.contextPolicy)} · ${escapeHtml(step.permission)}</span></footer></div>`;
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

async function loadStagePrompts(run, stage) {
  const key = `${run.id}:${stage.id}`;
  const signature = stagePromptSignature(run, stage);
  const requestKey = `${key}:${signature}`;
  if (cachedStagePrompts(run, stage) || pendingStagePromptTraces.has(requestKey)) return;
  pendingStagePromptTraces.add(requestKey);
  try {
    const result = await api(`/api/tickets/${encodeURIComponent(run.id)}/stages/${encodeURIComponent(stage.id)}/prompts`);
    stagePromptTraces.set(key, { signature, prompts: result.prompts || [] });
    if (run.id === runFor()?.id && stage.id === selectedStageId && activeTab === "prompt") renderInspector();
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

function render() {
  if (!state) return;
  const draft = clarificationDraft();
  $("#workspace-path").value = state.workspace.cwd;
  $("#workspace-path-display").textContent = state.workspace.cwd;
  $("#workspace-settings").title = state.workspace.cwd;
  const run = runFor();
  if (selectedStageId && !run?.stages?.some((stage) => stage.id === selectedStageId)) { selectedStageId = null; rememberView(); }
  if (!selectedStageId && activeTab === "overview") {
    selectedStepId = null;
    selectedStageId = preferredStageId(run?.stages);
    activeTab = "activity";
    rememberView();
  }
  if (checkpointUsesWorkspace(run) && !selectedStageId) {
    selectedStepId = null;
    selectedStageId = run.stages?.find((stage) => ["blocked", "active", "paused"].includes(stage.status))?.id || run.stages?.[0]?.id || null;
    rememberView();
  }
  if (!selectedStageId && !selectedStepId) selectedStageId = preferredStageId(run?.stages);
  if (!selectedStageId) selectedStepId = preferredStepId(run?.plan, selectedStepId);
  renderTickets();
  renderHeader();
  renderPlanTree();
  renderInspector();
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
  selectedStepId = stepId;
  selectedStageId = null;
  selectedArtifactId = null;
  activeTab = stepId ? "run" : "activity";
  rememberView();
  render();
  if (!persist) return;
  const selection = ++latestTicketSelection;
  pendingTicketSelections++;
  api(`/api/tickets/${encodeURIComponent(ticketId)}/select`, { method: "POST", body: "{}" })
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
  const railStep = event.target.closest("[data-rail-step]");
  if (railStep) {
    if (railStep.dataset.ticket !== state.selectedTicketId) {
      selectTicket(railStep.dataset.ticket, railStep.dataset.railStep);
      return;
    }
    selectedStepId = railStep.dataset.railStep;
    selectedStageId = null;
    selectedArtifactId = null;
    activeTab = "run";
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
  const selectStep = event.target.closest("[data-select-step]");
  if (selectStep) { selectedStepId = selectStep.dataset.selectStep; selectedStageId = null; activeTab = "diff"; rememberView(); render(); return; }
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
  if (stage) { selectedStageId = stage.dataset.stage; selectedStepId = null; selectedArtifactId = null; activeTab = "activity"; rememberView(); renderSelection(); return; }
  const step = event.target.closest("[data-step]");
  if (step) { selectedStepId = step.dataset.step; selectedStageId = null; selectedArtifactId = null; activeTab = "run"; rememberView(); renderSelection(); return; }
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
    try { await api(`/api/tickets/${encodeURIComponent(runFor().id)}/steps/${encodeURIComponent(stepId)}/changes`, { method: "POST", body: JSON.stringify({ feedback }) }); notify("Focused correction started"); }
    catch (error) { notify(error.message); }
  }
  const evidenceTicketId = event.target.dataset.requestEvidenceChanges;
  if (evidenceTicketId) {
    event.preventDefault();
    const feedback = new FormData(event.target).get("feedback");
    try { await api(`/api/tickets/${encodeURIComponent(evidenceTicketId)}/evidence/changes`, { method: "POST", body: JSON.stringify({ feedback }) }); notify("Proof changes sent; correction and verification restarted"); }
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

const events = new EventSource("/api/events");
events.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === "state") { state = event.state; render(); return; }
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
      if (event.type !== "text_delta") renderInspector();
    }
  }
};
events.onerror = () => notify("Live connection lost; reconnecting…");

state = await api("/api/state");
try { piModels = (await api("/api/models")).models || []; } catch (error) { notify(error.message); }
await refreshTickets();
render();
window.addEventListener("resize", () => runFor()?.plan && renderPlanTree());
setInterval(refreshLiveRun, 1000);

import { renderMarkdown } from "/markdown.js";
import { artifactsForStage, eventTimeline, executionGraph, formatOutput, parseDiff, preferredStepId, runHeartbeat } from "/ui-model.js";

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

let state = null;
let linear = { configured: false, viewer: null, tickets: [] };
let selectedStepId = null;
let selectedStageId = null;
let activeTab = "run";
let toastTimer;
const liveRuns = new Map();
const sessionTraces = new Map();
const pendingSessionTraces = new Set();
const profileIds = ["requirements", "exploration", "architecture", "implementation", "verification", "handoff"];
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

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
  $("#profile-fields").innerHTML = profileIds.map((id) => {
    const profile = state.stageProfiles[id];
    return `<fieldset class="profile-card" data-profile="${id}"><legend>${escapeHtml(profile.label)}</legend><label>Model<input name="${id}-model" list="model-options" value="${escapeHtml(profile.model)}" required></label><label>Reasoning<select name="${id}-thinking">${thinkingLevels.map((level) => `<option value="${level}" ${profile.thinking === level ? "selected" : ""}>${level === "off" ? "none" : level}</option>`).join("")}</select></label><label class="profile-prompt">Additional instructions<textarea name="${id}-prompt" rows="3">${escapeHtml(profile.prompt)}</textarea></label></fieldset>`;
  }).join("");
}

function runFor(id = state?.selectedTicketId) { return id ? state?.ticketRuns?.[id] || null : null; }
function selectedTicket() { return linear.tickets.find((ticket) => ticket.id === state?.selectedTicketId) || runFor()?.ticket || null; }
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

function renderLinearStatus() {
  const target = $("#linear-status");
  if (!linear.configured) {
    target.innerHTML = `<form id="linear-connect" class="linear-connect"><strong>Connect Linear</strong><p>Paste a personal API key. It stays in this server process and is never written to disk.</p><input name="apiKey" type="password" placeholder="lin_api_…" required><button class="button primary" type="submit">Connect</button></form>`;
    return;
  }
  target.innerHTML = `<div class="connected"><span class="connection-dot"></span><span>${escapeHtml(linear.viewer?.name || "Linear connected")}</span><small>${linear.tickets.length} active ticket${linear.tickets.length === 1 ? "" : "s"}</small></div>`;
}

function ticketCard(ticket) {
  const run = runFor(ticket.id);
  const selected = ticket.id === state.selectedTicketId ? "selected" : "";
  const priority = ticket.priority ? `<span>P${ticket.priority}</span>` : "";
  return `<button class="ticket-card ${selected}" type="button" data-ticket="${escapeHtml(ticket.id)}">
    <span class="ticket-row"><b>${escapeHtml(ticket.identifier)}</b>${priority}<i class="linear-state-dot" style="--state-color:${escapeHtml(ticket.state.color || "#777")}"></i></span>
    <strong>${escapeHtml(ticket.title)}</strong>
    <span class="ticket-meta">${escapeHtml(ticket.state.name)} · ${escapeHtml(ticket.team?.name || "Linear")} · ${escapeHtml(statusLabel(run))}</span>
    ${run ? `<span class="ticket-progress"><i style="width:${runProgress(run)}%"></i></span>` : ""}
  </button>`;
}

function runProgress(run) {
  if (run.status === "completed") return 100;
  const stages = run.stages || [];
  return stages.length ? Math.round(stages.filter((stage) => stage.status === "completed").length / stages.length * 100) : 0;
}

function renderTickets() {
  renderLinearStatus();
  const query = $("#ticket-search").value.trim().toLowerCase();
  const tickets = linear.tickets.filter((ticket) => `${ticket.identifier} ${ticket.title}`.toLowerCase().includes(query));
  const local = Object.values(state.ticketRuns || {})
    .filter((run) => run.ticket?.source === "local")
    .map((run) => run.ticket)
    .filter((ticket) => `${ticket.identifier} ${ticket.title}`.toLowerCase().includes(query));
  const groups = [
    ["started", "In progress"],
    ["unstarted", "Todo"],
    ["backlog", "Backlog"]
  ];
  const linearHtml = groups.map(([type, label]) => {
    const items = tickets.filter((ticket) => ticket.state.type === type);
    return `<section class="ticket-group"><header><span>${label}</span><b>${items.length}</b></header>${items.map(ticketCard).join("") || `<div class="ticket-empty">No ${label.toLowerCase()} tickets</div>`}</section>`;
  }).join("");
  const localHtml = `<section class="ticket-group"><header><span>Local runs</span><b>${local.length}</b></header>${local.map(ticketCard).join("") || `<div class="ticket-empty">Load feature.md and plan.json to start.</div>`}</section>`;
  $("#ticket-list").innerHTML = localHtml + (linear.configured ? linearHtml : `<div class="ticket-empty large">Connect Linear to load its active tickets.</div>`);
  const active = Object.values(state.ticketRuns || {}).filter((run) => ["preparing", "clarifying", "exploring", "planning", "running", "fixing", "verifying", "reviewing"].includes(run.status)).length;
  $("#run-capacity").textContent = `${active} / 2 active`;
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
    return `<form class="checkpoint clarification" data-clarify="${escapeHtml(run.id)}"><div class="checkpoint-icon">?</div><div class="checkpoint-copy"><span class="eyebrow">Requirements gate · repository not accessed</span><strong>${escapeHtml(checkpoint.title)}</strong><details class="requirements-contract"><summary>Review requirements contract</summary><div class="artifact-body">${renderMarkdown(checkpoint.prompt || "")}</div></details>${questions.map((question, index) => `<label>${index + 1}. ${escapeHtml(question)}<textarea name="answer-${index}" rows="2" required></textarea></label>`).join("")}${questions.length ? "" : `<label>Optional correction<textarea name="answer-0" rows="2" placeholder="Approve as written, or add a correction…"></textarea></label>`}</div><button class="button success" type="submit">Approve requirements</button></form>`;
  }
  if (["needs_input", "technical_input"].includes(checkpoint.kind)) {
    return `<form class="checkpoint clarification" data-clarify="${escapeHtml(run.id)}"><div class="checkpoint-icon">?</div><div class="checkpoint-copy"><span class="eyebrow">Technical decision gate</span><strong>${escapeHtml(checkpoint.title)}</strong>${checkpoint.questions.map((question, index) => `<label>${index + 1}. ${escapeHtml(question)}<textarea name="answer-${index}" rows="2" required></textarea></label>`).join("")}</div><button class="button primary" type="submit">Continue</button></form>`;
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
  return `<div class="checkpoint"><div class="checkpoint-icon">✓</div><div class="checkpoint-copy"><span class="eyebrow">Plan approval gate</span><strong>${escapeHtml(checkpoint.title)}</strong><p>Review the design artifact and execution graph before agents modify code.</p></div><button class="button success" type="button" data-approve-ticket="${escapeHtml(run.id)}">Approve & run</button></div>`;
}

function renderHeader() {
  const target = $("#ticket-header");
  const ticket = selectedTicket();
  const run = runFor();
  if (!ticket) {
    target.innerHTML = `<div class="plan-heading"><div><span class="eyebrow">No ticket selected</span><h2>Load a local fixture or choose Linear work</h2><p>Local fixtures start from an empty repository and use their authored ticket graph.</p></div></div>`;
    return;
  }
  const action = !run
    ? `<button class="button primary" data-start-ticket="${escapeHtml(ticket.id)}">Start workflow</button>`
    : `${["interrupted", "cancelled", "needs_attention"].includes(run.status) && run.plan ? `<button class="button primary" data-resume-ticket="${escapeHtml(run.id)}">Resume run</button>` : ""}${["running", "fixing", "verifying", "reviewing"].includes(run.status) ? `<button class="button danger" data-cancel-ticket="${escapeHtml(run.id)}">Cancel run</button>` : ""}<span class="run-pill status-${escapeHtml(run.status)}">${escapeHtml(statusLabel(run))}</span>${run.workspace ? `<span class="branch-pill">${escapeHtml(run.workspace.branch)}</span>` : ""}`;
  const reviewAction = run?.checkpoint?.kind === "step_review"
    ? `<button class="button primary" type="button" data-select-step="${escapeHtml(run.checkpoint.stepId)}">Review step</button>`
    : "";
  target.innerHTML = `<div class="plan-heading ticket-heading"><div><span class="eyebrow">${escapeHtml(ticket.identifier)} · ${escapeHtml(ticket.state.name)}</span><h2>${escapeHtml(ticket.title)}</h2><p>${escapeHtml(ticket.description || "No description provided in Linear.")}</p></div><div class="plan-actions">${action}${reviewAction}</div></div>${stagesHtml(run)}${checkpointHtml(run)}${run?.lastError ? `<div class="error-banner">${escapeHtml(run.lastError)}</div>` : ""}`;
}

function stepHtml(step) {
  const selected = step.id === selectedStepId ? "selected" : "";
  const profile = runFor()?.stageProfiles?.[step.role || "implementation"];
  return `<button class="step status-${escapeHtml(step.status)} ${selected}" data-step="${escapeHtml(step.id)}"><span class="state-icon">${statusIcon(step.status)}</span><span class="step-copy"><span class="step-title">${escapeHtml(step.title)}</span><span class="step-meta">${escapeHtml(profile ? `${profile.model}/${profile.thinking}` : step.agentId)} · ${escapeHtml(step.contextPolicy)} · ${escapeHtml(step.permission)}</span></span><span class="status-label">${escapeHtml(step.status.replaceAll("_", " "))}</span></button>`;
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
  if (!run?.plan) {
    const copy = run ? (run.status === "awaiting_requirements" ? "Approve the requirements above before repository exploration." : run.status === "awaiting_input" ? "Answer the technical question above." : "Exploration and design will produce the graph here.") : "Start the selected ticket to clarify requirements.";
    target.innerHTML = `<div class="empty"><div><strong>No execution graph yet</strong>${copy}</div></div>`;
    return;
  }
  const graph = executionGraph(run.plan);
  const columns = graph.columns.map((column, index) => `<section class="graph-column"><span class="graph-stage-label">Stage ${index + 1}</span>${column.map(graphUnitHtml).join("")}</section>`).join("");
  target.innerHTML = `<div class="tree-heading"><span class="eyebrow">Execution graph</span><span class="eyebrow">dependencies ↓</span></div><div class="execution-graph-scroll"><div id="execution-graph" class="execution-graph"><svg class="graph-edges"></svg><div class="graph-columns">${columns}</div></div></div>`;
  requestAnimationFrame(() => drawEdges(graph.edges));
}

function runPanel(step) {
  const run = runFor();
  const attempt = step.attempts?.at(-1);
  const trace = sessionTraces.get(`${run.id}:${step.id}`);
  const live = liveRuns.get(`${run.id}:${step.id}`);
  const currentLive = live?.runId === attempt?.runId ? null : live;
  const active = run.activeRuns?.[step.id];
  const pulse = runHeartbeat(active, live);
  const heartbeat = pulse ? `<section class="run-heartbeat ${pulse.state}"><span class="heartbeat-dot"></span><div><strong>${escapeHtml(pulse.label)}</strong><small>${pulse.elapsed}s elapsed · last activity ${pulse.idle ? `${pulse.idle}s ago` : "now"}${pulse.note ? ` · ${escapeHtml(pulse.note)}` : ""}</small></div></section>` : "";
  const events = [...(trace?.events || attempt?.events || []), ...(currentLive?.events || [])];
  const timeline = eventTimeline(events).map((item) => {
    const heading = `<span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.status)}</small></span><time>${escapeHtml((item.at || "").slice(11, 19))}</time>`;
    if (!item.hasDetails) return `<div class="run-event unavailable ${item.isError ? "warning" : ""}">${heading}<em>Legacy run — input and output were not recorded</em></div>`;
    const detail = [["Input", item.args], ["Live output", item.output], ["Result", item.result]].filter(([, value]) => value).map(([label, value]) => `<div class="event-block"><label>${label}</label><pre>${escapeHtml(formatOutput(value))}</pre></div>`).join("");
    return `<details class="run-event ${item.isError ? "warning" : ""}" data-event-key="${escapeHtml(item.key)}"><summary>${heading}</summary>${detail}</details>`;
  }).join("") || `<div class="run-empty">The worker has not called a tool yet.</div>`;
  const rawOutput = currentLive?.output || trace?.rawOutput || [attempt?.rawOutput, attempt?.verification?.rawOutput].filter(Boolean).join("\n\n") || "";
  const raw = `<section class="raw-output"><span class="eyebrow">Raw assistant output</span><pre>${escapeHtml(formatOutput(rawOutput || "No assistant text yet. Open event details below to inspect tool calls and their output."))}</pre></section>`;
  const criteria = `<section class="review-criteria"><span class="eyebrow">Acceptance criteria</span>${step.acceptanceCriteria.map((criterion) => `<div><span>○</span>${escapeHtml(criterion)}</div>`).join("")}</section>`;
  return `${step.lastError ? `<div class="error-banner">${escapeHtml(step.lastError)}</div>` : ""}<div class="run-summary"><span class="run-state status-${escapeHtml(step.status)}">${escapeHtml(step.status.replaceAll("_", " "))}</span><strong>${escapeHtml(step.agentId)}</strong><span>${attempt ? `${step.attempts.length} attempt${step.attempts.length === 1 ? "" : "s"}` : "waiting"}</span></div>${heartbeat}${criteria}${raw}<section class="run-events"><span class="eyebrow">Activity · chronological</span>${timeline}</section>`;
}

function diffPanel(step) {
  if (!step.diff?.available) return `<div class="empty compact"><div><strong>No diff captured</strong>A clean tree comparison is recorded for each step.</div></div>`;
  const diff = parseDiff(step.diff.patch);
  return `<div class="diff-overview"><div><strong>${step.diff.files.length} changed files</strong><span>${escapeHtml(step.diff.stat || "Exact tree diff")}</span></div><div class="diff-total"><b>+${diff.additions}</b><i>−${diff.deletions}</i></div></div><div class="diff-files">${diff.files.map((file, index) => `<details class="diff-file" ${index === 0 ? "open" : ""}><summary><span class="diff-file-name">${escapeHtml(file.name)}</span><span class="diff-numbers"><b>+${file.additions}</b><i>−${file.deletions}</i></span></summary><div class="diff-code">${file.rows.map((row) => `<div class="diff-line ${row.kind}"><span>${row.old}</span><span>${row.new}</span><code>${escapeHtml(row.text)}</code></div>`).join("")}</div></details>`).join("")}</div>`;
}

function artifactsPanel(step, artifacts = step ? step.artifacts || [] : runFor()?.artifacts || []) {
  return `<div class="artifact-list">${artifacts.map((artifact) => `<article class="artifact"><header><span class="artifact-name">${escapeHtml(artifact.name)}</span><span class="artifact-source">${escapeHtml(artifact.kind)}</span></header><code class="artifact-path">${escapeHtml(artifact.path || "")}</code><div class="artifact-body">${artifact.name.endsWith(".json") ? `<pre><code data-language="json">${escapeHtml(formatOutput(artifact.content))}</code></pre>` : renderMarkdown(artifact.content)}</div></article>`).join("") || `<div class="run-empty">No persisted artifacts yet.</div>`}</div>`;
}

function renderInspector() {
  const target = $("#inspector");
  const openEvents = new Set([...target.querySelectorAll("details.run-event[open]")].map((item) => item.dataset.eventKey));
  const run = runFor();
  const stage = run?.stages?.find((item) => item.id === selectedStageId);
  const step = nodeById(selectedStepId);
  if (!run) { target.innerHTML = `<div class="empty"><div><strong>Ticket details</strong>Select a Linear ticket, then start its workflow.</div></div>`; return; }
  if (stage) {
    const profileId = ({ explore: "exploration", design: "architecture", implement: "implementation", verify: "verification" })[stage.id] || stage.id;
    const profile = run.stageProfiles?.[profileId];
    const artifacts = artifactsForStage(run.artifacts, stage.id);
    target.innerHTML = `<div class="inspector-shell"><header class="inspector-header"><div><span class="eyebrow">Workflow stage</span><h2>${escapeHtml(stage.title)}</h2></div><span class="run-pill status-${escapeHtml(stage.status)}">${escapeHtml(stage.status)}</span></header><div class="stage-overview"><div><span class="eyebrow">Latest update</span><strong>${escapeHtml(stage.summary || "Waiting to start")}</strong></div>${profile ? `<div><span class="eyebrow">Agent profile</span><strong>${escapeHtml(profile.model)} · ${escapeHtml(profile.thinking)}</strong></div>` : ""}<div><span class="eyebrow">Artifacts</span><strong>${artifacts.length}</strong></div></div>${profile?.prompt ? `<details class="stage-guidance"><summary>Stage instructions</summary><div class="artifact-body">${renderMarkdown(profile.prompt)}</div></details>` : ""}<div class="tab-panel">${artifactsPanel(null, artifacts)}</div><footer class="inspector-footer"><span>${escapeHtml(run.workspace?.cwd || "worktree pending")}</span><span>${escapeHtml(stage.updatedAt ? new Date(stage.updatedAt).toLocaleString() : "not started")}</span></footer></div>`;
    return;
  }
  if (!step) {
    target.innerHTML = `<div class="inspector-shell"><header class="inspector-header"><div><span class="eyebrow">Isolated ticket run</span><h2>Persistent artifacts</h2></div><span class="run-pill status-${escapeHtml(run.status)}">${escapeHtml(statusLabel(run))}</span></header><div class="tab-panel">${artifactsPanel(null)}</div><footer class="inspector-footer"><span>${escapeHtml(run.workspace?.cwd || "worktree pending")}</span><span>sessions stored separately</span></footer></div>`;
    return;
  }
  loadSessionTrace(run, step);
  const renderedPrompt = liveRuns.get(`${run.id}:${step.id}`)?.prompt || run.activeRuns?.[step.id]?.prompt || sessionTraces.get(`${run.id}:${step.id}`)?.prompt || [...(run.artifacts || [])].reverse().find((artifact) => artifact.stepId === step.id && artifact.kind === "agent-prompt")?.content || "Prompt has not been rendered yet.";
  const panels = { run: runPanel(step), diff: diffPanel(step), artifacts: artifactsPanel(step), ticket: artifactsPanel(null), prompt: `<div class="artifact"><header><span class="artifact-name">Rendered agent prompt</span></header><div class="artifact-body">${renderMarkdown(renderedPrompt)}</div></div>` };
  const reviewActions = step.status === "review_ready" ? `<section class="step-review-actions"><form data-request-changes="${escapeHtml(step.id)}"><textarea name="feedback" rows="2" placeholder="Describe a focused correction…" required></textarea><button class="button" type="submit">Request changes</button></form><button class="button success" type="button" data-accept-step="${escapeHtml(step.id)}">Accept & continue</button></section>` : "";
  target.innerHTML = `<div class="inspector-shell"><header class="inspector-header"><div><span class="eyebrow">worker · ${escapeHtml(step.agentId)}</span><h2>${escapeHtml(step.title)}</h2></div><span class="run-pill status-${escapeHtml(step.status)}">${escapeHtml(step.status.replaceAll("_", " "))}</span></header><nav class="tabs">${[["run","Run"],["diff","Diff"],["artifacts","Artifacts"],["ticket","Ticket"],["prompt","Prompt"]].map(([id,label]) => `<button class="tab ${activeTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`).join("")}</nav><div class="tab-panel">${panels[activeTab]}</div>${reviewActions}<footer class="inspector-footer"><span>Output · ${escapeHtml(run.workspace?.cwd || state.workspace.cwd)}${run.workspace?.cwd ? "" : " (after approval)"}</span><span>${escapeHtml(step.contextPolicy)} context · ${escapeHtml(step.permission)} permission · ${escapeHtml(step.status.replaceAll("_", " "))}</span></footer></div>`;
  for (const item of target.querySelectorAll("details.run-event")) item.open = openEvents.has(item.dataset.eventKey);
}

async function loadSessionTrace(run, step) {
  const key = `${run.id}:${step.id}`;
  if (!step.sessionFile || sessionTraces.has(key) || pendingSessionTraces.has(key)) return;
  pendingSessionTraces.add(key);
  try {
    sessionTraces.set(key, await api(`/api/tickets/${encodeURIComponent(run.id)}/steps/${encodeURIComponent(step.id)}/session-trace`));
    if (run.id === runFor()?.id && step.id === selectedStepId) renderInspector();
  } catch (error) { sessionTraces.set(key, { prompt: "", rawOutput: "", events: [] }); notify(error.message); }
  finally { pendingSessionTraces.delete(key); }
}

function render() {
  if (!state) return;
  $("#workspace-path").value = state.workspace.cwd;
  const run = runFor();
  if (selectedStageId && !run?.stages?.some((stage) => stage.id === selectedStageId)) selectedStageId = null;
  if (!selectedStageId) selectedStepId = preferredStepId(run?.plan, selectedStepId);
  renderTickets();
  renderHeader();
  renderPlanTree();
  renderInspector();
}

async function refreshTickets() {
  $("#refresh-tickets").classList.add("spinning");
  try { linear = await api("/api/tickets"); render(); }
  catch (error) { linear = { configured: false, viewer: null, tickets: [] }; notify(error.message); render(); }
  finally { $("#refresh-tickets").classList.remove("spinning"); }
}

document.addEventListener("click", async (event) => {
  if (event.target.closest("#clear-queue")) {
    if (!confirm("Remove all non-running items from the queue? On-disk artifacts will be preserved.")) return;
    try {
      const result = await api("/api/queue/clear", { method: "POST", body: "{}" });
      state = result.state; selectedStepId = null; selectedStageId = null; render(); notify(`${result.cleared} queue item${result.cleared === 1 ? "" : "s"} removed`);
    } catch (error) { notify(error.message); }
    return;
  }
  const ticketButton = event.target.closest("[data-ticket]");
  if (ticketButton) {
    state = await api(`/api/tickets/${encodeURIComponent(ticketButton.dataset.ticket)}/select`, { method: "POST", body: "{}" });
    selectedStepId = null; selectedStageId = null; activeTab = "run"; render(); return;
  }
  const start = event.target.closest("[data-start-ticket]");
  if (start) {
    const ticket = linear.tickets.find((item) => item.id === start.dataset.startTicket);
    try { await api(`/api/tickets/${encodeURIComponent(ticket.id)}/start`, { method: "POST", body: JSON.stringify({ ticket }) }); notify(`${ticket.identifier} requirements clarification started`); }
    catch (error) { notify(error.message); }
    return;
  }
  const resume = event.target.closest("[data-resume-ticket]");
  if (resume) {
    try { await api(`/api/tickets/${encodeURIComponent(resume.dataset.resumeTicket)}/resume`, { method: "POST", body: "{}" }); notify("Interrupted run resumed"); }
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
  const approveContext = event.target.closest("[data-approve-context]");
  if (approveContext) {
    try { await api(`/api/tickets/${encodeURIComponent(approveContext.dataset.approveContext)}/context/approve`, { method: "POST", body: "{}" }); notify("Living product context approved; handoff complete"); }
    catch (error) { notify(error.message); }
    return;
  }
  const selectStep = event.target.closest("[data-select-step]");
  if (selectStep) { selectedStepId = selectStep.dataset.selectStep; selectedStageId = null; activeTab = "diff"; render(); return; }
  const acceptStep = event.target.closest("[data-accept-step]");
  if (acceptStep) {
    try { await api(`/api/tickets/${encodeURIComponent(runFor().id)}/steps/${encodeURIComponent(acceptStep.dataset.acceptStep)}/accept`, { method: "POST", body: "{}" }); notify("Step accepted; continuing to the next slice"); }
    catch (error) { notify(error.message); }
    return;
  }
  const stage = event.target.closest("[data-stage]");
  if (stage) { selectedStageId = stage.dataset.stage; selectedStepId = null; render(); return; }
  const step = event.target.closest("[data-step]");
  if (step) { selectedStepId = step.dataset.step; selectedStageId = null; activeTab = "run"; render(); return; }
  const tab = event.target.closest("[data-tab]");
  if (tab) { activeTab = tab.dataset.tab; renderInspector(); }
  if (event.target.closest("#profile-settings")) { renderProfiles(); $("#profiles-dialog").showModal(); }
  if (event.target.closest("#close-profiles")) $("#profiles-dialog").close();
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
  if (event.target.id === "workspace-form") {
    event.preventDefault();
    try { state = await api("/api/workspace", { method: "POST", body: JSON.stringify({ cwd: $("#workspace-path").value }) }); render(); }
    catch (error) { notify(error.message); }
    return;
  }
  if (event.target.id === "profiles-form") {
    event.preventDefault();
    const data = new FormData(event.target);
    const profiles = Object.fromEntries(profileIds.map((id) => [id, {
      model: data.get(`${id}-model`), thinking: data.get(`${id}-thinking`), prompt: data.get(`${id}-prompt`)
    }]));
    try {
      state = await api("/api/stage-profiles", { method: "POST", body: JSON.stringify({ profiles }) });
      $("#profiles-dialog").close(); render(); notify("Stage profiles saved for new runs");
    } catch (error) { notify(error.message); }
    return;
  }
  if (event.target.id === "linear-connect") {
    event.preventDefault();
    const apiKey = new FormData(event.target).get("apiKey");
    try { linear = await api("/api/linear/connect", { method: "POST", body: JSON.stringify({ apiKey }) }); notify("Linear connected"); render(); }
    catch (error) { notify(error.message); }
    return;
  }
  if (event.target.id === "local-load") {
    event.preventDefault();
    const path = new FormData(event.target).get("path");
    try {
      const result = await api("/api/local/load", { method: "POST", body: JSON.stringify({ path }) });
      state = result.state; selectedStepId = null; selectedStageId = null; activeTab = "run"; render(); notify("Local zero-state fixture loaded");
    } catch (error) { notify(error.message); }
    return;
  }
  const ticketId = event.target.dataset.clarify;
  if (ticketId) {
    event.preventDefault();
    const answers = [...new FormData(event.target).entries()].filter(([, value]) => String(value).trim()).map(([key, value]) => `${Number(key.split("-")[1]) + 1}. ${value}`).join("\n\n");
    try { await api(`/api/tickets/${encodeURIComponent(ticketId)}/clarify`, { method: "POST", body: JSON.stringify({ answers }) }); notify(runFor(ticketId)?.checkpoint?.kind === "requirements_review" ? "Requirements approved; isolated exploration started" : "Technical decision sent; design is being prepared"); }
    catch (error) { notify(error.message); }
  }
  const stepId = event.target.dataset.requestChanges;
  if (stepId) {
    event.preventDefault();
    const feedback = new FormData(event.target).get("feedback");
    try { await api(`/api/tickets/${encodeURIComponent(runFor().id)}/steps/${encodeURIComponent(stepId)}/changes`, { method: "POST", body: JSON.stringify({ feedback }) }); notify("Focused correction started"); }
    catch (error) { notify(error.message); }
  }
});

$("#refresh-tickets").addEventListener("click", refreshTickets);
$("#ticket-search").addEventListener("input", renderTickets);

const events = new EventSource("/api/events");
events.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === "state") { state = event.state; render(); return; }
  if (event.channel === "run" && event.ticketId && event.stepId) {
    const key = `${event.ticketId}:${event.stepId}`;
    let live = liveRuns.get(key) || { events: [], output: "" };
    if (live.runId && live.runId !== event.runId) live = { events: [], output: "" };
    live.runId = event.runId;
    if (event.type === "prompt") live.prompt = event.content;
    else if (event.type === "text_delta") live.output += event.delta;
    else live.events.push({ ...event, at: new Date().toISOString() });
    live.events = live.events.slice(-200);
    live.label = event.label || live.label;
    live.lastAt = new Date().toISOString();
    live.warning = event.type === "agent_error" || (event.type === "tool_end" && event.isError);
    liveRuns.set(key, live);
    if (event.ticketId === state.selectedTicketId && event.stepId === selectedStepId) renderInspector();
  }
};
events.onerror = () => notify("Live connection lost; reconnecting…");

state = await api("/api/state");
await refreshTickets();
render();
window.addEventListener("resize", () => runFor()?.plan && renderPlanTree());
setInterval(() => activeTab === "run" && runFor()?.activeRuns?.[selectedStepId] && renderInspector(), 1000);

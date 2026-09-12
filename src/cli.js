#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseModelRef } from "./profiles.js";
import { freeTextTicket } from "../public/ui-model.js";

const DEFAULT_URL = "http://127.0.0.1:4317";
export const usage = `agent-plan <command>
Talks to 127.0.0.1:4317. AGENT_PLAN_URL / AGENT_PLAN_API_TOKEN supported.

  orchestrator overview [json]      Project digest input ({since,until,offset,limit})
  orchestrator notifications [json] Delivery receipts; owner may {eventId,discard}
  orchestrator policy [json]        Delegation; owner may {expectedRevision,maxProviderResumes}
  orchestrator submit <json|@file|-> Submit an idempotent draft; does not start work
  orchestrator show <ticketId> <runId> Inspect exact run and pending decisions
  orchestrator brief <ticketId> <runId> Conversation-ready summary and decision context
  orchestrator act <ticketId> <json|@file|-> Relay a decision with exact expected identity
  init [--install] [--verify]       Initialize the selected project; optionally install/check it
  doctor [--visual]                Inspect project readiness without running project commands
  new text <prompt>                 Start a free-text ticket (New task dialog)
  list backlog                      Queue and tracker tickets
  list runs [ticketId]              Active and archived run identities for a ticket
  list timeline [ticketId] [runId]  Inspector output for an active or archived run
  select <ticketId> [action]        Select; action: resume|approve|pause|cancel
  resume [ticketId]                 Resume paused, interrupted, or failed work
  restart <ticketId> [target] --confirm Restart fresh or from stage:<id>/step:<id>
  proposal show <ticketId>         Inspect current UI proposal and its artifact
  proposal revise <ticketId> <revisionId> <feedback> Revise UI direction
  approve [ticketId] [--auto] [--proposal revisionId]       Run manually, or auto-run the graph
  approve-proof [ticketId]          Approve final proof and continue delivery
  revise-proof <ticketId> <feedback> [--criterion <id>] Request final-proof corrections (repeat flag for multiple criteria)
  restart-fixer <ticketId> <reason> Abandon a contaminated final-review fixer session
  accept <stepId> [ticketId] [--auto] Accept a step; --auto runs later slices automatically
  revise <stepId> <ticketId> <feedback> [--criterion <id>] Request focused changes (repeat flag for multiple criteria)
  steer <instruction> [ticketId] [--step <stepId>] Queue one focused instruction for an active worker
  waive <stepId> <ticketId> <reason> Reject a false verifier finding and return to review
  scope-add <stepId> <ticketId> <path> <reason> [--max-files N --max-lines N] Approve audited scope/budget
  coordination show [ticketId]      Peer messages, conflicts, decisions and revisions
  coordination conflict <ticketId> <json> Record {summary, stepIds, proposal}
  coordination decide <ticketId> <json> Save {summary, reason, conflictIds, stepIds}
  coordination propose <ticketId> <json> Propose {reason, changes, conflictIds}
  coordination resolve <ticketId> <conflictId> Ask supervisor for a resolution
  coordination accept <ticketId> <revisionId> Accept a proposed revision
  coordination reject <ticketId> <revisionId> <reason> Reject a proposed revision
  cancel [ticketId]
  pause [ticketId]                  Pause and persist the active checkpoint
  profile <stage> <model> <thinking> [ticketId] Override one stopped run stage profile
  preview start|stop|replay [ticketId]     Start or stop the ticket live preview
  answer <ticketId> <text|--approve> Approve or answer an open question
  start <ticketId>                  Start a tracker ticket already in the queue
  wait [ticketId]                   Block until checkpoint; exit 1 on needs_attention
  status [ticketId]
  queue clear                       Remove non-running queue items
  access show                       Current project access policy (JSON)
  access set <json>                 Set extra roots / any access (same JSON as the API)
`;

export async function runCli(argv, opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const [command, ...rest] = argv.filter((arg) => arg !== "--");
  if (!command || command === "help" || command === "--help" || command === "-h") {
    stdout.write(usage);
    return 0;
  }
  const ctx = { env, fetchImpl, stdout, stderr, sleep, stdin: opts.stdin || process.stdin };
  if (command === "status") return statusCommand(rest, ctx);
  return handleCommand(command, rest, ctx);
}

function revisionInput(words) {
  const feedback = [];
  const criterionIds = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== "--criterion") { feedback.push(words[i]); continue; }
    const id = words[++i];
    if (!id?.trim() || id.startsWith("--")) throw new Error("--criterion requires a criterion ID");
    criterionIds.push(id);
  }
  return { feedback: feedback.join(" ").trim(), ...(criterionIds.length ? { criterionIds } : {}) };
}

async function orchestratorInput(input, ctx) {
  let raw = input;
  if (input.startsWith("@")) raw = await readFile(input.slice(1), "utf8");
  else if (input === "-") { raw = ""; for await (const chunk of ctx.stdin) { raw += chunk; if (raw.length > 100000) throw new Error("Orchestrator input exceeds 100000 characters"); } }
  if (raw.length > 100000) throw new Error("Orchestrator input exceeds 100000 characters");
  try { return JSON.parse(raw); } catch { throw new Error("Orchestrator input must be valid JSON"); }
}

async function handleCommand(command, rest, ctx) {
  const { env, fetchImpl, stdout, stderr, sleep } = ctx;
  if (command === "orchestrator") {
    const [action, first, second, ...extra] = rest;
    if (["overview", "notifications", "policy"].includes(action)) {
      if (second || extra.length) throw new Error("Use orchestrator overview|notifications|policy [json|@file|-]");
      const input = first ? await orchestratorInput(first, ctx) : null;
      if (first && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error("Orchestrator options must be a JSON object");
      if (action === "overview" && input && (Array.isArray(input) || typeof input !== "object" || Object.keys(input).some((key) => !["since", "until", "offset", "limit"].includes(key)))) throw new Error("Overview accepts since, until, offset, limit");
      const readQuery = action === "overview" || (action === "notifications" && input && Object.keys(input).length === 1 && Object.hasOwn(input, "offset"));
      const query = readQuery && input ? `?${new URLSearchParams(input)}` : "";
      print(stdout, await request(input && !readQuery ? "POST" : "GET", `/api/orchestrator/${action}${query}`, { env, fetchImpl, ...(input && !readQuery ? { body: input } : {}) }));
      return 0;
    }
    if (extra.length || !first || !["submit", "show", "brief", "act"].includes(action) || (action === "submit" ? second : !second)) throw new Error("Usage: orchestrator submit <json|@file|-> | show|brief <ticketId> <runId> | act <ticketId> <json|@file|->");
    if (["show", "brief"].includes(action)) {
      const view = await request("GET", `/api/orchestrator/tickets/${encodeURIComponent(first)}/runs/${encodeURIComponent(second)}`, { env, fetchImpl });
      if (action === "brief") view.message = [
        `${view.ticket?.title || view.ticketId}: ${view.status}.`,
        view.requiredAction,
        ["needs_attention", "failed"].includes(view.status) && view.lastError ? `Error: ${view.lastError}` : null,
        ...(view.checkpoint?.questions || []).map((question) => `Question: ${question}`),
        view.checkpoint?.prompt ? `${view.checkpoint.promptTruncated ? "Prompt (truncated):\n" : "Prompt:\n"}${view.checkpoint.prompt}` : null,
        view.proof ? `Proof: ${view.proof.eligible ? "eligible" : "not eligible"}${view.proof.blockingReasons?.length ? `. ${view.proof.blockingReasons.join("; ")}` : ""}` : null,
        ...(view.proof?.criteria || []).map((criterion) => `Criterion ${criterion.id}: ${criterion.status} (evidence: ${criterion.evidenceValidity})${criterion.mediaIds?.length ? ` media=${criterion.mediaIds.join(",")}` : ""}. ${criterion.text}`),
        view.uiImpact ? `UI impact: ${view.uiImpact.level}. ${view.uiImpact.reason}` : null,
        view.uiProposal ? `UI proposal ${view.uiProposal.revisionId}: ${view.uiProposal.invalidatedAt ? "needs revision" : view.uiProposal.approvedAt ? "approved" : "awaiting review"}. ${view.uiProposal.summary || ""}` : null
      ].filter(Boolean).join("\n");
      print(stdout, view);
      return 0;
    }
    const input = action === "submit" ? first : second;
    const payload = await orchestratorInput(input, ctx);
    print(stdout, await request("POST", action === "submit" ? "/api/orchestrator/tickets" : `/api/orchestrator/tickets/${encodeURIComponent(first)}/actions`, { body: payload, env, fetchImpl }));
    return 0;
  }
  if (command === "init") {
    if (rest.some((arg) => !["--install", "--verify"].includes(arg))) throw new Error("Usage: agent-plan init [--install] [--verify]");
    const result = await request("POST", "/api/workspace/init", { body: { install: rest.includes("--install"), verify: rest.includes("--verify") }, env, fetchImpl });
    print(stdout, result);
    return Object.values(result.results).some((check) => check.status === "failed") ? 1 : 0;
  }
  if (command === "doctor") {
    if (rest.length && (rest.length !== 1 || rest[0] !== "--visual")) throw new Error("Usage: agent-plan doctor [--visual]");
    const result = await request("GET", `/api/workspace/readiness${rest.length ? "?visual=1" : ""}`, { env, fetchImpl });
    print(stdout, result);
    return result.ready ? 0 : 1;
  }
  if (command === "coordination") {
    const [action = "show", explicitId, input, ...extra] = rest;
    if (!["show", "conflict", "propose", "decide", "resolve", "accept", "reject"].includes(action) || (action !== "reject" && extra.length)) throw new Error("Usage: agent-plan coordination show|conflict|propose|resolve|accept|reject [ticketId] [input]");
    const id = await resolveTicketId(explicitId, ctx);
    const base = `/api/tickets/${encodeURIComponent(id)}/coordination`;
    if (action === "show") {
      if (input) throw new Error("Usage: agent-plan coordination show [ticketId]");
      print(stdout, await request("GET", base, { env, fetchImpl }));
      return 0;
    }
    if (!input) throw new Error(`coordination ${action} requires an input`);
    let body = {};
    let suffix;
    if (["conflict", "propose", "decide"].includes(action)) {
      try { body = JSON.parse(input); } catch { throw new Error("Coordination input must be valid JSON"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Coordination input must be an object");
      suffix = action === "conflict" ? "conflicts" : action === "decide" ? "decisions" : "revisions";
    } else if (action === "resolve") { suffix = "resolve"; body = { conflictId: input }; }
    else {
      suffix = `revisions/${encodeURIComponent(input)}/${action}`;
      if (action === "reject") {
        body = { reason: extra.join(" ").trim() };
        if (!body.reason) throw new Error("coordination reject requires a reason");
      }
    }
    print(stdout, await request("POST", `${base}/${suffix}`, { body, env, fetchImpl }));
    return 0;
  }
  if (command === "new") {
    if (rest[0] !== "text") throw new Error("Usage: agent-plan new text <prompt>\n" + usage);
    const prompt = rest.slice(1).join(" ").trim();
    if (!prompt) throw new Error("Usage: agent-plan new text <prompt>");
    const ticket = freeTextTicket(prompt, randomUUID());
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(ticket.id) + "/start", { body: { ticket }, env, fetchImpl });
    print(stdout, { ticketId: ticket.id, identifier: ticket.identifier, title: ticket.title, ...result });
    return 0;
  }
  if (command === "list" || command === "backlog" || command === "timeline") {
    const what = command === "list" ? rest[0] : command;
    const args = command === "list" ? rest.slice(1) : rest;
    if (what === "backlog") {
      print(stdout, await backlog(ctx));
      return 0;
    }
    if (what === "runs") {
      print(stdout, await runHistories(args[0], ctx));
      return 0;
    }
    if (what === "timeline" || what === "execution-timeline") {
      print(stdout, sanitizeTimeline(await timeline(args[0], args[1], ctx)));
      return 0;
    }
    throw new Error("Usage: agent-plan list backlog|runs [ticketId]|timeline [ticketId] [runId]\n" + usage);
  }
  if (command === "select") {
    const id = rest[0];
    if (!id) throw new Error("Usage: agent-plan select <ticketId> [resume|approve|pause|cancel]");
    await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/select", { body: {}, env, fetchImpl });
    const action = aliasAction(rest[1]);
    if (!action) {
      print(stdout, { selectedTicketId: id });
      return 0;
    }
    return handleCommand(action, [id, ...rest.slice(2)], ctx);
  }
  if (command === "resume") {
    const id = await resolveTicketId(rest[0], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/resume", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "restart") {
    const id = rest[0];
    const target = rest.find((arg, index) => index > 0 && arg !== "--confirm") || "fresh";
    if (!id || !rest.includes("--confirm")) throw new Error("Usage: agent-plan restart <ticketId> [fresh|stage:<id>|step:<id>] --confirm");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/restart", { body: { target, confirmed: true }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "cancel") {
    const id = await resolveTicketId(rest[0], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/cancel", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "pause") {
    const id = await resolveTicketId(rest[0], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/pause", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "profile") {
    const [profileId, model, thinking, explicitId] = rest;
    if (!profileId || !model || !thinking) throw new Error("Usage: agent-plan profile <stage> <model> <thinking> [ticketId]");
    const id = await resolveTicketId(explicitId, ctx);
    const parsed = parseModelRef(model);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/stage-profiles/" + encodeURIComponent(profileId), {
      body: { model: parsed.model, thinking, ...(parsed.provider ? { provider: parsed.provider } : {}) },
      env, fetchImpl
    });
    print(stdout, result);
    return 0;
  }
  if (command === "preview") {
    const action = rest[0];
    if (!["start", "stop", "replay"].includes(action)) throw new Error("Usage: agent-plan preview start|stop|replay [ticketId]");
    if (action === "replay" && (!rest[1] || !rest[2])) throw new Error("Usage: agent-plan preview replay <ticketId> <runId>");
    const id = await resolveTicketId(rest[1], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/preview", { body: { action, ...(action === "replay" ? { runId: rest[2] } : {}) }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "accept") {
    const stepId = rest[0];
    if (!stepId) throw new Error("Usage: agent-plan accept <stepId> [ticketId] [--auto]");
    const auto = rest.includes("--auto");
    const id = await resolveTicketId(rest.slice(1).find((arg) => arg !== "--auto"), ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steps/" + encodeURIComponent(stepId) + "/accept", { body: { auto }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "revise") {
    const [stepId, id, ...words] = rest;
    const input = revisionInput(words);
    if (!stepId || !id || !input.feedback) throw new Error("Usage: agent-plan revise <stepId> <ticketId> <feedback> [--criterion <id>]");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steps/" + encodeURIComponent(stepId) + "/changes", { body: input, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "steer") {
    const flag = rest.indexOf("--step");
    const stepId = flag >= 0 ? String(rest[flag + 1] || "").trim() : null;
    const args = flag < 0 ? rest : rest.filter((_, index) => index !== flag && index !== flag + 1);
    const [instruction, explicitId, ...extra] = args;
    if (!instruction || extra.length || (flag >= 0 && !stepId)) throw new Error("Usage: agent-plan steer <instruction> [ticketId] [--step <stepId>]");
    const id = await resolveTicketId(explicitId, ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steering", { body: { instruction, author: "cli", ...(stepId ? { stepId } : {}) }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "scope-add") {
    const [stepId, id, path, ...words] = rest;
    const reasonWords = [];
    const reviewBudget = {};
    for (let i = 0; i < words.length; i++) {
      if (words[i] === "--max-files" || words[i] === "--max-lines") {
        const key = words[i] === "--max-files" ? "maxFiles" : "maxChangedLines";
        const value = Number(words[++i]);
        if (!Number.isInteger(value) || value <= 0) throw new Error("Review budget limits must be positive integers");
        reviewBudget[key] = value;
      } else reasonWords.push(words[i]);
    }
    const hasBudget = Object.keys(reviewBudget).length > 0;
    if (hasBudget && (!reviewBudget.maxFiles || !reviewBudget.maxChangedLines)) throw new Error("Provide both --max-files and --max-lines");
    const reason = reasonWords.join(" ").trim();
    if (!stepId || !id || !path || !reason) throw new Error("Usage: agent-plan scope-add <stepId> <ticketId> <path> <reason>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steps/" + encodeURIComponent(stepId) + "/scope", { body: { paths: [path], reason, ...(hasBudget ? { reviewBudget } : {}) }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "waive") {
    const [stepId, id, ...words] = rest;
    const reason = words.join(" ").trim();
    if (!stepId || !id || !reason) throw new Error("Usage: agent-plan waive <stepId> <ticketId> <reason>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/steps/" + encodeURIComponent(stepId) + "/waive", { body: { reason }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "queue") {
    if (rest[0] !== "clear") throw new Error("Usage: agent-plan queue clear\n" + usage);
    const result = await request("POST", "/api/queue/clear", { body: {}, env, fetchImpl });
    print(stdout, { cleared: result.cleared });
    return 0;
  }
  if (command === "wait") {
    const id = await resolveTicketId(rest[0], ctx);
    const deadline = Date.now() + Number(env.AGENT_PLAN_WAIT_MS || 30 * 60 * 1000);
    while (Date.now() < deadline) {
      const run = await request("GET", "/api/tickets/" + encodeURIComponent(id) + "/run", { env, fetchImpl });
      const result = terminal(run);
      if (result.done) {
        print(stdout, run);
        return result.code;
      }
      await sleep(Number(env.AGENT_PLAN_POLL_MS || 1000));
    }
    stderr.write("Timed out waiting for a checkpoint\n");
    return 1;
  }
  if (command === "answer") {
    const id = rest[0];
    const approve = rest.length === 2 && rest[1] === "--approve";
    const answers = approve ? "" : rest.slice(1).join(" ").trim();
    if (!id || (!approve && !answers)) throw new Error("Usage: agent-plan answer <ticketId> <text|--approve>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/clarify", { body: { answers }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "proposal") {
    const [action, id, revision, ...words] = rest;
    if (!id || !["show", "revise"].includes(action)) throw new Error("Usage: agent-plan proposal show <ticketId> | revise <ticketId> <revisionId> <feedback>");
    if (action === "show") {
      const run = await request("GET", `/api/tickets/${encodeURIComponent(id)}/run?detail=1`, { env, fetchImpl });
      const proposal = run.uiProposal;
      if (!proposal) throw new Error("No UI proposal retained");
      const artifact = await request("GET", `/api/tickets/${encodeURIComponent(id)}/runs/${encodeURIComponent(run.runId)}/artifacts/${encodeURIComponent(proposal.artifactId)}/content`, { env, fetchImpl });
      print(stdout, { ticketId: id, runId: run.runId, ...proposal, artifact });
    } else {
      if (!revision || !words.length) throw new Error("Proposal revision and feedback are required");
      print(stdout, await request("POST", `/api/tickets/${encodeURIComponent(id)}/ui-proposal/changes`, { body: { proposalRevision: revision, feedback: words.join(" ") }, env, fetchImpl }));
    }
    return 0;
  }
  if (command === "approve") {
    const args = [...rest];
    const at = args.indexOf("--proposal");
    let proposalRevision;
    if (at !== -1) {
      if (!args[at + 1] || args[at + 1].startsWith("--")) throw new Error("--proposal requires a revision ID");
      proposalRevision = args[at + 1]; args.splice(at, 2);
    }
    const auto = args.includes("--auto");
    const positional = args.filter((arg) => arg !== "--auto");
    if (positional.length > 1 || positional[0]?.startsWith("--")) throw new Error("Usage: agent-plan approve [ticketId] [--auto] [--proposal revisionId]");
    const id = await resolveTicketId(positional[0], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/approve", { body: { auto, ...(proposalRevision ? { proposalRevision } : {}) }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "approve-proof") {
    const id = await resolveTicketId(rest[0], ctx);
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/evidence/approve", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "revise-proof") {
    const [id, ...words] = rest;
    const input = revisionInput(words);
    if (!id || !input.feedback) throw new Error("Usage: agent-plan revise-proof <ticketId> <feedback> [--criterion <id>]");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/evidence/changes", { body: input, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "restart-fixer") {
    const [id, ...words] = rest;
    const reason = words.join(" ").trim();
    if (!id || !reason) throw new Error("Usage: agent-plan restart-fixer <ticketId> <reason>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/review-fix/restart", { body: { reason }, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "start") {
    const id = rest[0];
    if (!id) throw new Error("Usage: agent-plan start <ticketId>");
    const result = await request("POST", "/api/tickets/" + encodeURIComponent(id) + "/start", { body: {}, env, fetchImpl });
    print(stdout, result);
    return 0;
  }
  if (command === "access") {
    const action = rest[0] || "show";
    if (action === "show" && rest.length <= 1) {
      print(stdout, await request("GET", "/api/workspace/access-policy", { env, fetchImpl }));
      return 0;
    }
    if (action === "set") {
      const raw = rest.slice(1).join(" ").trim();
      if (!raw) throw new Error("Usage: agent-plan access set <json>\n" + usage);
      let body;
      try { body = JSON.parse(raw); }
      catch { throw new Error("Access policy JSON is invalid"); }
      print(stdout, await request("POST", "/api/workspace/access-policy", { body, env, fetchImpl }));
      return 0;
    }
    throw new Error("Usage: agent-plan access show|set <json>\n" + usage);
  }
  throw new Error("Unknown command: " + command + "\n" + usage);
}

async function statusCommand(rest, ctx) {
  const { env, fetchImpl, stdout } = ctx;
  const id = rest[0];
  if (id) {
    print(stdout, await request("GET", "/api/tickets/" + encodeURIComponent(id) + "/run", { env, fetchImpl }));
    return 0;
  }
  const state = await request("GET", "/api/state", { env, fetchImpl });
  const runs = Object.values(state.ticketRuns || {}).map((run) => ({
    id: run.id, status: run.status, checkpoint: run.checkpoint, lastError: run.lastError, workflow: run.workflow
  }));
  print(stdout, { selectedTicketId: state.selectedTicketId, revision: state.revision, runs });
  return 0;
}

async function backlog(ctx) {
  const { env, fetchImpl } = ctx;
  const [sources, state] = await Promise.all([
    request("GET", "/api/tickets", { env, fetchImpl }).catch(() => ({ tickets: [] })),
    request("GET", "/api/state", { env, fetchImpl })
  ]);
  const runs = state.ticketRuns || {};
  const seen = new Set();
  const tickets = [];
  for (const ticket of sources.tickets || []) {
    const run = runs[ticket.id];
    tickets.push(backlogRow(ticket, run, state.selectedTicketId));
    seen.add(ticket.id);
  }
  for (const run of Object.values(runs)) {
    if (seen.has(run.id)) continue;
    tickets.push(backlogRow(run.ticket || { id: run.id }, run, state.selectedTicketId));
  }
  return { selectedTicketId: state.selectedTicketId, tickets };
}

function backlogRow(ticket, run, selectedTicketId) {
  return {
    id: ticket.id,
    identifier: ticket.identifier || run?.ticket?.identifier || ticket.id,
    title: ticket.title || run?.ticket?.title || "",
    source: ticket.source || ticket.provider || run?.ticket?.source || null,
    status: run?.status || ticket.state?.name || null,
    checkpoint: run?.checkpoint?.kind || null,
    selected: selectedTicketId === ticket.id
  };
}

async function timeline(explicitId, runId, ctx) {
  const { env, fetchImpl } = ctx;
  const state = explicitId ? null : await request("GET", "/api/state", { env, fetchImpl });
  const id = explicitId || state.selectedTicketId;
  if (!id) throw new Error("Pass a ticket id (no selected run)");
  // The inspector owns focus, lifecycle, redaction, and retention semantics. Keep
  // this command a transport-only view so its JSON cannot drift from the dashboard.
  const path = runId
    ? "/api/tickets/" + encodeURIComponent(id) + "/runs/" + encodeURIComponent(runId) + "/inspection"
    : "/api/tickets/" + encodeURIComponent(id) + "/inspection";
  return request("GET", path, { env, fetchImpl });
}

async function runHistories(explicitId, ctx) {
  const id = await resolveTicketId(explicitId, ctx);
  return request("GET", "/api/tickets/" + encodeURIComponent(id) + "/runs", { env: ctx.env, fetchImpl: ctx.fetchImpl });
}

function aliasAction(value) {
  if (!value) return null;
  if (value === "resume-run") return "resume";
  if (["resume", "approve", "pause", "cancel", "start"].includes(value)) return value;
  throw new Error("Unknown action: " + value + " (resume|approve|pause|cancel)");
}

async function resolveTicketId(explicit, ctx) {
  if (explicit) return explicit;
  const state = await request("GET", "/api/state", { env: ctx.env, fetchImpl: ctx.fetchImpl });
  const id = state.selectedTicketId || Object.keys(state.ticketRuns || {})[0];
  if (!id) throw new Error("Pass a ticket id (no selected run)");
  return id;
}

const timelineSecretKey = /(?:api[_-]?key|authorization|credential|password|secret|token|cookie|private[_-]?key)/i;
const timelineAuthorization = /\b(?:authorization|proxy-authorization)\s*[=:]\s*[^\r\n]+/gi;
const timelineSecret = /\b(?:api[_-]?key|authorization|credential|password|secret|token|cookie|private[_-]?key)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const timelinePath = /(^|[^A-Za-z0-9_.@-])(?:~\/|\/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*|[A-Za-z]:\\[^\s"'`),;]+)/g;

function sanitizeTimeline(value) {
  if (typeof value === "string") return value
    .replace(timelineAuthorization, "[redacted]")
    .replace(timelineSecret, (match) => match.replace(/(?:"[^"]*"|'[^']*'|[^\s,;]+)$/, "[redacted]"))
    .replace(timelinePath, (_, prefix) => `${prefix}[path]`);
  if (Array.isArray(value)) return value.map(sanitizeTimeline);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, timelineSecretKey.test(key) ? "[redacted]" : sanitizeTimeline(item)]));
}

function print(stdout, payload) {
  stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function baseUrl(env) {
  env = env || process.env;
  return String(env.AGENT_PLAN_URL || DEFAULT_URL).replace(/\/$/, "");
}

function headers(env) {
  env = env || process.env;
  const token = env.AGENT_PLAN_API_TOKEN;
  const result = { "content-type": "application/json" };
  if (token) result.authorization = "Bearer " + token;
  return result;
}

async function request(method, path, opts) {
  opts = opts || {};
  const env = opts.env;
  const fetchImpl = opts.fetchImpl || fetch;
  const response = await fetchImpl(baseUrl(env) + path, {
    method,
    headers: { ...headers(env), ...(method === "POST" ? { prefer: "respond-async" } : {}) },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!response.ok) throw new Error((payload && payload.error) || ("Request failed: " + response.status));
  return payload;
}

function terminal(run) {
  if (!run) return { done: true, code: 1, reason: "missing" };
  if (run.status === "needs_attention" || (run.checkpoint && run.checkpoint.kind === "needs_attention")) return { done: true, code: 1, reason: "needs_attention" };
  if (run.status === "failed") return { done: true, code: 1, reason: "failed" };
  if (run.status === "completed") return { done: true, code: 0, reason: "completed" };
  if (run.status === "paused") return { done: true, code: 0, reason: "paused" };
  if (run.checkpoint) return { done: true, code: 0, reason: "checkpoint" };
  return { done: false, code: 0, reason: run.status };
}

if (process.argv[1] && import.meta.url === ("file://" + process.argv[1])) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(error.message + String.fromCharCode(10));
    process.exitCode = 1;
  });
}

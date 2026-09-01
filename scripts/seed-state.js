import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTicketRun, localStages } from "../src/execution.js";
import { loadLocalFixture } from "../src/local.js";
import { normalizePlan } from "../src/plan.js";
import { JsonStore } from "../src/store.js";
import { repoRoot } from "./inspect.js";

export function sampleTicket(overrides = {}) {
  return {
    id: "ticket-1",
    identifier: "T-1",
    title: "Ticket",
    description: "Desc",
    state: { name: "Ready" },
    source: "linear",
    ...overrides
  };
}

export const scenarios = {
  empty: "Empty daemon state, no ticket runs",
  clarifying: "Tracker ticket in requirements clarification (daemon load marks this interrupted)",
  "plan-approval": "Local zero-state fixture awaiting plan approval",
  "review-ready": "Approved plan paused on a reviewable implementation step",
  interrupted: "In-flight execution paused after a daemon restart",
  "needs-attention": "Stalled correction waiting on the dashboard"
};

function planForReview() {
  const plan = normalizePlan({
    title: "Seeded review",
    summary: "One reviewable slice",
    nodes: [{
      id: "build",
      title: "Build the slice",
      permission: "write",
      writeScope: "src",
      expectedFiles: ["src/app.js"],
      estimatedChangedLines: 20,
      acceptanceCriteria: ["The slice is independently reviewable"]
    }]
  });
  plan.nodes[0].status = "review_ready";
  return plan;
}

async function ensureFixture(cwd) {
  const from = join(repoRoot, "fixtures/zero-state-task-board");
  const to = join(cwd, "fixtures/zero-state-task-board");
  await mkdir(join(cwd, "fixtures"), { recursive: true });
  await cp(from, to, { recursive: true });
  return loadLocalFixture(cwd, "fixtures/zero-state-task-board");
}

async function applyScenario(state, scenario, { cwd }) {
  if (scenario === "empty") return { ticketId: null };
  if (scenario === "plan-approval") {
    const fixture = await ensureFixture(cwd);
    const ticket = sampleTicket({
      id: "local-seeded-plan",
      identifier: "LOCAL-seeded-plan",
      title: fixture.plan.title,
      description: fixture.plan.summary || "Local zero-state fixture",
      source: "local",
      fixturePath: fixture.directory,
      state: { name: "Local fixture", type: "local" },
      team: { name: "Local" }
    });
    state.selectedTicketId = ticket.id;
    state.ticketRuns[ticket.id] = createTicketRun(ticket, state.stageProfiles, {
      runId: "seed-plan",
      status: "awaiting_approval",
      workspace: null,
      stages: localStages(),
      checkpoint: {
        id: "seed-approve-plan",
        kind: "awaiting_approval",
        title: "Approve local execution plan",
        prompt: fixture.feature,
        createdAt: new Date().toISOString()
      },
      plan: fixture.plan,
      artifacts: [
        { id: "feature", name: "feature.md", kind: "feature-brief", stageId: "requirements" },
        { id: "plan", name: "plan.json", kind: "plan-source", stageId: "design" }
      ]
    });
    return { ticketId: ticket.id };
  }

  const ticket = sampleTicket();
  const extras = {
    clarifying: { status: "clarifying" },
    "review-ready": {
      status: "awaiting_approval",
      plan: planForReview(),
      planApprovedAt: new Date().toISOString(),
      workspace: { cwd },
      checkpoint: { id: "seed-review", kind: "awaiting_approval", stepId: "build", title: "Review build", source: "worker" },
      stages: localStages().map((stage) => stage.id === "implement" ? { ...stage, status: "active", summary: "Waiting for review" } : stage)
    },
    interrupted: {
      status: "interrupted",
      workspace: { cwd },
      recovery: {
        kind: "execution",
        previousStatus: "running",
        previousMergeStatus: null,
        uncertainExternalActions: false,
        message: "Execution was interrupted. Review the checkpoint and resume manually."
      }
    },
    "needs-attention": {
      status: "needs_attention",
      lastError: "Paused after 8 correction rounds without a passing verification.",
      checkpoint: { id: "seed-stalled", kind: "needs_attention", title: "Correction stalled" }
    }
  }[scenario];
  if (!extras) throw new Error(`Unknown seed scenario: ${scenario}. Known: ${Object.keys(scenarios).join(", ")}`);
  state.selectedTicketId = ticket.id;
  state.ticketRuns[ticket.id] = createTicketRun(ticket, state.stageProfiles, {
    runId: "seed-run",
    workspace: { cwd },
    ...extras
  });
  return { ticketId: ticket.id };
}

export async function writeSeed({ dataDir, cwd, scenario = "clarifying" }) {
  if (!scenarios[scenario]) throw new Error(`Unknown seed scenario: ${scenario}. Known: ${Object.keys(scenarios).join(", ")}`);
  await mkdir(dataDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const store = new JsonStore(join(dataDir, "state-v3.json"), cwd);
  await store.init();
  let ticketId = null;
  const state = await store.update(async (draft) => {
    draft.workspace = { cwd };
    ({ ticketId } = await applyScenario(draft, scenario, { cwd }));
  });
  return { dataDir, cwd, scenario, ticketId, stateFile: join(dataDir, "state-v3.json"), revision: state.revision };
}

import { cp, mkdir, writeFile } from "node:fs/promises";
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
  "proof-review": "Verified ticket awaiting final screenshot and test review",
  interrupted: "In-flight execution paused after a daemon restart",
  "needs-attention": "Stalled correction waiting on the dashboard",
  observability: "Parallel active work with retained failed and corrected attempts, verification, handoff, truncation, and unavailable resources"
};

const observabilityTimes = {
  created: "2026-09-03T09:55:00.000Z",
  failedStart: "2026-09-03T10:00:00.000Z",
  failedEnd: "2026-09-03T10:01:00.000Z",
  correctedStart: "2026-09-03T10:02:00.000Z",
  correctedEnd: "2026-09-03T10:03:00.000Z",
  accepted: "2026-09-03T10:04:00.000Z",
  verification: "2026-09-03T10:05:00.000Z",
  handoff: "2026-09-03T10:06:00.000Z",
  active: "2026-09-03T10:07:00.000Z"
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

function observabilityPlan() {
  const plan = normalizePlan({
    title: "Observable workflow fixture",
    summary: "Stable lifecycle records for dashboard and CLI supervision",
    nodes: [
      {
        id: "foundation", title: "Retain corrected foundation", permission: "write", writeScope: "src/foundation.js",
        expectedArtifacts: ["foundation.md"], acceptanceCriteria: ["Correction is independently verified"]
      },
      {
        id: "parallel", type: "group", children: [
          { id: "api", title: "Active API worker", permission: "write", writeScope: "src/api.js", acceptanceCriteria: ["API work is attributable"] },
          { id: "ui", title: "Active UI worker", permission: "write", writeScope: "src/ui.js", acceptanceCriteria: ["UI work is attributable"] }
        ]
      }
    ]
  });
  const foundation = plan.nodes[0];
  foundation.status = "accepted";
  foundation.acceptedAt = observabilityTimes.accepted;
  foundation.attempts = [
    {
      attemptId: "foundation-original", runId: "worker-foundation-original", status: "failed",
      startedAt: observabilityTimes.failedStart, completedAt: observabilityTimes.failedEnd,
      error: "Provider request failed", rawOutput: "x".repeat(100000),
      terminationReason: "provider_failure"
    },
    {
      attemptId: "foundation-correction", runId: "worker-foundation-correction", status: "verified",
      startedAt: observabilityTimes.correctedStart, completedAt: observabilityTimes.correctedEnd,
      report: { status: "completed", summary: "Corrected foundation verified" },
      verification: { checks: { status: "passed", command: "node scripts/test.mjs", summary: "Passed" } },
      diff: { available: true, files: ["src/foundation.js"], stat: "1 file changed" }
    }
  ];
  for (const step of plan.nodes[1].children) step.status = "running";
  return plan;
}

async function ensureFixture(cwd) {
  const from = join(repoRoot, "fixtures/zero-state-task-board");
  const to = join(cwd, "fixtures/zero-state-task-board");
  await mkdir(join(cwd, "fixtures"), { recursive: true });
  await cp(from, to, { recursive: true });
  return loadLocalFixture(cwd, "fixtures/zero-state-task-board");
}

export async function applyScenario(state, scenario, { cwd, dataDir }) {
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

  if (scenario === "observability") {
    const ticket = sampleTicket({ id: "observable-workflow", identifier: "OBS-1", title: "Observable workflow fixture" });
    const plan = observabilityPlan();
    state.selectedTicketId = ticket.id;
    state.ticketRuns[ticket.id] = createTicketRun(ticket, state.stageProfiles, {
      runId: "seed-observability", status: "running", workspace: { cwd }, plan, createdAt: observabilityTimes.created,
      stages: localStages().map((stage) => stage.id === "implement"
        ? { ...stage, status: "active", summary: "Two independently attributable workers are active", updatedAt: observabilityTimes.active }
        : stage.id === "verify"
          ? { ...stage, status: "completed", summary: "Verification completed for the corrected foundation", updatedAt: observabilityTimes.verification }
          : stage.id === "handoff"
            ? { ...stage, status: "completed", summary: "Handoff retained for inspection", updatedAt: observabilityTimes.handoff }
            : stage),
      activeRuns: {
        api: { runId: "active-api", startedAt: observabilityTimes.active, lastEvent: "Waiting for first API event" },
        ui: { runId: "active-ui", startedAt: observabilityTimes.active, lastEvent: "Waiting for first UI event" }
      },
      artifacts: [
        { id: "foundation-output", name: "foundation.md", kind: "agent-output", stageId: "implement", stepId: "foundation", attemptId: "foundation-correction", summary: "Corrected output retained" },
        { id: "handoff", name: "handoff.md", kind: "handoff", stageId: "handoff", summary: "Completed handoff retained" }
      ],
      reviews: [{ round: 1, createdAt: observabilityTimes.verification, actionableFindings: [], reviews: [
        { role: "deterministic", summary: "Verification passed", checks: { status: "passed", command: "node scripts/test.mjs", summary: "Passed" } }
      ] }],
      integration: { integratedAt: observabilityTimes.handoff }
    });
    return { ticketId: ticket.id };
  }

  if (scenario === "proof-review") {
    const ticket = sampleTicket({ id: "proof-review", identifier: "T-PROOF", title: "Review final proof" });
    const plan = planForReview();
    Object.assign(plan.nodes[0], {
      status: "accepted",
      acceptedAt: new Date().toISOString(),
      requiresVisualEvidence: true,
      attempts: [{
        attemptId: "proof-implementation", runId: "worker-proof-implementation", status: "verified",
        startedAt: "2026-09-03T10:01:00.000Z", completedAt: "2026-09-03T10:02:00.000Z",
        report: { status: "completed", summary: "Implementation accepted" },
        verification: { checks: { status: "passed", command: "node scripts/test.mjs", summary: "Passed" } }
      }]
    });
    const directory = join(dataDir, "visual-evidence", "proof-review");
    const path = join(directory, "desktop.png");
    await mkdir(directory, { recursive: true });
    await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const artifact = { id: "proof-desktop", name: "desktop.png", path, mediaType: "image/png", mediaKind: "image", kind: "visual-evidence", stageId: "verify", summary: "1440×900 · final changed flow" };
    state.selectedTicketId = ticket.id;
    state.ticketRuns[ticket.id] = createTicketRun(ticket, state.stageProfiles, {
      runId: "seed-proof", status: "awaiting_evidence_review", workspace: { cwd }, plan, artifacts: [
        { id: "proof-output", name: "build.md", kind: "agent-output", stageId: "implement", stepId: "build", attemptId: "proof-implementation", summary: "Accepted implementation retained" },
        artifact
      ],
      reviews: [{ round: 1, createdAt: new Date().toISOString(), actionableFindings: [], reviews: [
        { role: "deterministic", summary: "Integration and repository checks passed", checks: { status: "passed", command: "node .agent-plan/verify.mjs", summary: "Integration and repository checks passed" } },
        { role: "integration", summary: "No cross-component issues found" }
      ] }],
      checkpoint: { id: "seed-proof-review", kind: "evidence_review", title: "Review final proof before delivery", finalChecks: { status: "passed", command: "node .agent-plan/verify.mjs", summary: "Integration and repository checks passed" }, media: [artifact], evidenceArtifactIds: [artifact.id], videoRequired: false },
      stages: localStages().map((stage) => stage.id === "implement" || stage.id === "verify"
        ? { ...stage, status: "completed", summary: stage.id === "verify" ? "Combined review passed" : "Accepted implementation retained" }
        : stage.id === "handoff" ? { ...stage, status: "blocked", summary: "Review final proof before delivery" } : stage)
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

export async function seedScenario(store, { dataDir, cwd, scenario = "clarifying" }) {
  if (!scenarios[scenario]) throw new Error(`Unknown seed scenario: ${scenario}. Known: ${Object.keys(scenarios).join(", ")}`);
  let ticketId = null;
  const state = await store.update(async (draft) => {
    draft.workspace = { cwd };
    ({ ticketId } = await applyScenario(draft, scenario, { cwd, dataDir }));
  });
  return { dataDir, cwd, scenario, ticketId, stateFile: store.file, revision: state.revision };
}

export async function writeSeed({ dataDir, cwd, scenario = "clarifying" }) {
  await mkdir(dataDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  const store = new JsonStore(join(dataDir, "state-v3.json"), cwd);
  await store.init();
  return seedScenario(store, { dataDir, cwd, scenario });
}

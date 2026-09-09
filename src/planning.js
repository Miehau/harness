import { inspectReadiness } from "./readiness.js";
import { randomUUID } from "node:crypto";
import { persistArtifact, readProductContext } from "./artifacts.js";
import { redactText, retainDurableRecord } from "./redaction.js";
import { formatTicketHorizon } from "./pi-prompts.js";
import { snapshotTree } from "./git.js";
import { ensureTicketWorktree } from "./worktrees.js";
import { initializeJjWorkspace } from "./jj.js";
import { executionBlockedByWorkflow, pauseIfWorkflowBlocked } from "./workflow.js";
import { setStage } from "./run-status.js";

function ticketRun(state, ticketId) {
  const run = state.ticketRuns?.[ticketId];
  if (!run) throw new Error("Ticket run not found");
  return run;
}

function ownedRun(state, ticketId, runId, signal) {
  const run = state.ticketRuns?.[ticketId];
  return !signal?.aborted && run?.runId === runId ? run : null;
}

export function planApprovalCheckpoint(prompt) {
  const notice = "Named project commands keep argv and environment allow-lists. They are not a filesystem sandbox and do not isolate subprocesses from the host. These controls are agent file-tool boundaries, not host-wide subprocess isolation.";
  const text = String(prompt || "");
  return {
    id: randomUUID(), kind: "awaiting_approval", title: "Approve implementation plan",
    prompt: text.includes("not a filesystem sandbox") ? text : `${text}\n\n## Agent file-tool boundary\n${notice}`,
    notice, createdAt: new Date().toISOString()
  };
}

export function createPlanningRunner({
  state, runtime, harness, artifacts, activity, lifecycle, ticketSources = () => [], vcsMode = "git"
}) {
  const { dataDir, artifactText } = artifacts;
  const { capture } = activity;
  const { mirrorCheckpoint, saveSession } = lifecycle;
  const start = (ticketId, work) => runtime.start(ticketId, work);
  const outcome = (ticketId, kind) => ({ ticketId, outcome: kind });
  const saveOwnedSession = (ticketId, runId, field, signal) => async (sessionFile) => {
    if (!ownedRun(state.read(), ticketId, runId, signal)) return;
    return saveSession(ticketId, runId, field, signal)(sessionFile);
  };

  async function blocked(ticketId, runId, signal) {
    let adopted = false;
    await state.update((draft) => {
      const run = ownedRun(draft, ticketId, runId, signal);
      if (!run) return;
      adopted = true;
      pauseIfWorkflowBlocked(run);
    });
    if (adopted && !signal?.aborted) await mirrorCheckpoint(ticketId);
    return outcome(ticketId, adopted ? "awaiting-input" : "superseded");
  }

  async function prepareTicket(ticketId) {
    return start(ticketId, async (signal) => {
      let captured;
      let run;
      try {
        signal.throwIfAborted();
        const before = state.read();
        run = ticketRun(before, ticketId);
        if (executionBlockedByWorkflow(run)) return blocked(ticketId, run.runId, signal);
        const readiness = await inspectReadiness({ cwd: before.workspace.cwd, vcsMode, phase: "planning",
          validateModels: () => harness.inspectModels ? harness.inspectModels(run.stageProfiles) : harness.validateProfiles?.(run.stageProfiles) });
        if (!readiness.ready) throw new Error(`Project setup required: ${readiness.checks.filter((check) => check.status === "action_needed").map((check) => check.action).join("; ")}`);
        captured = capture(ticketId, "requirements", run.runId);
        const productContext = await readProductContext(dataDir, before.workspace.cwd);
        await state.update((draft) => {
          const current = ownedRun(draft, ticketId, run.runId, signal);
          if (!current) return;
          current.status = "clarifying";
          setStage(current, "requirements", "active", "Pi is shaping requirements without repository access");
        });
        if (!ownedRun(state.read(), ticketId, run.runId, signal)) return outcome(ticketId, signal.aborted ? "aborted" : "superseded");
        const clarified = await harness.clarifyRequirements({
          cwd: before.workspace.cwd, ticket: run.ticket, runId: run.runId, sessionFile: run.requirementsSessionFile,
          productContext: productContext.content, profile: run.stageProfiles.requirements, onEvent: captured.onEvent,
          onSessionFile: saveOwnedSession(ticketId, run.runId, "requirementsSessionFile", signal), signal
        });
        signal.throwIfAborted();
        if (!ownedRun(state.read(), ticketId, run.runId, signal)) return outcome(ticketId, signal.aborted ? "aborted" : "superseded");
        const [contextSnapshot, artifact] = await Promise.all([
          persistArtifact(dataDir, run.ticket, { runId: run.runId, name: "product-context-snapshot.md", content: productContext.content, stageId: "requirements", kind: "product-context-snapshot" }),
          persistArtifact(dataDir, run.ticket, { runId: run.runId, name: "requirements-draft.md", content: clarified.artifact, stageId: "requirements", kind: "requirements-draft" })
        ]);
        let adopted = false;
        await state.update((draft) => {
          const current = ownedRun(draft, ticketId, run.runId, signal);
          if (!current) return;
          adopted = true;
          current.requirementsSessionFile = clarified.sessionFile;
          current.artifacts.push(contextSnapshot, artifact);
          if (pauseIfWorkflowBlocked(current)) {
            setStage(current, "requirements", "blocked", current.checkpoint.title).activity = captured.snapshot();
            return;
          }
          current.status = "awaiting_requirements";
          setStage(current, "requirements", "blocked", "Requirement approval needed before repository access").activity = captured.snapshot();
          current.checkpoint = { id: randomUUID(), kind: "requirements_review", title: "Approve ticket requirements", prompt: clarified.artifact, questions: clarified.questions, createdAt: new Date().toISOString() };
        });
        if (adopted && !signal.aborted) await mirrorCheckpoint(ticketId);
        return outcome(ticketId, adopted ? "awaiting-input" : signal.aborted ? "aborted" : "superseded");
      } catch (error) {
        if (signal.aborted) return outcome(ticketId, "aborted");
        let adopted = false;
        await state.update((draft) => {
          const current = ownedRun(draft, ticketId, run?.runId, signal);
          if (!current) return;
          adopted = true;
          current.status = "failed";
          current.lastError = redactText(error.message);
          if (captured) current.stages.find((stage) => stage.id === "requirements").activity = captured.snapshot();
        });
        return outcome(ticketId, adopted ? "failed" : "superseded");
      }
    });
  }

  async function continueAfterRequirements(ticketId, answers = "") {
    return start(ticketId, async (signal) => {
      let captured;
      let activityStage = "explore";
      let run;
      try {
        signal.throwIfAborted();
        const before = state.read();
        run = ticketRun(before, ticketId);
        if (executionBlockedByWorkflow(run)) return blocked(ticketId, run.runId, signal);
        if (answers.trim()) {
          activityStage = "requirements";
          captured = capture(ticketId, "requirements", run.runId);
          await state.update((draft) => {
            const current = ownedRun(draft, ticketId, run.runId, signal);
            if (!current) return;
            current.status = "clarifying";
            current.checkpoint = null;
            setStage(current, "requirements", "active", "Pi is revising requirements from your answers");
          });
          if (!ownedRun(state.read(), ticketId, run.runId, signal)) return outcome(ticketId, signal.aborted ? "aborted" : "superseded");
          const clarified = await harness.refineRequirements({
            cwd: before.workspace.cwd, ticket: run.ticket, runId: run.runId, sessionFile: run.requirementsSessionFile, answers,
            profile: run.stageProfiles.requirements, onEvent: captured.onEvent,
            onSessionFile: saveOwnedSession(ticketId, run.runId, "requirementsSessionFile", signal), signal
          });
          signal.throwIfAborted();
          if (!ownedRun(state.read(), ticketId, run.runId, signal)) return outcome(ticketId, signal.aborted ? "aborted" : "superseded");
          const artifact = await persistArtifact(dataDir, run.ticket, { runId: run.runId, name: "requirements-draft.md", content: clarified.artifact, stageId: "requirements", kind: "requirements-draft" });
          let adopted = false;
          await state.update((draft) => {
            const current = ownedRun(draft, ticketId, run.runId, signal);
            if (!current) return;
            adopted = true;
            current.requirementsSessionFile = clarified.sessionFile;
            current.artifacts.push(artifact);
            current.status = "awaiting_requirements";
            setStage(current, "requirements", "blocked", "Review the revised requirements or answer a follow-up").activity = captured.snapshot();
            current.checkpoint = { id: randomUUID(), kind: "requirements_review", title: "Review revised ticket requirements", prompt: clarified.artifact, questions: clarified.questions, createdAt: new Date().toISOString() };
          });
          if (adopted && !signal.aborted) await mirrorCheckpoint(ticketId);
          return outcome(ticketId, adopted ? "awaiting-input" : signal.aborted ? "aborted" : "superseded");
        }
        captured = capture(ticketId, "explore", run.runId);
        const approved = [...run.artifacts].reverse().find((artifact) => artifact.kind === "requirements");
        const draft = [...run.artifacts].reverse().find((artifact) => artifact.kind === "requirements-draft");
        const productContext = [...run.artifacts].reverse().find((artifact) => artifact.kind === "product-context-snapshot");
        if ((!approved && !draft) || !productContext) throw new Error("Requirements draft or product context snapshot not found");
        const [retainedRequirements, productContextBody] = await Promise.all([artifactText(approved || draft), artifactText(productContext)]);
        if (!retainedRequirements) throw new Error("Approved requirements content was not retained");
        if (!ownedRun(state.read(), ticketId, run.runId, signal)) return outcome(ticketId, signal.aborted ? "aborted" : "superseded");
        const requirements = approved ? retainedRequirements : `${retainedRequirements}\n\n## User clarification\nApproved without changes.`;
        const ticketHorizon = formatTicketHorizon(run.ticket, [...ticketSources(), ...Object.values(before.ticketRuns).map((item) => item.ticket)]);
        const requirementArtifact = approved ? null : await persistArtifact(dataDir, run.ticket, { runId: run.runId, name: "requirements.md", content: requirements, stageId: "requirements", kind: "requirements" });
        await state.update((draft) => {
          const current = ownedRun(draft, ticketId, run.runId, signal);
          if (!current) return;
          if (requirementArtifact) current.artifacts.push(requirementArtifact);
          current.checkpoint = null;
          current.status = "preparing";
          setStage(current, "requirements", "completed", "Approved requirements persisted");
          setStage(current, "explore", "active", "Preparing isolated repository exploration");
        });
        if (!ownedRun(state.read(), ticketId, run.runId, signal)) return outcome(ticketId, signal.aborted ? "aborted" : "superseded");
        const workspace = await ensureTicketWorktree({ sourceCwd: before.workspace.cwd, dataDir, ticket: run.ticket, runId: run.runId, access: run.access });
        if (vcsMode === "jj") {
          await initializeJjWorkspace(workspace.cwd);
          workspace.vcs = "jj";
          for (const repo of workspace.repositories || []) if (repo.cwd !== workspace.cwd) await initializeJjWorkspace(repo.cwd);
        }
        const baselineTree = await snapshotTree(workspace.cwd);
        await state.update((draft) => {
          const current = ownedRun(draft, ticketId, run.runId, signal);
          if (!current) return;
          current.workspace = workspace;
          current.repositories = workspace.repositories || [];
          current.baselineTree = baselineTree;
          current.status = "exploring";
          setStage(current, "explore", "active", "Pi is mapping code, tests, and nearby tickets");
        });
        const latestRun = ownedRun(state.read(), ticketId, run.runId, signal);
        if (!latestRun) return outcome(ticketId, "superseded");
        const results = await Promise.allSettled([
          harness.exploreTicket({
            cwd: workspace.cwd, ticket: run.ticket, sessionFile: latestRun.sessionFile, runId: run.runId, access: latestRun.access, repositories: workspace.repositories || [],
            productContext: productContextBody, requirements, profile: run.stageProfiles.exploration,
            onEvent: (event) => captured.onEvent(event, "code explorer"), onSessionFile: saveOwnedSession(ticketId, run.runId, "sessionFile", signal), signal
          }),
          harness.lookAheadTickets({
            cwd: before.workspace.cwd, ticket: run.ticket, runId: run.runId, productContext: productContextBody, requirements, ticketHorizon,
            profile: run.stageProfiles.exploration, onEvent: (event) => captured.onEvent(event, "ticket look-ahead"), signal
          })
        ]);
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
        const [explored, lookedAhead] = results.map((result) => result.value);
        signal.throwIfAborted();
        if (!ownedRun(state.read(), ticketId, run.runId, signal)) return outcome(ticketId, signal.aborted ? "aborted" : "superseded");
        const [explorationArtifact, lookAheadArtifact] = await Promise.all([
          persistArtifact(dataDir, run.ticket, { runId: run.runId, name: "implementation-delta.md", content: explored.artifact, stageId: "explore", kind: "implementation-delta" }),
          persistArtifact(dataDir, run.ticket, { runId: run.runId, name: "ticket-lookahead.md", content: lookedAhead.artifact, stageId: "explore", kind: "ticket-lookahead" })
        ]);
        let adopted = false;
        await state.update((draft) => {
          const current = ownedRun(draft, ticketId, run.runId, signal);
          if (!current) return;
          adopted = true;
          current.sessionFile = explored.sessionFile;
          current.artifacts.push(explorationArtifact, lookAheadArtifact);
          setStage(current, "explore", explored.questions.length ? "blocked" : "completed", explored.questions.length ? "Technical decision required" : "Code map and ticket look-ahead persisted").activity = captured.snapshot();
          if (pauseIfWorkflowBlocked(current)) return;
          if (explored.questions.length) {
            current.status = "awaiting_input";
            current.checkpoint = { id: randomUUID(), kind: "technical_input", title: "Resolve technical exception", questions: explored.questions, createdAt: new Date().toISOString() };
          }
        });
        const latest = ownedRun(state.read(), ticketId, run.runId, signal);
        if (!adopted || !latest) return outcome(ticketId, "superseded");
        if (executionBlockedByWorkflow(latest)) {
          await mirrorCheckpoint(ticketId);
          return outcome(ticketId, "awaiting-input");
        }
        if (explored.questions.length) {
          await mirrorCheckpoint(ticketId);
          return outcome(ticketId, "awaiting-input");
        }
        return designTicket(ticketId, "No technical exceptions were raised.", signal);
      } catch (error) {
        if (signal.aborted) return outcome(ticketId, "aborted");
        let adopted = false;
        await state.update((draft) => {
          const current = ownedRun(draft, ticketId, run?.runId, signal);
          if (!current) return;
          adopted = true;
          current.status = "failed";
          current.lastError = redactText(error.message);
          if (captured) current.stages.find((stage) => stage.id === activityStage).activity = captured.snapshot();
        });
        return outcome(ticketId, adopted ? "failed" : "superseded");
      }
    });
  }

  async function designTicket(ticketId, answers, signal) {
    signal?.throwIfAborted();
    const snapshot = state.read();
    const run = ticketRun(snapshot, ticketId);
    const captured = capture(ticketId, "design", run.runId);
    const requirements = [...run.artifacts].reverse().find((artifact) => artifact.kind === "requirements");
    const productContext = [...run.artifacts].reverse().find((artifact) => artifact.kind === "product-context-snapshot");
    const exploration = [...run.artifacts].reverse().find((artifact) => artifact.kind === "implementation-delta");
    const ticketLookAheadArtifact = [...run.artifacts].reverse().find((artifact) => artifact.kind === "ticket-lookahead");
    if (!requirements || !productContext || !exploration) throw new Error("Approved requirements, product context, and implementation delta are required before design");
    const [requirementsBody, productContextBody, explorationBody, ticketLookAhead] = await Promise.all([
      artifactText(requirements), artifactText(productContext), artifactText(exploration), artifactText(ticketLookAheadArtifact)
    ]);
    if (!requirementsBody || !productContextBody || !explorationBody) {
      throw new Error("Approved requirements, product context, and implementation delta content were not retained");
    }
    if (!ownedRun(state.read(), ticketId, run.runId, signal)) return outcome(ticketId, signal?.aborted ? "aborted" : "superseded");
    if (executionBlockedByWorkflow(run)) return blocked(ticketId, run.runId, signal);
    await state.update((draft) => {
      const current = ownedRun(draft, ticketId, run.runId, signal);
      if (!current) return;
      if (pauseIfWorkflowBlocked(current)) return;
      current.checkpoint = null;
      current.status = "planning";
      setStage(current, "explore", "completed", "Repository map and technical decisions persisted");
      setStage(current, "design", "active", "Pi is choosing an approach and executable steps");
    });
    const current = ownedRun(state.read(), ticketId, run.runId, signal);
    if (!current) return outcome(ticketId, "superseded");
    if (executionBlockedByWorkflow(current)) return blocked(ticketId, run.runId, signal);
    try {
      const result = await harness.designTicket({
        cwd: run.workspace.cwd, ticket: run.ticket, sessionFile: run.sessionFile, runId: run.runId, access: run.access, repositories: run.repositories || [],
        productContext: productContextBody, requirements: requirementsBody, exploration: explorationBody,
        ticketLookAhead: ticketLookAhead || "No nearby ticket implications were found.", answers,
        profile: run.stageProfiles.architecture, onEvent: captured.onEvent, onSessionFile: saveOwnedSession(ticketId, run.runId, "sessionFile", signal), signal
      });
      signal?.throwIfAborted();
      if (!ownedRun(state.read(), ticketId, run.runId, signal)) return outcome(ticketId, signal?.aborted ? "aborted" : "superseded");
      const designArtifact = retainDurableRecord(result.artifact);
      const designPlan = retainDurableRecord(result.plan);
      const artifact = await persistArtifact(dataDir, run.ticket, { runId: run.runId, name: "design.md", content: designArtifact, stageId: "design", kind: "architecture" });
      let adopted = false;
      await state.update((draft) => {
        const current = ownedRun(draft, ticketId, run.runId, signal);
        if (!current) return;
        adopted = true;
        current.sessionFile = result.sessionFile;
        current.plan = designPlan;
        current.artifacts.push(artifact);
        current.status = "awaiting_approval";
        setStage(current, "design", "blocked", "Plan ready for approval. Named project commands are not a filesystem sandbox.").activity = captured.snapshot();
        current.checkpoint = planApprovalCheckpoint(designArtifact);
      });
      return adopted ? { ...outcome(ticketId, "planned"), next: "awaiting-approval" } : outcome(ticketId, "superseded");
    } catch (error) {
      if (signal?.aborted) return outcome(ticketId, "aborted");
      let adopted = false;
      await state.update((draft) => {
        const current = ownedRun(draft, ticketId, run.runId, signal);
        if (!current) return;
        adopted = true;
        current.status = "failed";
        current.lastError = redactText(error.message);
        setStage(current, "design", "blocked", redactText(error.message)).activity = captured.snapshot();
      });
      return outcome(ticketId, adopted ? "failed" : "superseded");
    }
  }

  return { continueAfterRequirements, designTicket, prepareTicket };
}

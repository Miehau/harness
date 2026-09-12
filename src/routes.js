import { body, json } from "./http.js";

function routeId(value) {
  return decodeURIComponent(value);
}

function queryIdentity(url) {
  return {
    scope: url.searchParams.get("scope") || "step",
    stepId: url.searchParams.get("stepId"),
    attemptId: url.searchParams.get("attemptId"),
    reviewId: url.searchParams.get("reviewId"),
  };
}

/**
 * HTTP parsing and response formatting only. Every operation is a focused
 * service owned by the coordinator, inspection service, or a natural runtime
 * boundary; routes never receive the daemon, store, or Pi harness.
 */
export function createRoutes({
  orchestrator,
  supervisor,
  version,
  inspection,
  tickets,
  workspace,
  previews,
  steering,
  coordination,
  settings,
} = {}) {
  if (
    !inspection ||
    !tickets ||
    !workspace ||
    !previews ||
    !steering ||
    !settings
  ) {
    throw new Error(
      "Routes require inspection, ticket, workspace, preview, steering, and settings operations",
    );
  }

  return async function routeApi(request, response, url) {
    if (request.method === "GET" && url.pathname === "/api/orchestrator/overview") return json(response, 200, supervisor.overview(supervisor.projectFor(request), url.searchParams));
    if (request.method === "GET" && url.pathname === "/api/orchestrator/notifications") return json(response, 200, supervisor.notifications(supervisor.projectFor(request), url.searchParams));
    if (request.method === "POST" && url.pathname === "/api/orchestrator/notifications") return json(response, 200, await supervisor.retry(supervisor.projectFor(request), await body(request)));
    if (request.method === "GET" && url.pathname === "/api/orchestrator/policy") return json(response, 200, supervisor.policy(supervisor.projectFor(request)));
    if (request.method === "POST" && url.pathname === "/api/orchestrator/policy") return json(response, 200, await supervisor.setPolicy(supervisor.projectFor(request), await body(request)));
    if (request.method === "POST" && url.pathname === "/api/orchestrator/tickets") return json(response, 200, await orchestrator.submit(await body(request)));
    const orchestratorRun = url.pathname.match(/^\/api\/orchestrator\/tickets\/([^/]+)\/runs\/([^/]+)$/);
    if (request.method === "GET" && orchestratorRun) return json(response, 200, orchestrator.observe(routeId(orchestratorRun[1]), routeId(orchestratorRun[2]), request.supervisorProject));
    const orchestratorAction = url.pathname.match(/^\/api\/orchestrator\/tickets\/([^/]+)\/actions$/);
    if (request.method === "POST" && orchestratorAction) return json(response, 202, await orchestrator.act(routeId(orchestratorAction[1]), await body(request), request.supervisorProject));

    const coordinationRead = url.pathname.match(/^\/api\/tickets\/([^/]+)\/coordination$/);
    if (request.method === "GET" && coordinationRead) return json(response, 200, coordination.read(routeId(coordinationRead[1])));
    const coordinationConflict = url.pathname.match(/^\/api\/tickets\/([^/]+)\/coordination\/conflicts$/);
    if (request.method === "POST" && coordinationConflict) return json(response, 200, await coordination.conflict(routeId(coordinationConflict[1]), await body(request)));
    const coordinationProposal = url.pathname.match(/^\/api\/tickets\/([^/]+)\/coordination\/revisions$/);
    if (request.method === "POST" && coordinationProposal) return json(response, 200, await coordination.propose(routeId(coordinationProposal[1]), await body(request)));
    const coordinationDecision = url.pathname.match(/^\/api\/tickets\/([^/]+)\/coordination\/decisions$/);
    if (request.method === "POST" && coordinationDecision) return json(response, 200, await coordination.decide(routeId(coordinationDecision[1]), await body(request)));
    const coordinationResolve = url.pathname.match(/^\/api\/tickets\/([^/]+)\/coordination\/resolve$/);
    if (request.method === "POST" && coordinationResolve) return json(response, 200, await coordination.resolveConflict(routeId(coordinationResolve[1]), await body(request)));
    const coordinationAccept = url.pathname.match(/^\/api\/tickets\/([^/]+)\/coordination\/revisions\/([^/]+)\/accept$/);
    if (request.method === "POST" && coordinationAccept) return json(response, 200, await coordination.accept(routeId(coordinationAccept[1]), routeId(coordinationAccept[2]), await body(request)));
    const coordinationReject = url.pathname.match(/^\/api\/tickets\/([^/]+)\/coordination\/revisions\/([^/]+)\/reject$/);
    if (request.method === "POST" && coordinationReject) return json(response, 200, await coordination.reject(routeId(coordinationReject[1]), routeId(coordinationReject[2]), await body(request)));
    if (request.method === "POST" && url.pathname === "/api/workspace/init") {
      return json(response, 200, await workspace.initialize(await body(request)));
    }
    if (request.method === "GET" && url.pathname === "/api/workspace/readiness") {
      return json(response, 200, await workspace.readiness({ visual: url.searchParams.get("visual") === "1" }));
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, version });
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      return json(response, 200, await inspection.state());
    }

    const compactTicketRun = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/run$/,
    );
    if (request.method === "GET" && compactTicketRun) {
      return json(
        response,
        200,
        await inspection.ticketRun(routeId(compactTicketRun[1]), {
          detail: url.searchParams.get("detail") === "1",
        }),
      );
    }
    const proofCheckOutput = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/proof\/check-output$/,
    );
    if (request.method === "GET" && proofCheckOutput) {
      return json(
        response,
        200,
        await inspection.checkOutput(
          routeId(proofCheckOutput[1]),
          queryIdentity(url),
        ),
      );
    }
    const reviewPacket = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/review-packet$/,
    );
    if (request.method === "GET" && reviewPacket) {
      return json(
        response,
        200,
        await inspection.reviewPacket(routeId(reviewPacket[1])),
      );
    }
    const ticketInspection = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/inspection$/,
    );
    if (request.method === "GET" && ticketInspection) {
      return json(
        response,
        200,
        await inspection.ticketInspection(routeId(ticketInspection[1])),
      );
    }
    const ticketRunHistories = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/runs$/,
    );
    if (request.method === "GET" && ticketRunHistories) {
      return json(
        response,
        200,
        await inspection.runHistories(routeId(ticketRunHistories[1])),
      );
    }
    const runInspection = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/runs\/([^/]+)\/inspection$/,
    );
    if (request.method === "GET" && runInspection) {
      return json(
        response,
        200,
        await inspection.runInspection(
          routeId(runInspection[1]),
          routeId(runInspection[2]),
        ),
      );
    }
    if (request.method === "GET" && url.pathname === "/api/models") {
      return json(response, 200, await inspection.models());
    }
    if (request.method === "GET" && url.pathname === "/api/skills") {
      return json(response, 200, await inspection.skills());
    }
    if (request.method === "GET" && url.pathname === "/api/tracker-settings") {
      return json(response, 200, await settings.trackerSettings());
    }
    if (request.method === "POST" && url.pathname === "/api/tracker-settings") {
      return json(
        response,
        200,
        await settings.saveTrackerSettings(await body(request)),
      );
    }

    const openArtifact = url.pathname.match(
      /^\/api\/tickets\/([^/]+)(?:\/runs\/([^/]+))?\/artifacts\/([^/]+)\/open$/,
    );
    if (request.method === "POST" && openArtifact) {
      await inspection.openArtifact({
        ticketId: routeId(openArtifact[1]),
        runId: openArtifact[2] && routeId(openArtifact[2]),
        artifactId: routeId(openArtifact[3]),
      });
      return json(response, 200, { opened: true });
    }
    if (request.method === "POST" && url.pathname === "/api/queue/clear") {
      return json(response, 200, await settings.clearQueue());
    }
    const forget = url.pathname.match(/^\/api\/tickets\/([^/]+)\/forget$/);
    if (request.method === "POST" && forget) {
      const input = await body(request);
      return json(
        response,
        200,
        await settings.forgetRun(routeId(forget[1]), input),
      );
    }
    if (request.method === "GET" && url.pathname === "/api/retention") {
      return json(response, 200, await settings.retention());
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/retention/cleanup"
    ) {
      return json(
        response,
        200,
        await settings.cleanupRetention(await body(request)),
      );
    }

    const attemptDetail = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/runs\/([^/]+)\/steps\/([^/]+)\/attempts\/([^/]+)\/details$/,
    );
    if (request.method === "GET" && attemptDetail) {
      return json(
        response,
        200,
        await inspection.attemptDetail({
          ticketId: routeId(attemptDetail[1]),
          runId: routeId(attemptDetail[2]),
          stepId: routeId(attemptDetail[3]),
          attemptId: routeId(attemptDetail[4]),
        }),
      );
    }
    const proposalPreview = url.pathname.match(/^\/api\/tickets\/([^/]+)\/runs\/([^/]+)\/artifacts\/([^/]+)\/preview$/);
    if (request.method === "GET" && proposalPreview) {
      const content = await inspection.uiProposalPreview({ ticketId: routeId(proposalPreview[1]), runId: routeId(proposalPreview[2]), artifactId: routeId(proposalPreview[3]) });
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox allow-scripts; default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
      });
      response.end(content);
      return;
    }
    const artifactMedia = url.pathname.match(
      /^\/api\/tickets\/([^/]+)(?:\/runs\/([^/]+))?\/artifacts\/([^/]+)\/media$/,
    );
    if (request.method === "GET" && artifactMedia) {
      const media = await inspection.artifactMedia({
        ticketId: routeId(artifactMedia[1]),
        runId: artifactMedia[2] && routeId(artifactMedia[2]),
        artifactId: routeId(artifactMedia[3]),
      });
      response.writeHead(200, {
        "content-type": media.mediaType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(media.content);
      return;
    }
    const artifactContent = url.pathname.match(
      /^\/api\/tickets\/([^/]+)(?:\/runs\/([^/]+))?\/artifacts\/([^/]+)\/content$/,
    );
    if (request.method === "GET" && artifactContent) {
      return json(
        response,
        200,
        await inspection.artifactContent({
          ticketId: routeId(artifactContent[1]),
          runId: artifactContent[2] && routeId(artifactContent[2]),
          artifactId: routeId(artifactContent[3]),
        }),
      );
    }
    const artifact = url.pathname.match(
      /^\/api\/tickets\/([^/]+)(?:\/runs\/([^/]+))?\/artifacts\/([^/]+)$/,
    );
    if (request.method === "GET" && artifact) {
      return json(
        response,
        200,
        await inspection.artifact({
          ticketId: routeId(artifact[1]),
          runId: artifact[2] && routeId(artifact[2]),
          artifactId: routeId(artifact[3]),
        }),
      );
    }
    const sessionTrace = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/session-trace$/,
    );
    if (request.method === "GET" && sessionTrace) {
      return json(
        response,
        200,
        await inspection.sessionTrace(
          routeId(sessionTrace[1]),
          routeId(sessionTrace[2]),
        ),
      );
    }

    const steeringRoute = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/steering$/,
    );
    if (request.method === "GET" && steeringRoute) {
      return json(
        response,
        200,
        await inspection.steering(routeId(steeringRoute[1])),
      );
    }
    if (request.method === "POST" && steeringRoute) {
      return json(
        response,
        200,
        await steering.submit(routeId(steeringRoute[1]), await body(request)),
      );
    }
    const stageOutput = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/runs\/([^/]+)\/stages\/([^/]+)\/output$/,
    );
    if (request.method === "GET" && stageOutput) {
      return json(
        response,
        200,
        await inspection.stageOutput(
          routeId(stageOutput[1]),
          routeId(stageOutput[2]),
          routeId(stageOutput[3]),
        ),
      );
    }
    const stagePrompts = url.pathname.match(
      /^\/api\/tickets\/([^/]+)(?:\/runs\/([^/]+))?\/stages\/([^/]+)\/prompts$/,
    );
    if (request.method === "GET" && stagePrompts) {
      return json(
        response,
        200,
        await inspection.stagePrompts({
          ticketId: routeId(stagePrompts[1]),
          runId: stagePrompts[2] && routeId(stagePrompts[2]),
          stageId: routeId(stagePrompts[3]),
        }),
      );
    }
    const reviewMap = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/review-map$/,
    );
    if (request.method === "POST" && reviewMap) {
      return json(
        response,
        200,
        await tickets.createReviewMap(
          routeId(reviewMap[1]),
          routeId(reviewMap[2]),
        ),
      );
    }
    if (request.method === "POST" && url.pathname === "/api/stage-profiles") {
      return json(
        response,
        200,
        await settings.saveStageProfiles(await body(request)),
      );
    }
    const ticketStageProfile = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/stage-profiles\/([^/]+)$/,
    );
    if (request.method === "POST" && ticketStageProfile) {
      return json(
        response,
        200,
        await settings.saveTicketStageProfile(
          routeId(ticketStageProfile[1]),
          routeId(ticketStageProfile[2]),
          await body(request),
        ),
      );
    }
    const ticketPreview = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/preview$/,
    );
    if (request.method === "POST" && ticketPreview) {
      const ticketId = routeId(ticketPreview[1]);
      const input = await body(request);
      const action = input.action || "start";
      if (action === "replay") return json(response, 200, await previews.replay(ticketId, input));
      if (action === "stop") {
        await previews.stop(ticketId);
        return json(response, 200, {
          ticketId,
          preview: await inspection.operatorPreview(ticketId),
        });
      }
      if (action !== "start")
        throw new Error("Preview action must be start or stop");
      return json(response, 200, {
        ticketId,
        preview: await previews.start(ticketId),
      });
    }
    if (request.method === "GET" && url.pathname === "/api/tickets") {
      return json(response, 200, await inspection.ticketSources());
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      return inspection.events(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/workspace/pick") {
      return json(response, 200, await workspace.pick());
    }
    if (
      request.method === "GET" &&
      url.pathname === "/api/workspace/access-policy"
    ) {
      return json(response, 200, await workspace.accessPolicy());
    }
    if (
      request.method === "POST" &&
      url.pathname === "/api/workspace/access-policy"
    ) {
      return json(
        response,
        200,
        await workspace.saveAccessPolicy(await body(request)),
      );
    }
    if (request.method === "POST" && url.pathname === "/api/workspace") {
      return json(response, 200, await workspace.set(await body(request)));
    }
    if (request.method === "POST" && url.pathname === "/api/local/load") {
      return json(
        response,
        201,
        await workspace.loadLocal(await body(request)),
      );
    }

    if (request.method === "POST" && url.pathname === "/api/tickets/start") {
      return json(response, 202, await tickets.beginMany(await body(request)));
    }
    const start = url.pathname.match(/^\/api\/tickets\/([^/]+)\/start$/);
    if (request.method === "POST" && start) {
      const ticketId = routeId(start[1]);
      await tickets.begin(ticketId, await body(request));
      return json(response, 202, { accepted: true, ticketId });
    }
    const select = url.pathname.match(/^\/api\/tickets\/([^/]+)\/select$/);
    if (request.method === "POST" && select) {
      return json(response, 200, await tickets.select(routeId(select[1])));
    }
    const listSkills = url.pathname.match(/^\/api\/tickets\/([^/]+)\/skills$/);
    if (request.method === "GET" && listSkills) {
      return json(
        response,
        200,
        await inspection.ticketSkills(routeId(listSkills[1])),
      );
    }
    const bindWorkflow = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/workflow$/,
    );
    if (request.method === "POST" && bindWorkflow) {
      return json(
        response,
        200,
        await tickets.bindWorkflow(
          routeId(bindWorkflow[1]),
          await body(request),
        ),
      );
    }
    const continueWorkflow = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/workflow\/continue$/,
    );
    if (request.method === "POST" && continueWorkflow) {
      return json(
        response,
        202,
        await tickets.continueWorkflow(
          routeId(continueWorkflow[1]),
          await body(request),
        ),
      );
    }
    const resume = url.pathname.match(/^\/api\/tickets\/([^/]+)\/resume$/);
    if (request.method === "POST" && resume) {
      return json(response, 202, await tickets.resume(routeId(resume[1])));
    }
    const restartFixer = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/review-fix\/restart$/,
    );
    if (request.method === "POST" && restartFixer) {
      return json(
        response,
        202,
        await tickets.restartFixer(
          routeId(restartFixer[1]),
          await body(request),
        ),
      );
    }
    const restart = url.pathname.match(/^\/api\/tickets\/([^/]+)\/restart$/);
    if (request.method === "POST" && restart) {
      return json(
        response,
        202,
        await tickets.restart(routeId(restart[1]), await body(request)),
      );
    }
    const cancel = url.pathname.match(/^\/api\/tickets\/([^/]+)\/cancel$/);
    if (request.method === "POST" && cancel) {
      const ticketId = routeId(cancel[1]);
      await tickets.cancel(ticketId);
      return json(response, 200, { cancelled: true, ticketId });
    }
    const pause = url.pathname.match(/^\/api\/tickets\/([^/]+)\/pause$/);
    if (request.method === "POST" && pause) {
      const ticketId = routeId(pause[1]);
      const checkpoint = await tickets.pause(ticketId);
      return json(response, 200, { paused: true, ticketId, ...checkpoint });
    }
    const clarify = url.pathname.match(/^\/api\/tickets\/([^/]+)\/clarify$/);
    if (request.method === "POST" && clarify) {
      return json(
        response,
        202,
        await tickets.clarify(routeId(clarify[1]), await body(request)),
      );
    }
    const editPlan = url.pathname.match(/^\/api\/tickets\/([^/]+)\/plan$/);
    if (request.method === "POST" && editPlan) {
      return json(
        response,
        200,
        await tickets.editPlan(routeId(editPlan[1]), await body(request)),
      );
    }
    const proposal = url.pathname.match(/^\/api\/tickets\/([^/]+)\/ui-proposal\/changes$/);
    if (request.method === "POST" && proposal) return json(response, 202, await tickets.reviseProposal(routeId(proposal[1]), await body(request)));
    const approve = url.pathname.match(/^\/api\/tickets\/([^/]+)\/approve$/);
    if (request.method === "POST" && approve) {
      return json(
        response,
        202,
        await tickets.approvePlan(routeId(approve[1]), await body(request)),
      );
    }
    const approveEvidence = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/evidence\/approve$/,
    );
    if (request.method === "POST" && approveEvidence) {
      const ticketId = routeId(approveEvidence[1]);
      await tickets.finishHandoff(ticketId);
      return json(response, 200, { accepted: true, ticketId });
    }
    const changeEvidence = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/evidence\/changes$/,
    );
    if (request.method === "POST" && changeEvidence) {
      return json(
        response,
        202,
        await tickets.changeEvidence(
          routeId(changeEvidence[1]),
          await body(request),
        ),
      );
    }
    const approveContext = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/context\/approve$/,
    );
    if (request.method === "POST" && approveContext) {
      const ticketId = routeId(approveContext[1]);
      await tickets.finishHandoff(ticketId);
      return json(response, 200, { accepted: true, ticketId });
    }
    const stepScope = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/scope$/,
    );
    if (request.method === "POST" && stepScope) {
      return json(
        response,
        200,
        await tickets.expandStepScope(
          routeId(stepScope[1]),
          routeId(stepScope[2]),
          await body(request),
        ),
      );
    }
    const stepWaiver = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/waive$/,
    );
    if (request.method === "POST" && stepWaiver) {
      return json(
        response,
        200,
        await tickets.waiveStep(
          routeId(stepWaiver[1]),
          routeId(stepWaiver[2]),
          await body(request),
        ),
      );
    }
    const stepDecision = url.pathname.match(
      /^\/api\/tickets\/([^/]+)\/steps\/([^/]+)\/(accept|changes)$/,
    );
    if (request.method === "POST" && stepDecision) {
      const result = await tickets.decideStep(
        routeId(stepDecision[1]),
        routeId(stepDecision[2]),
        stepDecision[3],
        await body(request),
      );
      return json(
        response,
        result.alreadyAccepted ? 200 : 202,
        result,
      );
    }

    return json(response, 404, { error: "Not found" });
  };
}

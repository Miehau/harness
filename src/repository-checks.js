import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { prepareVisualEvidence } from "./visual-evidence.js";
import { visualEvidenceMedia } from "./artifacts.js";
import { createExecutionOwnership, createProcessContainment, environmentForOwnership } from "./process-containment.js";
import { projectEnvironment, redactCommandOutput, runManagedCommand, runProjectCommand, loadProjectConfig } from "./project-config.js";
import { redactText } from "./redaction.js";

export const defaultRepositoryCheckExec = promisify(execFile);
export const verificationEntry = ".agent-plan/verify.mjs";
export function transientRepositoryCheckFailure(output = "") {
  return /\bENOTEMPTY\b[\s\S]{0,200}\b(?:directory not empty|rmdir|scandir)\b/i.test(String(output));
}

export function repositoryCheckError(checks) {
  return Object.assign(new Error(`${checks.summary}\n\n${checks.output || ""}`), {
    failureKind: checks.failureKind || "repository-check",
    command: checks.command,
    output: checks.output,
    failureHighlights: checks.failureHighlights
  });
}

function eventText(value) {
  let text;
  try { text = typeof value === "string" ? value : JSON.stringify(value, null, 2); }
  catch { text = String(value); }
  text ??= String(value ?? "");
  text = redactText(text);
  if (text.length <= 10000) return text;
  const half = 5000;
  return `${text.slice(0, half)}\n\n[${text.length - (half * 2)} characters omitted]\n\n${text.slice(-half)}`;
}

function failureHighlights(output) {
  const lines = String(output || "").split(/\r?\n/);
  return [...new Set(lines.filter((line) => /^(?:not ok\b|FAIL(?:ED)?\b|.*\b(?:timed out|did not render|did not become|within \d+ seconds)\b|\s+.*:\d+:\d+\)?$|\s+(?:location|failureType|error|code|name|expected|actual|operator|stack|command failed|fatal|stderr):)/i.test(line)).map((line) => line.slice(0, 500)))].slice(-40).join("\n").slice(-4500);
}
export async function runRepositoryChecks({ cwd, signal, requireVisualEvidence = false, requireVideoEvidence = false, environment: captureEnvironment = {}, proofCriteria, ownership, containment, dataDir, containmentFactory = createProcessContainment, execImpl = defaultRepositoryCheckExec, repositoryCheckTimeoutMs = 10 * 60 * 1000 } = {}) {
    requireVisualEvidence ||= requireVideoEvidence;
    const executionId = `repository-check:${randomUUID()}`;
    const executionContainment = containment || containmentFactory({
      executionId,
      ownership: ownership || createExecutionOwnership(executionId)
    });
    const executionOwnership = executionContainment.ownership;
    let command = `node ${verificationEntry}`;
    let args = [join(cwd, verificationEntry)];
    let environment = null;
    let result;
    let failure;
    let cleanupTrigger;
    const startedAt = Date.now();

    try {
      try { await access(args[0]); }
      catch (error) {
        if (error.code !== "ENOENT") {
          result = { status: "failed", command, summary: `${verificationEntry} could not be read.`, output: error.message, evidence: [] };
          return result;
        }
        result = { status: "failed", command, failureKind: "verification-contract", summary: `Missing ${verificationEntry}; repair the repository verification contract before continuing.`, output: "", evidence: [] };
        return result;
      }
      let evidenceDir = null;
      if (requireVisualEvidence) {
        const evidenceRoot = join(dataDir, "visual-evidence");
        await mkdir(evidenceRoot, { recursive: true });
        evidenceDir = await mkdtemp(join(evidenceRoot, "run-"));
      }
      const config = await loadProjectConfig(cwd);
      if (requireVisualEvidence && !config.commands["capture-proof"]) {
        result = { status: "failed", command: "capture-proof", failureKind: "capture-configuration", summary: "Required visual proof has no valid capture-proof command.", output: config.commandErrors?.["capture-proof"] || "Declare a separate capture-proof argv command in .agent-plan/project.json; keep the canonical verifier independent of browser capture.", evidence: [], evidenceDir, durationMs: Date.now() - startedAt };
        return result;
      }
      environment = environmentForOwnership(executionOwnership, {
        ...(await projectEnvironment(cwd, config)), CI: "1", ...captureEnvironment,
        ...(requireVisualEvidence ? { AGENT_PLAN_EVIDENCE_DIR: evidenceDir } : {})
      });
      const executable = process.execPath;
      // execFile waits for `close`, which a token-owned descendant can defer by
      // retaining inherited pipes. The controlled runner settles at the child
      // exit or deadline so timeout cleanup below is requested immediately.
      const runner = execImpl === defaultRepositoryCheckExec ? runManagedCommand : execImpl;
      for (let attempt = 0; attempt < 2; attempt++) try {
        // A prior preview or timeout cleanup may already be settled on this
        // shared containment. Mark this launch before invoking the runner so
        // descendants require a fresh worker-exit containment cycle.
        executionContainment.beginLaunch?.();
        if (requireVisualEvidence && (config.commands["test-capture-proof"] || config.commandErrors?.["test-capture-proof"])) {
          const preflight = await runProjectCommand(cwd, "test-capture-proof", { signal, execImpl: runner, ownership: executionOwnership, containment: executionContainment, timeoutMs: repositoryCheckTimeoutMs, environment: { ...environment, ...(proofCriteria ? { AGENT_PLAN_CAPTURE_CRITERIA: JSON.stringify(proofCriteria) } : {}) } });
          if (preflight.status !== "passed") {
            result = { ...preflight, failureKind: "capture-preflight", summary: "Capture fixture preflight failed; repair its inputs and transitions before browser capture.", evidence: [], evidenceDir, durationMs: Date.now() - startedAt };
            return result;
          }
        }
        const { stdout, stderr } = await runner(executable, args, { cwd, signal, timeout: repositoryCheckTimeoutMs, maxBuffer: 4 * 1024 * 1024, env: environment, containment: executionContainment });
        let captureOutput = "";
        if (requireVisualEvidence && (config.commands["capture-proof"] || config.commandErrors?.["capture-proof"])) {
          const capture = await runProjectCommand(cwd, "capture-proof", {
            signal, execImpl: runner, ownership: executionOwnership, containment: executionContainment,
            timeoutMs: repositoryCheckTimeoutMs, environment: { ...environment, ...(proofCriteria ? { AGENT_PLAN_CAPTURE_CRITERIA: JSON.stringify(proofCriteria) } : {}) }
          });
          captureOutput = capture.output;
          if (capture.status !== "passed") {
            result = { ...capture, failureKind: "visual-evidence", summary: "Deterministic verification passed, but capture-proof failed.", evidence: [], evidenceDir, durationMs: Date.now() - startedAt };
            return result;
          }
        }
        let evidence = (evidenceDir ? await readdir(evidenceDir, { withFileTypes: true }) : [])
          .filter((entry) => entry.isFile())
          .map((entry) => ({ name: entry.name, path: join(evidenceDir, entry.name) }))
          .map((item) => ({ ...item, ...visualEvidenceMedia(item.path) }))
          .filter((item) => item.mediaType);
        const hasScreenshot = evidence.some((item) => item.mediaKind === "image");
        evidence = await prepareVisualEvidence(evidence, { evidenceDir, run: (executable, args) => {
          executionContainment.beginLaunch?.();
          return runner(executable, args, { cwd, signal, timeout: repositoryCheckTimeoutMs, maxBuffer: 4 * 1024 * 1024, env: environment, containment: executionContainment });
        } });
        const output = eventText(redactCommandOutput([stdout, stderr, captureOutput].filter(Boolean).join("\n"), environment));
        if (requireVisualEvidence && !hasScreenshot) result = { status: "failed", failureKind: "visual-evidence", command, summary: `${command} passed but produced no screenshot evidence.`, output, evidence, evidenceDir, durationMs: Date.now() - startedAt };
        else if (requireVideoEvidence && !evidence.some((item) => item.mediaKind === "video")) result = { status: "failed", failureKind: "visual-evidence", command, summary: `${command} passed but produced no video evidence.`, output, evidence, evidenceDir, durationMs: Date.now() - startedAt };
        else result = { status: "passed", command, summary: `${command} passed${attempt ? " after retrying a transient filesystem cleanup failure" : ""}${evidence.length ? ` with ${evidence.length} visual artifact${evidence.length === 1 ? "" : "s"}` : ""}.`, output, evidence, evidenceDir, durationMs: Date.now() - startedAt };
        return result;
      } catch (error) {
        const timedOut = error?.code === "ETIMEDOUT" || (error?.killed === true && error?.signal === "SIGTERM");
        if (timedOut || signal?.aborted) {
          const trigger = { trigger: signal?.aborted ? "repository-check-aborted" : "repository-check-timeout", command };
          try { await executionContainment.cleanup(trigger); }
          catch { /* The exit cleanup below records durable failure evidence. */ }
        }
        if (signal?.aborted) { failure = error; throw error; }
        // Bound each process channel before combining them. A noisy stderr tail
        // must not evict the causal stdout line (or the process error itself).
        const channels = [error.stdout, error.stderr, error.message].filter(Boolean);
        const rawOutput = eventText(redactCommandOutput(channels.map(eventText).join("\n"), environment, { truncate: false }));
        const highlights = failureHighlights(redactCommandOutput(channels.join("\n"), environment, { truncate: false }));
        const output = eventText(`${rawOutput}${highlights ? `\n\nFailure highlights:\n${highlights}` : ""}`);
        if (!attempt && transientRepositoryCheckFailure(output)) continue;
        result = { status: "failed", failureKind: timedOut ? "timeout" : "repository-check", command, summary: `${command} failed.`, output, failureHighlights: highlights, evidence: [], durationMs: Date.now() - startedAt };
        return result;
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // This timestamp is the durable identity of this completion request.
      // The daemon receives the same object when it settles shared containment.
      cleanupTrigger = { trigger: signal?.aborted ? "repository-check-aborted" : "repository-check-exit", command, at: new Date().toISOString() };
      let cleanup;
      try { cleanup = await executionContainment.cleanup(cleanupTrigger); }
      catch (error) {
        cleanup = { executionId: executionContainment.executionId, outcome: "incomplete", diagnostics: [`Repository-check cleanup failed: ${error instanceof Error ? error.message : String(error)}`] };
      }
      if (result) Object.assign(result, { cleanup, cleanupTrigger });
      else if (failure && typeof failure === "object") Object.assign(failure, { cleanup, cleanupTrigger });
    }
  }

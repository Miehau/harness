import { createHash } from "node:crypto";
import { persistArtifact } from "./artifacts.js";

/** Keep finished-run display excerpts hot; retain full output as a normal artifact. */
export async function archiveHistoryOutput(state, dataDir) {
  for (const run of [...Object.values(state.ticketRuns || {}), ...Object.values(state.retainedRuns || {})]) {
    if (run.status !== "completed" || !run.ticket || !run.runId) continue;
    const entries = [];
    const replacements = [];
    const visit = (value, pointer) => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "artifacts") continue;
        const path = [...pointer, key];
        if (["rawOutput", "output", "result", "patch"].includes(key) && typeof child === "string" && child.length > 4000) {
          entries.push({ pointer: path, content: child });
          replacements.push({ value, key, child });
        } else if (typeof child === "object") visit(child, path);
      }
    };
    visit(run, []);
    if (!entries.length) continue;
    const content = JSON.stringify(entries);
    const digest = createHash("sha256").update(content).digest("hex").slice(0, 20);
    // Write evidence first. A failed state rename can leave an orphan artifact,
    // but never a persisted excerpt whose complete source was not saved.
    const artifact = await persistArtifact(dataDir, run.ticket, {
      runId: run.runId, stageId: "history", kind: "historical-output",
      name: `output-${digest}.json`, content
    });
    run.artifacts ||= [];
    if (!run.artifacts.some((item) => item.id === artifact.id)) run.artifacts.push(artifact);
    for (const { value, key, child } of replacements) value[key] = `${child.slice(0, 2000)}\n[Full historical output: artifact ${artifact.id}]`;
  }
}

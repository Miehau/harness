export function executionGraph(plan) {
  const nodes = plan?.nodes || [];
  const owner = new Map();
  for (const node of nodes) {
    owner.set(node.id, node.id);
    for (const child of node.children || []) owner.set(child.id, node.id);
  }

  const units = nodes.map((node) => {
    const dependencies = (node.type === "group" ? node.children.flatMap((child) => child.dependsOn || []) : node.dependsOn || [])
      .map((id) => owner.get(id))
      .filter((id, index, all) => id && id !== node.id && all.indexOf(id) === index);
    return { id: node.id, node, dependencies };
  });
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const memo = new Map();
  const levelOf = (id, visiting = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0;
    const next = new Set(visiting).add(id);
    const dependencies = byId.get(id)?.dependencies.filter((dependency) => byId.has(dependency)) || [];
    const level = dependencies.length ? Math.max(...dependencies.map((dependency) => levelOf(dependency, next))) + 1 : 0;
    memo.set(id, level);
    return level;
  };
  for (const unit of units) unit.level = levelOf(unit.id);

  const columns = Array.from({ length: Math.max(0, ...units.map((unit) => unit.level)) + 1 }, () => []);
  for (const unit of units) columns[unit.level].push(unit);
  return {
    columns,
    edges: units.flatMap((unit) => unit.dependencies
      .filter((dependency) => byId.has(dependency))
      .map((dependency) => ({ from: dependency, to: unit.id })))
  };
}

export function artifactsForStage(artifacts = [], stageId) {
  return artifacts.filter((artifact) => artifact.stageId === stageId || (stageId === "verify" && artifact.stageId?.startsWith("review-round-")));
}

export function preferredStepId(plan, currentId) {
  const steps = (plan?.nodes || []).flatMap((node) => node.type === "group" ? node.children : [node]);
  if (steps.some((step) => step.id === currentId)) return currentId;
  return steps.find((step) => step.status === "review_ready")?.id || steps[0]?.id || null;
}

function toolTitle(tool, args) {
  let values = {};
  try { values = JSON.parse(args || "{}"); } catch {}
  const subject = values.command || values.cmd || values.path || values.pattern || values.query;
  return subject ? `${tool} · ${String(subject).split("\n")[0]}` : tool;
}

function expandJson(value) {
  if (Array.isArray(value)) return value.map(expandJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandJson(item)]));
  if (typeof value !== "string" || !/^[{[]/.test(value.trim())) return value;
  try { return expandJson(JSON.parse(value)); } catch { return value; }
}

export function formatOutput(value = "") {
  const text = String(value);
  if (!/^[{[]/.test(text.trim())) return text;
  try { return JSON.stringify(expandJson(JSON.parse(text)), null, 2); } catch { return text; }
}

export function eventTimeline(events = []) {
  const items = [];
  const byCallId = new Map();
  const pendingByTool = new Map();
  for (const event of events) {
    if (event.type === "tool_start") {
      const item = { key: event.callId || `${event.tool}:${items.length}`, tool: event.tool, title: toolTitle(event.tool, event.args), at: event.at, args: event.args || "", output: "", result: "", status: "running", isError: false };
      items.push(item);
      if (event.callId) byCallId.set(event.callId, item);
      else pendingByTool.set(event.tool, [...(pendingByTool.get(event.tool) || []), item]);
      continue;
    }
    if (["tool_update", "tool_end"].includes(event.type)) {
      let item = event.callId ? byCallId.get(event.callId) : pendingByTool.get(event.tool)?.find((candidate) => candidate.status === "running");
      if (!item) {
        item = { key: event.callId || `${event.tool}:${items.length}`, tool: event.tool, title: event.tool, at: event.at, args: "", output: "", result: "", status: "running", isError: false };
        items.push(item);
      }
      if (event.type === "tool_update") item.output += event.detail || "";
      else Object.assign(item, { result: event.result || "", status: event.isError ? "failed" : "finished", isError: Boolean(event.isError) });
      continue;
    }
    if (event.type === "agent_error") items.push({ key: `error:${items.length}`, title: "Model request failed", at: event.at, result: event.label || "Unknown model error", status: "failed", isError: true });
    if (event.type === "reasoning_summary") items.push({ key: `reasoning:${items.length}`, title: "Reasoning summary", at: event.at, result: event.detail || "", status: "summary", isError: false });
  }
  return items.map((item) => ({ ...item, hasDetails: Boolean(item.args || item.output || item.result) }));
}

export function runHeartbeat(active, live = {}, now = Date.now()) {
  if (!active) return null;
  const elapsed = Math.max(0, Math.floor((now - Date.parse(active.startedAt)) / 1000));
  const idle = Math.max(0, Math.floor((now - Date.parse(live.lastAt || active.lastEventAt || active.startedAt)) / 1000));
  const warning = Boolean(live.warning || active.warning);
  return {
    label: live.label || active.lastEvent || "Agent is running",
    elapsed,
    idle,
    state: warning ? "warning" : idle >= 30 ? "stale" : "active",
    note: warning ? "operation failed; correction or permission may be required" : idle >= 30 ? "model request or command may still be running" : ""
  };
}

export function parseDiff(patch = "") {
  const blocks = patch.split(/^diff --git /m).slice(1).map((block) => `diff --git ${block}`);
  const files = blocks.map((block, fileIndex) => {
    const header = block.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const name = header?.[2] || `Changed file ${fileIndex + 1}`;
    const rows = [];
    let oldLine = null;
    let newLine = null;
    let additions = 0;
    let deletions = 0;
    for (const line of block.split("\n").slice(1)) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        rows.push({ kind: "hunk", old: "", new: "", text: `@@ ${hunk[3].trim()}`.trim() });
      } else if (line.startsWith("+") && !line.startsWith("+++")) {
        rows.push({ kind: "add", old: "", new: newLine++, text: line.slice(1) });
        additions++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        rows.push({ kind: "delete", old: oldLine++, new: "", text: line.slice(1) });
        deletions++;
      } else if (oldLine !== null && !line.startsWith("\\")) {
        rows.push({ kind: "context", old: oldLine++, new: newLine++, text: line.startsWith(" ") ? line.slice(1) : line });
      } else if (!/^(index |--- |\+\+\+ )/.test(line) && line) {
        rows.push({ kind: "meta", old: "", new: "", text: line });
      }
    }
    return { name, additions, deletions, rows };
  });
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0)
  };
}

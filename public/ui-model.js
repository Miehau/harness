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

export function summarizeRun(events = []) {
  const groups = {
    inspect: { title: "Explored the repository", detail: "reads and searches", tools: new Set(["read", "grep", "find", "ls"]) },
    change: { title: "Changed the implementation", detail: "file edits", tools: new Set(["write", "edit"]) },
    check: { title: "Ran commands and checks", detail: "commands", tools: new Set(["bash"]) },
    report: { title: "Prepared the handoff", detail: "reports", tools: new Set(["worker_report"]) }
  };
  const activities = [];
  for (const group of Object.values(groups)) {
    const matching = events.filter((event) => event.type === "tool_start" && group.tools.has(event.tool));
    if (matching.length) activities.push({ title: group.title, detail: `${matching.length} ${matching.length === 1 && group.detail === "reports" ? "report" : group.detail}`, at: matching[0].at, kind: "success" });
  }
  const errors = events.filter((event) => event.type === "tool_end" && event.isError);
  if (errors.length) activities.push({ title: "Some commands needed correction", detail: `${errors.length} failed ${errors.length === 1 ? "operation" : "operations"}`, at: errors[0].at, kind: "warning" });
  return activities.sort((a, b) => String(a.at).localeCompare(String(b.at)));
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

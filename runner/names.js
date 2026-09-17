export function titleOf(text) {
  const line = String(text ?? '').split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
  return line.replace(/^#+\s*/, '').trim().slice(0, 72) || 'task';
}

export function slugOf(text, max = 40) {
  const slug = titleOf(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug || 'task';
}

export function workspaceLabel(task) {
  return String(task.title || titleOf(task.slug) || 'task').slice(0, 60);
}

export function tabLabel(agent) {
  if (agent.role === 'orchestrator') return 'Coordinator';
  const stage = agent.stage || (agent.mode === 'write' ? 'implementation' : 'explore');
  return `${stage[0].toUpperCase()}${stage.slice(1)} worker`;
}

export function agentName(task, agent) {
  const slug = (task.slug || slugOf(task.title)).slice(0, 24);
  const role = agent.role === 'orchestrator' ? 'coord' : (agent.stage || agent.mode || 'worker');
  return `${slug}-${role}-${agent.id.slice(0, 4)}`;
}

export function branchName(task, name) {
  const slug = task.slug || slugOf(task.title);
  const unique = task.id.slice(0, 8);
  return name === 'integration' ? `runner/${slug}-${unique}` : `runner/${slug}-${unique}-${name}`;
}

const skippedTicketPrefix = /^(UTF|ISO|SHA|AES|RSA|TLS|SSL|HTTP|HTML|CSS|RFC|PEP|IEEE|UUID|W3C)$/;

export function titleOf(text) {
  const line = String(text ?? '').split(/\r?\n/).map(value => value.trim()).find(Boolean) || '';
  return line.replace(/^#+\s*/, '').trim().slice(0, 72) || 'task';
}

function usableTitle(text) {
  const line = titleOf(text ?? '');
  if (!line || line === 'task') return '';
  if (/[\\/]/.test(line) || /\.(md|json|txt)$/i.test(line)) return '';
  return line;
}

export function ticketOf(...texts) {
  for (const text of texts) {
    const source = String(text ?? '');
    for (const match of source.matchAll(/\b([A-Z]{2,10})-(\d+)\b/g)) {
      if (!skippedTicketPrefix.test(match[1])) return match[0];
    }
    const issue = source.match(/(^|[\s\[(])#(\d{1,6})\b/);
    if (issue) return `#${issue[2]}`;
  }
  return '';
}

export function commitSubject({ title, assignment, handoff, brief, ticket } = {}) {
  const named = typeof title === 'string' ? title.trim().slice(0, 72) : '';
  const subject = usableTitle(assignment) || named || usableTitle(handoff) || 'Apply worker changes';
  const id = ticket || ticketOf(title, brief, assignment, handoff);
  if (!id || subject.toUpperCase().includes(id.toUpperCase())) return subject;
  const prefix = `${id}: `;
  return prefix + subject.slice(0, Math.max(0, 72 - prefix.length));
}

export function commitMessage({ title, assignment, handoff, brief, ticket } = {}) {
  const subject = commitSubject({ title, assignment, handoff, brief, ticket });
  const text = String(handoff ?? '').trim();
  if (!text) return { subject, body: '' };
  const rest = text.split(/\r?\n/).slice(1).join('\n').trim();
  const body = (usableTitle(handoff) === subject ? rest : text).slice(0, 4000);
  return { subject, body: body && body !== subject ? body : '' };
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

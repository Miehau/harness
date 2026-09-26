import { exec as defaultExec, assert, string } from './io.js';

function ref(value, label) {
  string(value, label, 200);
  assert(!value.startsWith('-') && !/[\s~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{') && !value.includes('//') && value !== '@' && !value.startsWith('/') && !value.endsWith('/') && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')), `${label} must be a Git branch or remote name`);
  return value;
}

export function validateHosting(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'hosting must be an object');
  assert(['github', 'gitlab'].includes(value.provider), 'hosting.provider must be github or gitlab');
  const host = value.host ?? (value.provider === 'github' ? 'github.com' : 'gitlab.com');
  assert(typeof host === 'string' && /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d+)?$/.test(host), 'hosting.host must be a hostname (optional port), without a URL scheme');
  const project = string(value.project, 'hosting.project', 500);
  assert(project.split('/').length >= 2 && project.split('/').every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..') && (value.provider !== 'github' || project.split('/').length === 2), 'hosting.project must be owner/repo or GitLab namespace/project');
  return { provider: value.provider, host: host.toLowerCase(), project, remote: ref(value.remote ?? 'origin', 'hosting.remote'), target: ref(value.target ?? 'main', 'hosting.target') };
}
export const normalizeHosting = validateHosting;

async function output(exec, command, args, options = {}) {
  const result = await exec(command, args, { timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options });
  return (typeof result === 'string' ? result : result.stdout).trim();
}

// Remote discovery supplies hints; a self-hosted provider must be selected explicitly.
export async function discoverHosting(repo, overrides = {}, options = {}) {
  const exec = options.exec ?? defaultExec;
  const remote = ref(overrides.remote ?? 'origin', 'hosting.remote');
  const url = await output(exec, 'git', ['remote', 'get-url', '--', remote], { cwd: repo });
  const { host, project } = parseRemote(url);
  const provider = overrides.provider ?? (host === 'github.com' ? 'github' : host === 'gitlab.com' ? 'gitlab' : null);
  assert(provider, 'Select github or gitlab explicitly for a self-hosted remote');
  let target = overrides.target;
  if (!target) {
    try { target = (await output(exec, 'git', ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], { cwd: repo })).slice(remote.length + 1); }
    catch { target = 'main'; }
  }
  return validateHosting({ provider, host, project, remote, target, ...overrides });
}

function parseRemote(url) {
  let host, project;
  if (/^[\w.+-]+:\/\//.test(url)) {
    const parsed = new URL(url); host = parsed.host; project = parsed.pathname.replace(/^\//, '');
  } else {
    const match = url.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
    assert(match, 'Hosting discovery requires an SSH or HTTP Git remote');
    [, host, project] = match;
  }
  project = project.replace(/\.git\/?$/, '').replace(/\/$/, '');
  return { host: host.toLowerCase(), project };
}

export async function validateRemote(repo, value, { exec = defaultExec } = {}) {
  const config = validateHosting(value);
  const urls = (await output(exec, 'git', ['remote', 'get-url', '--push', '--all', '--', config.remote], { cwd: repo })).split('\n');
  assert(urls.length === 1, 'Hosting requires exactly one push URL for its configured remote');
  const remote = parseRemote(urls[0]);
  assert(remote.host === config.host && remote.project === config.project, 'Git push remote does not match the configured hosting host/project');
  return config;
}

function ciState(checks) {
  if (!checks.length) return 'none';
  if (checks.some(check => ['failure', 'error', 'failed', 'canceled', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(check.state))) return 'failed';
  return checks.every(check => ['success', 'neutral', 'skipped'].includes(check.state)) ? 'passed' : 'pending';
}

export function createHosting(value, { exec = defaultExec, cwd } = {}) {
  const config = validateHosting(value);
  const github = config.provider === 'github';
  const command = github ? 'gh' : 'glab';
  const repository = `${config.host}/${config.project}`;
  const endpoint = github ? `repos/${config.project}/pulls` : `projects/${encodeURIComponent(config.project)}/merge_requests`;
  const run = args => output(exec, command, args, { cwd });
  const api = async (path, method = 'GET', fields = {}, extra = []) => JSON.parse(await run(['api', path, '--hostname', config.host, '--method', method, ...Object.entries(fields).flatMap(([key, val]) => ['--raw-field', `${key}=${val}`]), ...extra]));
  const read = async number => {
    assert(Number.isSafeInteger(Number(number)) && Number(number) > 0, 'PR/MR number must be a positive integer');
    if (github) {
      const pr = JSON.parse(await run(['pr', 'view', String(number), '--repo', repository, '--json', 'number,url,state,headRefOid,headRefName,baseRefName,mergeStateStatus,statusCheckRollup,isDraft,body']));
      const checks = (pr.statusCheckRollup ?? []).map(check => ({ name: check.name ?? check.context, state: (check.conclusion || check.state || check.status || 'pending').toLowerCase(), url: check.detailsUrl ?? check.targetUrl }));
      return { number: pr.number, url: pr.url, body: pr.body, state: pr.state.toLowerCase(), head: pr.headRefOid, branch: pr.headRefName, target: pr.baseRefName, mergeable: !pr.isDraft && pr.mergeStateStatus === 'CLEAN', ci: { state: ciState(checks), checks }, mergeStatus: pr.mergeStateStatus };
    }
    const mr = await api(`${endpoint}/${number}`);
    const checks = mr.head_pipeline ? [{ name: 'pipeline', state: mr.head_pipeline.sha === mr.sha ? mr.head_pipeline.status : 'pending', url: mr.head_pipeline.web_url }] : [];
    return { number: mr.iid, url: mr.web_url, body: mr.description, state: mr.state === 'opened' ? 'open' : mr.state, head: mr.sha, branch: mr.source_branch, target: mr.target_branch, mergeable: !mr.draft && !mr.work_in_progress && mr.detailed_merge_status === 'mergeable', ci: { state: ciState(checks), checks }, mergeStatus: mr.detailed_merge_status };
  };
  return {
    config,
    async find(branch) {
      ref(branch, 'branch');
      const query = new URLSearchParams(github ? { state: 'all', head: `${config.project.split('/')[0]}:${branch}`, base: config.target, per_page: '100' } : { state: 'all', source_branch: branch, target_branch: config.target, per_page: '100' });
      let matches;
      if (github) matches = (await api(`${endpoint}?${query}`, 'GET', {}, ['--paginate', '--slurp'])).flat();
      else {
        matches = [];
        for (let page = 1; ; page++) {
          const batch = await api(`${endpoint}?${query}&page=${page}`);
          matches.push(...batch.filter(mr => mr.source_project_id === mr.target_project_id));
          if (batch.length < 100) break;
        }
      }
      assert(matches.length <= 1, 'Multiple PRs/MRs match the task branch; inspect before continuing');
      return matches.length ? read(github ? matches[0].number : matches[0].iid) : null;
    },
    async create({ branch, title, body }) {
      ref(branch, 'branch'); string(title, 'title', 256); string(body, 'body', 100000);
      const fields = github ? { head: branch, base: config.target, title, body } : { source_branch: branch, target_branch: config.target, title, description: body };
      const pr = await api(endpoint, 'POST', fields);
      return read(github ? pr.number : pr.iid);
    },
    read,
    async update({ number, title, body }) {
      string(title, 'title', 256); string(body, 'body', 100000);
      const current = await read(number);
      assert(current.target === config.target && current.state === 'open', 'PR/MR is not open against the configured target');
      await api(`${endpoint}/${current.number}`, github ? 'PATCH' : 'PUT', github ? { title, body } : { title, description: body });
      return read(current.number);
    },
    async merge({ number, head }) {
      assert(typeof head === 'string' && /^[a-f0-9]{40,64}$/.test(head), 'Merge requires the exact approved commit SHA');
      const pr = await read(number);
      assert(pr.head === head, 'Remote head changed; a new exact-head approval is required');
      assert(pr.target === config.target && pr.state === 'open', 'PR/MR is not open against the configured target');
      assert(pr.mergeable && ['passed', 'none'].includes(pr.ci.state), 'Required CI or merge requirements are pending or blocked');
      if (github) {
        const result = await api(`${endpoint}/${number}/merge`, 'PUT', { sha: head, merge_method: 'merge' });
        assert(result.merged === true, 'Provider rejected the exact-head merge');
      }
      else await api(`${endpoint}/${number}/merge`, 'PUT', { sha: head });
      return read(number);
    },
    async uploadEvidence() {
      return { supported: false, reason: 'Publish evidence through the repository-backed evidence branch so repository access controls apply.' };
    }
  };
}

import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assert, exec, git, safePath } from './io.js';
import { validateRemote } from './hosting.js';

export async function assertHostingRemote(task) {
  const expected = task.config.hosting;
  await validateRemote(task.repo, expected);
  const pushURL = await git(task.repo, 'remote', 'get-url', '--push', expected.remote);
  return pushURL;
}

// Repository-backed evidence preserves access controls on both providers; GitLab
// image uploads are public by URL by default, even for private projects.
export async function publishEvidence(runtime, task, paths, { checkRemote = assertHostingRemote } = {}) {
  const remote = await checkRemote(task);
  const root = await mkdtemp(join(tmpdir(), 'runner-evidence-'));
  try {
    await git(root, 'init', '-q');
    for (const path of paths) {
      const source = await safePath(join(runtime.dir(task), 'artifacts'), path);
      const destination = join(root, path);
      await mkdir(dirname(destination), { recursive: true }); await copyFile(source, destination);
    }
    await git(root, 'add', '-A');
    const date = new Date(task.createdAt).toISOString();
    await exec('git', ['-c', 'user.name=Agent Plan', '-c', 'user.email=agent-plan@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `Evidence for ${task.id} at ${task.hosted.commit}`], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    const commit = await git(root, 'rev-parse', 'HEAD');
    const branch = `runner-evidence/${task.id}/${task.hosted.commit}/${commit}`;
    await git(root, 'push', remote, `${commit}:refs/heads/${branch}`);
    const config = task.config.hosting;
    const prefix = `https://${config.host}/${config.project}/${config.provider === 'gitlab' ? '-/blob' : 'blob'}/${commit}`;
    return paths.map(path => ({ artifact: path, url: `${prefix}/${path.split('/').map(encodeURIComponent).join('/')}`, evidenceCommit: commit }));
  } finally { await rm(root, { recursive: true, force: true }); }
}

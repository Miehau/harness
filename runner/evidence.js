import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { assert, id, json, safePath } from './io.js';

// ponytail: inline playback caps video at 25 MB; use streaming for larger recordings.
export async function mediaFile(path) {
  const extension = extname(path).slice(1).toLowerCase();
  assert(['png', 'webm', 'mp4'].includes(extension), 'Only PNG, WebM and MP4 evidence is supported');
  const size = (await stat(path)).size;
  assert(size > 0 && size <= (extension === 'png' ? 10000000 : 25000000), 'Evidence exceeds its size limit or is empty');
  const bytes = await readFile(path);
  const valid = extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : extension === 'webm' ? bytes.subarray(0, 4).equals(Buffer.from([26,69,223,163]))
      : bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  assert(valid, `Invalid ${extension} evidence header`);
  return { bytes, extension, mimeType: extension === 'png' ? 'image/png' : `video/${extension}` };
}

export async function verifyUI(runtime, task, commit) {
  const runId = id();
  const directory = join(runtime.dir(task), 'ui-runs', runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = { commit, runId, passed: false, criteria: [], attachments: [] };
  try {
    result.command = await runtime.command(task, task.integration, task.config.uiEvidence.command, {
      RUNNER_UI_DIR: directory, RUNNER_UI_COMMIT: commit, RUNNER_UI_RUN_ID: runId
    });
    assert(result.command.passed, 'Project UI verification command failed');
    const manifestPath = await safePath(directory, 'manifest.json');
    assert((await stat(manifestPath)).size <= 1000000, 'UI manifest exceeds 1 MB');
    const manifest = await json(manifestPath);
    assert(manifest.commit === commit && manifest.runId === runId, 'UI evidence must match this candidate and verification run');
    assert(manifest.passed === true && Array.isArray(manifest.criteria) && manifest.criteria.length > 0 && manifest.criteria.length <= 100, 'Provide passing UI criteria');
    const seen = new Set();
    for (const criterion of manifest.criteria) {
      assert(typeof criterion.id === 'string' && criterion.id.trim() && criterion.id.length <= 200 && !seen.has(criterion.id), 'UI criterion IDs must be nonempty and unique');
      seen.add(criterion.id);
      assert(criterion.passed === true && typeof criterion.assertion === 'string' && criterion.assertion.trim() && criterion.assertion.length <= 10000, 'Each UI criterion needs a passing assertion');
      assert(Array.isArray(criterion.files) && criterion.files.length > 0 && criterion.files.length <= 4, 'Each UI criterion needs 1–4 screenshots or videos');
      const files = [];
      for (const name of criterion.files) {
        const media = await mediaFile(await safePath(directory, name));
        const artifact = await runtime.artifact(task, media.bytes, media.extension);
        files.push({ artifact, mimeType: media.mimeType, size: media.bytes.length });
        if (result.attachments.length < 4) result.attachments.push(artifact);
      }
      result.criteria.push({ id: criterion.id, assertion: criterion.assertion, passed: true, files });
    }
    result.passed = true;
  } catch (error) { result.error = error.message; }
  result.artifact = await runtime.artifact(task, JSON.stringify(result, null, 2), 'json');
  return result;
}

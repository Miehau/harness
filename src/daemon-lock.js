import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

function processAlive(pid, processKill) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { processKill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

export async function acquireDaemonLock(path, { pid = process.pid, processKill = process.kill } = {}) {
  await mkdir(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`);
      await handle.close();
      let released = false;
      return { path, async release() { if (!released) { released = true; await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; }); } } };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner = null;
      try { owner = JSON.parse(await readFile(path, "utf8")); } catch {}
      if (processAlive(Number(owner?.pid), processKill)) throw new Error(`Another harness daemon is using this data directory (PID ${owner.pid})`);
      await unlink(path).catch((removeError) => { if (removeError.code !== "ENOENT") throw removeError; });
    }
  }
  throw new Error("Could not acquire the harness data-directory lock");
}

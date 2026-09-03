#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function startSnapshotPreview([serverFile, cwd, dataDir, host, portValue, seedFile]) {
  if (![serverFile, cwd, dataDir, host, portValue, seedFile].every(Boolean)) throw new Error("Snapshot preview requires server, workspace, data, host, port, and seed paths");
  const snapshot = JSON.parse(await readFile(seedFile, "utf8"));
  const { createDaemon } = await import(pathToFileURL(serverFile));
  const daemon = await createDaemon({ cwd, dataDir, host, port: Number(portValue), listen: false, lock: false });

  // createDaemon performs normal crash recovery during construction. Restore
  // the immutable proof snapshot before opening the port so no request can see
  // that preview-only mutation.
  daemon.store.state = snapshot;
  await daemon.store.save();
  await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(Number(portValue), host, resolve);
  });
  console.log(`Agent Plan proof preview: http://${host}:${portValue}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => daemon.close({ exit: true }));
  return daemon;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await startSnapshotPreview(process.argv.slice(2));

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

function linearCredentialPath(dataDir, cwd) {
  const repository = createHash("sha256").update(resolve(cwd)).digest("hex");
  return join(dataDir, "credentials", repository, "linear-api-key");
}

export async function readLinearApiKey(dataDir, cwd) {
  try { return (await readFile(linearCredentialPath(dataDir, cwd), "utf8")).trim(); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

export async function persistLinearApiKey(dataDir, cwd, apiKey) {
  const path = linearCredentialPath(dataDir, cwd);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await writeFile(path, `${apiKey.trim()}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

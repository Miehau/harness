import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const identity = [
  "--config", "user.name=Agent Plan Workspace",
  "--config", "user.email=agent-plan@local",
  "--color", "never",
  "--no-pager"
];

async function run(cwd, args, execImpl = exec) {
  const { stdout = "" } = await execImpl("jj", [...identity, ...args], { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

async function exists(path) {
  try { await access(path); return true; }
  catch { return false; }
}

export async function initializeJjWorkspace(cwd, execImpl = exec) {
  if (!(await exists(join(cwd, ".jj")))) {
    try { await run(cwd, ["git", "init", "--git-repo=.git", "."], execImpl); }
    catch (error) {
      if (error.code === "ENOENT") throw new Error("Jujutsu mode requires the jj executable in PATH");
      throw error;
    }
  }
  return currentJjChange(cwd, execImpl);
}

export async function currentJjChange(cwd, execImpl = exec) {
  const output = await run(cwd, ["log", "--no-graph", "-r", "@", "-T", 'change_id ++ "\\n" ++ commit_id ++ "\\n"'], execImpl);
  const [changeId, commitId] = output.split("\n");
  if (!changeId || !commitId) throw new Error("Could not read the current Jujutsu change");
  return { system: "jj", changeId, commitId };
}

export async function beginJjChange(cwd, { changeId, title }, execImpl = exec) {
  if (changeId) {
    const current = await currentJjChange(cwd, execImpl);
    if (current.changeId !== changeId) await run(cwd, ["edit", changeId], execImpl);
  }
  await run(cwd, ["describe", "-m", `WIP: ${title}`], execImpl);
  return currentJjChange(cwd, execImpl);
}

export async function snapshotJjChange(cwd, execImpl = exec) {
  await run(cwd, ["util", "snapshot"], execImpl);
  return currentJjChange(cwd, execImpl);
}

export async function acceptJjChange(cwd, { changeId, message, bookmark }, execImpl = exec) {
  const current = await currentJjChange(cwd, execImpl);
  if (current.changeId !== changeId) await run(cwd, ["edit", changeId], execImpl);
  await run(cwd, ["describe", "-m", message], execImpl);
  const accepted = await currentJjChange(cwd, execImpl);
  await run(cwd, ["bookmark", "set", bookmark, "-r", "@"], execImpl);
  await run(cwd, ["new"], execImpl);
  return accepted;
}

export async function prepareJjForGit(cwd, bookmark, execImpl = exec) {
  await run(cwd, ["git", "export"], execImpl);
  await execImpl("git", ["switch", bookmark], { cwd, maxBuffer: 4 * 1024 * 1024 });
}

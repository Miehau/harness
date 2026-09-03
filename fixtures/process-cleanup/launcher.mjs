import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const [mode = "long-lived", eventFile = ""] = process.argv.slice(2);
const descendant = fileURLToPath(new URL("./descendant.mjs", import.meta.url));
const child = spawn(process.execPath, [descendant, mode, eventFile], {
  stdio: "ignore"
});

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
if (mode !== "normal-exit") child.unref();
process.stdout.write(`${JSON.stringify({ pid: child.pid, mode })}\n`);

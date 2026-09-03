import { spawn } from "node:child_process";

function signalTree(child, signal) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    child.kill(signal);
  }
}

export function execFileTree(file, args, { timeout = 0, signal, maxBuffer = 1024 * 1024, ...options } = {}) {
  signal?.throwIfAborted();
  const child = spawn(file, args, { ...options, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let failure;
  let killTimer;
  const terminate = () => {
    signalTree(child, "SIGTERM");
    killTimer ||= setTimeout(() => signalTree(child, "SIGKILL"), 1000);
    killTimer.unref?.();
  };
  const collect = (chunks, stream) => (chunk) => {
    chunks.push(chunk);
    if (stream === "stdout") stdoutBytes += chunk.length;
    else stderrBytes += chunk.length;
    if (!failure && Math.max(stdoutBytes, stderrBytes) > maxBuffer) {
      failure = new Error(`${stream} exceeded maxBuffer`);
      terminate();
    }
  };
  child.stdout.on("data", collect(stdout, "stdout"));
  child.stderr.on("data", collect(stderr, "stderr"));
  child.once("error", (error) => { failure ||= error; });
  const timeoutTimer = timeout > 0 && setTimeout(() => {
    failure ||= new Error(`${file} timed out after ${timeout}ms`);
    terminate();
  }, timeout);
  timeoutTimer?.unref?.();
  const abort = () => {
    failure ||= Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });

  return new Promise((resolve, reject) => child.once("close", (code, exitSignal) => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener("abort", abort);
    const result = { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
    if (!failure && code === 0) resolve(result);
    else {
      const error = failure || new Error(`${file} exited with code ${code ?? "null"}${exitSignal ? ` (${exitSignal})` : ""}`);
      Object.assign(error, result, { code, signal: exitSignal });
      reject(error);
    }
  }));
}

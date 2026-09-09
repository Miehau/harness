#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewChromiumPath } from "../src/previews.js";
import { signalProcessTree } from "../src/process-tree.js";

async function waitFor(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Not ready: ${url}`);
}

function sendCdp(socket) {
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result || {}));
    socket.send(JSON.stringify({ id, method, params }));
  });
}

export async function capturePage({ url, out, video = null, click = null, eval: script = null, interact = null, waitMs = 600, width = 1440, height = 900 }) {
  await waitFor(url);
  const profile = await mkdtemp(join(tmpdir(), "agent-plan-chrome-"));
  const chrome = spawn(await previewChromiumPath(), [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    ...(video ? ["--auto-select-tab-capture-source-by-title=Agent Plan CLI recording"] : []),
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, url
  ], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let debugPort;
  let socket;
  try {
    debugPort = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Chromium did not expose DevTools")), 20000);
      const onData = (chunk) => {
        const match = String(chunk).match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      chrome.stderr.on("data", onData);
      chrome.stdout.on("data", onData);
      chrome.once("exit", (code) => reject(new Error(`Chromium exited ${code}`)));
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!page) throw new Error("No Chromium page target");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", () => reject(new Error("DevTools websocket failed")));
    });
    const cdp = sendCdp(socket);
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    const evaluate = async (expression) => {
      const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout: 15000 });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    await cdp("Runtime.addBinding", { name: "__agentPlanInputBinding" });
    await evaluate(`globalThis.__agentPlanInputPending = new Map(); globalThis.__agentPlanInputNext = 0;
      globalThis.__agentPlanInput = (method, params) => new Promise((resolve, reject) => {
        const id = ++globalThis.__agentPlanInputNext;
        globalThis.__agentPlanInputPending.set(id, { resolve, reject });
        globalThis.__agentPlanInputBinding(JSON.stringify({ id, method, params }));
      });`);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method !== "Runtime.bindingCalled" || message.params.name !== "__agentPlanInputBinding") return;
      const input = JSON.parse(message.params.payload);
      if (!Number.isSafeInteger(input.id)) return;
      const allowed = ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText"].includes(input.method);
      Promise.resolve().then(() => {
        if (!allowed) throw new Error("Unsupported browser input");
        return cdp(input.method, input.params);
      }).then(() => null, (error) => error.message).then((error) => evaluate(`{
        const pending = globalThis.__agentPlanInputPending.get(${input.id});
        globalThis.__agentPlanInputPending.delete(${input.id});
        if (pending) ${error ? `pending.reject(new Error(${JSON.stringify(error)}))` : "pending.resolve()"};
      }`)).catch(() => {});
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (video) await evaluate(`(async () => {
      const title = document.title;
      document.title = "Agent Plan CLI recording";
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false, preferCurrentTab: true });
      document.title = title;
      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
      let size = 0;
      recorder.ondataavailable = (event) => { size += event.data.size; if (size > 20 * 1024 * 1024) recorder.stop(); chunks.push(event.data); };
      globalThis.__agentPlanRecording = { recorder, chunks, stream };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Tab recording produced no video data within 10 seconds")), 10000);
        recorder.addEventListener("dataavailable", function ready(event) {
          if (!event.data.size) return;
          clearTimeout(timer);
          recorder.removeEventListener("dataavailable", ready);
          resolve();
        });
        recorder.addEventListener("error", (event) => { clearTimeout(timer); reject(event.error || new Error("Tab recording failed")); }, { once: true });
        recorder.start(100);
      });
    })()`);
    if (click) {
      await cdp("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(click)})?.click()` });
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (script) {
      await evaluate(script);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    if (interact) try { await interact({ evaluate }); }
    catch (error) {
      if (out) {
        const failed = await cdp("Page.captureScreenshot", { format: "png", fromSurface: true });
        await writeFile(out, Buffer.from(failed.data, "base64"));
      }
      throw error;
    }
    const shot = await cdp("Page.captureScreenshot", { format: "png", fromSurface: true });
    if (out) await writeFile(out, Buffer.from(shot.data, "base64"));
    if (video) {
      // MediaRecorder records the live tab stream, not a slideshow of screenshots.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const data = await evaluate(`(async () => {
        const { recorder, chunks, stream } = globalThis.__agentPlanRecording;
        if (recorder.state !== "recording") throw new Error("Recording exceeded its size limit");
        await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
        stream.getTracks().forEach((track) => track.stop());
        return await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = reject;
          reader.readAsDataURL(new Blob(chunks, { type: "video/webm" }));
        });
      })()`);
      const raw = join(profile, "recording.webm");
      await writeFile(raw, Buffer.from(data, "base64"));
      // Finalize duration/index metadata so the independent decoder can seek it.
      await promisify(execFile)("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", raw, "-c", "copy", video], { timeout: 30000 });
    }
  } finally {
    socket?.close();
    signalProcessTree(chrome);
    await new Promise((resolve) => {
      if (chrome.exitCode !== null) return resolve();
      const timer = setTimeout(resolve, 1000);
      chrome.once("close", () => { clearTimeout(timer); resolve(); });
    });
    if (chrome.exitCode === null) signalProcessTree(chrome, "SIGKILL");
    await rm(profile, { recursive: true, force: true });
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/"));
if (isMain) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const numberOption = (name, fallback) => Number(option(name)) || fallback;
  capturePage({
    url: option("--url"),
    out: option("--out"),
    click: option("--click"),
    waitMs: numberOption("--wait-ms", 600),
    width: numberOption("--width", 1440),
    height: numberOption("--height", 900)
  }).then((path) => {
    process.stdout.write(`${path}\n`);
  }, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}

#!/usr/bin/env node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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
    if (message.id && pending.has(message.id)) pending.get(message.id)(message);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result || {}));
    socket.send(JSON.stringify({ id, method, params }));
  });
}

export async function capturePage({ url, out, click = null, eval: script = null, waitMs = 600, width = 1440, height = 900 }) {
  await waitFor(url);
  const profile = await mkdtemp(join(tmpdir(), "agent-plan-chrome-"));
  const chrome = spawn(await previewChromiumPath(), [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, url
  ], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let debugPort;
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
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", () => reject(new Error("DevTools websocket failed")));
    });
    const cdp = sendCdp(socket);
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (click) {
      await cdp("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(click)})?.click()` });
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
    if (script) {
      await cdp("Runtime.evaluate", { expression: script });
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const shot = await cdp("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(out, Buffer.from(shot.data, "base64"));
    socket.close();
  } finally {
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

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const [mode = "long-lived", eventFile = ""] = process.argv.slice(2);

async function record(event) {
  if (!eventFile) return;
  await mkdir(dirname(eventFile), { recursive: true });
  await appendFile(eventFile, `${Date.now()} ${event} ${process.pid}\n`);
}

await record("started");
if (mode === "normal-exit") {
  await record("completed");
  process.exit(0);
}

process.on("SIGTERM", () => {
  record("graceful").then(() => {
    if (mode !== "stubborn") process.exit(0);
  });
});

process.on("SIGINT", () => { process.exit(0); });
setInterval(() => {}, 1_000);

import assert from "node:assert/strict";
import test from "node:test";
import { enqueueSerial } from "../src/merge-queue.js";

test("repository merge queue runs one item at a time in FIFO order", async () => {
  const queues = new Map();
  const order = [];
  let releaseFirst;
  let markFirstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const first = enqueueSerial(queues, "/repo", () => {}, async () => { order.push("first:start"); markFirstStarted(); await firstGate; order.push("first:end"); });
  const second = enqueueSerial(queues, "/repo", () => {}, async () => { order.push("second:start"); order.push("second:end"); });
  assert.deepEqual([first.position, second.position], [1, 2]);
  await firstStarted;
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  await Promise.all([first.promise, second.promise]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start", "second:end"]);
  assert.equal(queues.size, 0);
});

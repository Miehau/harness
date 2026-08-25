export function enqueueSerial(queues, key, onQueued, work) {
  const queue = queues.get(key) || { tail: Promise.resolve(), pending: 0 };
  queues.set(key, queue);
  const position = ++queue.pending;
  const queued = Promise.resolve(onQueued(position));
  const turn = queue.tail.catch(() => {}).then(() => queued).then(work);
  const tracked = turn.finally(() => {
    queue.pending--;
    if (!queue.pending && queues.get(key) === queue) queues.delete(key);
  });
  queue.tail = tracked.catch(() => {});
  return { position, promise: tracked };
}

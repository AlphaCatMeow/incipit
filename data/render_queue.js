const queue = [];
let scheduled = false;

function pump() {
  const deadline = performance.now() + 4;
  while (queue.length) {
    const job = queue.shift();
    if (job.signal?.aborted) job.reject(new DOMException('Rendering cancelled.', 'AbortError'));
    else { try { job.resolve(job.render()); } catch (error) { job.reject(error); } }
    if (performance.now() >= deadline) break;
  }
  if (queue.length) setTimeout(pump, 0);
  else scheduled = false;
}

/** Share a small rendering budget across saved messages and syntax highlights. */
export function scheduleRender(render, signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Rendering cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    queue.push({ render, signal, resolve, reject });
    if (!scheduled) { scheduled = true; setTimeout(pump, 0); }
  });
}

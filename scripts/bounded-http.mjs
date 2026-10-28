import { setTimeout as schedule, clearTimeout as cancelTimer } from 'node:timers';

// Read helpers only. This does not retry or authorize any write.
export async function fetchTextBounded(fetchImpl, url, init, { timeoutMs = 12000, maxBytes = 2_000_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid_read_budget');
  const controller = new AbortController();
  let reader, expired = false, timer;
  const operation = (async () => {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (expired) { void response.body?.cancel().catch(() => {}); throw new DOMException('Read timed out', 'TimeoutError'); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      void response.body?.cancel().catch(() => {}); throw new Error('read_size_limit');
    }
    if (!response.body) return { response, text: '' };
    reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (expired) throw new DOMException('Read timed out', 'TimeoutError');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('read_size_limit');
      chunks.push(value);
    }
    return { response, text: Buffer.concat(chunks).toString('utf8') };
  })();
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = schedule(() => {
        expired = true;
        reject(new DOMException('Read timed out', 'TimeoutError'));
        controller.abort();
        if (reader) void reader.cancel().catch(() => {});
      }, timeoutMs);
    })]);
  } finally {
    cancelTimer(timer);
    if (reader) void reader.cancel().catch(() => {});
  }
}

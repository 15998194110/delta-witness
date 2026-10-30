// Importable local receiver sample; importing this file does not start a server.
// inbox.accept must atomically insert event ID + body digest + payload, or return
// duplicate/conflict. Acknowledge only after durable commit. Process the inbox
// separately with the same event ID as your downstream idempotency key.
export async function receiveWatchWebhook(request, { secret, inbox, nowSeconds = Math.floor(Date.now() / 1000), maxSkewSeconds = 300 }) {
  const reject = (status) => Response.json({ok: false}, {status});
  if (request.method !== 'POST') return reject(405);
  if (typeof secret !== 'string' || !secret || !inbox || typeof inbox.accept !== 'function') return reject(503);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0 || !Number.isSafeInteger(maxSkewSeconds) || maxSkewSeconds <= 0) return reject(503);
  const timestamp = request.headers.get('x-delta-timestamp') ?? '';
  const eventId = request.headers.get('x-delta-event-id') ?? '';
  const signature = request.headers.get('x-delta-signature') ?? '';
  if (!/^[1-9][0-9]{0,11}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > maxSkewSeconds ||
      !/^sha256=[0-9a-f]{64}$/.test(signature) || !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(eventId)) return reject(401);
  const chunks = [], reader = request.body?.getReader();
  let size = 0, timer, expired = false;
  try {
    await Promise.race([
      (async () => {
        if (reader) while (true) {
          const {done, value} = await reader.read();
          if (expired) throw new Error('body_timeout');
          if (done) break;
          size += value.byteLength;
          if (size > 32_000) throw new Error('body_limit');
          chunks.push(value);
        }
      })(),
      new Promise((_, rejectBody) => { timer = setTimeout(() => {
        expired = true; rejectBody(new Error('body_timeout'));
        void reader?.cancel().catch(() => {});
      }, 10_000); }),
    ]);
  } catch (error) { return reject(expired ? 408 : error?.message === 'body_limit' ? 413 : 400); }
  finally { clearTimeout(timer); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let raw, payload;
  try { raw = new TextDecoder('utf-8', {fatal: true}).decode(bytes); payload = JSON.parse(raw); }
  catch { return reject(400); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.event_id !== eventId || typeof payload.event_created_at !== 'string' || !Number.isFinite(Date.parse(payload.event_created_at))) return reject(401);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
  const mac = Uint8Array.from(signature.slice(7).match(/../g), byte => Number.parseInt(byte, 16));
  if (!await crypto.subtle.verify('HMAC', key, mac, new TextEncoder().encode(`${timestamp}.${raw}`))) return reject(401);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    const result = await inbox.accept(eventId, `sha256:${digest}`, payload);
    if (result === 'accepted') return Response.json({ok: true}, {status: 202});
    if (result === 'duplicate') return Response.json({ok: true, duplicate: true});
    return reject(result === 'conflict' ? 409 : 503);
  } catch { return reject(503); }
}

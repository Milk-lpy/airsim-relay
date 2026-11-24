import http from 'node:http';
import http2 from 'node:http2';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { loadAPNsConfig, assertCurrent, publicStatus } from './apns-certificate.mjs';

export function createAPNsBridge({ config = loadAPNsConfig(), connect = http2.connect, sleep = delay, requestTimeoutMs = 15000 } = {}) {
  const sessions = new Map();
  function sessionFor(credential) {
    const name = credential.certPath;
    let session = sessions.get(name);
    if (!session || session.closed || session.destroyed) {
      session = connect(config.origin, { ...credential.tls, family: 4 });
      sessions.set(name, session);
      session.setTimeout(60_000, () => session.destroy());
      session.on('error', () => session.destroy());
      session.on('goaway', () => { if (sessions.get(name) === session) sessions.delete(name); session.close(); });
      session.on('close', () => { if (sessions.get(name) === session) sessions.delete(name); });
    }
    return session;
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      try { assertCurrent(config.alert); assertCurrent(config.voip); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(publicStatus(config))); }
      catch { res.writeHead(503).end('APNs certificate expired or not yet valid'); }
      return;
    }
    const origin = req.headers['x-airsim-apns-origin'];
    if (origin !== config.origin || req.method !== 'POST' || !/^\/3\/device\/[0-9a-f]{16,512}$/i.test(req.url)) {
      res.writeHead(400).end('{"reason":"InvalidAPNsEnvironmentOrRequest"}'); return;
    }
    const pushType = req.headers['apns-push-type'], topic = req.headers['apns-topic'];
    if (!['alert', 'background', 'voip'].includes(pushType) || topic !== config.bundle + (pushType === 'voip' ? '.voip' : '')) {
      res.writeHead(403).end('{"reason":"TopicDisallowed"}'); return;
    }
    const credential = pushType === 'voip' ? config.voip : config.alert;
    try { assertCurrent(credential); }
    catch { res.writeHead(503).end('{"reason":"APNsCertificateExpired"}'); return; }
    const headers = { ':method': 'POST', ':path': req.url };
    for (const [key, value] of Object.entries(req.headers)) {
      // Certificate authentication never forwards Bearer JWTs.
      if (key === 'content-type' || key.startsWith('apns-')) headers[key] = value;
    }
    let size = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      for (let attempt = 0; attempt < 3; attempt++) {
        if (res.destroyed) return;
        assertCurrent(credential);
        const reply = await new Promise((resolve, reject) => {
          const activeSession = sessionFor(credential);
          const stream = activeSession.request(headers); let h, received = 0; const parts = [];
          const cancel = () => stream.destroy(new Error('request closed'));
          res.once('close', cancel);
          stream.setTimeout(requestTimeoutMs, () => {
            const error = new Error('APNs timeout'); error.code = 'APNS_STREAM_TIMEOUT';
            stream.destroy(error);
          });
          stream.on('response', value => { h = value; });
          stream.on('data', part => {
            received += part.length;
            if (received > 16384) stream.destroy(new Error('APNs response too large')); else parts.push(part);
          });
          stream.on('error', error => {
            // A timed-out or broken transport must not poison later pushes.
            // Do not replay this request: APNs might already have accepted it.
            if (sessions.get(credential.certPath) === activeSession) sessions.delete(credential.certPath);
            activeSession.destroy();
            reject(error);
          });
          stream.on('close', () => { res.off('close', cancel); if (!h) reject(new Error('APNs stream closed')); });
          stream.on('end', () => h ? resolve({ headers: h, body: Buffer.concat(parts) }) : reject(new Error('APNs response missing')));
          stream.end(body);
        });
        const status = Number(reply.headers[':status']);
        if ([429, 500, 503].includes(status) && attempt < 2) {
          const expiry = Number(headers['apns-expiration']);
          const raw = reply.headers['retry-after'];
          const wait = raw ? (/^\d+$/.test(String(raw)) ? Number(raw) * 1000 : Date.parse(String(raw)) - Date.now()) : 250 * (2 ** attempt);
          // Do not retry past the call deadline or hold a local request for a long Retry-After.
          if (Number.isFinite(wait) && wait >= 0 && wait <= 1000 && (!expiry || Date.now() + wait < expiry * 1000)) { await sleep(wait); continue; }
        }
        const responseHeaders = {};
        for (const key of ['apns-id', 'content-type', 'retry-after']) if (reply.headers[key]) responseHeaders[key] = reply.headers[key];
        // No device path, token, payload or credential is written to logs.
        let reason;
        try { const value = JSON.parse(reply.body).reason; if (typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(value)) reason = value; } catch {}
        console.log(JSON.stringify({ event: 'apns_response', push_type: pushType, environment: config.environment, status, reason, attempts: attempt + 1 }));
        res.writeHead(status, responseHeaders).end(reply.body); return;
      }
    } catch (error) {
      const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'APNS_TRANSPORT_ERROR';
      console.error(JSON.stringify({ event: 'apns_transport_error', push_type: pushType, environment: config.environment, code }));
      // An ambiguous transport failure is never automatically replayed.
      if (!res.headersSent) res.writeHead(502);
      res.end('{"reason":"APNsTransportUnavailable"}');
    }
  });
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  return { server, close() { for (const s of sessions.values()) s.destroy(); server.closeAllConnections(); return new Promise(r => server.close(r)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const config = loadAPNsConfig();
    const bridge = createAPNsBridge({ config });
    bridge.server.listen(Number(process.env.APNS_BRIDGE_PORT || 8790), '127.0.0.1', () => console.log(JSON.stringify({ event: 'apns_ready', ...publicStatus(config) })));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => bridge.close().then(() => process.exit(0)));
  } catch (error) { console.error('APNs certificate configuration rejected:', error.message); process.exitCode = 1; }
}

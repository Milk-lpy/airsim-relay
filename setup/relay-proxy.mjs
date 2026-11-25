import { createServer } from 'node:https';
import http from 'node:http';
import { once } from 'node:events';
import { authority } from './tls.mjs';

const maxBody = 5 * 1024 * 1024;
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'forwarded', 'x-forwarded-host', 'x-forwarded-for',
  'x-forwarded-proto', 'host']);
function endToEnd(headers) {
  const drop = new Set([...hopHeaders, ...(headers.connection || '').toLowerCase().split(',').map(v => v.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !drop.has(name)));
}
function mobileRoute(target) {
  if (!target?.startsWith('/') || target.startsWith('//') || /[\\#]/.test(target)) return false;
  const path = target.split('?')[0];
  if (/%(?:2e|2f|5c)/i.test(path) || path.split('/').some(v => v === '.' || v === '..')) return false;
  return path === '/healthz' || path.startsWith('/v1/') || path.startsWith('/v2/');
}
function relayRequest(req, host, port, upgrade) {
  const headers = { ...endToEnd(req.headers), host: authority(host, port), 'x-forwarded-proto': 'https' };
  if (upgrade) Object.assign(headers, {connection: 'Upgrade', upgrade: 'websocket'});
  return http.request({ hostname: '127.0.0.1', port: 8787, method: req.method, path: req.url, headers });
}

export async function openProxy(config, credentials) {
  const {host, port} = config;
  const server = createServer(credentials, (req, res) => {
    if (!mobileRoute(req.url)) { res.writeHead(404).end(); return; }
    if (Number(req.headers['content-length']) > maxBody) {
      res.writeHead(413, {connection:'close'}).end();
      return;
    }
    const upstream = relayRequest(req, host, port, false);
    upstream.on('response', incoming => {
      res.writeHead(incoming.statusCode, endToEnd(incoming.headers));
      incoming.on('error', () => res.destroy());
      incoming.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    let size = 0;
    req.on('data', part => {
      size += part.length;
      if (size <= maxBody || res.headersSent) return;
      req.unpipe(upstream);
      res.writeHead(413, {connection:'close'}).end();
      upstream.destroy();
    });
    req.pipe(upstream);
  });
  server.on('upgrade', (req, client, head) => {
    client.on('error', () => client.destroy());
    if (!mobileRoute(req.url) || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = relayRequest(req, host, port, true);
    client.on('close', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    upstream.on('response', incoming => {
      incoming.resume();
      client.end('HTTP/1.1 ' + incoming.statusCode + ' Rejected\r\nConnection: close\r\n\r\n');
    });
    upstream.on('upgrade', (reply, backend, upstreamHead) => {
      if (client.destroyed) { backend.destroy(); return; }
      backend.on('error', () => client.destroy());
      backend.on('close', () => client.destroy());
      client.on('close', () => backend.destroy());
      const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
      for (const [name, value] of Object.entries(reply.headers)) {
        if (name.startsWith('sec-websocket-')) lines.push(name + ': ' + value);
      }
      client.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) backend.write(head);
      if (upstreamHead.length) client.write(upstreamHead);
      client.pipe(backend).pipe(client);
    });
    upstream.end();
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const ready = once(server, 'listening');
  server.listen(port);
  await ready;
  return {
    setTLS(options) { server.setSecureContext(options); },
    close() {
      const done = new Promise(resolve => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      return done;
    }
  };
}

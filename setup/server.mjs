import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, open, link, rm, readdir } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const webDir = fileURLToPath(new URL('./web/', import.meta.url));
const maxBody = 1024 * 1024;
const fields = new Set(['bundleId', 'environment', 'host', 'port', 'certificate', 'privateKey',
  'voipCertificate', 'voipPrivateKey', 'serverCertificate', 'serverPrivateKey', 'pkcs12', 'pkcs12Password']);

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function setupToken(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, 'setup-token');
  let token;
  try {
    token = (await readFile(target, 'utf8')).trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const temporary = join(directory, '.setup-token-' + randomBytes(12).toString('hex'));
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(randomBytes(32).toString('base64url') + '\n');
      await handle.sync();
      await handle.close();
      try { await link(temporary, target); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    } finally {
      await handle.close();
      await rm(temporary, { force: true });
    }
  }
  token ??= (await readFile(target, 'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw Error('Invalid setup token file');
  return token;
}

function digest(value) { return createHash('sha256').update(value).digest(); }

async function inputFrom(request) {
  if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new RequestError(415, '请使用 JSON 提交配置');
  }
  if (Number(request.headers['content-length']) > maxBody) throw new RequestError(413, '配置文件过大');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBody) throw new RequestError(413, '配置文件过大');
    chunks.push(chunk);
  }
  let obj;
  try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new RequestError(400, 'JSON 格式无效'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new RequestError(400, '配置格式无效');
  for (const [key, value] of Object.entries(obj)) {
    if (!fields.has(key) || !(typeof value === 'string' || value === null || (key === 'port' && Number.isInteger(value)))) {
      throw new RequestError(400, '配置包含未知字段或类型错误');
    }
  }
  return obj;
}

// Send the export password on its own pipe. Neither it nor private PEM is a process argument.
async function unpackIdentity(bytes, password, legacy) {
  const args = ['pkcs12', '-nodes', '-clcerts', '-passin', 'fd:3'];
  if (legacy) args.push('-legacy');
  const child = spawn('openssl', args, {stdio: ['pipe', 'pipe', 'ignore', 'pipe']});
  const output = [];
  let size = 0;
  const complete = new Promise((done, fail) => {
    child.once('error', fail);
    child.once('close', code => done(code));
  });
  child.stdout.on('data', part => {
    size += part.length;
    if (size > maxBody) child.kill('SIGKILL');
    else output.push(part);
  });
  child.stdin.on('error', () => {});
  child.stdio[3].on('error', () => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  try {
    child.stdin.end(bytes);
    child.stdio[3].end(password + '\n');
    if (await complete !== 0) return null;
    return Buffer.concat(output).toString('ascii');
  } finally { clearTimeout(timer); }
}

export async function normalizeCredentials(input) {
  const {pkcs12, pkcs12Password, ...settings} = input;
  if (!pkcs12) {
    if (pkcs12Password) throw new RequestError(400, '请选择对应的 P12 文件');
    return settings;
  }
  if (settings.certificate || settings.privateKey || typeof pkcs12 !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(pkcs12) || /[\r\n\0]/.test(pkcs12Password || '')) {
    throw new RequestError(400, '请单独提供有效的 P12 文件及其密码');
  }
  const bytes = Buffer.from(pkcs12, 'base64');
  try {
    const pem = await unpackIdentity(bytes, pkcs12Password || '', false) ??
                await unpackIdentity(bytes, pkcs12Password || '', true);
    const certs = pem?.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    const keys = pem?.match(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g);
    if (certs?.length !== 1 || keys?.length !== 1) {
      throw new RequestError(400, '无法读取 P12。请核对导出密码，并选择仅含一套 APNs 证书与私钥的文件');
    }
    return {...settings, certificate: certs[0] + '\n', privateKey: keys[0] + '\n'};
  } finally { bytes.fill(0); }
}

const mediaTypes = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json',
  '.svg':'image/svg+xml', '.png':'image/png', '.woff2':'font/woff2', '.ico':'image/x-icon'};

async function assets(dir, prefix = '') {
  const files = new Map();
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    if (entry.name.startsWith('.')) continue;
    const url = prefix + '/' + entry.name;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of await assets(path, url)) files.set(key, value);
    } else if (entry.isFile() && mediaTypes[extname(path)]) {
      files.set(url, {body: await readFile(path), type: mediaTypes[extname(path)]});
    }
  }
  return files;
}

export async function createSetupServer({runtime, token, staticDir = webDir, suggestedHost = ''}) {
  const files = await assets(staticDir);
  const tokenDigest = digest('Bearer ' + token);
  function status() {
    const state = runtime.status();
    if (!state.configured && !state.host && isIPv4(suggestedHost) && !suggestedHost.startsWith('127.') && suggestedHost !== '0.0.0.0') {
      return {...state, host:suggestedHost};
    }
    return state;
  }
  let busy = false;
  return createServer({requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 8192}, async (req, res) => {
    function json(status, value) {
      res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
      res.end(JSON.stringify(value));
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'");
    try {
      const path = req.url?.split('?', 1)[0];
      if (!path?.startsWith('/api/')) {
        const asset = files.get(path === '/' ? '/index.html' : path);
        if (!asset || !['HEAD','GET'].includes(req.method)) throw new RequestError(404, '页面不存在');
        res.writeHead(200, {'Content-Type':asset.type});
        res.end(req.method === 'HEAD' ? undefined : asset.body);
        return;
      }
      if (!timingSafeEqual(tokenDigest, digest(req.headers.authorization || ''))) {
        throw new RequestError(401, '请输入安装时生成的配置令牌');
      }
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); } catch { throw new RequestError(403, '请求来源无效'); }
        if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
          throw new RequestError(403, '请求来源无效');
        }
      }
      if (req.method === 'GET' && path === '/api/status') return json(200, {ok:true, status:status()});
      if (req.method === 'GET' && path === '/api/ca') {
        const ca = await runtime.ca();
        if (!ca) throw new RequestError(404, '当前入口未使用向导生成的根证书');
        res.writeHead(200, {'Content-Type':'application/x-x509-ca-cert', 'Content-Disposition':'attachment; filename="AirSIM-Relay-CA.crt"'});
        res.end(ca);
        return;
      }
      if (req.method !== 'POST' || !['/api/apply','/api/validate'].includes(path)) throw new RequestError(404, '接口不存在');
      if (busy) throw new RequestError(409, '另一项配置操作正在执行，请稍后重试');
      busy = true;
      try {
        const input = await normalizeCredentials(await inputFrom(req));
        if (path === '/api/validate') {
          const verified = await runtime.validate(input);
          return json(200, {ok:true, status:status(), verified});
        }
        await runtime.apply(input);
        json(200, {ok:true, status:status()});
      } finally { busy = false; }
    } catch (err) {
      if (res.destroyed || res.headersSent) return;
      const message = String(err.message || '');
      const sensitive = /-----BEGIN|password=|DASHBOARD_TOKEN=|\r|\n/i.test(message);
      const code = err.status ?? err.statusCode;
      const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 400;
      json(status, {ok:false, error: sensitive || !message || message.length > 240 ? '配置校验或启动失败，请检查输入及容器状态' : message});
    }
  });
}

async function main() {
  process.umask(0o077);
  const {createRuntime} = await import('./runtime.mjs');
  const dataDir = resolve(process.env.AIRSIM_DATA_DIR || '/data');
  const runtime = createRuntime({dataDir, workerDir: resolve(process.env.AIRSIM_WORKER_DIR || 'push-relay-worker'),
    workerdPath: process.env.AIRSIM_WORKERD_PATH || 'workerd'});
  const token = await setupToken(dataDir);
  await runtime.initialize();
  const server = await createSetupServer({runtime, token, suggestedHost:process.env.AIRSIM_SUGGESTED_HOST});
  const host = process.env.AIRSIM_SETUP_HOST || '0.0.0.0';
  const port = Number(process.env.AIRSIM_SETUP_PORT || 18181);
  server.listen(port, host, () => console.info('AirSIM setup interface ready'));
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    server.close();
    try { await runtime.close(); } finally { process.exit(0); }
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('AirSIM setup could not start; check volume permissions, ports and installed files'); process.exitCode = 1; });
}

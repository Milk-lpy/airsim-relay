import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile, rename, copyFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadAPNsConfig } from '../push-relay-worker/self-hosted/apns-certificate.mjs';
import { createAPNsBridge } from '../push-relay-worker/self-hosted/apns-bridge.mjs';
import { generateConfig } from '../push-relay-worker/self-hosted/configure.mjs';
import { checkHost, copyRoot, preparePrivateTLS, readTLS, renewIfDue } from './tls.mjs';
import { openProxy } from './relay-proxy.mjs';

const trust = fileURLToPath(new URL('./trust/', import.meta.url));
const defaults = { bundleId: '', environment: 'sandbox', host: '', port: 18788,
  hasVoipCertificate: false, hasCustomTls: false };
const save = (path, data) => writeFile(path, data, { mode: 0o600 });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
function pairValues(input, certField, keyField, optional) {
  const cert = input[certField], key = input[keyField];
  if (optional && cert === null && key === null) return { clear: true };
  if (cert === null || key === null) throw new Error('清除证书时必须同时清除对应私钥');
  if ((cert !== undefined && typeof cert !== 'string') || (key !== undefined && typeof key !== 'string')) {
    throw new Error('证书和私钥必须是 PEM 文本');
  }
  if (!cert?.trim() && !key?.trim()) return {};
  if (!cert?.trim() || !key?.trim()) throw new Error('请同时提供证书及配套私钥');
  if (!cert.trimStart().startsWith('-----BEGIN CERTIFICATE-----') || cert.includes('PRIVATE KEY-----')) {
    throw new Error('证书字段需要 PEM 格式的公开证书');
  }
  if (!/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(key.trimStart())) throw new Error('请提供未加密的 PEM 私钥');
  return { cert: cert.trim() + '\n', key: key.trim() + '\n' };
}
async function stagePair(dir, previous, name, fields, required) {
  const cert = name + '.pem', key = name + '.key';
  if (fields.clear) return false;
  if (fields.cert) {
    await save(join(dir, cert), fields.cert);
    await save(join(dir, key), fields.key);
    return true;
  }
  if (previous) {
    try { await copyFile(join(previous, cert), join(dir, cert)); }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      if (!required) return false;
      throw new Error('请提供 APNs 证书和私钥');
    }
    await copyFile(join(previous, key), join(dir, key));
    return true;
  }
  if (required) throw new Error('请提供 APNs 证书和私钥');
  return false;
}

export function createRuntime({ dataDir, workerDir, workerdPath, trustDir = trust }) {
  dataDir = resolve(dataDir);
  workerDir = resolve(workerDir);
  // Bare command names come from PATH. Resolve relative executable paths before changing cwd.
  if (workerdPath.includes('/')) workerdPath = resolve(workerdPath);
  const versions = join(dataDir, 'configurations');
  const storage = join(dataDir, 'relay-db');
  const pointer = join(dataDir, 'installed.json');
  let current, services, busy = false, closed = false, problem = null;
  let operation, restartTimer, rotationTimer, maintenanceTimer;
  let retryMs = 1000;
  function status() {
    return { ...(current?.metadata || defaults), configured: Boolean(current), running: Boolean(services?.ready), lastError: problem };
  }
  async function prepare(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('配置格式无效');
    const host = checkHost(input.host);
    if (Number(input.port ?? 18788) !== 18788) throw new Error('当前 Relay TLS 端口为 18788');
    const environment = input.environment;
    if (!['sandbox','production'].includes(environment)) throw new Error('请选择 Sandbox 或 Production');
    const bundleId = input.bundleId;
    if (typeof bundleId !== 'string' || bundleId.length > 255 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new Error('Bundle ID 格式无效');
    const primary = pairValues(input, 'certificate', 'privateKey', false);
    const voip = pairValues(input, 'voipCertificate', 'voipPrivateKey', true);
    const tls = pairValues(input, 'serverCertificate', 'serverPrivateKey', true);
    const previous = current?.dir;
    const dir = await mkdtemp(join(versions, 'config-'));
    try {
      await stagePair(dir, previous, 'apns', primary, true);
      const hasVoipCertificate = await stagePair(dir, previous, 'voip', voip, false);
      for (const file of ['apple-roots.pem', 'apple-intermediates.pem']) await copyFile(join(trustDir, file), join(dir, file));
      const oldConfig = current && await json(join(previous, 'config.json'));
      const config = { APNS_AUTH_MODE: 'certificate', APNS_ENVIRONMENT: environment, APNS_BUNDLE_ID: bundleId,
        ALLOWED_BUNDLE_ID: bundleId, DASHBOARD_TOKEN: oldConfig?.DASHBOARD_TOKEN || randomBytes(32).toString('hex'),
        APNS_CERT_PATH: join(dir, 'apns.pem'), APNS_KEY_PATH: join(dir, 'apns.key') };
      if (hasVoipCertificate) Object.assign(config, { APNS_VOIP_CERT_PATH: join(dir, 'voip.pem'), APNS_VOIP_KEY_PATH: join(dir, 'voip.key') });
      await save(join(dir, 'config.json'), JSON.stringify(config));
      try { loadAPNsConfig(join(dir, 'config.json')); }
      catch (err) {
        if (err.message.startsWith('APNs ')) throw err;
        throw new Error('无法解析 APNs 证书或私钥，请检查 PEM 格式');
      }
      const hasRoot = previous && await copyRoot(previous, dir);
      const hasCustomTls = await stagePair(dir, current?.metadata.hasCustomTls ? previous : null, 'server', tls, false);
      if (!hasCustomTls) await preparePrivateTLS(dir, host, hasRoot);
      await readTLS(dir, host);
      const metadata = {bundleId, environment, host, port: 18788, hasVoipCertificate, hasCustomTls};
      await save(join(dir, 'metadata.json'), JSON.stringify(metadata));
      await save(join(dir, 'relay.capnp'), generateConfig({config, dataDir: storage}));
      return {dir, metadata};
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      throw err;
    }
  }

  async function stop() {
    clearTimeout(restartTimer);
    clearTimeout(rotationTimer);
    clearTimeout(maintenanceTimer);
    const set = services;
    services = null;
    if (!set) return;
    set.stopping = true;
    if (set.proxy) await set.proxy.close();
    if (set.bridge?.server.listening) await set.bridge.close();
    if (set.child?.pid && set.child.exitCode === null && set.child.signalCode === null) {
      const exited = new Promise(resolve => set.child.once('exit', resolve));
      set.child.kill('SIGTERM');
      const timer = setTimeout(() => set.child.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(timer); }
    }
  }

  function exclusive(fn) {
    if (closed || busy) throw Object.assign(new Error('配置正在应用，请稍后重试'), {status:409});
    busy = true;
    operation = Promise.resolve().then(fn).finally(() => { busy = false; });
    return operation;
  }
  function scheduleRestart() {
    if (closed || !current) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (busy) { scheduleRestart(); return; }
      exclusive(async () => {
        await stop();
        try { await start(current); problem = null; }
        catch { problem = 'Relay 启动失败，正在重试'; retryMs = Math.min(30_000, 2 * retryMs); scheduleRestart(); }
      }).catch(() => {});
    }, retryMs);
    restartTimer.unref();
  }
  function scheduleRotation(version, set) {
    if (version.metadata.hasCustomTls || closed) return;
    rotationTimer = setTimeout(() => {
      if (services !== set || closed) return;
      if (busy) { scheduleRotation(version, set); return; }
      exclusive(async () => {
        try {
          if (await renewIfDue(version.dir, version.metadata.host)) {
            set.proxy.setTLS(await readTLS(version.dir, version.metadata.host));
          }
          problem = null;
        } catch { problem = '自动 TLS 证书续签失败'; }
        if (services === set) scheduleRotation(version, set);
      }).catch(() => {});
    }, 12 * 3600 * 1000);
    rotationTimer.unref();
  }
  function scheduleMaintenance(set, config, after = 1000) {
    const day = 24 * 3600 * 1000;
    maintenanceTimer = setTimeout(async () => {
      if (closed || services !== set || !set.ready) return;
      const expiry = Math.min(config.alert.notAfter, config.voip.notAfter);
      if (expiry - Date.now() <= 30 * day) {
        console.warn('AirSIM APNs certificate expires ' + new Date(expiry).toISOString());
      }
      const marker = join(dataDir, 'last-retention.json');
      let next = day;
      try {
        let last = 0;
        try { last = Number(await json(marker)); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
        if (!Number.isFinite(last) || last + day <= Date.now() || last > Date.now()) {
          const response = await fetch('http://127.0.0.1:8789/scheduled', {
            method: 'POST', signal: AbortSignal.timeout(120000),
          });
          if (!response.ok) throw new Error('retention failed');
          await response.arrayBuffer();
          await save(marker, JSON.stringify(Date.now()));
        } else {
          next = last + day - Date.now();
        }
      } catch { console.error('AirSIM retention task failed'); next = 3600 * 1000; }
      if (!closed && services === set) scheduleMaintenance(set, config, Math.max(next, 1000));
    }, after);
    maintenanceTimer.unref();
  }
  async function start(version) {
    const set = { ready: false, stopping: false };
    services = set;
    try {
      if (!version.metadata.hasCustomTls) await renewIfDue(version.dir, version.metadata.host);
      const credentials = await readTLS(version.dir, version.metadata.host);
      const config = loadAPNsConfig(join(version.dir, 'config.json'));
      set.bridge = createAPNsBridge({config});
      const listening = once(set.bridge.server, 'listening');
      set.bridge.server.listen(8790, '127.0.0.1');
      await listening;
      // Regenerate on boot too, so installing a newer image actually loads its worker sources.
      await save(join(version.dir, 'relay.capnp'), generateConfig({ config: await json(join(version.dir, 'config.json')), dataDir: storage }));
      const child = spawn(workerdPath, ['serve', join(version.dir, 'relay.capnp')], {
        cwd: workerDir, stdio: 'ignore', env: { PATH: process.env.PATH || '/usr/bin:/bin' },
      });
      set.child = child;
      let failed = false;
      child.on('error', () => { failed = true; });
      child.once('exit', () => {
        failed = true;
        if (set.ready && !set.stopping && services === set && !closed) {
          set.ready = false; problem = 'Relay 进程已退出，正在重新启动'; scheduleRestart();
        }
      });
      let healthy = false;
      for (let i = 0; i < 100 && !failed; i++) {
        try {
          const req = await fetch('http://127.0.0.1:8787/healthz', {signal: AbortSignal.timeout(350)});
          healthy = req.ok && (await req.json()).service === 'airsim-push-relay';
        } catch {}
        if (healthy) break;
        await delay(100);
      }
      if (!healthy || failed) throw new Error('workerd 未能启动，请检查版本、数据目录与内部端口');
      set.proxy = await openProxy(version.metadata, credentials);
      if (failed) throw new Error('workerd 已意外退出');
      set.ready = true;
      retryMs = 1000;
      scheduleRotation(version, set);
      scheduleMaintenance(set, config);
    } catch (err) {
      await stop();
      throw err;
    }
  }
  async function pruneExcept(names) {
    const keep = new Set(names);
    for (const item of await readdir(versions, {withFileTypes:true})) {
      if (item.isDirectory() && /^config-[a-zA-Z0-9]{6}$/.test(item.name) && !keep.has(item.name)) {
        await rm(join(versions, item.name), {recursive: true, force: true});
      }
    }
  }
  return {
    status,
    async ca() {
      return current && !current.metadata.hasCustomTls ? readFile(join(current.dir, 'ca.pem')) : null;
    },
    async initialize() {
      return exclusive(async () => {
        if (current) return status();
        await mkdir(versions, { recursive: true, mode: 0o700 });
        await mkdir(storage, { recursive: true, mode: 0o700 });
        let saved;
        try { saved = await json(pointer); }
        catch (err) {
          if (err.code !== 'ENOENT') throw err;
          await pruneExcept([]);
          return status();
        }
        if (!/^config-[a-zA-Z0-9]{6}$/.test(saved.active)) throw new Error('配置索引无效');
        const dir = join(versions, saved.active);
        current = {dir, metadata: await json(join(dir, 'metadata.json'))};
        await pruneExcept([saved.active, saved.previous]);
        try { await start(current); }
        catch { problem = '已保存的配置启动失败，请检查证书有效期及数据目录'; scheduleRestart(); }
        return status();
      });
    },
    async validate(input) {
      return exclusive(async () => {
        const candidate = await prepare(input);
        try { return {...candidate.metadata, valid:true}; }
        finally { await rm(candidate.dir, {recursive:true, force:true}); }
      });
    },
    async apply(input) {
      return exclusive(async () => {
        const candidate = await prepare(input);
        const previous = current;
        await stop();
        const tmp = join(dataDir, 'installed.next');
        const active = basename(candidate.dir), prior = previous && basename(previous.dir);
        try {
          await start(candidate);
          await save(tmp, JSON.stringify({active, previous: prior || null}));
          await rename(tmp, pointer);
        } catch (err) {
          await stop();
          if (previous) {
            try { await start(previous); problem = null; }
            catch { problem = '原配置恢复启动失败，请检查服务状态'; scheduleRestart(); }
          }
          await rm(candidate.dir, {recursive:true, force:true});
          await rm(tmp, {force:true});
          throw err;
        }
        current = candidate;
        problem = null;
        // A cleanup error after committing the pointer must not misreport a failed apply.
        try { await pruneExcept([active, prior]); }
        catch { problem = '配置已应用，旧配置目录清理失败'; }
        return status();
      });
    },
    async close() {
      closed = true;
      await operation?.catch(() => {});
      await stop();
    }
  };
}

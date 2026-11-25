import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createRuntime } from '../runtime.mjs';
import { fixture } from '../../push-relay-worker/self-hosted/test/certificate-fixture.mjs';

const workerDir = fileURLToPath(new URL('../../push-relay-worker', import.meta.url));

async function setup(t, workerdPath) {
  const certs = fixture();
  t.after(() => rm(certs.dir, {recursive:true, force:true}));
  const dataDir = await mkdtemp(join(tmpdir(), 'airsim-setup-test-'));
  t.after(() => rm(dataDir, {recursive:true, force:true}));
  const options = {dataDir, workerDir, workerdPath, trustDir:certs.dir};
  const runtime = createRuntime(options);
  await runtime.initialize();
  const input = {
    host:'127.0.0.1', port:18788, bundleId:certs.config.APNS_BUNDLE_ID, environment:'sandbox',
    certificate:await readFile(certs.file('apns.pem'), 'utf8'),
    privateKey:await readFile(certs.file('apns.key'), 'utf8'),
  };
  return {options, runtime, input, certs};
}

test('validates APNs, host and TLS before switching or saving credentials', async t => {
  const {runtime, input, options, certs} = await setup(t, '/bin/false');
  try {
    assert.equal(runtime.status().configured, false);
    assert.equal(await runtime.ca(), null);
    const custom = {
      serverCertificate: await readFile(certs.file('server.pem'), 'utf8'),
      serverPrivateKey: await readFile(certs.file('server.key'), 'utf8'),
    };
    assert.equal((await runtime.validate({...input, ...custom})).hasCustomTls, true);
    await assert.rejects(runtime.validate({...input, host:'https://127.0.0.1:18788'}), /主机名/);
    await assert.rejects(runtime.validate({...input, ...custom, host:'elsewhere.example'}), /SAN/);
    await assert.rejects(runtime.validate({...input, privateKey:custom.serverPrivateKey}), /match/);
    await assert.rejects(runtime.validate({...input, bundleId:'com.other.airsim'}), /topic/);
    await assert.rejects(runtime.validate({...input, voipCertificate:null}), /同时/);
    await assert.rejects(runtime.validate({...input, port:443}), /18788/);
    assert.deepEqual(await readdir(join(options.dataDir, 'configurations')), []);
  } finally { await runtime.close(); }
});

function call(ca, path, body) {
  return new Promise((resolve, reject) => {
    const req = request({host:'127.0.0.1', port:18788, ca, path, method:body ? 'POST' : 'GET',
      checkServerIdentity:(_, peer) => checkServerIdentity('127.0.0.1', peer),
      headers:{'content-type':'application/json', host:'incorrect.invalid', 'x-forwarded-proto':'http'}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({status: res.statusCode, body: Buffer.concat(chunks).toString()}));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

// Opt in on a test machine or in a dedicated network namespace. This exercises the fixed
// container ports with a real workerd subprocess and never sends real APNs notifications.
test('TLS/WSS, retained registrations, certificate changes, failed apply and cold restart',
  {skip: !process.env.AIRSIM_TEST_WORKERD, timeout: 90_000}, async t => {
    const {runtime, input, options, certs} = await setup(t, process.env.AIRSIM_TEST_WORKERD);
    // This wrapper gives a single deterministic failed start. The old config then starts normally.
    const wrapper = join(options.dataDir, 'run-worker');
    await writeFile(wrapper, '#!/bin/sh\nif [ -e "$0.fail" ]; then rm "$0.fail"; exit 1; fi\nexec "$0.bin" "$@"\n');
    await chmod(wrapper, 0o700);
    await symlink(options.workerdPath, wrapper + '.bin');
    await runtime.close();
    const managed = createRuntime({...options, workerdPath:wrapper});
    await managed.initialize();
    try {
      await managed.apply(input);
      const ca = await managed.ca();
      assert.match(ca.toString(), /BEGIN CERTIFICATE/);
      const caPath = join(options.dataDir, 'trusted-for-test.pem');
      await writeFile(caPath, ca);
      const auth = {device_id:'test-' + randomUUID(), device_secret:randomUUID()};
      assert.equal((await call(ca, '/healthz')).status, 200);
      assert.equal((await call(ca, '/dashboard')).status, 404);
      assert.equal((await call(ca, '/v1/devices/register', {...auth, voip_token:'a'.repeat(64),
        bundle_id: input.bundleId, environment:'sandbox', relay_url:'https://127.0.0.1:18788'})).status, 200);
      assert.equal((await call(ca, '/v1/events/heartbeat', {...auth, event:'agent_heartbeat', agent_id:'synthetic',
        at_ok:true, cellular_state:'registered'})).status, 202);
      const queued = await call(ca, '/v2/commands/enqueue', {...auth, command_id:randomUUID(), type:'dial',
        number:'123456', target_agent_id:'synthetic'});
      assert.equal(queued.status, 202);
      const {call:relayCall} = JSON.parse(queued.body);
      assert.equal(new URL(relayCall.media_url).origin, 'wss://127.0.0.1:18788');
      const url = new URL(relayCall.media_url);
      url.searchParams.set('token', relayCall.call_secret);
      // Pass the short-lived test media token on stdin, and trust only the test CA in this child.
      const runner = promisify(execFile);
      const script = fileURLToPath(new URL('../test-fixtures/media-roundtrip.mjs', import.meta.url));
      const result = runner(process.execPath, [script], {timeout:10000,
        env:{...process.env, NODE_EXTRA_CA_CERTS:caPath}});
      result.child.stdin.end(url.href);
      await result;
      const {certificate, privateKey, ...retained} = input;
      await writeFile(wrapper + '.fail', '');
      await assert.rejects(managed.apply({...retained, environment:'production'}), /workerd/);
      assert.equal(managed.status().environment, 'sandbox');
      assert.equal(managed.status().running, true);
      assert.equal((await call(ca, '/v1/devices/status', auth)).status, 200);
      const custom = await managed.apply({...retained, voipCertificate:certificate, voipPrivateKey:privateKey,
        serverCertificate:await readFile(certs.file('server.pem'), 'utf8'),
        serverPrivateKey:await readFile(certs.file('server.key'), 'utf8')});
      assert.equal(custom.hasCustomTls, true);
      assert.equal(custom.hasVoipCertificate, true);
      assert.equal(await managed.ca(), null);
      const cleared = await managed.apply({...retained, certificate:'', privateKey:'', voipCertificate:null,
        voipPrivateKey:null, serverCertificate:null, serverPrivateKey:null});
      assert.equal(cleared.hasCustomTls, false);
      assert.equal(cleared.hasVoipCertificate, false);
      assert.deepEqual(await managed.ca(), ca);
      assert.equal((await call(ca, '/v1/devices/status', auth)).status, 200);
      await managed.close();
      const restored = createRuntime(options);
      try {
        assert.equal((await restored.initialize()).running, true);
        assert.equal((await call(ca, '/v1/devices/status', auth)).status, 200);
      } finally { await restored.close(); }
    } finally { await managed.close(); }
  });

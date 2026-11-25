import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { createSetupServer, normalizeCredentials, setupToken } from '../server.mjs';
import { fixture } from '../../push-relay-worker/self-hosted/test/certificate-fixture.mjs';

test('parallel first starts and restarts retain one private setup token', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'airsim-wizard-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const results = await Promise.all(Array.from({length:8}, () => setupToken(dir)));
  assert.equal(new Set(results).size, 1);
  assert.equal(await setupToken(dir), results[0]);
  assert.equal((await stat(join(dir,'setup-token'))).mode & 0o777, 0o600);
});

test('wizard protects private endpoints and serializes configuration changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'airsim-assets-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  await writeFile(join(dir, 'index.html'), '<main>AirSIM</main>');
  await writeFile(join(dir, 'private.key'), 'excluded');
  const token = randomBytes(32).toString('hex');
  const state = {configured:false};
  let finish, applied;
  const pending = new Promise(resolve => { applied = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const server = await createSetupServer({token, staticDir:dir, runtime:{
    status() { return state; },
    async validate() { return {valid:true}; },
    async apply() { applied(); await gate; state.configured = true; },
    async ca() { return state.configured ? Buffer.from('public root') : null; }
  }});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { finish(); server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = {authorization:'Bearer ' + token, 'content-type':'application/json'};
  const send = (path, body, extra = {}) => fetch(base + path, {method:'POST', headers:{...headers, ...extra}, body:JSON.stringify(body)});
  const home = await fetch(base + '/?display=setup');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(base + '/private.key')).status, 404);
  assert.equal((await fetch(base + '/api/status?token=' + token)).status, 401);
  assert.equal((await fetch(base + '/api/status', {headers:{authorization:'Bearer wrong'}})).status, 401);
  assert.equal((await fetch(base + '/api/ca', {headers})).status, 404);
  assert.equal((await send('/api/validate', {}, {origin:'https://other.invalid'})).status, 403);
  assert.equal((await send('/api/validate', {}, {'content-type':'text/plain'})).status, 415);
  assert.equal((await send('/api/apply', {trustDir:'/tmp'})).status, 400);
  assert.equal((await send('/api/validate', {host:'x'.repeat(1024 * 1024)})).status, 413);
  const checked = await send('/api/validate', {pkcs12Password:'', privateKey:'sensitive-test-value'}, {origin:base});
  assert.deepEqual(await checked.json(), {ok:true, verified:{valid:true}, status:{configured:false}});
  const write = send('/api/apply', {});
  try { await pending; assert.equal((await send('/api/apply', {})).status, 409); }
  finally { finish(); }
  assert.equal((await write).status, 200);
  const ca = await fetch(base + '/api/ca', {headers});
  assert.match(ca.headers.get('content-disposition'), /AirSIM-Relay-CA.crt/);
  assert.equal(await ca.text(), 'public root');
  assert.deepEqual(await (await fetch(base + '/api/status', {headers})).json(), {ok:true,status:{configured:true}});
});

test('P12 conversion preserves the matching identity and discards the password', async t => {
  const f = fixture();
  t.after(() => rm(f.dir, {recursive:true, force:true}));
  const password = randomBytes(15).toString('hex');
  const pkcs12 = execFileSync('openssl', ['pkcs12','-export','-inkey',f.file('apns.key'),'-in',f.file('apns.pem'),'-passout','stdin'],
    {input:password + '\n', stdio:['pipe','pipe','pipe']}).toString('base64');
  const result = await normalizeCredentials({pkcs12, pkcs12Password:password, host:'localhost'});
  assert.deepEqual(Object.keys(result).sort(), ['certificate','host','privateKey']);
  assert.ok(new X509Certificate(result.certificate).checkPrivateKey(createPrivateKey(result.privateKey)));
  await assert.rejects(normalizeCredentials({pkcs12, pkcs12Password:'wrong-test-password'}), /无法读取 P12/);
  await assert.rejects(normalizeCredentials({pkcs12, certificate:result.certificate}), /单独/);
});

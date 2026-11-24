import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { once } from 'node:events';
import { readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createAPNsBridge } from '../apns-bridge.mjs';
import { loadAPNsConfig, loadCredential, assertCurrent, ORIGINS } from '../apns-certificate.mjs';
import { fixture } from './certificate-fixture.mjs';
const f = fixture(); after(() => rmSync(f.dir,{recursive:true,force:true}));
const config = loadAPNsConfig(f.file('config.json'));
const token = 'a'.repeat(64);
const headers = (type='voip') => ({'x-airsim-apns-origin':config.origin, authorization:'bearer MUST-NOT-FORWARD', 'apns-topic':config.bundle+(type==='voip'?'.voip':''),'apns-push-type':type});
async function listen(server) { server.listen(0,'127.0.0.1'); await once(server,'listening'); return server.address().port; }
async function mock(t, handler, override={}) {
  const up=http2.createServer(); up.on('stream',handler); const port=await listen(up);
  const bridge=createAPNsBridge({config,sleep:async()=>{},connect:(origin,options)=>{
    assert.equal(origin,config.origin);assert.equal(options.rejectUnauthorized,true);assert.equal(options.minVersion,'TLSv1.2');assert.ok(options.key);assert.ok(options.cert);
    return http2.connect(`http://127.0.0.1:${port}`);
  },...override});
  const local=await listen(bridge.server);
  t.after(async()=>{await bridge.close();await new Promise(r=>up.close(r));});
  return `http://127.0.0.1:${local}/3/device/${token}`;
}
test('certificate chain, key, EKU, topic extension, environment and expiry checked before use',()=>{
  assert.ok(config.alert.topics.get(config.bundle).has('topic'));
  assert.ok(config.voip.topics.get(config.bundle+'.voip').has('voip'));
  assert.throws(()=>loadCredential(f.file('apns.pem'),f.file('server.key'),'production'),/do not match/);
  assert.throws(()=>loadCredential(f.file('apns.pem'),f.file('apns.key'),'invalid'),/environment/);
  assert.throws(()=>assertCurrent(config.alert,config.alert.notAfter+1),/expired/);
  assert.throws(()=>assertCurrent(config.alert,config.alert.notBefore-1),/not yet valid/);
  assert.throws(()=>loadAPNsConfig('/definitely/missing'),/ENOENT/);
});
test('configuration rejects JWT fallback, mismatched bundles, and certificates missing VoIP authorization',()=>{
 const file=f.file('negative-config.json');
 const load=value=>{writeFileSync(file,JSON.stringify({...f.config,...value}));return loadAPNsConfig(file);};
 assert.throws(()=>load({APNS_AUTH_MODE:'token'}),/JWT fallback is disabled/);
 assert.throws(()=>load({APNS_BUNDLE_ID:'com.wrong.app'}),/must match/);
 assert.throws(()=>load({APNS_BUNDLE_ID:'com.wrong.app',ALLOWED_BUNDLE_ID:'com.wrong.app'}),/alert topic/);
 assert.throws(()=>load({APNS_VOIP_CERT_PATH:f.file('apns.pem')}),/paths are required/);
 assert.equal(load({APNS_ENVIRONMENT:'sandbox'}).origin,ORIGINS.sandbox);
 const utf=text=>Buffer.concat([Buffer.from([12,Buffer.byteLength(text)]),Buffer.from(text)]);
 const topicType=utf('topic');const fields=Buffer.concat([utf(config.bundle),Buffer.from([48,topicType.length]),topicType]);
 const ext=readFileSync(f.file('client.ext'),'utf8').replace(/1\.2\.840\.113635\.100\.6\.3\.6=DER:.*\n/,`1.2.840.113635.100.6.3.6=DER:${Buffer.concat([Buffer.from([48,fields.length]),fields]).toString('hex')}\n`);
 writeFileSync(f.file('no-voip.ext'),ext);
 execFileSync('openssl',['x509','-req','-in',f.file('apns.csr'),'-CA',f.file('apple-roots.pem'),'-CAkey',f.file('ca.key'),'-CAcreateserial','-out',f.file('no-voip.pem'),'-days','1','-extfile',f.file('no-voip.ext')],{stdio:'pipe'});
 assert.throws(()=>load({APNS_VOIP_CERT_PATH:f.file('no-voip.pem'),APNS_VOIP_KEY_PATH:f.file('apns.key')}),/VoIP Services Certificate/);
});
test('APNs bridge starts through release symlink with certificate configuration',async t=>{
  const link=f.file('apns-bridge.mjs');symlinkSync(resolve('apns-bridge.mjs'),link);
  const child=spawn(process.execPath,[link],{env:{...process.env,AIRSIM_CONFIG_FILE:f.file('config.json'),APNS_BRIDGE_PORT:'0'},stdio:'pipe'});
  let output='';child.stdout.on('data',b=>output+=b);
  t.after(async()=>{if(child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}});
  for(let i=0;i<100;i++){if(output.includes('apns_ready'))return;assert.equal(child.exitCode,null);await delay(20);}assert.fail('APNs bridge did not start');
});
for(const [status,reason] of [[200,null],[400,'BadDeviceToken'],[403,'TopicDisallowed'],[410,'Unregistered']]) {
 test(`HTTP ${status} preserved without replay and without JWT`,async t=>{
  let count=0;
  const url=await mock(t,(stream,h)=>{
    count++;assert.equal(h.authorization,undefined);assert.equal(h['x-airsim-apns-origin'],undefined);assert.equal(h['apns-topic'],config.bundle+'.voip');
    stream.on('data',()=>{});stream.on('end',()=>{stream.respond({':status':status,'apns-id':'synthetic-id'});stream.end(reason?JSON.stringify({reason,timestamp:123}):'');});
  });
  const response=await fetch(url,{method:'POST',headers:headers(),body:'{"aps":{}}'});
  assert.equal(response.status,status);assert.equal(response.headers.get('apns-id'),'synthetic-id');
  if(reason)assert.equal((await response.json()).reason,reason);
  assert.equal(count,1);
 });
}
test('only explicit retryable HTTP responses retried with bounded attempts',async t=>{
 let count=0;const url=await mock(t,s=>{count++;s.on('data',()=>{});s.on('end',()=>{s.respond({':status':503});s.end('{"reason":"ServiceUnavailable"}');});});
 assert.equal((await fetch(url,{method:'POST',headers:headers(),body:'{}'})).status,503);assert.equal(count,3);
});
test('sandbox/production, topic, push type, payload and destination boundaries enforced',async t=>{
 let count=0;const url=await mock(t,s=>{count++;s.on('data',()=>{});s.on('end',()=>{s.respond({':status':200});s.end();});});
 for(const e of ['sandbox','http://169.254.169.254']) {
  assert.equal((await fetch(url,{method:'POST',headers:{...headers(),'x-airsim-apns-origin':ORIGINS[e]||e}})).status,400);
 }
 assert.equal((await fetch(url,{method:'POST',headers:{...headers(),'apns-topic':'com.wrong.voip'}})).status,403);
 assert.equal((await fetch(url,{method:'POST',headers:{...headers(),'apns-push-type':'liveactivity'}})).status,403);
 assert.equal((await fetch(url,{method:'POST',headers:headers(),body:'x'.repeat(4097)})).status,413);
 assert.equal((await fetch(url,{method:'POST',headers:headers('alert'),body:'{}'})).status,200);
 assert.equal((await fetch(url,{method:'POST',headers:{...headers('background'),'apns-priority':'5'},body:'{}'})).status,200);
 assert.equal((await fetch(url,{method:'POST',headers:{...headers('background'),'apns-topic':config.bundle+'.voip'},body:'{}'})).status,403);
 assert.equal(count,2);
});
test('ambiguous transport failure never retried',async t=>{
 let count=0;const url=await mock(t,s=>{count++;s.on('error',()=>{});s.session.destroy();});
 assert.equal((await fetch(url,{method:'POST',headers:headers(),body:'{}'})).status,502);assert.equal(count,1);
});
test('real HTTP/2 mutual TLS presents client certificate and verifies server certificate',async t=>{
 let count=0;
 const up=http2.createSecureServer({key:readFileSync(f.file('server.key')),cert:readFileSync(f.file('server.pem')),ca:readFileSync(f.file('apple-roots.pem')),requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'});
 up.on('stream',(s,h)=>{count++;assert.equal(s.session.socket.authorized,true);assert.equal(s.session.socket.alpnProtocol,'h2');assert.equal(h.authorization,undefined);s.on('data',()=>{});s.on('end',()=>{s.respond({':status':200});s.end();});});
 const port=await listen(up);
 const bridge=createAPNsBridge({config,connect:(_,options)=>http2.connect(`https://127.0.0.1:${port}`,{...options,servername:'localhost',ca:readFileSync(f.file('apple-roots.pem'))})});
 const local=await listen(bridge.server);
 t.after(async()=>{await bridge.close();await new Promise(r=>up.close(r));});
 assert.equal((await fetch(`http://127.0.0.1:${local}/3/device/${token}`,{method:'POST',headers:headers(),body:'{}'})).status,200);assert.equal(count,1);
 const bad=createAPNsBridge({config,connect:(_,options)=>http2.connect(`https://127.0.0.1:${port}`,{...options,servername:'localhost'})});const bp=await listen(bad.server);
 try{assert.equal((await fetch(`http://127.0.0.1:${bp}/3/device/${token}`,{method:'POST',headers:headers(),body:'{}'})).status,502);assert.equal(count,1);}finally{await bad.close();}
});

test('timed-out cached session is discarded; next push opens a fresh session without replay',async t=>{
 let requests=0,connections=0;
 const upstream=http2.createServer();
 upstream.on('stream',stream=>{
  requests++;stream.on('error',()=>{});stream.on('data',()=>{});
  if(requests===1)return;
  stream.on('end',()=>{stream.respond({':status':400});stream.end('{"reason":"BadDeviceToken"}');});
 });
 const port=await listen(upstream);
 const bridge=createAPNsBridge({config,requestTimeoutMs:100,connect:()=>{
  connections++;return http2.connect(`http://127.0.0.1:${port}`);
 }});
 const local=await listen(bridge.server);
 t.after(async()=>{await bridge.close();await new Promise(r=>upstream.close(r));});
 const url=`http://127.0.0.1:${local}/3/device/${token}`;
 assert.equal((await fetch(url,{method:'POST',headers:headers(),body:'{}'})).status,502);
 assert.equal(requests,1,'ambiguous first push must not be replayed');
 const second=await fetch(url,{method:'POST',headers:headers(),body:'{}'});
 assert.equal(second.status,400);assert.equal((await second.json()).reason,'BadDeviceToken');
 assert.equal(connections,2);assert.equal(requests,2);
});

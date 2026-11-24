import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const run = args => execFileSync('openssl', args, { stdio: 'pipe' });
const tlv = (tag, value) => { const b = Buffer.from(value); return Buffer.concat([Buffer.from([tag, ...(b.length < 128 ? [b.length] : [0x81,b.length])]), b]); };
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'airsim-apns-cert-test-'));
  const file = n => join(dir, n);
  const bundle = 'com.example.airsim';
  const topic = (name,type) => Buffer.concat([tlv(12,Buffer.from(name)),tlv(48,tlv(12,Buffer.from(type)))]);
  const topics = tlv(48,Buffer.concat([topic(bundle,'topic'),topic(bundle+'.voip','voip')]));
  writeFileSync(file('client.ext'), `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n1.2.840.113635.100.6.3.6=DER:${topics.toString('hex')}\n1.2.840.113635.100.6.3.1=DER:05:00\n1.2.840.113635.100.6.3.2=DER:05:00\n`);
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',file('ca.key'),'-out',file('apple-roots.pem'),'-subj','/CN=AirSIM TEST CA','-days','2','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign']);
  writeFileSync(file('apple-intermediates.pem'),readFileSync(file('apple-roots.pem')));
  run(['req','-new','-newkey','rsa:2048','-nodes','-keyout',file('apns.key'),'-out',file('apns.csr'),'-subj','/CN=AirSIM TEST client']);
  run(['x509','-req','-in',file('apns.csr'),'-CA',file('apple-roots.pem'),'-CAkey',file('ca.key'),'-CAcreateserial','-out',file('apns.pem'),'-days','1','-extfile',file('client.ext')]);
  writeFileSync(file('server.ext'),'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run(['req','-new','-newkey','rsa:2048','-nodes','-keyout',file('server.key'),'-out',file('server.csr'),'-subj','/CN=localhost']);
  run(['x509','-req','-in',file('server.csr'),'-CA',file('apple-roots.pem'),'-CAkey',file('ca.key'),'-CAcreateserial','-out',file('server.pem'),'-days','1','-extfile',file('server.ext')]);
  const config = { APNS_AUTH_MODE:'certificate', APNS_ENVIRONMENT:'production',APNS_BUNDLE_ID:bundle,ALLOWED_BUNDLE_ID:bundle,APNS_CERT_PATH:file('apns.pem'),APNS_KEY_PATH:file('apns.key') };
  writeFileSync(file('config.json'),JSON.stringify(config));
  return { dir,file,config };
}

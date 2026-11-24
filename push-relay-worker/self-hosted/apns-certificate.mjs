import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { X509Certificate, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const ORIGINS = Object.freeze({ production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' });
const OIDS = { topics4: '2a864886f76364060304', topics6: '2a864886f76364060306', sandbox: '2a864886f76364060301', production: '2a864886f76364060302' };
function der(buffer) {
  const result = [];
  for (let p = 0; p < buffer.length;) {
    const tag = buffer[p++]; let length = buffer[p++];
    if (length === undefined) throw new Error('APNs certificate DER truncated');
    if (length & 128) {
      const count = length & 127;
      if (!count || count > 4 || p + count > buffer.length) throw new Error('APNs certificate DER length invalid');
      length = buffer.readUIntBE(p, count); p += count;
    }
    if (p + length > buffer.length) throw new Error('APNs certificate DER truncated');
    result.push({ tag, data: buffer.subarray(p, p + length) }); p += length;
  }
  return result;
}
export function certificateCapabilities(cert) {
  const outer = der(cert.raw);
  const tbs = der(outer[0].data)[0];
  const ext = der(tbs.data).find(n => n.tag === 0xa3);
  if (!ext) throw new Error('APNs certificate has no extensions');
  const extensions = new Map(der(der(ext.data)[0].data).map(n => {
    const fields = der(n.data);
    return [fields[0].data.toString('hex'), fields.at(-1).data];
  }));
  const topics = new Map();
  for (const oid of [OIDS.topics4, OIDS.topics6]) {
    const raw = extensions.get(oid); if (!raw) continue;
    const fields = der(der(raw)[0].data);
    for (let i = 0; i < fields.length; i += 2) {
      if (fields[i]?.tag !== 12 || fields[i + 1]?.tag !== 48) throw new Error('APNs topic extension invalid');
      const types = der(fields[i + 1].data);
      if (types.some(n => n.tag !== 12)) throw new Error('APNs topic types invalid');
      const topic = fields[i].data.toString('utf8');
      topics.set(topic, new Set([...(topics.get(topic) || []), ...types.map(n => n.data.toString('utf8'))]));
    }
  }
  return { topics, environments: new Set(['sandbox', 'production'].filter(e => extensions.has(OIDS[e]))),
    topicOIDs: [OIDS.topics4, OIDS.topics6].filter(o => extensions.has(o)).map(o => o === OIDS.topics4 ? '1.2.840.113635.100.6.3.4' : '1.2.840.113635.100.6.3.6') };
}
export function assertCurrent(credential, now = Date.now()) {
  if (now < credential.notBefore || now >= credential.notAfter) throw new Error('APNs certificate expired or not yet valid');
}
export function loadCredential(certPath, keyPath, environment, now = Date.now()) {
  if (!certPath || !keyPath) throw new Error('APNs certificate/key paths are required');
  const certPEM = readFileSync(certPath, 'utf8'), keyPEM = readFileSync(keyPath, 'utf8');
  const cert = new X509Certificate(certPEM), key = createPrivateKey(keyPEM);
  const spki = publicKey => publicKey.export({ type: 'spki', format: 'der' });
  const a = spki(cert.publicKey), b = spki(createPublicKey(key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('APNs certificate and private key do not match');
  if (!cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2')) throw new Error('APNs certificate lacks clientAuth EKU');
  const credential = { cert, certPath, keyPath, notBefore: Date.parse(cert.validFrom), notAfter: Date.parse(cert.validTo),
    ...certificateCapabilities(cert) };
  assertCurrent(credential, now);
  if (!credential.environments.has(environment)) throw new Error('APNs certificate does not authorize configured environment');
  // The Apple root is installed separately with a pinned public fingerprint.
  // Never use this file to replace Node's APNs SERVER trust store.
  const roots = join(dirname(certPath), 'apple-roots.pem');
  const intermediates = join(dirname(certPath), 'apple-intermediates.pem');
  try {
    execFileSync('openssl', ['verify', '-purpose', 'sslclient', '-CAfile', roots, '-untrusted', intermediates, certPath], { stdio: 'pipe', timeout: 5000 });
  } catch { throw new Error('APNs provider certificate chain verification failed'); }
  credential.tls = { cert: certPEM + '\n' + readFileSync(intermediates, 'utf8'), key: keyPEM,
    minVersion: 'TLSv1.2', rejectUnauthorized: true, ALPNProtocols: ['h2'] };
  return credential;
}
export function loadAPNsConfig(path = process.env.AIRSIM_CONFIG_FILE || '/etc/airsim-relay/config.json') {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (config.APNS_AUTH_MODE !== 'certificate') throw new Error('APNS_AUTH_MODE must be certificate; JWT fallback is disabled');
  const bundle = config.APNS_BUNDLE_ID, environment = config.APNS_ENVIRONMENT;
  if (!bundle || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundle) || bundle !== config.ALLOWED_BUNDLE_ID) throw new Error('APNS_BUNDLE_ID must match ALLOWED_BUNDLE_ID');
  if (!ORIGINS[environment]) throw new Error('APNS_ENVIRONMENT must be production or sandbox');
  const alert = loadCredential(config.APNS_CERT_PATH, config.APNS_KEY_PATH, environment);
  const separate = config.APNS_VOIP_CERT_PATH || config.APNS_VOIP_KEY_PATH;
  const voip = separate ? loadCredential(config.APNS_VOIP_CERT_PATH, config.APNS_VOIP_KEY_PATH, environment) : alert;
  if (!alert.topics.get(bundle)?.has('topic')) throw new Error('APNs certificate does not authorize alert topic');
  if (!voip.topics.get(bundle + '.voip')?.has('voip')) throw new Error('APNs certificate does not authorize VoIP topic; provide a VoIP Services Certificate');
  return { bundle, environment, origin: ORIGINS[environment], alert, voip };
}
export function publicStatus(config, now = Date.now()) {
  return { auth_mode: 'certificate', bundle_id: config.bundle, environment: config.environment,
    certificates: [...new Set([config.alert, config.voip])].map(c => ({ certificate: c.certPath,
      topics: [...c.topics.keys()], topic_extensions: c.topicOIDs, environments: [...c.environments],
      expires_at: new Date(c.notAfter).toISOString(), days_remaining: Math.floor((c.notAfter - now) / 86400000) })) };
}

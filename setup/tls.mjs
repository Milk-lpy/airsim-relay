import { execFile } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { readFile, writeFile, copyFile, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { promisify } from 'node:util';

const run = promisify(execFile);
const days = 86_400_000;
const writePrivate = (path, value) => writeFile(path, value, { mode: 0o600 });

export function checkHost(value) {
  if (typeof value !== 'string' || value.length > 253) throw new Error('请输入 IP 地址或 DNS 主机名');
  const host = value.trim().toLowerCase();
  if (isIP(host) && !host.includes('%')) return host;
  const labels = host.split('.');
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /^\d+$/.test(labels.at(-1))) throw new Error('主机名不能包含协议、端口或路径');
  return host;
}

export function authority(host, port) {
  return (isIP(host) === 6 ? '[' + host + ']' : host) + ':' + port;
}

async function openssl(dir, args) {
  try { await run('openssl', args, { cwd: dir, timeout: 30_000, maxBuffer: 64_000 }); }
  catch { throw new Error('无法创建本地 TLS 证书，请检查 OpenSSL 和数据目录权限'); }
}

export async function readTLS(dir, host) {
  const cert = await readFile(join(dir, 'server.pem'));
  const key = await readFile(join(dir, 'server.key'));
  try {
    const x = new X509Certificate(cert);
    if (x.ca || Date.parse(x.validFrom) > Date.now() || Date.parse(x.validTo) <= Date.now()) {
      throw new Error('TLS 服务器证书已过期、尚未生效或为 CA 证书');
    }
    if (!(isIP(host) ? x.checkIP(host) : x.checkHost(host, {subject: 'never'}))) throw new Error('TLS 证书的 SAN 未包含指定主机');
    if (x.keyUsage && !x.keyUsage.includes('1.3.6.1.5.5.7.3.1')) throw new Error('TLS 证书缺少 serverAuth 用途');
    createSecureContext({ cert, key, minVersion: 'TLSv1.2' });
    return { cert, key, minVersion: 'TLSv1.2' };
  } catch (err) {
    if (err.message.startsWith('TLS ')) throw err;
    throw new Error('无法读取 TLS 证书或私钥，或两者不匹配');
  }
}

async function sign(dir, host, key) {
  const constraints = ['basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature',
    'extendedKeyUsage=serverAuth', 'subjectAltName=' + (isIP(host) ? 'IP:' : 'DNS:') + host].join('\n');
  await writePrivate(join(dir, 'leaf.ext'), constraints + '\n');
  await openssl(dir, ['req', '-new', '-key', key, '-subj', '/CN=AirSIM Relay', '-out', 'leaf.csr']);
  await openssl(dir, ['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
    '-set_serial', '0x' + randomBytes(16).toString('hex'), '-days', '180', '-sha256',
    '-extfile', 'leaf.ext', '-out', 'leaf.new']);
  await openssl(dir, ['verify', '-CAfile', 'ca.pem', '-purpose', 'sslserver', 'leaf.new']);
  await rename(join(dir, 'leaf.new'), join(dir, 'server.pem'));
  await rm(join(dir, 'leaf.csr'), { force: true });
}

export async function preparePrivateTLS(dir, host, hasRoot) {
  if (!hasRoot) {
    await openssl(dir, ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650',
      '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=AirSIM Private Relay CA',
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  }
  await openssl(dir, ['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'server.key']);
  await sign(dir, host, 'server.key');
}

export async function copyRoot(from, to) {
  try { await copyFile(join(from, 'ca.pem'), join(to, 'ca.pem')); }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  await copyFile(join(from, 'ca.key'), join(to, 'ca.key'));
  return true;
}

export async function renewIfDue(dir, host) {
  const leaf = new X509Certificate(await readFile(join(dir, 'server.pem')));
  if (Date.parse(leaf.validTo) - Date.now() > 30 * days) return false;
  await sign(dir, host, 'server.key');
  return true;
}

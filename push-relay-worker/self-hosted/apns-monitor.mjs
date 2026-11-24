import { loadAPNsConfig, publicStatus } from './apns-certificate.mjs';
try {
  const status = publicStatus(loadAPNsConfig());
  console.log(JSON.stringify(status));
  if (status.certificates.some(c => c.days_remaining <= 30)) {
    console.error('ALERT: AirSIM APNs provider certificate expires within 30 days; renew with Apple Developer and restart airsim-apns.service');
    process.exitCode = 1;
  }
} catch (error) { console.error('ALERT: AirSIM APNs certificate validation failed:', error.message); process.exitCode = 1; }

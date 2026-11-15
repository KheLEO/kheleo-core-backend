import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

type Headers = Readonly<Record<string, string | string[] | undefined>>;

/** Only the BFF's authenticated assertion can replace the socket peer address. */
export function clientIp(request: { ip?: string; headers?: Headers }, now = Date.now()): string {
  const headers = request.headers ?? {};
  const ip = headers['x-kheleo-client-ip'];
  const timestamp = headers['x-kheleo-client-timestamp'];
  const signature = headers['x-kheleo-client-signature'];
  const secret = process.env.BFF_PROXY_SECRET || process.env.TELEMETRY_SERVICE_HMAC_SECRET;
  if (
    secret &&
    typeof ip === 'string' &&
    isIP(ip) &&
    typeof timestamp === 'string' &&
    /^\d{13}$/.test(timestamp) &&
    Math.abs(now - Number(timestamp)) <= 120_000 &&
    typeof signature === 'string' &&
    /^[a-f0-9]{64}$/i.test(signature)
  ) {
    const key = createHmac('sha256', secret).update('kheleo/bff-client-ip/v1').digest();
    const expected = createHmac('sha256', key).update(`${timestamp}\n${ip}`).digest();
    if (timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return ip;
  }
  return request.ip ?? 'unknown';
}

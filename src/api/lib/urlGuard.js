/**
 * src/api/lib/urlGuard.js
 *
 * SSRF protection for outbound webhook deliveries. A webhook URL must be https and
 * must resolve only to public addresses — never loopback, private (RFC 1918 / ULA),
 * link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast or unspecified.
 * The check runs at registration AND immediately before every delivery (DNS can change).
 *
 * NODE_ENV=test keeps the existing exception for http://localhost / http://127.0.0.1.
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';

export function isTestLocalhost(url) {
  return process.env.NODE_ENV === 'test' &&
    (url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1'));
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [ipv4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

export function isBlockedAddress(ip) {
  let addr = ip.toLowerCase();
  // IPv4 embedded in IPv6: mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and
  // deprecated compatible (::a.b.c.d) — in dotted OR hex form (URL parsing turns
  // [::ffff:10.0.0.1] into ::ffff:a00:1, which must not slip past the IPv4 rules).
  const emb = addr.match(/^(?:::ffff:|64:ff9b::|::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (emb) {
    addr = emb[1] ?? (() => {
      const hi = parseInt(emb[2], 16), lo = parseInt(emb[3], 16);
      return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
    })();
  }
  if (isIP(addr) === 4) {
    const n = ipv4ToInt(addr);
    return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (isIP(addr) === 6) {
    return addr === '::' || addr === '::1'
      || /^f[cd]/.test(addr)          // fc00::/7 unique-local
      || /^fe[89ab]/.test(addr)       // fe80::/10 link-local
      || /^ff/.test(addr);            // multicast
  }
  return true;                         // not an IP at all → refuse
}

/** Throws an Error with a user-facing message if the URL may not be called. */
export async function assertSafeWebhookUrl(url) {
  if (isTestLocalhost(url)) return;
  let u;
  try { u = new URL(url); } catch { throw new Error('Webhook url is not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('Webhook url must use https://');
  if (u.username || u.password) throw new Error('Webhook url must not contain credentials');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true })
    .catch(() => { throw new Error(`Webhook host ${host} does not resolve`); });
  const bad = addrs.find((a) => isBlockedAddress(a.address));
  if (bad) throw new Error(`Webhook url resolves to a non-public address (${bad.address})`);
}

// ── Delivery with connect-time address pinning (closes DNS rebinding) ──────────
// assertSafeWebhookUrl() checks what the name resolves to *now*; an attacker's DNS
// could answer differently a moment later when fetch() connects. Here the check runs
// inside the socket's own DNS lookup, so the address that is validated is exactly
// the address that is connected to.
import https from 'https';
import http from 'http';
import dns from 'dns';

export function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad) return callback(Object.assign(new Error(`Webhook host resolves to a non-public address (${bad.address})`), { code: 'EBLOCKEDADDR' }));
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/** POST a webhook body. Never follows redirects. Resolves { status }. */
export async function postWebhook(url, body, headers, timeoutMs = 10_000) {
  await assertSafeWebhookUrl(url);                       // scheme / literal-IP / syntax checks
  const u = new URL(url);
  const testLocal = isTestLocalhost(url);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method:  'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
      ...(testLocal ? {} : { lookup: guardedLookup }),
    }, (res) => {
      res.resume();                                      // drain; response body is not used
      res.on('end', () => resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300 }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error(`Request timed out after ${timeoutMs / 1000}s`), { name: 'AbortError' })));
    req.on('error', reject);
    req.end(body);
  });
}

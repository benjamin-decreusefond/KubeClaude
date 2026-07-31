import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getAuthConfig, useSession, verifyApiKey, verifyPassword } from '../store/auth.js';
import { safeEqual } from './secrets.js';
import type { AuthMethod, AuthState } from '../types.js';

export const SESSION_COOKIE = 'kubeclaude_session';

/**
 * Paths that must answer before anybody is authenticated: the probes, the
 * static shell, and the endpoints the login screen itself calls. Everything
 * else under /api/ goes through the guard.
 */
const PUBLIC_API_PATHS = new Set([
  '/api/auth/state',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/logout',
]);

export function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (!path.startsWith('/api/')) return true;
  return PUBLIC_API_PATHS.has(path);
}

/**
 * The configured method, unless the environment pins one. Pinning matters for
 * a GitOps deployment: the cluster decides that this instance sits behind an
 * oauth2-proxy, and no click in the UI should be able to turn that off.
 */
export function effectiveMethod(): { method: AuthMethod; locked: boolean } {
  const pinned = normaliseMethod(config.authMethod);
  if (pinned) return { method: pinned, locked: true };
  return { method: getAuthConfig().method, locked: false };
}

export function normaliseMethod(value: string): AuthMethod | null {
  const candidate = value.trim().toLowerCase();
  return candidate === 'none' || candidate === 'forms' || candidate === 'basic' || candidate === 'external'
    ? candidate
    : null;
}

/**
 * Private-network detection for the "trust the LAN" option. Deliberately
 * conservative: anything it cannot parse is treated as remote, because the cost
 * of a false positive here is an open instance.
 */
export function isLocalAddress(address: string | undefined): boolean {
  if (!address) return false;
  // ::ffff:192.168.1.10 — an IPv4 client on a dual-stack socket.
  const ip = address.startsWith('::ffff:') ? address.slice(7) : address;

  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // Carrier-grade NAT and link-local are not "my LAN"; treat them as remote.
    return false;
  }

  const v6 = ip.toLowerCase();
  // Unique local (fc00::/7) and link-local (fe80::/10).
  return v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') ||
    v6.startsWith('fea') || v6.startsWith('feb');
}

export function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function setSessionCookie(reply: FastifyReply, token: string, days: number, secure: boolean): void {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(1, days) * 86_400}`,
  ];
  // Only when the request itself arrived over TLS: a Secure cookie on a plain
  // http:// homelab instance is silently dropped, which reads as a broken login.
  if (secure) attributes.push('Secure');
  reply.header('set-cookie', attributes.join('; '));
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** True when the request reached us over TLS, directly or through a proxy. */
export function isSecureRequest(request: FastifyRequest): boolean {
  return request.protocol === 'https';
}

export interface AuthOutcome {
  allowed: boolean;
  via: AuthState['via'];
  username: string | null;
  /** Setup has not happened yet, so there is nothing to authenticate against. */
  setupRequired: boolean;
  /** Ask the browser for credentials rather than just refusing. */
  challenge: boolean;
}

function deny(setupRequired = false, challenge = false): AuthOutcome {
  return { allowed: false, via: null, username: null, setupRequired, challenge };
}

/**
 * The credential a machine presents: an API key, or the static token from the
 * environment. Accepted whatever the login method is, so a script does not
 * break when a human turns forms auth on.
 */
function machineCredential(request: FastifyRequest): string {
  const header = request.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const apiKeyHeader = request.headers['x-api-key'];
  const fromHeader = typeof apiKeyHeader === 'string' ? apiKeyHeader.trim() : '';
  // EventSource cannot set headers, so the stream endpoint also takes a query.
  const query = request.query as Record<string, unknown> | undefined;
  const fromQuery =
    typeof query?.token === 'string' ? query.token : typeof query?.apikey === 'string' ? query.apikey : '';
  return fromHeader || bearer || fromQuery.trim();
}

function basicCredentials(request: FastifyRequest): { username: string; password: string } | null {
  const header = request.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/**
 * Decide whether a request may proceed. The order matters: machine credentials
 * first so automation is never affected by the human login method, then the
 * configured method, and only then the local-network exemption.
 */
export async function authenticate(request: FastifyRequest): Promise<AuthOutcome> {
  const stored = getAuthConfig();
  const { method } = effectiveMethod();

  const credential = machineCredential(request);
  if (credential) {
    if (config.authToken && safeEqual(credential, config.authToken)) {
      return { allowed: true, via: 'api-key', username: null, setupRequired: false, challenge: false };
    }
    if (await verifyApiKey(credential)) {
      return { allowed: true, via: 'api-key', username: stored.username, setupRequired: false, challenge: false };
    }
  }

  if (method === 'none') {
    return { allowed: true, via: 'open', username: null, setupRequired: false, challenge: false };
  }

  if (method === 'external') {
    const header = stored.externalUserHeader.trim().toLowerCase();
    // An empty header name means "trust the proxy unconditionally" — for proxies
    // that authenticate but forward no identity.
    if (!header) {
      return { allowed: true, via: 'proxy', username: null, setupRequired: false, challenge: false };
    }
    const value = request.headers[header];
    const username = Array.isArray(value) ? value[0] : value;
    if (username && username.trim()) {
      return { allowed: true, via: 'proxy', username: username.trim(), setupRequired: false, challenge: false };
    }
    // A proxy that stopped sending the header is a misconfiguration, and the
    // safe reading of a misconfiguration is "not authenticated".
    return deny();
  }

  // A session works in every credentialled mode, including basic: it is how the
  // UI signs out and how the setup wizard hands over to the running app.
  const cookie = readCookie(request, SESSION_COOKIE);
  if (cookie && useSession(cookie)) {
    return { allowed: true, via: 'session', username: stored.username, setupRequired: false, challenge: false };
  }

  if (!stored.configured) {
    // Nothing to check against yet. The API stays shut; only the setup endpoint
    // is public, and it is what fills this in.
    return deny(true);
  }

  if (method === 'basic') {
    const credentials = basicCredentials(request);
    if (credentials) {
      if (await verifyPassword(credentials.username, credentials.password)) {
        return {
          allowed: true,
          via: 'basic',
          username: stored.username,
          setupRequired: false,
          challenge: false,
        };
      }
    }
    return deny(false, true);
  }

  return deny();
}

/**
 * The local-network exemption, applied after the real check fails. Kept
 * separate so that "authenticated" and "let in because of where you are" never
 * get confused for one another.
 */
export function localBypassApplies(request: FastifyRequest): boolean {
  const { method } = effectiveMethod();
  if (method === 'none') return false;
  if (getAuthConfig().requirement !== 'local_bypass') return false;
  return isLocalAddress(request.ip);
}

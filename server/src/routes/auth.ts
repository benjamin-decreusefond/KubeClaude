import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  authenticate,
  clearSessionCookie,
  effectiveMethod,
  isLocalAddress,
  isSecureRequest,
  localBypassApplies,
  readCookie,
  setSessionCookie,
} from '../auth/guard.js';
import { randomToken } from '../auth/secrets.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as authStore from '../store/auth.js';
import type { AuthState } from '../types.js';

const methodSchema = z.enum(['none', 'forms', 'basic', 'external']);

const setupSchema = z.object({
  username: z.string().min(1).max(80),
  password: z.string().min(8).max(200),
  method: methodSchema.default('forms'),
  requirement: z.enum(['always', 'local_bypass']).default('always'),
});

const loginSchema = z.object({
  username: z.string().min(1).max(80),
  password: z.string().min(1).max(200),
});

const configSchema = z.object({
  method: methodSchema.optional(),
  requirement: z.enum(['always', 'local_bypass']).optional(),
  externalUserHeader: z.string().max(80).optional(),
  username: z.string().min(1).max(80).optional(),
  sessionDays: z.number().int().min(1).max(365).optional(),
});

const passwordSchema = z.object({
  currentPassword: z.string().max(200).default(''),
  newPassword: z.string().min(8).max(200),
});

/**
 * Failed logins per address. scrypt already makes each attempt expensive, which
 * is exactly why this exists: without a cap, guessing is a way to burn the CPU
 * this instance needs for the runs it is actually here to do.
 */
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60_000;
const attempts = new Map<string, { count: number; until: number }>();

function lockedOut(ip: string, now = Date.now()): boolean {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (entry.until <= now) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip: string, now = Date.now()): void {
  // Entries are normally dropped when the address comes back, so a scan from
  // many addresses is the only way this grows; sweep it rather than let it.
  if (attempts.size > 1_000) {
    for (const [address, entry] of attempts) {
      if (entry.until <= now) attempts.delete(address);
    }
  }

  const entry = attempts.get(ip);
  if (!entry || entry.until <= now) {
    attempts.set(ip, { count: 1, until: now + LOCKOUT_MS });
    return;
  }
  entry.count += 1;
  entry.until = now + LOCKOUT_MS;
}

function clearFailures(ip: string): void {
  attempts.delete(ip);
}

/**
 * The state of a request that has just been given a session. The cookie is on
 * the reply, not on the request we are holding, so asking the guard again would
 * report the caller as anonymous and bounce the UI straight back to the login.
 */
function signedInState(request: FastifyRequest): AuthState {
  const stored = authStore.getAuthConfig();
  const { method, locked } = effectiveMethod();
  return {
    method,
    setupRequired: false,
    authenticated: true,
    username: stored.username || null,
    via: 'session',
    locked,
    local: isLocalAddress(request.ip),
  };
}

async function stateFor(request: FastifyRequest): Promise<AuthState> {
  const stored = authStore.getAuthConfig();
  const { method, locked } = effectiveMethod();
  const outcome = await authenticate(request);
  const local = isLocalAddress(request.ip);
  const bypass = !outcome.allowed && localBypassApplies(request);

  return {
    method,
    // `none` and a trusted proxy never need a password, so they never need setup.
    setupRequired: !stored.configured && method !== 'none' && method !== 'external',
    authenticated: outcome.allowed || bypass,
    username: outcome.username ?? (outcome.allowed || bypass ? stored.username || null : null),
    via: outcome.allowed ? outcome.via : bypass ? 'local' : null,
    locked,
    local,
  };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  /** Public: what the login screen needs to draw itself. */
  app.get('/api/auth/state', async (request) => stateFor(request));

  /**
   * First run. Open by design — there is no credential to present yet — with
   * two guards: it only works while no password exists, and an instance that
   * already had a static token still has to present it, so upgrading a
   * protected deployment does not open a window for whoever gets there first.
   */
  app.post('/api/auth/setup', async (request, reply) => {
    const stored = authStore.getAuthConfig();
    if (stored.configured) {
      return reply.code(409).send({ error: 'This instance is already set up' });
    }
    if (config.authToken) {
      const outcome = await authenticate(request);
      if (outcome.via !== 'api-key') {
        return reply
          .code(401)
          .send({ error: 'This instance is protected by KUBECLAUDE_AUTH_TOKEN; present it to set a password' });
      }
    }

    const parsed = setupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'A username and a password of at least 8 characters are required',
        details: parsed.error.flatten(),
      });
    }
    const input = parsed.data;

    await authStore.setPassword(input.password);
    authStore.updateAuthConfig({
      username: input.username.trim(),
      // Storing a method the environment overrides would only be misleading:
      // the config page would show one thing and the guard would do another.
      method: effectiveMethod().locked ? undefined : input.method,
      requirement: input.requirement,
    });
    const apiKey = await authStore.rotateApiKey();

    const token = randomToken();
    const days = authStore.getAuthConfig().sessionDays;
    authStore.createSession(token, days, request.headers['user-agent'] ?? null);
    setSessionCookie(reply, token, days, isSecureRequest(request));

    logger.info({ username: input.username, method: input.method }, 'authentication configured');
    // The only time the key is readable. It is stored hashed.
    return reply.code(201).send({ ...signedInState(request), apiKey });
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (lockedOut(request.ip)) {
      return reply.code(429).send({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A username and password are required' });

    const stored = authStore.getAuthConfig();
    if (!stored.configured) return reply.code(409).send({ error: 'This instance has no password set yet' });

    if (!(await authStore.verifyPassword(parsed.data.username, parsed.data.password))) {
      recordFailure(request.ip);
      logger.warn({ ip: request.ip }, 'failed login');
      return reply.code(401).send({ error: 'Wrong username or password' });
    }

    clearFailures(request.ip);
    const token = randomToken();
    authStore.createSession(token, stored.sessionDays, request.headers['user-agent'] ?? null);
    setSessionCookie(reply, token, stored.sessionDays, isSecureRequest(request));
    return signedInState(request);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const cookie = readCookie(request, SESSION_COOKIE);
    if (cookie) authStore.deleteSession(cookie);
    clearSessionCookie(reply);
    return { ok: true };
  });

  /** Guarded from here down: the hook has already let the caller through. */
  app.get('/api/auth/config', async () => {
    const { method, locked } = effectiveMethod();
    return {
      ...authStore.getAuthConfig(),
      method,
      locked,
      hasApiKey: authStore.hasApiKey(),
      staticTokenConfigured: Boolean(config.authToken),
      activeSessions: authStore.countSessions(),
    };
  });

  app.patch('/api/auth/config', async (request, reply) => {
    const parsed = configSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid settings', details: parsed.error.flatten() });
    }
    const { locked } = effectiveMethod();
    if (locked && parsed.data.method) {
      return reply.code(409).send({ error: 'AUTH_METHOD pins the login method for this instance' });
    }

    const stored = authStore.getAuthConfig();
    // Turning a credentialled method on without a password would lock everyone
    // out of an instance that has no way to let them back in.
    const nextMethod = parsed.data.method ?? stored.method;
    if (!stored.configured && (nextMethod === 'forms' || nextMethod === 'basic')) {
      return reply.code(409).send({ error: 'Set a password before switching to this method' });
    }

    const updated = authStore.updateAuthConfig(parsed.data);
    logger.info({ method: updated.method, requirement: updated.requirement }, 'authentication settings changed');
    return { ...updated, hasApiKey: authStore.hasApiKey(), activeSessions: authStore.countSessions() };
  });

  app.post('/api/auth/password', async (request, reply) => {
    const parsed = passwordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'The new password must be at least 8 characters' });
    }
    const stored = authStore.getAuthConfig();
    // Whoever is calling is authenticated, but that may be an API key rather
    // than the person who knows the password.
    if (stored.configured && !(await authStore.verifyPassword(stored.username, parsed.data.currentPassword))) {
      return reply.code(403).send({ error: 'The current password is wrong' });
    }

    await authStore.setPassword(parsed.data.newPassword);
    // setPassword drops every session, including this caller's: give them a new
    // one so changing a password does not read as being thrown out.
    const token = randomToken();
    authStore.createSession(token, stored.sessionDays, request.headers['user-agent'] ?? null);
    setSessionCookie(reply, token, stored.sessionDays, isSecureRequest(request));
    return { ok: true };
  });

  /** Mint a new API key. The old one stops working immediately. */
  app.post('/api/auth/api-key', async () => ({ apiKey: await authStore.rotateApiKey() }));

  /** Sign every browser out, including this one. */
  app.post('/api/auth/sessions/revoke', async (_request, reply) => {
    authStore.clearSessions();
    clearSessionCookie(reply);
    return { ok: true };
  });
}

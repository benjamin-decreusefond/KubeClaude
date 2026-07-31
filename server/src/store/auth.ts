import { db } from '../db.js';
import { hashSecret, randomToken, tokenDigest, verifySecret } from '../auth/secrets.js';
import type { AuthConfig, AuthMethod, AuthRequirement } from '../types.js';

interface ConfigRow {
  id: number;
  method: string;
  requirement: string;
  external_user_header: string;
  username: string;
  password_hash: string | null;
  api_key_hash: string | null;
  session_days: number;
  updated_at: string;
}

function row(): ConfigRow {
  const existing = db.prepare<[], ConfigRow>('SELECT * FROM auth_config WHERE id = 1').get();
  if (existing) return existing;

  db.prepare('INSERT INTO auth_config (id, updated_at) VALUES (1, ?)').run(new Date().toISOString());
  return db.prepare<[], ConfigRow>('SELECT * FROM auth_config WHERE id = 1').get()!;
}

export function getAuthConfig(): AuthConfig {
  const current = row();
  return {
    method: current.method as AuthMethod,
    requirement: current.requirement as AuthRequirement,
    externalUserHeader: current.external_user_header,
    username: current.username,
    configured: Boolean(current.password_hash),
    sessionDays: current.session_days,
    updatedAt: current.updated_at,
  };
}

export interface AuthConfigPatch {
  method?: AuthMethod;
  requirement?: AuthRequirement;
  externalUserHeader?: string;
  username?: string;
  sessionDays?: number;
}

const COLUMN_BY_FIELD: Record<string, string> = {
  method: 'method',
  requirement: 'requirement',
  externalUserHeader: 'external_user_header',
  username: 'username',
  sessionDays: 'session_days',
};

export function updateAuthConfig(patch: AuthConfigPatch): AuthConfig {
  row();
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(patch)) {
    const column = COLUMN_BY_FIELD[field];
    if (!column || value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(value as never);
  }
  if (assignments.length > 0) {
    assignments.push('updated_at = ?');
    values.push(new Date().toISOString());
    db.prepare(`UPDATE auth_config SET ${assignments.join(', ')} WHERE id = 1`).run(...(values as never[]));
  }
  return getAuthConfig();
}

/**
 * Set the very first password, and only if there is not one already.
 *
 * First-run setup is the one moment this instance is open, and hashing takes
 * long enough that two requests can both pass a "is it configured?" check
 * before either has written. Deciding it in SQL means exactly one of them wins,
 * and the other is told the instance is already set up.
 */
export async function initialisePassword(password: string): Promise<boolean> {
  const hash = await hashSecret(password);
  row();
  const result = db
    .prepare('UPDATE auth_config SET password_hash = ?, updated_at = ? WHERE id = 1 AND password_hash IS NULL')
    .run(hash, new Date().toISOString());
  return result.changes > 0;
}

/**
 * Set the password. Every existing session goes with it: a password is changed
 * either because it might be known, or because somebody should be locked out.
 */
export async function setPassword(password: string): Promise<void> {
  const hash = await hashSecret(password);
  row();
  db.prepare('UPDATE auth_config SET password_hash = ?, updated_at = ? WHERE id = 1').run(
    hash,
    new Date().toISOString(),
  );
  clearSessions();
}

export async function verifyPassword(username: string, password: string): Promise<boolean> {
  const current = row();
  if (!current.password_hash) return false;
  // The username is checked too, but a wrong one still pays for the hash so the
  // response time does not say which half was wrong.
  const passwordOk = await verifySecret(password, current.password_hash);
  return passwordOk && username.trim().toLowerCase() === current.username.trim().toLowerCase();
}

/** Mint a new API key, returning the only copy that will ever be readable. */
export async function rotateApiKey(): Promise<string> {
  const key = randomToken();
  row();
  db.prepare('UPDATE auth_config SET api_key_hash = ?, updated_at = ? WHERE id = 1').run(
    await hashSecret(key),
    new Date().toISOString(),
  );
  return key;
}

export function hasApiKey(): boolean {
  return Boolean(row().api_key_hash);
}

export async function verifyApiKey(key: string): Promise<boolean> {
  return verifySecret(key, row().api_key_hash);
}

// --------------------------------------------------------------------------
// Sessions
// --------------------------------------------------------------------------

export interface SessionRecord {
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export function createSession(token: string, days: number, userAgent: string | null): SessionRecord {
  const now = new Date();
  const expires = new Date(now.getTime() + Math.max(1, days) * 86_400_000);
  db.prepare(
    'INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).run(tokenDigest(token), now.toISOString(), expires.toISOString(), now.toISOString(), userAgent);
  return { createdAt: now.toISOString(), expiresAt: expires.toISOString(), lastSeenAt: now.toISOString() };
}

/** Look a session up and touch it, or return null when it is gone or expired. */
export function useSession(token: string, now = new Date()): SessionRecord | null {
  const hash = tokenDigest(token);
  const found = db
    .prepare<[string], { created_at: string; expires_at: string; last_seen_at: string }>(
      'SELECT created_at, expires_at, last_seen_at FROM auth_sessions WHERE token_hash = ?',
    )
    .get(hash);
  if (!found) return null;

  if (new Date(found.expires_at).getTime() <= now.getTime()) {
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hash);
    return null;
  }

  // Only written once a minute: every request would mean a write per poll, and
  // the UI polls several endpoints on a timer.
  if (now.getTime() - new Date(found.last_seen_at).getTime() > 60_000) {
    db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?').run(
      now.toISOString(),
      hash,
    );
  }

  return {
    createdAt: found.created_at,
    expiresAt: found.expires_at,
    lastSeenAt: found.last_seen_at,
  };
}

export function deleteSession(token: string): void {
  db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenDigest(token));
}

export function clearSessions(): void {
  db.prepare('DELETE FROM auth_sessions').run();
}

export function countSessions(): number {
  const found = db
    .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM auth_sessions')
    .get();
  return found?.count ?? 0;
}

export function pruneSessions(now = new Date()): number {
  return db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now.toISOString()).changes;
}

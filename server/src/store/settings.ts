import { DEFAULT_ENVIRONMENT_BRIEFING } from '../claude/briefing.js';
import { DEFAULT_GIT_IDENTITY } from '../claude/git.js';
import { db } from '../db.js';
import type { Settings } from '../types.js';

export const DEFAULT_SETTINGS: Settings = {
  sessionWindowHours: 5,
  weeklyWindowDays: 7,
  sessionTokenBudget: 0,
  weeklyTokenBudget: 0,
  budgetBasis: 'weighted',
  /**
   * Turns a run may take when the prompt does not pin its own. Thirty is about
   * ten minutes of reading and two edits: enough for "check something and
   * report", nowhere near enough for "fix this and open a pull request", which
   * is what the first real goal ran into. The per-run token ceiling is the
   * budget guard; this one is only here to stop a genuinely stuck loop.
   */
  defaultMaxTurns: 120,
  runTokenCap: 0,
  quotaGuardEnabled: false,
  quotaReservePct: 0,
  defaultModel: null,
  globalEnv: {},
  environmentBriefing: DEFAULT_ENVIRONMENT_BRIEFING,
  timezone: process.env.TZ ?? 'UTC',
  gitUserName: DEFAULT_GIT_IDENTITY.name,
  gitUserEmail: DEFAULT_GIT_IDENTITY.email,
  autoResumeEnabled: true,
  autoResumeDelayMinutes: 1,
};

export function getSettings(): Settings {
  const rows = db.prepare<[], { key: string; value: string }>('SELECT key, value FROM settings').all();
  const stored: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      /* ignore corrupted entries and fall back to the default */
    }
  }
  return { ...DEFAULT_SETTINGS, ...(stored as Partial<Settings>) };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      upsert.run(key, JSON.stringify(value));
    }
  })();
  return getSettings();
}

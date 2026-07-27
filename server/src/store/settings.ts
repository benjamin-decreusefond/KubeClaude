import { db } from '../db.js';
import type { Settings } from '../types.js';

export const DEFAULT_SETTINGS: Settings = {
  sessionWindowHours: 5,
  weeklyWindowDays: 7,
  sessionTokenBudget: 0,
  weeklyTokenBudget: 0,
  quotaGuardEnabled: false,
  quotaReservePct: 0,
  defaultModel: null,
  globalEnv: {},
  timezone: process.env.TZ ?? 'UTC',
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

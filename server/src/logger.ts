const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

function currentLevel(): number {
  const configured = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as Level;
  return LEVELS[configured] ?? LEVELS.info;
}

function emit(level: Level, context: unknown, message?: string): void {
  if (LEVELS[level] < currentLevel()) return;
  const payload =
    typeof context === 'string'
      ? { level, time: new Date().toISOString(), msg: context }
      : { level, time: new Date().toISOString(), msg: message ?? '', ...(context as object) };
  const line = JSON.stringify(payload);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (context: unknown, message?: string) => emit('debug', context, message),
  info: (context: unknown, message?: string) => emit('info', context, message),
  warn: (context: unknown, message?: string) => emit('warn', context, message),
  error: (context: unknown, message?: string) => emit('error', context, message),
};

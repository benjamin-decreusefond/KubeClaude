import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * What this image actually ships, probed rather than asserted.
 *
 * The briefing used to be prose alone: a hand-written list of what a run can
 * reach, kept true by whoever remembered to edit it when the Dockerfile
 * changed. Prose drifts, and a run that believes it has a tool it does not have
 * spends turns proving otherwise — the expensive direction of that mistake,
 * because a missing tool is only discovered by trying to use it.
 *
 * So the same probe answers both the capabilities endpoint and the text
 * injected into every run's system prompt. One source, and it cannot go stale.
 */
export const PROBED_TOOLS = [
  'claude',
  'git',
  'gh',
  'kubectl',
  'rg',
  'jq',
  'node',
  'python3',
] as const;

export interface ToolAvailability {
  name: string;
  available: boolean;
}

export async function onPath(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

export async function probeTools(): Promise<ToolAvailability[]> {
  return Promise.all(
    PROBED_TOOLS.map(async (name) => ({ name, available: await onPath(name) })),
  );
}

export interface BrowserAvailability {
  available: boolean;
  /** Absolute path to the browser binary, for `executablePath`. */
  executablePath: string | null;
  /** Where the browsers were installed, i.e. PLAYWRIGHT_BROWSERS_PATH. */
  browsersPath: string | null;
  /** The stripped-down headless build rather than a full Chromium. */
  headlessShell: boolean;
}

/**
 * Binary layouts Playwright has shipped, in the order we would rather have
 * them. Three of these are real and in use: the build id directory says
 * `chromium_headless_shell` but the binary inside it has been
 * `chrome-headless-shell-linux64/chrome-headless-shell` in some versions and
 * `chrome-linux/headless_shell` in others, so the flavour cannot be inferred
 * from the directory name alone — it has to be looked for.
 */
const BROWSER_LAYOUTS: Array<{ relative: string; headlessShell: boolean }> = [
  { relative: 'chrome-headless-shell-linux64/chrome-headless-shell', headlessShell: true },
  { relative: 'chrome-linux/headless_shell', headlessShell: true },
  { relative: 'chrome-linux64/chrome', headlessShell: false },
  { relative: 'chrome-linux/chrome', headlessShell: false },
];

/** The trailing build id, compared as a number so 999 sorts below 1194. */
function buildId(entry: string): number {
  const match = /-(\d+)$/.exec(entry);
  return match ? Number.parseInt(match[1]!, 10) : -1;
}

/**
 * The headless browser baked into the image, if there is one.
 *
 * Located by walking PLAYWRIGHT_BROWSERS_PATH rather than by trusting a version
 * number: the directory carries a build id (`chromium_headless_shell-1234`)
 * that changes with every Playwright bump, and a hardcoded one would report
 * "no browser" the first time somebody upgrades it.
 */
export function probeBrowser(): BrowserAvailability {
  const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH ?? null;
  const missing: BrowserAvailability = {
    available: false,
    executablePath: null,
    browsersPath,
    headlessShell: false,
  };
  if (!browsersPath) return missing;

  let entries: string[];
  try {
    entries = fs.readdirSync(browsersPath);
  } catch {
    return missing;
  }

  // Headless shells first, then the newest build id. Order matters both ways:
  // a full Chromium and its headless shell ship under the same build id, so
  // without the first comparison the tie falls to whatever order the directory
  // happens to list — and the heavier browser wins by accident.
  const isShell = (name: string) => name.startsWith('chromium_headless_shell-');
  const candidates = entries
    .filter((name) => isShell(name) || name.startsWith('chromium-'))
    .sort((a, b) => Number(isShell(b)) - Number(isShell(a)) || buildId(b) - buildId(a));

  for (const entry of candidates) {
    for (const layout of BROWSER_LAYOUTS) {
      const candidate = path.join(browsersPath, entry, layout.relative);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return {
          available: true,
          executablePath: candidate,
          browsersPath,
          headlessShell: layout.headlessShell,
        };
      } catch {
        /* try the next layout — Playwright has changed it between versions */
      }
    }
  }

  return missing;
}

/**
 * The probe, written for the model rather than for the UI, appended to the
 * environment briefing.
 *
 * It says what is present, what is absent, and — the part that actually saves a
 * session — that absence is final. A run that cannot install what it is missing
 * needs to be told so explicitly, because every habit it has says the fix for a
 * missing package is to install it. Without that sentence it will download a
 * browser into $HOME, watch it fail to launch on a library it cannot add, and
 * keep going until something else stops it.
 */
export async function describeCapabilities(): Promise<string> {
  const tools = await probeTools();
  const present = tools.filter((tool) => tool.available).map((tool) => tool.name);
  const absent = tools.filter((tool) => !tool.available).map((tool) => tool.name);
  const browser = probeBrowser();

  const lines = [
    '# What this image actually has',
    '',
    'Probed at the moment this run started, so it is accurate for this container.',
    '',
    present.length > 0 ? `- **On PATH:** ${present.map((name) => `\`${name}\``).join(', ')}.` : null,
    absent.length > 0 ? `- **Not installed:** ${absent.map((name) => `\`${name}\``).join(', ')}.` : null,
    browser.available
      ? `- **Headless browser:** ${browser.headlessShell ? 'a Chromium headless shell' : 'Chromium'} ` +
        `is installed at \`${browser.executablePath}\`, ` +
        'and `PLAYWRIGHT_BROWSERS_PATH` already points at it. Use Playwright directly — ' +
        'do **not** run `playwright install`, which would download a second copy that is no better. ' +
        'If a project pins a Playwright version that cannot find it, pass ' +
        `\`executablePath: '${browser.executablePath}'\` when you launch.`
      : '- **No browser.** Nothing in this image can render a page, and you cannot add one — see below.',
    '',
    '# What you cannot do, and cannot fix',
    '',
    'You are running as an unprivileged user. There is no root, no `sudo`, and no',
    'password that will get you one. `apt-get`, `dnf`, `apk` and anything else that',
    'writes outside your home directory will fail, and no amount of retrying will',
    'change that.',
    '',
    'This matters most for tools that *look* installable. Downloading a binary or a',
    'browser into your home directory usually succeeds — and then fails to run,',
    'because the system libraries it needs require root to install. Treat a missing',
    'system dependency as a hard stop, not as a setup step.',
    '',
    'If the task needs something this image does not have: stop, and say plainly',
    'what was missing and what would need to be added to the image. That is a',
    'finished run with a useful answer. Grinding against a permission you will never',
    'get is neither.',
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}

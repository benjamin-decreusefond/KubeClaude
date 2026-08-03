import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { describeCapabilities, probeBrowser, probeTools } from '../src/claude/environment.js';

function withBrowsersPath<T>(value: string | undefined, body: () => T): T {
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (value === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  else process.env.PLAYWRIGHT_BROWSERS_PATH = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
  }
}

/**
 * A browsers directory laid out the way `playwright install` leaves one.
 *
 * `relative` is the binary path inside the build directory, which Playwright
 * has changed between versions — hence a parameter rather than a constant.
 */
function fakeInstall(
  buildIds: string[],
  relative = 'chrome-headless-shell-linux64/chrome-headless-shell',
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-browsers-'));
  for (const id of buildIds) {
    const binary = path.join(root, `chromium_headless_shell-${id}`, relative);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\n');
    fs.chmodSync(binary, 0o755);
  }
  return root;
}

test('the probe reports node, which is by definition running', async () => {
  const tools = await probeTools();
  assert.equal(tools.find((tool) => tool.name === 'node')?.available, true);
});

test('no browsers path means no browser', () => {
  withBrowsersPath(undefined, () => {
    const browser = probeBrowser();
    assert.equal(browser.available, false);
    assert.equal(browser.executablePath, null);
  });
});

test('a browsers path that does not exist means no browser', () => {
  withBrowsersPath('/nonexistent/pw-browsers', () => {
    assert.equal(probeBrowser().available, false);
  });
});

test('the browser is found by walking the build id, not by guessing it', () => {
  const root = fakeInstall(['1234']);
  try {
    withBrowsersPath(root, () => {
      const browser = probeBrowser();
      assert.equal(browser.available, true);
      assert.equal(
        browser.executablePath,
        path.join(root, 'chromium_headless_shell-1234', 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      );
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('two installs resolve to the newer build id, compared as a number', () => {
  // Lexicographically "999" sorts above "1194", so a string compare would pick
  // the older build the first time Playwright's build id gains a digit.
  const root = fakeInstall(['999', '1194']);
  try {
    withBrowsersPath(root, () => {
      assert.match(probeBrowser().executablePath ?? '', /chromium_headless_shell-1194/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the chrome-linux/headless_shell layout is found too', () => {
  // The layout actually shipped by playwright 1.5x: the directory says
  // headless_shell, the binary inside it is not where the newer builds put it.
  const root = fakeInstall(['1194'], 'chrome-linux/headless_shell');
  try {
    withBrowsersPath(root, () => {
      const browser = probeBrowser();
      assert.equal(browser.available, true);
      assert.equal(browser.headlessShell, true);
      assert.match(browser.executablePath ?? '', /chrome-linux\/headless_shell$/);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a full chromium build is reported as such, not as a headless shell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-browsers-'));
  try {
    const binary = path.join(root, 'chromium-1194', 'chrome-linux', 'chrome');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\n');
    fs.chmodSync(binary, 0o755);
    withBrowsersPath(root, () => {
      const browser = probeBrowser();
      assert.equal(browser.available, true);
      assert.equal(browser.headlessShell, false);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a headless shell is preferred over a full chromium of the same build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-browsers-'));
  try {
    for (const [dir, relative] of [
      ['chromium-1194', 'chrome-linux/chrome'],
      ['chromium_headless_shell-1194', 'chrome-linux/headless_shell'],
    ] as const) {
      const binary = path.join(root, dir, relative);
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.writeFileSync(binary, '#!/bin/sh\n');
      fs.chmodSync(binary, 0o755);
    }
    withBrowsersPath(root, () => {
      assert.equal(probeBrowser().headlessShell, true);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the injected text tells a run that missing system packages are a hard stop', async () => {
  const text = await describeCapabilities();
  // The specific trap that cost a session: downloading succeeds, launching does
  // not, and the fix needs a root that will never be granted.
  assert.match(text, /no root/i);
  assert.match(text, /apt-get/);
  assert.match(text, /hard stop/i);
  assert.match(text, /\bnode\b/);
});

test('the injected text names the browser path when one is installed', async () => {
  const root = fakeInstall(['1234']);
  try {
    process.env.PLAYWRIGHT_BROWSERS_PATH = root;
    const text = await describeCapabilities();
    assert.match(text, /chrome-headless-shell/);
    // Telling it not to reinstall matters as much as telling it where the
    // browser is: `playwright install` is the reflex, and it wastes the download.
    assert.match(text, /do \*\*not\*\* run `playwright install`/);
  } finally {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the injected text says there is no browser when there is none', async () => {
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  try {
    const text = await describeCapabilities();
    assert.match(text, /No browser/i);
  } finally {
    if (previous !== undefined) process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
  }
});

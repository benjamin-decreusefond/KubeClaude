import fs from 'node:fs';
import path from 'node:path';

/**
 * The files a prompt could be talking about.
 *
 * This exists for one thing: the composer's `@` completion, so a person naming a
 * file in a chat does not have to remember its path. It is therefore allowed to
 * be approximate — a bounded, best-effort walk that stops long before a large
 * repository could make a keystroke slow — but it must never wander outside the
 * directory it was given, and it never reads a file's contents.
 */

/** Directories that are never worth suggesting and are usually the largest. */
const SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.playwright',
  'test-results',
]);

/** Ceiling on the walk, so one keystroke cannot read a whole disk. */
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 8;

export interface WorkspaceEntry {
  /** Path relative to the workspace root, with `/` on a directory. */
  path: string;
  directory: boolean;
}

interface CacheEntry {
  at: number;
  entries: WorkspaceEntry[];
}

/**
 * Typing is a burst of requests, and the answer does not change between two
 * keystrokes. Ten seconds is short enough that a file written by the run
 * appears while you are still talking about it.
 */
const CACHE_MS = 10_000;
const cache = new Map<string, CacheEntry>();

function walk(root: string): WorkspaceEntry[] {
  const entries: WorkspaceEntry[] = [];
  // Breadth-first: the shallow paths are the ones somebody means, and the
  // budget is spent near the top rather than deep inside one subtree.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (queue.length > 0 && entries.length < MAX_ENTRIES) {
    const { dir, depth } = queue.shift()!;
    let contents: fs.Dirent[];
    try {
      contents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable, gone since the walk started, or a permission the pod does
      // not have. Not worth failing a completion over.
      continue;
    }

    for (const entry of contents) {
      if (entries.length >= MAX_ENTRIES) break;
      // A symlink is not followed: it is the one way a walk rooted in the
      // workspace could end up outside it, or in a cycle.
      if (entry.isSymbolicLink()) continue;

      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        entries.push({ path: `${relative}/`, directory: true });
        if (depth + 1 < MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        entries.push({ path: relative, directory: false });
      }
    }
  }

  return entries;
}

function listAll(root: string): WorkspaceEntry[] {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.entries;
  if (!fs.existsSync(root)) return [];

  const entries = walk(root);
  cache.set(root, { at: Date.now(), entries });
  return entries;
}

/**
 * Rank a match by where it hit: the file's own name first, then the path. Two
 * equally good matches are ordered by how shallow they are, because a path near
 * the root is usually the one meant.
 */
function score(entry: WorkspaceEntry, query: string): number | null {
  if (!query) return entry.path.split('/').length;

  const haystack = entry.path.toLowerCase();
  const index = haystack.indexOf(query);
  if (index === -1) return null;

  const name = (entry.directory ? entry.path.slice(0, -1) : entry.path).split('/').pop() ?? '';
  const inName = name.toLowerCase().includes(query);
  const depth = entry.path.split('/').length;
  return (inName ? 0 : 1_000) + index + depth;
}

/** Paths under `root` matching `query`, best first. */
export function suggestFiles(root: string, query: string, limit = 20): WorkspaceEntry[] {
  const needle = query.trim().toLowerCase();
  return listAll(root)
    .map((entry) => ({ entry, rank: score(entry, needle) }))
    .filter((candidate): candidate is { entry: WorkspaceEntry; rank: number } => candidate.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.entry.path.localeCompare(b.entry.path))
    .slice(0, limit)
    .map((candidate) => candidate.entry);
}

/** Forget what was cached; used when a test needs the next call to look again. */
export function forgetWorkspaceFiles(): void {
  cache.clear();
}

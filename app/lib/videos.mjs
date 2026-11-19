// WHAT: The local video shelf — tutorial recordings kept in docs/.
// WHY: These are the only files the cockpit serves from outside app/web, so the
//      resolver is deliberately strict: an extension allowlist, a basename-only match
//      against a directory listing, and a final realpath check. No request-supplied
//      string is ever concatenated into a path.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { REPO_ROOT } from './config.mjs';

// The override lets a disposable server exercise generation and playback without
// publishing test clips into the real shelf.
const VIDEO_DIR = resolve(process.env.STUDYDECK_VIDEO_DIR || join(REPO_ROOT, 'docs'));

/** Extension → MIME. Anything not listed here is not servable, full stop. */
const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
};

const prettyName = (file) =>
  file
    .replace(extname(file), '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * The shelf's real path, or null if it can't be resolved.
 * Resolved once per call rather than per file — the containment check needs it for
 * every entry, and re-resolving it made N+1 identical syscalls per request.
 */
function shelfRoot() {
  try {
    return realpathSync(VIDEO_DIR);
  } catch {
    return null;
  }
}

/** True when `file` resolves, through symlinks, to something still inside docs/. */
function containedInShelf(file, realRoot) {
  if (!realRoot) return false;
  try {
    const real = realpathSync(resolve(VIDEO_DIR, file));
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

/** Videos on the shelf. Empty is a normal state — these files are gitignored. */
export function listVideos() {
  if (!existsSync(VIDEO_DIR)) return [];

  const realRoot = shelfRoot();
  if (!realRoot) return [];

  return readdirSync(VIDEO_DIR)
    .filter((file) => extname(file).toLowerCase() in VIDEO_TYPES)
    // Listing and serving apply the same containment rule, so the shelf can never
    // advertise a file that the media route will refuse.
    .filter((file) => containedInShelf(file, realRoot))
    .map((file) => {
      const { size, mtime } = statSync(join(VIDEO_DIR, file));
      return {
        file,
        title: prettyName(file),
        bytes: size,
        size_mb: Math.round((size / 1_048_576) * 10) / 10,
        modified: mtime.toISOString().slice(0, 10),
        type: VIDEO_TYPES[extname(file).toLowerCase()],
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified) || a.file.localeCompare(b.file));
}

/**
 * Resolve a requested video to a real path, or null.
 *
 * Two independent gates. First, the name is matched against the actual directory
 * listing rather than trusted, so a traversal attempt simply fails to match anything.
 * Second, the path is resolved through symlinks and confirmed to still sit inside
 * docs/ — a symlink dropped into the shelf pointing at, say, ~/.ssh would otherwise be
 * listed and served, because a lexical comparison of a bare basename can never catch it.
 */
export function resolveVideo(name) {
  const entry = listVideos().find((v) => v.file === name);
  if (!entry) return null;

  // listVideos already applied the containment check, but this route serves bytes, so
  // it re-verifies rather than trusting a list that was built a moment earlier.
  const realRoot = shelfRoot();
  if (!containedInShelf(entry.file, realRoot)) return null;

  return { path: realpathSync(resolve(VIDEO_DIR, entry.file)), ...entry };
}

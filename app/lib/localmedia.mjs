// WHAT: Serving a media file from local disk over HTTP: validators, conditional requests,
//       If-Range, byte ranges and HEAD. docs/changes/2026-11-10-local-video-validators.
// WHY:  Players seek with ranges, probe with HEAD and resume with If-Range. Without
//       validators every reopen re-downloads the whole file (46MB for a tutorial), and an
//       ignored If-Range splices a range of a re-rendered file onto the old one's start.
//       The path must already be resolved and contained by the caller; nothing here
//       touches a request-supplied name.
import { statSync } from 'node:fs';
import { pipeFile } from './stream.mjs';

// Revalidate on every use. Without it a browser may cache heuristically from
// Last-Modified and keep playing a file that has since been replaced.
const CACHE_CONTROL = 'private, max-age=0, must-revalidate';

/** The opaque part of an entity tag, so `W/"x"` and `"x"` compare equal (weak comparison). */
const opaque = (tag) => tag.trim().replace(/^W\//, '');

/** True when an If-None-Match list names this file's ETag, or is `*`. */
function noneMatchHits(header, etag) {
  return header.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === etag);
}

/** True when an If-Modified-Since date is at or after the file's mtime, to the second. */
function notModifiedSince(header, mtimeMs) {
  const since = Date.parse(header);
  // HTTP dates carry whole seconds; comparing raw milliseconds would never revalidate.
  return Number.isFinite(since) && since >= Math.floor(mtimeMs / 1000) * 1000;
}

/** The byte span a Range header asks for, or null when it cannot be satisfied. */
function parseRange(range, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  // `bytes=-N` is a SUFFIX range meaning "the last N bytes", not "from 0 to N".
  if (match[1] === '') {
    start = size - Math.min(Number(match[2]), size);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  // One check for both forms: `bytes=-0`, or any suffix of an empty file, selects no bytes.
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size || start < 0) return null;
  return { start, end };
}

/** Answer a GET or HEAD for the file at `path`, served as `type`. */
export function sendLocalMedia(req, res, { path, type, sha256 }) {
  // Pass `sha256` when the file can be replaced in place with different bytes (a re-rendered
  // chapter), so the ETag tells the two apart; without it, size and mtime as before.
  const { size, mtimeMs } = statSync(path);
  // Strong, from size and mtime: hand-placed recordings, not a content hash per request.
  const etag = sha256 ? `"${sha256}"` : `"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}"`;
  const lastModified = new Date(mtimeMs).toUTCString();
  const validators = { etag, 'last-modified': lastModified, 'cache-control': CACHE_CONTROL };

  // RFC 9110 13.2.2: If-None-Match first, and If-Modified-Since only in its absence.
  const noneMatch = req.headers['if-none-match'];
  const modifiedSince = req.headers['if-modified-since'];
  if (noneMatch ? noneMatchHits(noneMatch, etag) : modifiedSince && notModifiedSince(modifiedSince, mtimeMs)) {
    res.writeHead(304, validators);
    return res.end();
  }

  const headers = { 'content-type': type, 'accept-ranges': 'bytes', ...validators };
  let range = req.method === 'HEAD' ? undefined : req.headers.range;
  // If-Range uses the strong comparison: a stale or weak validator means "send it all".
  const ifRange = req.headers['if-range'];
  if (range && ifRange && ifRange !== etag && ifRange !== lastModified) range = undefined;

  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': size });
    return req.method === 'HEAD' ? res.end() : pipeFile(res, path);
  }

  const span = parseRange(range, size);
  if (!span) {
    res.writeHead(416, { 'content-range': `bytes */${size}`, 'content-length': 0 });
    return res.end();
  }
  res.writeHead(206, {
    ...headers,
    'content-length': span.end - span.start + 1,
    'content-range': `bytes ${span.start}-${span.end}/${size}`,
  });
  return pipeFile(res, path, span);
}

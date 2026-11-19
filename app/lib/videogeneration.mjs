// Local, source-grounded narrated slides. Jobs and intermediates stay in an ignored
// docs subdirectory; only a successfully rendered MP4 appears on the video shelf.
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config, REPO_ROOT } from './config.mjs';
import { readJsonSafe, writeFileAtomicSync, writeJsonAtomicSync } from './atomic.mjs';
import { listSources, readSource } from './opennotebook.mjs';
import { videoScriptFromSources } from './ollama.mjs';

const exec = promisify(execFile);
const DEFAULT_OUTPUT = resolve(process.env.STUDYDECK_VIDEO_DIR || join(REPO_ROOT, 'docs'));
const MAX_SOURCES = 20;
const MAX_SOURCE_CHARS = 1_000;
const MAX_TOTAL_CHARS = 18_000;

const VIDEO_JOB_DAMAGED = 'Video job state is damaged';

const videoError = (message, status = 502) => Object.assign(new Error(message), { status });

/**
 * One damaged job file is listed as `{ id, status: 'damaged', error }` instead of failing the
 * whole list. Dated jobs come newest first; markers have no date, so they follow, by id.
 * `read(id)` returns null, `{ damaged: true }` or `{ job }`. Shared with the Higgsfield list.
 */
export function listJobs(ids, read, damagedMessage) {
  const jobs = [];
  const damaged = [];
  for (const id of ids) {
    const found = read(id);
    if (found?.damaged) damaged.push({ id, status: 'damaged', error: damagedMessage });
    else if (found?.job) jobs.push(found.job);
  }
  jobs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  damaged.sort((a, b) => a.id.localeCompare(b.id));
  return [...jobs, ...damaged];
}
const cleanText = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const xml = (value) => cleanText(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const wordCount = (value) => cleanText(value).split(/\s+/).filter(Boolean).length;

export function normalizeVideoScript(value, knownSources) {
  const slides = value?.slides;
  if (!Array.isArray(slides) || slides.length < 3 || slides.length > 5) {
    throw videoError('The local model did not return 3 to 5 slides');
  }
  return slides.map((slide, index) => {
    const title = cleanText(slide?.title);
    const narration = cleanText(slide?.narration);
    const bullets = Array.isArray(slide?.bullets) ? slide.bullets.map(cleanText) : [];
    const sourceIds = slide?.source_ids;
    if (!title || title.length > 72 || bullets.length < 2 || bullets.length > 4
      || bullets.some((bullet) => !bullet || bullet.length > 120)
      || wordCount(narration) < 10 || wordCount(narration) > 120) {
      throw videoError(`The local model returned an incomplete or oversized slide ${index + 1}`);
    }
    if (!Array.isArray(sourceIds) || sourceIds.length === 0
      || sourceIds.some((id) => !knownSources.has(id))) {
      throw videoError(`The local model returned an invalid source anchor on slide ${index + 1}`);
    }
    return { title, bullets, narration, source_ids: [...new Set(sourceIds)] };
  });
}

function tool(envName, name) {
  const candidates = [process.env[envName], `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, name].filter(Boolean);
  return candidates.find((path) => path === name || existsSync(path)) ?? name;
}

async function command(binary, args, timeout = 180_000) {
  try {
    await exec(binary, args, { timeout, maxBuffer: 1_000_000 });
  } catch (err) {
    const detail = cleanText(err.stderr ?? err.message).slice(-250);
    throw videoError(`${binary.split('/').at(-1)} failed: ${detail}`);
  }
}

function wrap(value, maxChars) {
  const lines = [];
  let line = '';
  for (const word of cleanText(value).split(' ')) {
    if (line && `${line} ${word}`.length > maxChars) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function slideSvg(slide, { topicName, index, total, sources }) {
  const titleLines = wrap(slide.title, 35).slice(0, 2);
  let bulletY = titleLines.length > 1 ? 310 : 275;
  const bulletRows = slide.bullets.flatMap((bullet, bulletIndex) => {
    const lines = wrap(bullet, 52).slice(0, 2);
    const rows = lines.map((line, lineIndex) => {
      const y = bulletY + lineIndex * 31;
      return `${lineIndex ? '' : `<circle cx="84" cy="${y - 9}" r="4" fill="#efb45b"/>`}<text x="104" y="${y}" fill="#ece9e3" font-size="24" font-family="Avenir Next, Helvetica, sans-serif">${xml(line)}</text>`;
    });
    bulletY += lines.length * 31 + (bulletIndex === slide.bullets.length - 1 ? 0 : 15);
    return rows;
  });
  const cited = slide.source_ids.map((id) => sources.get(id)?.title ?? id).map((title) => cleanText(title)).join(' · ');
  const titleRows = titleLines.map((line, offset) => `<text x="80" y="${186 + offset * 64}" fill="#f6f1e8" font-size="52" font-weight="600" font-family="Avenir Next, Helvetica, sans-serif">${xml(line)}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
<rect width="1280" height="720" fill="#181d24"/><rect x="0" y="0" width="12" height="720" fill="#e7ab59"/>
<circle cx="1140" cy="150" r="250" fill="#25313b" opacity=".65"/><circle cx="1170" cy="150" r="160" fill="#2b3f43" opacity=".55"/>
<text x="80" y="77" fill="#e7ab59" font-size="24" letter-spacing="3" font-family="Avenir Next, Helvetica, sans-serif">STUDYDECK  /  VIDEO OVERVIEW</text>
<text x="80" y="111" fill="#9eabb3" font-size="20" font-family="Avenir Next, Helvetica, sans-serif">${xml(topicName)}</text>
${titleRows.join('\n')}
${bulletRows.join('\n')}
<rect x="80" y="627" width="1120" height="1" fill="#56616a"/>
<text x="80" y="665" fill="#a7b0b5" font-size="17" font-family="Avenir Next, Helvetica, sans-serif">SOURCE  ${xml(cited.slice(0, 100))}</text>
<text x="1140" y="665" fill="#e7ab59" font-size="21" font-family="Avenir Next, Helvetica, sans-serif">${index + 1} / ${total}</text>
</svg>`;
}

export async function collectSources(notebookId) {
  const listed = await listSources(notebookId);
  if (!listed.length) throw videoError('This notebook has no sources. Add a source in Reading Room first.', 400);
  const selected = listed.slice(0, MAX_SOURCES);
  const detailed = [];
  for (let start = 0; start < selected.length; start += 4) {
    detailed.push(...await Promise.all(selected.slice(start, start + 4).map((source) => readSource(source.id))));
  }
  let remaining = MAX_TOTAL_CHARS;
  const sources = detailed.flatMap((source) => {
    const text = cleanText(source.text).slice(0, Math.min(MAX_SOURCE_CHARS, remaining));
    remaining -= text.length;
    return text ? [{ id: source.id, title: source.title, excerpt: text }] : [];
  });
  if (!sources.length) throw videoError('These sources have no readable text yet. Wait for source processing and try again.', 400);
  return { sources, total: listed.length };
}

async function speech(text, path) {
  const { baseUrl, model } = config.tts;
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, voice: process.env.STUDYDECK_VIDEO_VOICE || 'af_nova', input: text, response_format: 'wav' }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw videoError(`Local Speaches TTS is unavailable: ${cleanText(err.message)}`, 503);
  }
  if (!response.ok) throw videoError(`Local Speaches TTS returned ${response.status}`, 503);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 44 || bytes.length > 12_000_000 || bytes.toString('ascii', 0, 4) !== 'RIFF') {
    throw videoError('Local Speaches TTS did not return usable WAV audio');
  }
  writeFileAtomicSync(path, bytes);
}

export async function renderLocalVideo(job, publishPath, update, workDir,
  { collect = collectSources, plan = videoScriptFromSources, speak = speech } = {}) {
  update('Reading notebook sources');
  const { sources, total } = await collect(job.notebook_id);
  update('Writing a source-grounded script with the local model');
  const script = normalizeVideoScript(await plan(job.topic_name, sources),
    new Set(sources.map((source) => source.id)));
  const jobPath = join(workDir, job.id);
  const sourceIndex = new Map(sources.map((source) => [source.id, source]));
  writeJsonAtomicSync(join(jobPath, 'script.json'), { topic: job.topic_name, model: config.ollama.model,
    sources: sources.map((source) => ({ id: source.id, title: source.title,
      excerpt_sha256: createHash('sha256').update(source.excerpt).digest('hex') })), slides: script });
  const parts = [];
  for (const [index, slide] of script.entries()) {
    update(`Narrating and rendering slide ${index + 1} of ${script.length}`);
    const stem = `slide-${String(index + 1).padStart(2, '0')}`;
    const svgPath = join(jobPath, `${stem}.svg`);
    const pngPath = join(jobPath, `${stem}.png`);
    const wavPath = join(jobPath, `${stem}.wav`);
    const mp4Path = join(jobPath, `${stem}.mp4`);
    writeFileAtomicSync(svgPath, slideSvg(slide, { topicName: job.topic_name, index, total: script.length, sources: sourceIndex }));
    await speak(slide.narration, wavPath);
    await command(tool('STUDYDECK_RSVG_CONVERT', 'rsvg-convert'), ['-o', pngPath, svgPath]);
    await command(tool('STUDYDECK_FFMPEG', 'ffmpeg'), [
      '-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-framerate', '24', '-i', pngPath,
      '-i', wavPath, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage',
      '-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p', '-shortest', '-movflags', '+faststart', mp4Path,
    ]);
    parts.push(mp4Path);
  }
  update('Assembling video');
  const concatPath = join(jobPath, 'segments.txt');
  writeFileAtomicSync(concatPath, parts.map((part) => `file '${part.replaceAll("'", "'\\''")}'`).join('\n') + '\n');
  const stagedPath = join(jobPath, 'final.mp4');
  await command(tool('STUDYDECK_FFMPEG', 'ffmpeg'), [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
    '-c', 'copy', '-movflags', '+faststart', stagedPath,
  ]);
  const probe = await exec(tool('STUDYDECK_FFPROBE', 'ffprobe'), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', stagedPath,
  ], { timeout: 10_000 });
  const duration = Number(JSON.parse(probe.stdout).format?.duration);
  if (!Number.isFinite(duration) || duration < 10 || duration > 900) throw videoError('Rendered video duration is invalid');
  renameSync(stagedPath, publishPath);
  return { slides: script.length, duration_seconds: Math.round(duration), source_count: total,
    used_sources: sources.map((source) => source.id), omitted_sources: total - sources.length,
    model: config.ollama.model, voice: process.env.STUDYDECK_VIDEO_VOICE || 'af_nova' };
}

export function createVideoService({ outputDir = DEFAULT_OUTPUT, workDir = join(outputDir, '.video-renders'), render = renderLocalVideo } = {}) {
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const active = new Set();
  const jobFile = (id) => join(workDir, id, 'job.json');
  // Damage is a value, not an exception: get() refuses it, list() reports it and lists the
  // rest. A thrown error from anywhere else still propagates from both.
  const read = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) return null;
    const { value, source } = readJsonSafe(jobFile(id), null);
    if (source === 'fallback') return { damaged: true };
    if (!value) return null;
    if (value.status === 'running' && !active.has(id)) {
      const published = join(outputDir, value.file);
      return { job: existsSync(published) && statSync(published).size > 0
        ? { ...value, status: 'completed', progress: 'Ready' }
        : { ...value, status: 'failed', error: 'Render interrupted by a server restart. Start a new video.' } };
    }
    return { job: value };
  };
  const get = (id) => {
    const found = read(id);
    if (found?.damaged) throw videoError(VIDEO_JOB_DAMAGED, 500);
    return found?.job ?? null;
  };
  const list = () => listJobs(readdirSync(workDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name), read, VIDEO_JOB_DAMAGED);

  const start = ({ topicSlug, topicName, notebookId, mutationId }) => {
    // A damaged job file can't be read, so a replay whose mutation_id is inside one starts a
    // second render. Accepted: it costs local compute only (job-list-damage spec F2).
    const replay = list().find((job) => job.status !== 'damaged' && job.mutation_id === mutationId);
    if (replay) {
      if (replay.topic_slug !== topicSlug || replay.notebook_id !== notebookId) {
        throw videoError('mutation_id was already used for a different notebook', 409);
      }
      return replay;
    }
    if (active.size) throw videoError('A video is already rendering. Wait for it to finish.', 409);
    const id = randomUUID();
    const file = `${topicSlug.replace(/[^a-z0-9-]/g, '-')}-overview-${id.slice(0, 8)}.mp4`;
    const job = { id, topic_slug: topicSlug, topic_name: topicName ?? topicSlug,
      notebook_id: notebookId, mutation_id: mutationId, file,
      status: 'running', progress: 'Queued', created_at: new Date().toISOString() };
    mkdirSync(join(workDir, id));
    writeJsonAtomicSync(jobFile(id), job);
    active.add(id);
    const update = (progress) => writeJsonAtomicSync(jobFile(id), { ...get(id), progress });
    Promise.resolve().then(async () => {
      try {
        const result = await render(job, join(outputDir, file), update, workDir);
        if (!existsSync(join(outputDir, file)) || statSync(join(outputDir, file)).size === 0) {
          throw videoError('Video renderer produced no output');
        }
        writeJsonAtomicSync(jobFile(id), { ...get(id), ...result, status: 'completed', progress: 'Ready', completed_at: new Date().toISOString() });
      } catch (err) {
        try { unlinkSync(join(outputDir, file)); } catch { /* no published output */ }
        writeJsonAtomicSync(jobFile(id), { ...get(id), status: 'failed', error: cleanText(err.message).slice(0, 350),
          completed_at: new Date().toISOString() });
      } finally {
        active.delete(id);
      }
    });
    return job;
  };
  return { start, get, list };
}

export const videoService = createVideoService();

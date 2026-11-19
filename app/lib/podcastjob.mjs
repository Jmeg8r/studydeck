// WHAT: The one table of Open Notebook podcast-job statuses, and their normalized
//       lifecycle for browser consumers.
// WHY: The job poll, the retry planner and the canary sweep each kept a copy, and every
//      copy missed `new`: ON's jobs are surreal_commands commands (new, running,
//      completed, failed, canceled; `unknown` when ON has no record), so a queued job
//      read as finished and a retry deleted it. Read the statuses from this file only.

// `new` and `running` are what ON reports. The rest are spellings earlier code accepted;
// they cost nothing to keep. `submitted` is the generate route's reply, not a job status.
export const ACTIVE_JOB_STATUSES = new Set([
  'new', 'running', 'pending', 'queued', 'started', 'processing', 'in_progress', 'submitted',
]);

const SUCCESS = 'completed';

export function isActiveJobStatus(status) {
  return ACTIVE_JOB_STATUSES.has(String(status).toLowerCase());
}

export function normalizePodcastJob(job, fallbackId) {
  const status = String(job.status ?? 'unknown').toLowerCase();
  const terminal = !ACTIVE_JOB_STATUSES.has(status);
  // ON sends `''` rather than omitting the field, so a blank message is no message.
  const message = String(job.error_message ?? '').trim() || null;
  const successful = terminal && status === SUCCESS && !message;
  const error = message
    ?? (terminal && !successful ? `Open Notebook reported the job as ${status}` : null);
  return {
    job_id: job.job_id ?? fallbackId,
    status,
    progress: job.progress ?? null,
    result: job.result ?? null,
    error,
    updated: job.updated ?? null,
    terminal,
    successful,
    retryable: terminal && !successful,
  };
}

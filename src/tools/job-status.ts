import { ApiRequestError } from '../http-client.js';

/**
 * One status vocabulary for every Sync job, so an agent waits on all of them the same way.
 * Each kind's own read tool keeps returning its API status; jobs_get and jobs_wait add the
 * unified one. docs/jobs.md has the full table.
 */
export const JOB_STATUSES = [
  'PENDING',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'REJECTED',
  'CANCELED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_KINDS = [
  'generation',
  'transcription',
  'speaker_analysis',
  'translation_preview',
  'import',
  'batch',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

const TERMINAL = new Set<JobStatus>(['COMPLETED', 'FAILED', 'REJECTED', 'CANCELED']);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

// API statuses that are not already a unified name. Case is ignored.
const ALIASES: Record<string, JobStatus> = {
  QUEUED: 'PENDING',
  DOWNLOADING: 'PROCESSING',
  // Translation previews attach their output after the provider finishes.
  COMPLETING: 'PROCESSING',
  // A batch has created its generations, or is writing its result file.
  JOBS_CREATED: 'PROCESSING',
  FINISHING: 'PROCESSING',
  CANCELLED: 'CANCELED',
  // Speaker analysis that cannot run for this source (no faces, too long, audio only).
  UNAVAILABLE: 'FAILED',
};

/** The API's own status string on a job payload, if it has one. */
export function rawStatus(payload: unknown): string | undefined {
  const status =
    payload && typeof payload === 'object' ? (payload as { status?: unknown }).status : undefined;
  return typeof status === 'string' ? status : undefined;
}

/**
 * Maps a job payload's `status` to the unified status. A payload without a status counts
 * as COMPLETED, as the per-kind waiters always did, so a wait never spins on a shape it
 * cannot read; an unknown status counts as PROCESSING, so the wait keeps going until the
 * budget runs out instead of reporting a result that may not exist.
 */
export function jobStatus(payload: unknown): JobStatus {
  const raw = rawStatus(payload);
  if (raw === undefined) return 'COMPLETED';
  const status = raw.trim().toUpperCase();
  if ((JOB_STATUSES as readonly string[]).includes(status)) return status as JobStatus;
  return ALIASES[status] ?? 'PROCESSING';
}

/**
 * Whether a wait should stop on this payload. A translation preview with recoveryRequired
 * stays in its status, but polling will not resolve it: provider acceptance is uncertain
 * and only Sync can recover it.
 */
export function jobSettled(payload: unknown): boolean {
  return (
    isTerminal(jobStatus(payload)) ||
    (payload as { recoveryRequired?: unknown } | null)?.recoveryRequired === true
  );
}

/** True for the 409 a social link import answers while it is still downloading. */
export function isImportInProgress(error: unknown): error is ApiRequestError {
  return (
    error instanceof ApiRequestError && error.status === 409 && error.code === 'import_in_progress'
  );
}

// Import error codes from the API's ImportErrorCodes. Unlisted import_* codes are refusals.
const IMPORT_ERROR_STATUS: Record<string, JobStatus> = {
  import_failed: 'FAILED',
  import_download_failed: 'FAILED',
  import_upload_failed: 'FAILED',
  import_processing_failed: 'FAILED',
  import_cancelled_by_user: 'CANCELED',
};

/**
 * The unified status for an error from a social link import, or undefined when the error
 * did not come from the import (auth, the project-intent guard, the network) and should
 * stay a tool error.
 */
export function importErrorStatus(error: unknown): JobStatus | undefined {
  if (!(error instanceof ApiRequestError) || !error.code?.startsWith('import_')) return undefined;
  if (error.status === 409 && error.code === 'import_in_progress')
    return error.importDetails?.importStatus === 'queued' ? 'PENDING' : 'PROCESSING';
  return IMPORT_ERROR_STATUS[error.code] ?? 'REJECTED';
}

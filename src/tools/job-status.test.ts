import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../http-client.js';
import { importErrorStatus, jobSettled, jobStatus } from './job-status.js';

const importError = (status: number, code: string, details = {}) =>
  new ApiRequestError(`API request failed: ${status}`, status, code, undefined, undefined, details);

describe('unified job status', () => {
  it.each([
    // generation (/v2/generate/{id})
    ['PENDING', 'PENDING'],
    ['PROCESSING', 'PROCESSING'],
    ['COMPLETED', 'COMPLETED'],
    ['FAILED', 'FAILED'],
    ['REJECTED', 'REJECTED'],
    ['CANCELED', 'CANCELED'],
    ['CANCELLED', 'CANCELED'],
    // translation preview (/v2/integrations/dubbing/{id})
    ['COMPLETING', 'PROCESSING'],
    // speaker analysis, lowercase
    ['processing', 'PROCESSING'],
    ['completed', 'COMPLETED'],
    ['unavailable', 'FAILED'],
    // import statuses
    ['queued', 'PENDING'],
    ['downloading', 'PROCESSING'],
    // anything new keeps the wait going rather than inventing a result
    ['SOMETHING_NEW', 'PROCESSING'],
  ])('maps %s to %s', (raw, unified) => {
    expect(jobStatus({ status: raw })).toBe(unified);
  });

  it('treats a payload without a status as finished, as the per-kind waiters did', () => {
    expect(jobStatus({ id: 'x' })).toBe('COMPLETED');
    expect(jobStatus(null)).toBe('COMPLETED');
  });

  it('stops waiting on terminal states and on a translation needing recovery', () => {
    expect(jobSettled({ status: 'PROCESSING' })).toBe(false);
    expect(jobSettled({ status: 'REJECTED' })).toBe(true);
    expect(jobSettled({ status: 'unavailable' })).toBe(true);
    expect(jobSettled({ status: 'PROCESSING', recoveryRequired: true })).toBe(true);
  });

  it('maps import errors, and leaves errors that are not about the import alone', () => {
    expect(
      importErrorStatus(importError(409, 'import_in_progress', { importStatus: 'queued' })),
    ).toBe('PENDING');
    expect(
      importErrorStatus(importError(409, 'import_in_progress', { importStatus: 'downloading' })),
    ).toBe('PROCESSING');
    expect(importErrorStatus(importError(422, 'import_failed'))).toBe('FAILED');
    expect(importErrorStatus(importError(422, 'import_download_failed'))).toBe('FAILED');
    expect(importErrorStatus(importError(409, 'import_cancelled_by_user'))).toBe('CANCELED');
    for (const code of [
      'import_not_enabled',
      'import_unavailable',
      'import_daily_limit_reached',
      'import_invalid_url',
      'import_unsupported_platform',
    ])
      expect(importErrorStatus(importError(403, code)), code).toBe('REJECTED');
    expect(importErrorStatus(importError(400, 'PROJECT_INTENT_REQUIRED'))).toBeUndefined();
    expect(importErrorStatus(new Error('network'))).toBeUndefined();
  });
});

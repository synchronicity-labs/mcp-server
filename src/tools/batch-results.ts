import { z } from 'zod';
import { boundedBy, TIMED_OUT } from './job-wait.js';

/**
 * A finished batch's results. The API writes one JSONL line per item (request_id, status,
 * error and the /v2/generate response) and serves the file publicly behind the API origin;
 * batches_get turns it into rows the agent can use without downloading anything.
 */

export const BATCH_DONE = new Set(['COMPLETED', 'FAILED']);
const RESULTS_TIMEOUT_MS = 30_000;
const MAX_RESULTS_BYTES = 20 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const resultRow = z.object({
  requestId: z.string(),
  status: z.string().describe('The generation status: COMPLETED, FAILED or REJECTED.'),
  generationId: z.string().optional().describe('Read it with generate_get-generation.'),
  outputMediaUrl: z.string().optional().describe('The finished video; return it verbatim.'),
  error: z.unknown().optional(),
});
type ResultRow = z.infer<typeof resultRow>;

function rowOf(line: unknown): ResultRow | undefined {
  if (!isRecord(line) || typeof line.request_id !== 'string') return undefined;
  const response = isRecord(line.response) ? line.response : {};
  const output = response.outputMediaUrl ?? response.outputUrl;
  return {
    requestId: line.request_id,
    status: typeof line.status === 'string' ? line.status : 'UNKNOWN',
    ...(typeof response.id === 'string' ? { generationId: response.id } : {}),
    ...(typeof output === 'string' && output ? { outputMediaUrl: output } : {}),
    ...(line.error === null || line.error === undefined ? {} : { error: line.error }),
  };
}

const TOO_LARGE = 'the result file is too large to read here';

/**
 * The body as text, counting decoded bytes as they arrive, so a chunked or compressed
 * file cannot grow past the cap in memory: the download is canceled once it would.
 */
async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESULTS_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error(TOO_LARGE);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The result file is public behind the API origin, which redirects to a signed copy; it
 * is fetched without credentials, and only from the API origin.
 */
async function readResults(
  outputUrl: string,
  apiBaseUrl: string,
  signal: AbortSignal | undefined,
): Promise<ResultRow[]> {
  const url = new URL(outputUrl);
  if (url.origin !== new URL(apiBaseUrl).origin)
    throw new Error(`the result file is not on the Sync API (${url.origin})`);
  const response = await boundedBy(RESULTS_TIMEOUT_MS, signal, (bounded) =>
    fetch(url, { signal: bounded, redirect: 'follow' }).then(async (res) => {
      if (!res.ok) throw new Error(`the result file answered ${res.status}`);
      if (Number(res.headers.get('content-length') ?? 0) > MAX_RESULTS_BYTES)
        throw new Error(TOO_LARGE);
      return readCapped(res);
    }),
  );
  if (response === TIMED_OUT) throw new Error('reading the result file timed out');
  return response
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => rowOf(JSON.parse(line)))
    .filter((row): row is ResultRow => row !== undefined);
}

const FAILED_ROW = new Set(['FAILED', 'REJECTED']);

export async function withResults(
  batch: Record<string, unknown>,
  which: 'all' | 'failed' | 'none',
  apiBaseUrl: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  if (which === 'none' || !BATCH_DONE.has(String(batch.status))) return batch;
  if (typeof batch.outputUrl !== 'string' || batch.outputUrl === '') return batch;
  try {
    const rows = await readResults(batch.outputUrl, apiBaseUrl, signal);
    return {
      ...batch,
      results: which === 'failed' ? rows.filter((row) => FAILED_ROW.has(row.status)) : rows,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...batch,
      resultsError: `${reason}. Download outputUrl (JSONL, one line per item with request_id, status, error and response) or find the generations with generate_get-generations.`,
    };
  }
}

import { z } from 'zod';
import { ApiRequestError, cameFromApi } from '../http-client.js';

/** One argument's shape: a closed-set value, or a kind that carries none of the content. */
export type Facet = string | number | boolean;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_VALUE = /^[A-Za-z0-9 ._:+/(),-]{1,64}$/;
const LANGUAGE_FIELD = /(language|locale|lang)s?$/i;
const LANGUAGE_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/i;
const LOCAL_PATH = /^(\/|~\/|\.\.?\/|[A-Za-z]:[\\/]|\\\\)/;
// Fields that name a product choice, not content, though the API types them as free strings.
// A single token is recorded; anything with spaces is treated as text.
const IDENTIFIER_FIELDS = new Set([
  'model',
  'provider',
  'voiceId',
  'format',
  'contentType',
  'status',
  'tool',
  'errorCode',
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const MAX_FIELDS = 40;

// Public platforms only: any other host, a customer's own domain included, is "other".
const HOST_CLASSES: [string, readonly string[]][] = [
  ['youtube', ['youtube.com', 'youtu.be']],
  ['tiktok', ['tiktok.com']],
  ['instagram', ['instagram.com']],
  ['x', ['x.com', 'twitter.com']],
  ['facebook', ['facebook.com', 'fb.watch']],
  ['vimeo', ['vimeo.com']],
  ['google_drive', ['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com']],
  ['dropbox', ['dropbox.com', 'dropboxusercontent.com']],
  ['sync', ['sync.so']],
  ['openai_file', ['oaiusercontent.com', 'oaistatic.com']],
  ['s3', ['amazonaws.com']],
  ['gcs', ['storage.googleapis.com']],
];

export function urlClass(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol === 'file:') return 'path';
  if (url.protocol === 'data:') return 'url:data';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase();
  const match = HOST_CLASSES.find(([, suffixes]) =>
    suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)),
  );
  return `url:${match?.[0] ?? 'other'}`;
}

export function textBucket(length: number): string {
  if (length <= 20) return 'text:1-20';
  if (length <= 100) return 'text:21-100';
  if (length <= 500) return 'text:101-500';
  if (length <= 2000) return 'text:501-2000';
  return 'text:2001+';
}

// The values a field's schema allows, if it is a closed set. Read once per field.
const closedSets = new WeakMap<z.ZodType, ReadonlySet<string> | null>();

function collectEnum(schema: unknown, into: Set<string>): boolean {
  if (!schema || typeof schema !== 'object') return false;
  const node = schema as { enum?: unknown; const?: unknown; anyOf?: unknown; oneOf?: unknown };
  let found = false;
  if (Array.isArray(node.enum))
    for (const value of node.enum)
      if (typeof value === 'string') {
        into.add(value);
        found = true;
      }
  if (typeof node.const === 'string') {
    into.add(node.const);
    found = true;
  }
  for (const branch of [node.anyOf, node.oneOf])
    if (Array.isArray(branch)) for (const item of branch) found = collectEnum(item, into) || found;
  return found;
}

function closedSet(schema: z.ZodType): ReadonlySet<string> | null {
  const cached = closedSets.get(schema);
  if (cached !== undefined) return cached;
  let values: Set<string> | null = new Set();
  try {
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    if (!collectEnum(json, values)) values = null;
  } catch {
    values = null;
  }
  closedSets.set(schema, values);
  return values;
}

function stringFacet(key: string, value: string, schema: z.ZodType | undefined): Facet {
  if (schema && closedSet(schema)?.has(value)) return SAFE_VALUE.test(value) ? value : 'enum';
  if (UUID.test(value)) return 'uuid';
  const url = urlClass(value);
  if (url) return url;
  if (LOCAL_PATH.test(value)) return 'path';
  if (LANGUAGE_FIELD.test(key) && LANGUAGE_CODE.test(value)) return value;
  if (IDENTIFIER_FIELDS.has(key) && IDENTIFIER.test(value)) return value;
  return textBucket(value.length);
}

function arrayFacet(key: string, value: unknown[]): Facet {
  // "Which languages do people dub into" is a product question; codes are not content.
  if (
    LANGUAGE_FIELD.test(key) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && LANGUAGE_CODE.test(item))
  ) {
    const joined = [...new Set(value as string[])].sort().join(',');
    if (joined.length <= 64) return joined;
  }
  return `array:${value.length}`;
}

function facet(key: string, value: unknown, schema: z.ZodType | undefined): Facet | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 'nan';
  if (typeof value === 'string') return stringFacet(key, value, schema);
  if (Array.isArray(value)) return arrayFacet(key, value);
  return typeof value === 'object' ? 'object' : undefined;
}

/** Facets of the fields the tool declares. Undeclared fields are never read. */
export function argumentFacets(
  shape: Record<string, z.ZodType>,
  args: Record<string, unknown> | undefined,
): Record<string, Facet> {
  const facets: Record<string, Facet> = {};
  if (!args || typeof args !== 'object') return facets;
  for (const key of Object.keys(shape)) {
    if (Object.keys(facets).length >= MAX_FIELDS) break;
    if (!/^[A-Za-z0-9_]{1,64}$/.test(key) || !Object.hasOwn(args, key)) continue;
    const value = facet(key, args[key], shape[key]);
    if (value !== undefined) facets[key] = value;
  }
  return facets;
}

/** The declared top-level fields that failed validation. */
export function invalidFields(
  shape: Record<string, z.ZodType>,
  args: Record<string, unknown> | undefined,
): string[] {
  const result = z.object(shape).safeParse(args ?? {});
  if (result.success) return [];
  return [
    ...new Set(
      result.error.issues.flatMap((issue) => {
        const key = issue.path[0];
        return typeof key === 'string' && Object.hasOwn(shape, key) ? [key] : [];
      }),
    ),
  ].slice(0, 20);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function uuidAt(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && UUID.test(value));
}

const LIST_KEYS = [
  'items',
  'data',
  'generations',
  'assets',
  'projects',
  'voices',
  'jobs',
  'results',
];

/** IDs, status and size a result returned; nothing else of it. */
export function resultFacets(tool: string, result: unknown): Record<string, string | number> {
  const outer = asObject(result);
  const body = asObject(outer?.structuredContent) ?? outer;
  if (Array.isArray(result)) return { result_count: result.length };
  if (!body) return {};
  const generation = asObject(body.generation);
  const job = asObject(body.job);
  const project = asObject(body.project);
  const createsGeneration = /^(lipsync|dubbing|dialogue-videos|generations|translation)/.test(tool);
  const generationId = uuidAt(
    body.generationId,
    generation?.id,
    createsGeneration && tool.includes('create') ? body.id : undefined,
  );
  const jobId = uuidAt(body.jobId, job?.id, tool.startsWith('jobs_') ? body.id : undefined);
  const batchId = uuidAt(body.batchId, tool.startsWith('batches_') ? body.id : undefined);
  const projectId = uuidAt(body.projectId, project?.id);
  const status = [body.status, generation?.status, job?.status].find(
    (value): value is string => typeof value === 'string' && /^[A-Za-z_]{1,32}$/.test(value),
  );
  const list = LIST_KEYS.map((key) => body[key]).find(Array.isArray);
  return {
    ...(generationId && { generation_id: generationId }),
    ...(jobId && { job_id: jobId }),
    ...(batchId && { batch_id: batchId }),
    ...(projectId && { project_id: projectId }),
    ...(status && { result_status: status }),
    ...(list && { result_count: Math.min(list.length, 100_000) }),
  };
}

export type Outcome =
  | 'success'
  | 'invalid_arguments'
  | 'refused'
  | 'api_error'
  | 'timeout'
  | 'cancelled'
  | 'tool_error';

export type OutcomeFacets = {
  outcome: Outcome;
  error_status?: number;
  error_code?: string;
};

const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,80}$/;

function withDetails(outcome: Outcome, status: unknown, code: unknown): OutcomeFacets {
  return {
    outcome,
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { error_status: status }
      : {}),
    ...(typeof code === 'string' && ERROR_CODE.test(code) ? { error_code: code } : {}),
  };
}

function resultOutcome(result: unknown): OutcomeFacets {
  const outer = asObject(result);
  if (outer?.isError !== true) return { outcome: 'success' };
  const error = asObject(asObject(outer.structuredContent)?.error);
  return error?.status === undefined
    ? withDetails('tool_error', undefined, error?.code)
    : withDetails('api_error', error.status, error.code);
}

/** Why a call ended, from what it threw or returned. Never the message: it can echo input. */
export function classifyOutcome(
  error: unknown,
  result: unknown,
  signal?: AbortSignal,
): OutcomeFacets {
  if (error === undefined) return resultOutcome(result);
  if (error instanceof z.ZodError) return { outcome: 'invalid_arguments' };
  if (error instanceof ApiRequestError)
    return withDetails(cameFromApi(error) ? 'api_error' : 'refused', error.status, error.code);
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    return { outcome: signal?.aborted ? 'cancelled' : 'timeout' };
  // This server's own checks throw plain errors; anything else is unexpected.
  if (error instanceof Error && error.constructor === Error) return { outcome: 'refused' };
  return { outcome: 'tool_error' };
}

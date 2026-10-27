import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';

const platform = z.enum(['youtube', 'tiktok', 'instagram', 'facebook', 'dropbox', 'unsupported']);
const state = z.enum(['queued', 'downloading', 'processing', 'completed', 'failed']);
const urlInput = z.object({
  url: z.url().refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'Use an HTTP(S) URL without credentials.'),
});
const jobInput = z.object({ jobId: z.uuid() });
const metadata = z.object({
  title: z.string(),
  author: z.string(),
  durationSeconds: z.number().finite().nonnegative(),
  thumbnailUrl: z.string().nullable(),
  description: z.string().optional(),
  platform: z.string(),
  fileSizeBytes: z.number().finite().nonnegative(),
  availableQualities: z.array(z.string()),
});
const jobMetadata = z.object({
  title: z.string(),
  author: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  durationSeconds: z.number().nullable(),
});
const job = z.object({
  jobId: z.uuid(),
  platform: z.string(),
  status: state,
  progress: z.number().min(0).max(100),
  assetId: z.uuid().optional(),
  errorMessage: z.string().optional(),
  metadata: jobMetadata.optional(),
  startedAt: z.string(),
  updatedAt: z.string(),
});
const listedJob = job.omit({ startedAt: true, assetId: true, errorMessage: true }).extend({
  sourceUrl: z.string(),
  assetId: z.uuid().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  project: z.object({ id: z.uuid(), name: z.string() }).nullable(),
});
const start = urlInput.extend({
  projectId: z.uuid(),
  options: z
    .object({ quality: z.string().optional(), generateThumbnail: z.boolean().optional() })
    .optional(),
});
const list = z.object({
  projectId: z.uuid(),
  limit: z.number().int().min(1).max(100).default(100),
  offset: z.number().int().nonnegative().default(0),
});
const routes = [
  ['detect', 'get'],
  ['metadata', 'get'],
  ['start', 'post'],
  ['status', 'get'],
  ['', 'get'],
  ['cancel', 'post'],
  ['retry', 'post'],
] as const;
export function isPlatformImportOperation(operation: ParsedOperation) {
  return routes.some(
    ([name, method]) =>
      operation.path === `/v2/platform-import${name ? `/${name}` : ''}` &&
      operation.method === method,
  );
}
export function supportsPlatformImports(operations: ParsedOperation[]) {
  return routes.every(([name, method]) =>
    operations.some(
      (op) => op.path === `/v2/platform-import${name ? `/${name}` : ''}` && op.method === method,
    ),
  );
}
export function createPlatformImportTools(
  operations: ParsedOperation[],
  http: HttpClient,
): McpToolDefinition[] {
  if (!supportsPlatformImports(operations)) return [];
  function tool<I extends z.ZodObject, O extends z.ZodObject>(
    name: string,
    route: string,
    method: 'get' | 'post',
    input: I,
    output: O,
    description: string,
  ): McpToolDefinition {
    return {
      name,
      title: name.replaceAll('-', ' '),
      description,
      inputSchema: input.shape,
      outputSchema: output.shape,
      annotations: {
        readOnlyHint: method === 'get',
        destructiveHint: route === 'cancel',
        idempotentHint: method === 'get',
        openWorldHint: route === 'metadata' || route === 'start' || route === 'retry',
      },
      handler: async (raw, context) => {
        const args = input.parse(raw);
        const actor = z
          .object({ account: z.object({ id: z.uuid() }).nullable() })
          .parse(await http.request('get', '/v2/oauth/account', { signal: context?.signal }));
        if (!actor.account)
          throw new Error('Platform imports require a connected Sync user account.');
        const query =
          method === 'get'
            ? Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)]))
            : undefined;
        return output.parse(
          await http.request(method, `/v2/platform-import${route ? `/${route}` : ''}`, {
            query,
            body: method === 'post' ? args : undefined,
            signal: context?.signal,
          }),
        );
      },
    };
  }
  return [
    tool(
      'detect-platform-link',
      'detect',
      'get',
      urlInput,
      z.object({
        platform,
        supported: z.boolean(),
        normalizedUrl: z.string(),
        reason: z.string().optional(),
      }),
      'Detect whether a link is supported for video import. Does not import or start generation.',
    ),
    tool(
      'get-platform-link-metadata',
      'metadata',
      'get',
      urlInput,
      metadata,
      'Read a supported video link preview. Requires current account eligibility; a temporary preview failure does not establish that import will fail.',
    ),
    tool(
      'start-platform-import',
      'start',
      'post',
      start,
      z.object({ jobId: z.uuid(), status: z.literal('queued') }),
      'Import a supported video link into the selected accessible project. Confirm the link and media rights first. Returns a job: poll get-platform-import, then read its assetId. Limits and platform restrictions apply. A queued response can refer to an already completed import. After uncertain admission, use list-platform-imports to recover; never blindly repeat start. Does not generate a video.',
    ),
    tool(
      'get-platform-import',
      'status',
      'get',
      jobInput,
      job,
      'Read one existing import job in the connected user/team. Poll this job instead of starting another import. Read the canonical asset after completion.',
    ),
    tool(
      'list-platform-imports',
      '',
      'get',
      list,
      z.object({ jobs: listedJob.array(), total: z.number().int().nonnegative() }),
      'Read paginated import jobs for an accessible project to recover an interrupted start or resume existing downloads. Does not start or retry imports.',
    ),
    tool(
      'cancel-platform-import',
      'cancel',
      'post',
      jobInput,
      z.object({ success: z.boolean() }),
      'Cancel an existing active import only on explicit request. Stops its download/conversion; it does not delete a completed asset. Reconcile uncertain cancellation through get-platform-import.',
    ),
    tool(
      'retry-platform-import',
      'retry',
      'post',
      jobInput,
      z.object({ success: z.boolean(), newJobId: z.uuid() }),
      'Explicitly retry a failed video import after user confirmation. Counts toward import limits. Poll the returned newJobId; do not automatically retry uncertain responses.',
    ),
  ];
}

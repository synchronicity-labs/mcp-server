import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';
import {
  AcknowledgeStudioViewSchema,
  RegisterStudioViewSchema,
  RequestStudioViewActionSchema,
  StudioViewSchema,
} from './studio-view-contract.js';

export function supportsStudioViews(operations: ParsedOperation[]) {
  return [
    ['StudioViewsController_get', 'get'],
    ['StudioViewsController_register', 'put'],
    ['StudioViewsController_request', 'post'],
    ['StudioViewsController_acknowledge', 'post'],
  ].every(([id, method]) =>
    operations.some(
      (op) => op.operationId === id && op.method === method && op.studioViewVersion === 1,
    ),
  );
}
export function createStudioViewTools(
  operations: ParsedOperation[],
  http: HttpClient,
): McpToolDefinition[] {
  if (!supportsStudioViews(operations)) return [];
  const viewId = z.uuid();
  return (
    [
      ['get-studio-view', 'Read mounted Studio view', z.object({}), '', 'get', false],
      [
        'request-studio-view-action',
        'Request a mounted Studio action',
        RequestStudioViewActionSchema,
        '/actions',
        'post',
        false,
      ],
      [
        'register-studio-view',
        'Register mounted Studio view',
        RegisterStudioViewSchema,
        '',
        'put',
        true,
      ],
      [
        'ack-studio-view',
        'Acknowledge displayed Studio action',
        AcknowledgeStudioViewSchema,
        '/acknowledgement',
        'post',
        true,
      ],
    ] as const
  ).map(
    ([name, title, schema, suffix, method, appOnly]): McpToolDefinition => ({
      name,
      title,
      description:
        method === 'get'
          ? 'Read the exact viewId published by the mounted Studio, including its current revision and last action receipt. No view list or inferred latest widget. pending means not displayed; blocked needs the UI action/recovery completed; failed was not confirmed; applied confirms that action was displayed. An unavailable view must be reopened.'
          : appOnly
            ? 'Studio-only view ownership/context and application receipt. No provider work.'
            : 'After a backend create/open/rename/upload/generation succeeds, request navigation or refresh in the exact published viewId. First get-studio-view, use its expectedRevision and a fresh UUID id; retry an uncertain handoff with the SAME id/body. This never repeats backend creation or paid work. Use open-project for creation/opening, refresh-project after rename, refresh-assets after upload/registration, open-generation for the already accepted generationId, and continue-generation for an explicit result continuation (may register existing output as media, never generate). Media selection, workflow/model/options/language/unsent speech edits use get-studio-draft and update-studio-draft with revision checks. Do not infer UI success from backend success: check this action receipt through get-studio-view and report pending/blocked/failed until applied. Do not replace unresolved actions, guess a widget, or automatically overwrite stale edits.',
      inputSchema: { viewId, ...schema.shape },
      outputSchema: StudioViewSchema.shape,
      annotations: {
        readOnlyHint: method === 'get',
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...(appOnly ? { meta: { ui: { visibility: ['app'] } } } : {}),
      handler: async (args, context) => {
        const { viewId: rawId, ...body } = args;
        const id = viewId.parse(rawId);
        return StudioViewSchema.refine((view) => view.id === id).parse(
          await http.request(method, `/v2/studio-views/${id}${suffix}`, {
            body: method === 'get' ? undefined : schema.parse(body),
            signal: context?.signal,
          }),
        );
      },
    }),
  );
}

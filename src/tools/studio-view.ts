import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import type { McpToolDefinition } from './generator.js';
import {
  AcknowledgeStudioViewSchema,
  RegisterStudioViewSchema,
  RequestStudioViewActionSchema,
  StudioViewCommandSchema,
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
  const instructions =
    ' First get-studio-view for the exact published viewId, use its expectedRevision and a fresh UUID id; retry an uncertain handoff with the SAME id/body. Do not replace unresolved actions, guess a widget, or overwrite stale edits. This never repeats backend creation or paid work. Check the action receipt through get-studio-view: only applied confirms UI display; pending/blocked/failed do not. Draft selection/settings edits use get-studio-draft and update-studio-draft.';
  const actions = {
    'open-project': {
      name: 'open-studio-project',
      title: 'Open a project in Studio',
      description:
        'Open an existing project in the mounted Studio, optionally selecting its workflow. Preserves saved drafts; does not create a project or generate media.',
    },
    'refresh-project': {
      name: 'refresh-studio-project',
      title: 'Refresh Studio project details',
      description:
        'Refresh an existing project in the mounted Studio after its backend details change, such as a rename. Does not rename or create the project.',
    },
    'refresh-assets': {
      name: 'refresh-studio-assets',
      title: 'Refresh Studio media',
      description:
        'Refresh an existing project’s media in the mounted Studio after an upload or asset registration succeeds. Does not upload, register, delete or select media.',
    },
    'open-generation': {
      name: 'show-studio-generation',
      title: 'Show an existing Studio generation',
      description:
        'Display an already accepted generation or its result in the mounted Studio, opening its project if needed. Does not submit or retry generation.',
    },
    'continue-generation': {
      name: 'continue-studio-generation',
      title: 'Continue an existing Studio generation',
      description:
        'For an explicit user request, stage an existing generation’s source input or output as a new editable draft in the selected workflow. Replaces the active draft and archives its prior state; output continuation may register existing output as Sync media. Does not generate or synthesize media.',
    },
  };
  const actionTools = StudioViewCommandSchema.options.map((command) => {
    const { type: discriminator, ...fields } = command.shape;
    const type = discriminator.value;
    const schema = RequestStudioViewActionSchema.omit({ command: true }).extend(fields);
    return {
      ...actions[type],
      description: actions[type].description + instructions,
      schema,
      bodySchema: schema.transform(({ id, expectedRevision, ...fields }) => ({
        id,
        expectedRevision,
        command: command.parse({ ...fields, type }),
      })),
      suffix: '/actions',
      method: 'post' as const,
      appOnly: false,
      destructive: type === 'continue-generation',
    };
  });
  const tools = [
    [
      'get-studio-view',
      'Read mounted Studio view',
      z.object({}),
      '',
      'get',
      false,
      'Read the exact viewId published by the mounted Studio, including its current revision and last action receipt. No view list or inferred latest widget. pending means not displayed; blocked needs the UI action/recovery completed; failed was not confirmed; applied confirms that action was displayed. An unavailable view must be reopened.',
    ],
    [
      'register-studio-view',
      'Register mounted Studio view',
      RegisterStudioViewSchema,
      '',
      'put',
      true,
      'Studio-only view ownership/context registration. No provider work.',
    ],
    [
      'ack-studio-view',
      'Acknowledge displayed Studio action',
      AcknowledgeStudioViewSchema,
      '/acknowledgement',
      'post',
      true,
      'Studio-only application receipt. No provider work.',
    ],
  ] as const;
  return [
    ...tools.map(([name, title, schema, suffix, method, appOnly, description]) => ({
      name,
      title,
      schema,
      bodySchema: schema,
      suffix,
      method,
      appOnly,
      description,
      destructive: false,
    })),
    ...actionTools,
  ].map(
    ({
      name,
      title,
      schema,
      bodySchema,
      suffix,
      method,
      appOnly,
      description,
      destructive,
    }): McpToolDefinition => ({
      name,
      title,
      description,
      inputSchema: { viewId, ...schema.shape },
      outputSchema: StudioViewSchema.shape,
      annotations: {
        readOnlyHint: method === 'get',
        destructiveHint: destructive,
        idempotentHint: true,
        openWorldHint: false,
      },
      ...(appOnly ? { meta: { ui: { visibility: ['app'] } } } : {}),
      handler: async (args, context) => {
        const { viewId: rawId, ...body } = args;
        const id = viewId.parse(rawId);
        return StudioViewSchema.refine((view) => view.id === id).parse(
          await http.request(method, `/v2/studio-views/${id}${suffix}`, {
            body: method === 'get' ? undefined : bodySchema.parse(body),
            signal: context?.signal,
          }),
        );
      },
    }),
  );
}

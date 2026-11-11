import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { resolveClientProfile } from './client-profile.js';
import { ApiRequestError } from './http-client.js';
import {
  createJsonToolResult,
  createToolDescriptorMeta,
  createToolErrorResult,
  logToolError,
  registerTools,
  SERVER_INSTRUCTIONS,
  selectHostedHttpTools,
  serverInstructions,
} from './server.js';
import type { McpToolDefinition } from './tools/index.js';
import { generationOutputSchema } from './tools/output-schemas.js';
import { UploadOverloadedError } from './upload-runtime.js';

function tool(name: string): McpToolDefinition {
  return {
    name,
    description: `${name} description`,
    inputSchema: {},
    handler: async () => ({}),
  };
}

describe('registered tool labels', () => {
  it('advertises lowercase labels while preserving tool names and result data', async () => {
    const server = new McpServer({ name: 'sync', version: 'test' });
    const result = { outputUrl: 'https://Example.com/Video.mp4?Token=AbC' };
    registerTools(server, [
      {
        ...tool('projects_list'),
        resultFormat: 'json',
        title: 'List Sync Projects',
        meta: { 'openai/toolInvocation/invoking': 'Loading Sync Projects…' },
        handler: async () => result,
      },
    ]);
    const client = new Client({ name: 'test', version: 'test' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    try {
      await client.connect(clientTransport);
      expect((await client.listTools()).tools[0]).toMatchObject({
        name: 'projects_list',
        title: 'list sync projects',
        _meta: { 'openai/toolInvocation/invoking': 'loading sync projects…' },
      });
      expect((await client.callTool({ name: 'projects_list' })).structuredContent).toEqual(result);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('createToolErrorResult', () => {
  it('preserves retry metadata in client-visible upload errors', () => {
    expect(createToolErrorResult(new UploadOverloadedError(2_500))).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'UPLOAD_CAPACITY_EXCEEDED',
          retryable: true,
          retryAfterMs: 2_500,
        },
      },
    });
  });

  it.each([
    [429, 'concurrency_limit_reached', 'generations_get'],
    [402, 'generation_plan_duration_exceeded', 'audio-trims_create'],
    [402, 'free_tier_generations_exhausted', 'Sending the same request again fails'],
    [404, 'generation_not_found', 'projects_list-generations'],
    [400, undefined, 'Sending the same request again fails'],
  ])('tells the agent what to do after a %i %s', (status, code, guidance) => {
    const result = createToolErrorResult(new ApiRequestError('rejected', status, code));
    expect(result.structuredContent).toMatchObject({
      error: { status, nextStep: expect.stringContaining(guidance) },
    });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(guidance) }]);
  });

  it.each([
    ['upgrade_plan', { requiredPlan: 'creator' }, "not included in the user's current sync. plan"],
    ['buy_credits', { requiredCredits: 500 }, 'not have enough sync. credits'],
  ])('points the ChatGPT app at the billing page, never checkout, for %s', (type, extra, step) => {
    const approval = 'https://sync.so/checkout/approve?organizationId=org&plan=creator';
    const error = new ApiRequestError(
      'Upgrade required',
      402,
      'free_tier_generations_exhausted',
      undefined,
      undefined,
      undefined,
      {
        nextAction: { type, url: approval, ...('requiredPlan' in extra && extra) },
        billingUrl: 'https://sync.so/billing/subscription',
        ...extra,
      },
    );
    const chatgpt = createToolErrorResult(error, undefined, true);
    const text = JSON.stringify(chatgpt);
    expect(text).not.toContain('/checkout/');
    expect(chatgpt.structuredContent).toMatchObject({
      error: {
        nextAction: { type, url: 'https://sync.so/billing/subscription' },
        billingUrl: 'https://sync.so/billing/subscription',
        nextStep: expect.stringContaining(step),
      },
    });
    expect(
      String((chatgpt.structuredContent as { error: { nextStep: string } }).error.nextStep),
    ).toContain('Do not');
    // Every other client keeps the approval link it can hand to a person.
    expect(createToolErrorResult(error).structuredContent).toMatchObject({
      error: { nextAction: { url: approval }, nextStep: expect.stringContaining('approval') },
    });
  });

  it('keeps other refusals unchanged in the ChatGPT app', () => {
    const invoice = 'https://invoice.stripe.com/i/abc';
    const error = new ApiRequestError(
      'Unpaid',
      402,
      'invoice_unpaid',
      undefined,
      undefined,
      undefined,
      {
        nextAction: { type: 'pay_invoice', url: invoice },
      },
    );
    expect(createToolErrorResult(error, undefined, true).structuredContent).toMatchObject({
      error: { nextAction: { type: 'pay_invoice', url: invoice } },
    });
  });

  it('logs the tool, profile, status and code of a failed call', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      logToolError(() => 'chatgpt')(
        'lipsync_create',
        new ApiRequestError('limit', 429, 'concurrency_limit_reached'),
      );
      expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({
        event: 'mcp_tool_error',
        tool: 'lipsync_create',
        profile: 'chatgpt',
        status: 429,
        code: 'concurrency_limit_reached',
        source: 'mcp',
        errorName: 'ApiRequestError',
      });
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    'The uploaded video isn\'t a fetchable URL (received "abc"private words").',
    'Could not fetch media from private-host.internal: connection refused',
  ])('logs no message text from a failed call: %s', (message) => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      logToolError(() => 'claude')('lipsync_create', new Error(message));
      const raw = String(write.mock.calls[0]?.[0]);
      expect(JSON.parse(raw)).toMatchObject({ tool: 'lipsync_create', errorName: 'Error' });
      expect(raw).not.toMatch(/private|abc|fetchable/);
    } finally {
      write.mockRestore();
    }
  });

  it('logs the fields of a validation error, not the values', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      const error = z
        .object({ items: z.array(z.object({ url: z.url() })) })
        .safeParse({ items: [{ url: 'secret words' }] }).error;
      logToolError(() => 'claude')('jobs_create-many', error);
      const raw = String(write.mock.calls[0]?.[0]);
      expect(JSON.parse(raw)).toMatchObject({ errorName: 'ZodError', fields: ['items.[].url'] });
      expect(raw).not.toContain('secret');
    } finally {
      write.mockRestore();
    }
  });

  it('leaves a retryable conflict without a next step', () => {
    const result = createToolErrorResult(
      new ApiRequestError('importing', 409, 'import_in_progress'),
    );
    expect(result.structuredContent).not.toHaveProperty('error.nextStep');
  });

  it.each([null, undefined])('handles a nullish thrown value: %s', (error: null | undefined) => {
    expect(createToolErrorResult(error)).toEqual({
      content: [{ type: 'text', text: `Error: ${String(error)}` }],
      isError: true,
    });
  });
});

describe('createToolDescriptorMeta', () => {
  it('lowercases invocation labels without changing other metadata or the source', () => {
    const meta = {
      'openai/toolInvocation/invoking': 'Creating Your Lipsync Video…',
      'openai/toolInvocation/invoked': 'Lipsync Generation Started.',
      'openai/outputTemplate': 'ui://Sync/Studio.html',
      'openai/fileParams': ['sourceVideo'],
    };
    expect(createToolDescriptorMeta(meta)).toMatchObject({
      'openai/toolInvocation/invoking': 'creating your lipsync video…',
      'openai/toolInvocation/invoked': 'lipsync generation started.',
      'openai/outputTemplate': 'ui://Sync/Studio.html',
      'openai/fileParams': ['sourceVideo'],
    });
    expect(meta['openai/toolInvocation/invoking']).toBe('Creating Your Lipsync Video…');
  });

  it('adds OAuth security schemes for ChatGPT tool descriptors', () => {
    expect(createToolDescriptorMeta(undefined)).toEqual({
      securitySchemes: [{ type: 'oauth2', scopes: [] }],
    });
  });

  it('preserves existing tool metadata', () => {
    expect(
      createToolDescriptorMeta({
        'openai/fileParams': ['image'],
      }),
    ).toEqual({
      'openai/fileParams': ['image'],
      securitySchemes: [{ type: 'oauth2', scopes: [] }],
    });
  });
});

describe('createJsonToolResult', () => {
  it('exposes JSON object results as structured content and text', () => {
    const result = {
      id: 'gen-123',
      status: 'PENDING',
      outputUrl: null,
    };

    expect(createJsonToolResult(result)).toEqual({
      structuredContent: result,
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    });
  });

  it('leaves array results as text-only JSON', () => {
    const result = [{ id: 'voice-1' }];

    expect(createJsonToolResult(result)).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    });
  });

  // The browser cannot render the backend ETA if the MCP public projection strips it.
  it('forwards server generation estimates without exposing private inputs', () => {
    const generationEstimate = {
      serverTime: '2026-10-01T12:00:00Z',
      estimatedFinishAt: '2026-10-01T12:00:40Z',
    };
    const result = createJsonToolResult(
      {
        id: 'gen-123',
        status: 'PROCESSING',
        generationEstimate,
        input: [{ url: 'https://private.example/input.mp4' }],
      },
      generationOutputSchema,
    );
    expect(result.structuredContent).toEqual({
      id: 'gen-123',
      status: 'PROCESSING',
      generationEstimate,
    });
  });

  it('projects structured content to output schema fields when provided', () => {
    const result = {
      id: 'gen-123',
      status: 'COMPLETED',
      input: [{ url: 'https://storage.example/private-input.mp4' }],
      outputUrl: 'https://api.sync.so/result',
    };
    const expected = {
      id: 'gen-123',
      status: 'COMPLETED',
      outputUrl: 'https://api.sync.so/result',
    };

    expect(
      createJsonToolResult(result, {
        id: {},
        status: {},
        outputUrl: {},
      }),
    ).toEqual({
      structuredContent: expected,
      content: [
        {
          type: 'text',
          text: JSON.stringify(expected, null, 2),
        },
      ],
    });
  });
});

describe('SERVER_INSTRUCTIONS', () => {
  it('documents the concise lipsync input contract and defaults', () => {
    expect(SERVER_INSTRUCTIONS).toContain('exactly one visual input');
    expect(SERVER_INSTRUCTIONS).toContain('one driver');
    expect(SERVER_INSTRUCTIONS).toContain('defaults to sync-3');
    expect(SERVER_INSTRUCTIONS).toContain('NEW project');
    expect(SERVER_INSTRUCTIONS).toContain(
      'When the whole request is covered, proceed without mentioning prices or asking for spending confirmation.',
    );
    expect(SERVER_INSTRUCTIONS).toContain('elevenLabsKeyConnected=false');
    expect(SERVER_INSTRUCTIONS).toContain(
      'Paid, external or unknown coverage still requires a quote and spending confirmation',
    );
  });

  it('describes only tools available to every profile and exact result handling', () => {
    expect(SERVER_INSTRUCTIONS).toContain('voices_list');
    expect(SERVER_INSTRUCTIONS).toContain('Create once');
    expect(SERVER_INSTRUCTIONS).toContain('exact structuredContent.outputMediaUrl verbatim');
    expect(SERVER_INSTRUCTIONS).toContain('outputUrl is a deprecated alias with the same value');
    expect(SERVER_INSTRUCTIONS).not.toContain('structuredContent.outputUrl');
    expect(SERVER_INSTRUCTIONS).not.toContain('assets_open-upload-widget');
    expect(SERVER_INSTRUCTIONS).not.toContain('tts_create');
  });

  it('keeps ChatGPT and Studio guidance out of model-only clients', () => {
    expect(serverInstructions(resolveClientProfile('openai-mcp (codex)'))).toBe(
      SERVER_INSTRUCTIONS,
    );
    const modelOnly = serverInstructions(resolveClientProfile('claude-code'));
    expect(modelOnly).not.toContain('When Studio publishes');
    expect(modelOnly).not.toContain('In ChatGPT');
    expect(modelOnly).toContain('exactly one visual input');
    expect(modelOnly).toContain('assets_create-upload-url');
  });

  it('never tells the ChatGPT app to hand over upgrade or credit links', () => {
    const chatgpt = serverInstructions(resolveClientProfile('openai-mcp'));
    expect(chatgpt).not.toContain('upgrade_plan (requiredPlan names the plan), buy_credits');
    expect(chatgpt).toContain('Do not recommend a plan, quote prices or encourage upgrading');
    expect(chatgpt.match(/When a Sync tool error has nextAction/g)).toHaveLength(1);
    for (const client of ['openai-mcp (codex)', 'claude-code']) {
      const other = serverInstructions(resolveClientProfile(client));
      expect(other).toContain('upgrade_plan (requiredPlan names the plan), buy_credits');
      expect(other).not.toContain('Do not recommend a plan');
    }
  });

  it('mentions the jobs_*-many tools only to clients that list them', () => {
    const chatgpt = serverInstructions(resolveClientProfile('openai-mcp'));
    expect(chatgpt).not.toContain('jobs_create-many');
    expect(chatgpt).toContain('When Studio publishes');
    expect(serverInstructions(resolveClientProfile('claude-code'))).toContain('jobs_create-many');
  });
});

describe('selectHostedHttpTools', () => {
  it('exposes app discovery and generation tools without exposing unrelated writes', () => {
    const tools = [
      tool('assets_create'),
      tool('assets_create-upload-url'),
      tool('projects_create'),
      tool('assets_open-upload-widget'),
      tool('assets_upload'),
      tool('lipsync_create'),
      tool('models_list'),
      tool('voices_list'),
      tool('generations_get'),
      tool('projects_list'),
      tool('projects_delete'),
      tool('assets_delete'),
    ];

    expect(
      selectHostedHttpTools(tools, resolveClientProfile('chatgpt')).map((t) => t.name),
    ).toEqual([
      'assets_create',
      'assets_create-upload-url',
      'projects_create',
      'assets_open-upload-widget',
      'assets_upload',
      'lipsync_create',
      'models_list',
      'voices_list',
      'generations_get',
      'projects_list',
      'assets_delete',
    ]);
  });

  it('marks hosted data tools callable from the upload widget', () => {
    const tools = [
      tool('assets_open-upload-widget'),
      tool('assets_upload'),
      tool('lipsync_create'),
      tool('voices_list'),
      tool('generations_get'),
    ];

    const selected = selectHostedHttpTools(tools, resolveClientProfile('chatgpt'));
    const widgetCallableTools = selected.filter((t) => t.name !== 'assets_open-upload-widget');

    expect(widgetCallableTools.map((t) => t.name)).toEqual([
      'assets_upload',
      'lipsync_create',
      'voices_list',
      'generations_get',
    ]);
    for (const selectedTool of widgetCallableTools) {
      expect(selectedTool.meta?.['openai/widgetAccessible']).toBe(true);
      expect(selectedTool.meta?.ui).toEqual({ visibility: ['model', 'app'] });
    }
  });
});

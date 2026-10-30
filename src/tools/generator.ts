import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ClientProfile } from '../client-profile.js';
import type { HttpClient } from '../http-client.js';
import type { JsonSchema, ParsedOperation } from '../openapi/types.js';
import { estimateDurationInputs, resolveEstimateDuration } from './estimate-duration.js';
import { getOverride } from './overrides.js';

type McpToolBaseDefinition = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  outputSchema?: Record<string, z.ZodType>;
  annotations?: ToolAnnotations;
  // Tool-level metadata passed through to the MCP client (e.g. OpenAI's
  // `openai/fileParams` and invocation-status hints for ChatGPT apps).
  meta?: Record<string, unknown>;
};

export type ToolRequestContext = {
  _meta?: Record<string, unknown>;
  signal?: AbortSignal;
  // Internal session presentation, supplied by the server wrapper, never tool arguments.
  clientProfile?: ClientProfile;
};

type JsonMcpToolDefinition = McpToolBaseDefinition & {
  resultFormat?: 'json';
  handler: (args: Record<string, unknown>, context?: ToolRequestContext) => Promise<unknown>;
};

type RawMcpToolDefinition = McpToolBaseDefinition & {
  resultFormat: 'mcp';
  handler: (args: Record<string, unknown>, context?: ToolRequestContext) => Promise<CallToolResult>;
};

export type McpToolDefinition = JsonMcpToolDefinition | RawMcpToolDefinition;

const voiceCloneSourceSchema = z
  .object({
    url: z
      .url()
      .optional()
      .describe('Sync-hosted audio/video sample URL. Supply url or assetId, not both.'),
    sampleUrls: z
      .array(z.url())
      .min(1)
      .max(10)
      .optional()
      .describe('Sync-hosted samples for one reusable voice; use instead of url or assetId.'),
    assetId: z
      .uuid()
      .optional()
      .describe('Accessible audio/video sample asset ID. Supply assetId or url, not both.'),
  })
  .refine(
    (input) =>
      [input.url, input.assetId, input.sampleUrls].filter((value) => value !== undefined).length ===
      1,
    {
      message: 'Provide exactly one of url, assetId or sampleUrls for voice samples.',
    },
  );

export function generateTools(
  operations: ParsedOperation[],
  httpClient: HttpClient,
): McpToolDefinition[] {
  return operations.map((op) => generateTool(op, httpClient));
}

/**
 * Behaviour hints required by the ChatGPT and Claude app/connector directories
 * (missing/incorrect annotations are a top review-rejection cause). Derived
 * from the HTTP verb: reads are read-only; writes modify external Sync state,
 * so they are destructive and open-world.
 */
export function deriveAnnotations(method: string, toolName?: string): ToolAnnotations {
  if (
    method === 'get' ||
    ['generate_estimate-cost', 'generations_estimate-cost'].includes(toolName ?? '')
  ) {
    return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  }
  if (method === 'delete') {
    return { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  }
  // No idempotency contract for generation or other create/update operations.
  return { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
}

function generateTool(operation: ParsedOperation, httpClient: HttpClient): McpToolDefinition {
  const name = operationIdToToolName(operation.operationId);
  const override = getOverride(name);
  const description = override?.description ?? truncate(operation.summary, 200);

  const inputSchema = buildInputSchema(operation);
  const estimatesCost = ['generate_estimate-cost', 'generations_estimate-cost'].includes(name);
  if (estimatesCost) {
    if (inputSchema.duration) {
      inputSchema.duration = inputSchema.duration
        .optional()
        .describe(
          'Billable output seconds, or source seconds for translate-and-dub. For replacement speech, supply script or measured audioDuration instead. Never use the source video length for a shorter replacement script.',
        );
    }
    Object.assign(inputSchema, estimateDurationInputs);
  }
  if (name === 'voices_clone-voice') {
    // Flattening the API's allOf/oneOf alternatives makes both sources required.
    // Keep the descriptor flat, then enforce the exclusive choice before writing.
    Object.assign(inputSchema, voiceCloneSourceSchema.shape);
  }

  return {
    name,
    title: override?.title ?? titleForToolName(name),
    description,
    inputSchema,
    outputSchema: override?.outputSchema,
    annotations: deriveAnnotations(operation.method, name),
    handler: async (args, context) => {
      if (name === 'voices_clone-voice') voiceCloneSourceSchema.parse(args);
      const estimate = estimatesCost ? resolveEstimateDuration(args) : undefined;
      const requestArgs = estimate?.args ?? args;
      if (estimatesCost && inputSchema.duration && requestArgs.duration === undefined)
        throw new Error('Supply duration, script or audioDuration for a cost estimate.');
      const path = buildPath(operation.path, requestArgs);
      const query = buildQuery(operation.parameters, requestArgs);
      const body = buildBody(operation, requestArgs);

      const result = await httpClient.request(operation.method, path, {
        query,
        body,
        signal: context?.signal,
      });
      if (!estimate?.durationEstimate) return result;
      return {
        ...z.record(z.string(), z.unknown()).parse(result),
        durationEstimate: estimate.durationEstimate,
      };
    },
  };
}

function titleForToolName(name: string): string {
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function operationIdToToolName(operationId: string): string {
  // "GenerateController_createGeneration" → "generate_create-generation"
  const parts = operationId.split('_');
  if (parts.length < 2) return toKebab(operationId);

  const controller = toKebab(parts[0]!.replace(/Controller$/, ''));
  const method = toKebab(parts.slice(1).join('_'));
  return `${controller}_${method}`;
}

function toKebab(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 3)}...`;
}

function buildInputSchema(operation: ParsedOperation): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};

  for (const param of operation.parameters) {
    if (param.in === 'header') continue;
    const zodType = jsonSchemaToZod(param.schema, param.description);
    shape[param.name] = param.required ? zodType : zodType.optional();
  }

  if (operation.requestBody?.schema) {
    const bodySchema = operation.requestBody.schema;
    const flatSchemas = flattenComposedSchema(bodySchema);
    for (const sub of flatSchemas) {
      if (!sub.properties) continue;
      const properties = sub.properties as Record<string, JsonSchema>;
      const required = (sub.required as string[]) ?? [];
      for (const [propName, propSchema] of Object.entries(properties)) {
        const zodType = jsonSchemaToZod(propSchema, propSchema.description as string | undefined);
        shape[propName] = required.includes(propName) ? zodType : zodType.optional();
      }
    }
  }

  return shape;
}

function flattenComposedSchema(schema: JsonSchema): JsonSchema[] {
  const results: JsonSchema[] = [];
  if (schema.properties) results.push(schema);
  for (const key of ['allOf', 'oneOf', 'anyOf'] as const) {
    const composed = schema[key] as JsonSchema[] | undefined;
    if (composed) results.push(...composed.flatMap(flattenComposedSchema));
  }
  return results.length > 0 ? results : [schema];
}

function jsonSchemaToZod(schema: JsonSchema, description?: string): z.ZodType {
  let zodType: z.ZodType;

  const type = schema.type as string | undefined;
  const enumValues = schema.enum as string[] | undefined;

  if (enumValues) {
    zodType = z.enum(enumValues as [string, ...string[]]);
  } else if (type === 'string') {
    zodType = z.string();
  } else if (type === 'number' || type === 'integer') {
    zodType = z.number();
  } else if (type === 'boolean') {
    zodType = z.boolean();
  } else if (type === 'array') {
    const items = schema.items as JsonSchema | undefined;
    zodType = z.array(items ? jsonSchemaToZod(items) : z.unknown());
  } else if (type === 'object') {
    const properties = schema.properties as Record<string, JsonSchema> | undefined;
    if (properties) {
      const required = (schema.required as string[]) ?? [];
      const shape: Record<string, z.ZodType> = {};
      for (const [propName, propSchema] of Object.entries(properties)) {
        const innerType = jsonSchemaToZod(propSchema);
        shape[propName] = required.includes(propName) ? innerType : innerType.optional();
      }
      zodType = z.object(shape);
    } else {
      zodType = z.record(z.string(), z.unknown());
    }
  } else {
    zodType = z.unknown();
  }

  if (description) {
    zodType = zodType.describe(description);
  }

  return zodType;
}

function buildPath(pathTemplate: string, args: Record<string, unknown>): string {
  return pathTemplate.replace(/\{(\w+)\}/g, (_match, paramName: string) => {
    const value = args[paramName];
    if (value === undefined) {
      throw new Error(`Missing required path parameter: ${paramName}`);
    }
    return encodeURIComponent(String(value));
  });
}

function buildQuery(
  parameters: ParsedOperation['parameters'],
  args: Record<string, unknown>,
): Record<string, string> | undefined {
  const queryParams = parameters.filter((p) => p.in === 'query');
  if (queryParams.length === 0) return undefined;

  const query: Record<string, string> = {};
  for (const param of queryParams) {
    const value = args[param.name];
    if (value !== undefined && value !== null) {
      query[param.name] = String(value);
    }
  }

  return Object.keys(query).length > 0 ? query : undefined;
}

function buildBody(operation: ParsedOperation, args: Record<string, unknown>): unknown | undefined {
  if (!operation.requestBody) return undefined;

  const pathAndQueryNames = new Set(
    operation.parameters.filter((p) => p.in !== 'header').map((p) => p.name),
  );

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!pathAndQueryNames.has(key) && value !== undefined) {
      body[key] = value;
    }
  }

  return Object.keys(body).length > 0 ? body : undefined;
}

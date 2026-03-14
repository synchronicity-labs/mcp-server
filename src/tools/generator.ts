import { z } from 'zod';
import type { HttpClient } from '../http-client.js';
import type { JsonSchema, ParsedOperation } from '../openapi/types.js';
import { getOverride } from './overrides.js';

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

export function generateTools(
  operations: ParsedOperation[],
  httpClient: HttpClient,
): McpToolDefinition[] {
  return operations.map((op) => generateTool(op, httpClient));
}

function generateTool(operation: ParsedOperation, httpClient: HttpClient): McpToolDefinition {
  const name = operationIdToToolName(operation.operationId);
  const override = getOverride(name);
  const description = override?.description ?? truncate(operation.summary, 200);

  const inputSchema = buildInputSchema(operation);

  return {
    name,
    description,
    inputSchema,
    handler: async (args: Record<string, unknown>) => {
      const path = buildPath(operation.path, args);
      const query = buildQuery(operation.parameters, args);
      const body = buildBody(operation, args);

      return httpClient.request(operation.method, path, { query, body });
    },
  };
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

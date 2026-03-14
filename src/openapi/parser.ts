import type { JsonSchema, OpenApiSpec, ParsedOperation, ParsedParameter } from './types.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

export function parseSpec(spec: OpenApiSpec): ParsedOperation[] {
  const operations: ParsedOperation[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const tags = operation.tags ?? [];
      if (tags.includes('internal')) continue;

      const operationId = operation.operationId;
      if (!operationId) continue;

      const parameters = parseParameters(operation.parameters ?? [], spec);
      const requestBody = parseRequestBody(operation.requestBody, spec);
      const isMultipart = requestBody?.contentType === 'multipart/form-data';

      operations.push({
        operationId,
        method,
        path,
        summary: operation.summary ?? operationId,
        description: operation.description,
        tags,
        parameters,
        requestBody,
        isMultipart,
      });
    }
  }

  return operations;
}

function parseParameters(
  params: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema: JsonSchema;
    description?: string;
    $ref?: string;
  }>,
  spec: OpenApiSpec,
): ParsedParameter[] {
  return params.map((param) => {
    const resolved = param.$ref ? resolveRef(spec, param.$ref) : param;
    return {
      name: resolved.name as string,
      in: resolved.in as ParsedParameter['in'],
      required: (resolved.required as boolean) ?? false,
      schema: resolveSchemaRefs((resolved.schema as JsonSchema) ?? { type: 'string' }, spec),
      description: resolved.description as string | undefined,
    };
  });
}

function parseRequestBody(
  requestBody: { content: Record<string, { schema: JsonSchema }>; required?: boolean } | undefined,
  spec: OpenApiSpec,
): { schema: JsonSchema; contentType: string } | undefined {
  if (!requestBody?.content) return undefined;

  const contentType =
    'application/json' in requestBody.content
      ? 'application/json'
      : 'multipart/form-data' in requestBody.content
        ? 'multipart/form-data'
        : Object.keys(requestBody.content)[0];

  if (!contentType) return undefined;
  const mediaType = requestBody.content[contentType];
  if (!mediaType?.schema) return undefined;

  return {
    schema: resolveSchemaRefs(mediaType.schema, spec),
    contentType,
  };
}

export function resolveRef(spec: OpenApiSpec, ref: string): JsonSchema {
  const parts = ref.replace('#/', '').split('/');
  let current: unknown = spec;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') {
      throw new Error(`Cannot resolve $ref: ${ref}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current as JsonSchema;
}

export function resolveSchemaRefs(schema: JsonSchema, spec: OpenApiSpec): JsonSchema {
  if (schema.$ref) {
    const resolved = resolveRef(spec, schema.$ref as string);
    return resolveSchemaRefs(resolved, spec);
  }

  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const props: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value as Record<string, JsonSchema>)) {
        props[propName] = resolveSchemaRefs(propSchema, spec);
      }
      result[key] = props;
    } else if (
      (key === 'items' || key === 'additionalProperties') &&
      typeof value === 'object' &&
      value !== null
    ) {
      result[key] = resolveSchemaRefs(value as JsonSchema, spec);
    } else if (key === 'allOf' || key === 'oneOf' || key === 'anyOf') {
      result[key] = (value as JsonSchema[]).map((s) => resolveSchemaRefs(s, spec));
    } else {
      result[key] = value;
    }
  }
  return result;
}

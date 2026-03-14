export type ParsedParameter = {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: JsonSchema;
  description?: string;
};

export type ParsedOperation = {
  operationId: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters: ParsedParameter[];
  requestBody?: { schema: JsonSchema; contentType: string };
  isMultipart: boolean;
};

export type JsonSchema = Record<string, unknown>;

export type OpenApiSpec = {
  openapi: string;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: {
    content: Record<string, { schema: JsonSchema }>;
    required?: boolean;
  };
  [key: string]: unknown;
};

type OpenApiParameter = {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema: JsonSchema;
  description?: string;
  $ref?: string;
};

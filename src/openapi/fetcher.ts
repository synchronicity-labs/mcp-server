import type { OpenApiSpec } from './types.js';

export async function fetchSpec(baseUrl: string): Promise<OpenApiSpec> {
  const url = `${baseUrl}/api-json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch OpenAPI spec from ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return (await response.json()) as OpenApiSpec;
}

export async function loadSpecFromFile(path: string): Promise<OpenApiSpec> {
  const fs = await import('node:fs/promises');
  const content = await fs.readFile(path, 'utf-8');
  return JSON.parse(content) as OpenApiSpec;
}

import { z } from 'zod';
import type { McpToolDefinition } from './generator.js';
import { hashUuid } from './project-destination.js';

/** jobs_create-many's items: validation, repeats, and the keys each item derives. */

const KEY_FIELDS = ['idempotencyKey', 'projectCreationKey'] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON with object keys sorted, so the same item always derives the same keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function withoutKeys(item: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(item).filter(([key]) => !(KEY_FIELDS as readonly string[]).includes(key)),
  );
}

/** Validates every item as the tool would, and refuses the set before anything starts. */
export function checkItems(target: McpToolDefinition, items: Record<string, unknown>[]) {
  const schema = z.object(target.inputSchema);
  const problems: string[] = [];
  const seen = new Map<string, number>();
  const parsed = items.map((item, index) => {
    const result = schema.safeParse(item);
    if (!result.success) {
      for (const issue of result.error.issues.slice(0, 3))
        problems.push(
          `items[${index}]${issue.path.map((part) => `.${String(part)}`).join('')}: ${issue.message}`,
        );
      return item;
    }
    const identity = canonical(withoutKeys(result.data));
    const first = seen.get(identity);
    if (first === undefined) seen.set(identity, index);
    else problems.push(`items[${index}] repeats items[${first}]; each item must differ`);
    return result.data as Record<string, unknown>;
  });
  if (problems.length > 0)
    throw new Error(
      `Nothing was started. ${problems.slice(0, 10).join('; ')}${problems.length > 10 ? `; and ${problems.length - 10} more` : ''}. Each item takes the arguments ${target.name} takes on its own.`,
    );
  return parsed;
}

/** Which keys the create tool takes, read once from its input schema. */
export type KeyFields = { idempotencyKey: boolean; projectCreationKey: boolean };

export function keyFields(target: McpToolDefinition): KeyFields {
  return {
    idempotencyKey: 'idempotencyKey' in target.inputSchema,
    projectCreationKey: 'projectCreationKey' in target.inputSchema,
  };
}

/**
 * Fills the item's missing keys from the set key, the tool name and the item's other
 * arguments, never its position, so the same item sent again (alone, or in `remaining`)
 * gets the same keys and resends the same request, never a second job. Only those
 * caller-supplied, non-secret strings are hashed.
 */
export function withKeys(
  tool: string,
  takes: KeyFields,
  setKey: string,
  item: Record<string, unknown>,
): Record<string, unknown> {
  const identity = canonical(withoutKeys(item));
  const derive = (field: string) =>
    hashUuid('sync:mcp:jobs-many:v1', setKey.toLowerCase(), tool, field, identity);
  const keys: Record<string, string> = {};
  if (takes.idempotencyKey && item.idempotencyKey === undefined)
    keys.idempotencyKey = derive('idempotencyKey');
  if (
    takes.projectCreationKey &&
    item.projectCreationKey === undefined &&
    item.projectId === undefined
  )
    keys.projectCreationKey = derive('projectCreationKey');
  return { ...item, ...keys };
}

/** What a create returned, unwrapping a tool result in MCP form; throws its error. */
export function created(result: unknown): Record<string, unknown> {
  if (isRecord(result) && 'isError' in result && 'content' in result) {
    const structured = isRecord(result.structuredContent) ? result.structuredContent : {};
    if (result.isError === true) {
      const error = isRecord(structured.error) ? structured.error : {};
      throw new Error(typeof error.message === 'string' ? error.message : 'The create failed.');
    }
    return structured;
  }
  return isRecord(result) ? result : {};
}

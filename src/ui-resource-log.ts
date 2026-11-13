import type { ClientProfile } from './client-profile.js';

/**
 * Reads a widget resource and writes one ui_resource_read line, served or refused. A
 * refusal reaches the client as a JSON-RPC error inside an HTTP 200, so request logs alone
 * never show it, and the host only says it couldn't load the widget. The line says which
 * client asked, which profile it resolved to and why it was turned away. The client name is
 * the client's own claim, so only an expected shape is logged.
 */
export async function readUiResource<T>(
  read: {
    resource: string;
    profile: ClientProfile;
    clientName: string | undefined;
    /** Why this profile may not load the resource; undefined serves it. */
    refusal: { reason: string; message: string } | undefined;
  },
  load: () => T | Promise<T>,
): Promise<T> {
  const line = {
    event: 'ui_resource_read',
    resource: read.resource,
    clientProfile: read.profile.name,
    clientName: loggedClientName(read.clientName),
  };
  if (read.refusal) {
    writeLine({ ...line, outcome: 'refused', reason: read.refusal.reason });
    throw new Error(read.refusal.message);
  }
  let result: T;
  try {
    result = await load();
  } catch (error) {
    writeLine({
      ...line,
      outcome: 'failed',
      reason: error instanceof Error ? error.name : 'unknown',
    });
    throw error;
  }
  writeLine({ ...line, outcome: 'served', bytes: textBytes(result) });
  return result;
}

function textBytes(result: unknown): number | undefined {
  const contents = (result as { contents?: unknown } | undefined)?.contents;
  if (!Array.isArray(contents)) return undefined;
  return contents.reduce<number>((total, content: { text?: unknown }) => {
    return total + (typeof content?.text === 'string' ? Buffer.byteLength(content.text) : 0);
  }, 0);
}

function loggedClientName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  return /^[\w ./()@-]{1,80}$/.test(name) ? name : '<other client>';
}

function writeLine(line: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...line })}\n`);
}

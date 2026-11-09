import { runWithAuth } from '../auth/async-context.js';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { TelemetryQueue } from './queue.js';

export { TelemetrySession } from './session.js';
export type { TelemetryQueue } from './queue.js';

export const MCP_EVENTS_OPERATION_ID = 'analytics_captureMcpEvents';
export const MCP_EVENTS_PATH = '/v2/analytics/mcp-events';
const SEND_TIMEOUT_MS = 3000;

const OFF = new Set(['0', 'false', 'off', 'no', 'disabled']);

/** On unless --no-telemetry, SYNC_MCP_TELEMETRY=off or DO_NOT_TRACK=1 (any value but 0/false). */
export function resolveTelemetry(
  override: boolean | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (override !== undefined) return override;
  const setting = env.SYNC_MCP_TELEMETRY?.trim().toLowerCase();
  if (setting && OFF.has(setting)) return false;
  const doNotTrack = env.DO_NOT_TRACK?.trim().toLowerCase();
  return !doNotTrack || OFF.has(doNotTrack);
}

export function isMcpEventsOperation(operation: Pick<ParsedOperation, 'operationId'>): boolean {
  return operation.operationId === MCP_EVENTS_OPERATION_ID;
}

/**
 * The process's event queue, or undefined when telemetry is off or the API does not
 * collect MCP events yet.
 */
export function createTelemetryQueue(
  enabled: boolean,
  operations: Pick<ParsedOperation, 'operationId'>[],
  http: HttpClient,
): TelemetryQueue | undefined {
  if (!enabled || !operations.some(isMcpEventsOperation)) return undefined;
  return new TelemetryQueue((events, token) => {
    const send = () =>
      http.request('post', MCP_EVENTS_PATH, {
        body: { events },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    return token ? runWithAuth(token, undefined, send) : send();
  });
}

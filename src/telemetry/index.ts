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

/** Reads the API's published schema again: true once it lists the MCP events collector. */
export type CollectorCheck = () => Promise<boolean>;

const RECHECK_MS = 10 * 60_000;

/**
 * The process's event queue, or undefined when telemetry is off. When the API does not
 * collect MCP events yet and `recheck` is given, the queue starts inactive and turns on
 * when a later read of the schema lists the collector, so a server that deploys before
 * the API needs no restart. Without `recheck` it stays undefined.
 */
export function createTelemetryQueue(
  enabled: boolean,
  operations: Pick<ParsedOperation, 'operationId'>[],
  http: HttpClient,
  recheck?: CollectorCheck,
  recheckMs = RECHECK_MS,
): TelemetryQueue | undefined {
  if (!enabled) return undefined;
  const listed = operations.some(isMcpEventsOperation);
  if (!listed && !recheck) return undefined;
  const queue = new TelemetryQueue(
    (events, token) => {
      const send = () =>
        http.request('post', MCP_EVENTS_PATH, {
          body: { events },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      return token ? runWithAuth(token, undefined, send) : send();
    },
    undefined,
    listed,
  );
  if (!listed && recheck) waitForCollector(queue, recheck, recheckMs);
  return queue;
}

function waitForCollector(queue: TelemetryQueue, recheck: CollectorCheck, everyMs: number): void {
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    // A failed read is the same as not listed yet: try again on the next tick.
    void recheck()
      .catch(() => false)
      .then((collects) => {
        checking = false;
        if (!collects) return;
        clearInterval(timer);
        queue.activate();
      });
  }, everyMs);
  timer.unref?.();
}

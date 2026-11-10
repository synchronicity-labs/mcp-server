import { runWithAuth } from '../auth/async-context.js';
import type { HttpClient } from '../http-client.js';
import type { ParsedOperation } from '../openapi/types.js';
import { TelemetryQueue } from './queue.js';
import { collectorAcceptsReferral } from './referral.js';

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

type CollectorOperation = Pick<ParsedOperation, 'operationId' | 'requestBody'>;
/** Reads the collector's current request schema from the API. */
export type CollectorCheck = () => Promise<CollectorOperation | undefined>;

const RECHECK_MS = 10 * 60_000;

/**
 * The process's event queue, or undefined when telemetry is off. When the API does not
 * collect MCP events yet and `recheck` is given, the queue starts inactive and turns on
 * when a later read of the schema lists the collector, so a server that deploys before
 * the API needs no restart. Without `recheck` it stays undefined.
 */
export function createTelemetryQueue(
  enabled: boolean,
  operations: CollectorOperation[],
  http: HttpClient,
  recheck?: CollectorCheck,
  recheckMs = RECHECK_MS,
): TelemetryQueue | undefined {
  if (!enabled) return undefined;
  const collector = operations.find(isMcpEventsOperation);
  if (!collector && !recheck) return undefined;
  let referral = collectorAcceptsReferral(collector?.requestBody?.schema);
  const queue = new TelemetryQueue(
    (events, token) => {
      const send = () =>
        http.request('post', MCP_EVENTS_PATH, {
          body: {
            events: referral
              ? events
              : events.map((event) => {
                  const properties = { ...event.properties };
                  delete properties.referral_source;
                  return { ...event, properties };
                }),
          },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      return token ? runWithAuth(token, undefined, send) : send();
    },
    undefined,
    Boolean(collector),
  );
  if (!referral && recheck) {
    waitForCollector(recheck, recheckMs, (current) => {
      queue.activate();
      referral = collectorAcceptsReferral(current.requestBody?.schema);
      return referral;
    });
  }
  return queue;
}

function waitForCollector(
  recheck: CollectorCheck,
  everyMs: number,
  update: (collector: CollectorOperation) => boolean,
): void {
  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    // A failed read is the same as not listed yet: try again on the next tick.
    void recheck()
      .catch(() => undefined)
      .then((collector) => {
        checking = false;
        if (collector && update(collector)) clearInterval(timer);
      });
  }, everyMs);
  timer.unref?.();
}

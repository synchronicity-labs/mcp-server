import { expect, it, vi } from 'vitest';
import { SessionTelemetry } from './session-telemetry.js';

it('correlates reuse and closure without logging identities, arguments or raw IDs', () => {
  let now = 0;
  const emit = vi.fn();
  const telemetry = new SessionTelemetry(emit, () => now);
  telemetry.start('secret-session-one', 'openai-mcp', '2025-03-26');
  const first = telemetry.request('secret-session-one', 'notifications/initialized');
  telemetry.request('secret-session-one', 'tools/list');
  now = 1000;
  const call = telemetry.request('secret-session-one', [
    'tools/call',
    'tools/call',
    'resources/list',
  ]);
  expect(call.sessionRef).toBe(first.sessionRef);
  expect(call.sessionRequest).toBe(4);
  now = 121000;
  telemetry.close('secret-session-one', 'expired');
  expect(emit).toHaveBeenCalledWith('mcp_session_closed', {
    sessionRef: first.sessionRef,
    reason: 'expired',
    clientName: 'openai-mcp',
    clientProfile: 'chatgpt',
    protocol: '2025-03-26',
    requests: 4,
    toolCalls: 2,
    discoveries: 2,
    lifetimeMs: 121000,
    idleMs: 120000,
  });
  expect(JSON.stringify(emit.mock.calls)).not.toContain('secret-session');
  telemetry.close('secret-session-one', 'closed');
  expect(emit).toHaveBeenCalledTimes(1);
});

it('bounds client metadata and changes pseudonyms across process lifetimes and tabs', () => {
  const emit = vi.fn();
  const a = new SessionTelemetry(emit);
  const b = new SessionTelemetry(emit);
  expect(a.reference('one')).not.toBe(a.reference('two'));
  expect(a.reference('one')).not.toBe(b.reference('one'));
  a.start('one', 'Bearer secret-value', 'secret-value');
  a.close('one', 'closed');
  expect(JSON.stringify(emit.mock.calls)).not.toContain('secret-value');
  expect(emit.mock.calls[0]?.[1]).toMatchObject({
    clientName: 'other',
    clientProfile: 'generic',
    protocol: 'unknown',
  });
});

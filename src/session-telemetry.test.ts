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

it.each([
  ['codex-mcp-client', 'codex-mcp-client', 'generic'],
  ['cursor-vscode', 'cursor-vscode', 'generic'],
  ['Anthropic/ClaudeAI', 'anthropic/claudeai', 'claude'],
])('names known client %s in closed-session telemetry', (name, client, profile) => {
  const emit = vi.fn();
  const telemetry = new SessionTelemetry(emit);
  telemetry.start('session', name, '2025-06-18');
  telemetry.close('session', 'closed');
  expect(emit.mock.calls[0]?.[1]).toMatchObject({ clientName: client, clientProfile: profile });
});

it('explains a 404 by the session it named: live elsewhere, recently closed or unknown', () => {
  let now = 0;
  const telemetry = new SessionTelemetry(vi.fn(), () => now);
  telemetry.start('live-session', 'Anthropic/ClaudeAI', '2025-11-25');
  telemetry.start('expired-session', 'Anthropic/ClaudeAI', '2025-11-25');
  now = 600_000;
  telemetry.close('expired-session', 'expired');
  now = 602_300;
  expect(telemetry.notFound('expired-session')).toEqual({
    sessionRef: telemetry.reference('expired-session'),
    cause: 'expired',
    closedAgoMs: 2_300,
    clientName: 'anthropic/claudeai',
    clientProfile: 'claude',
  });
  expect(telemetry.notFound('live-session')).toMatchObject({
    cause: 'other_owner',
    clientProfile: 'claude',
  });
  expect(telemetry.notFound('never-seen')).toEqual({
    sessionRef: telemetry.reference('never-seen'),
    cause: 'unknown',
  });
  expect(JSON.stringify(telemetry.notFound('expired-session'))).not.toContain('expired-session');
  now += 60 * 60_000 + 1;
  expect(telemetry.notFound('expired-session')).toMatchObject({ cause: 'unknown' });
});

it('keeps a bounded memory of closed sessions', () => {
  let now = 0;
  const telemetry = new SessionTelemetry(vi.fn(), () => now);
  for (let index = 0; index <= 5_000; index++) {
    telemetry.start(`session-${index}`, 'openai-mcp', '2025-11-25');
    telemetry.close(`session-${index}`, 'expired');
    now += 1;
  }
  expect(telemetry.notFound('session-0')).toMatchObject({ cause: 'unknown' });
  expect(telemetry.notFound('session-1')).toMatchObject({ cause: 'expired' });
  expect(telemetry.notFound('session-5000')).toMatchObject({ cause: 'expired' });
});

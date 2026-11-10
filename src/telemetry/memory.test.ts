import { describe, expect, it } from 'vitest';
import { TelemetryMemory } from './memory.js';

function memory(limits = { repeatWindowMs: 100, conversationTtlMs: 1000, maxKeys: 3 }) {
  let now = 0;
  const store = new TelemetryMemory(() => now, limits);
  return { store, advance: (ms: number) => void (now += ms) };
}

describe('TelemetryMemory', () => {
  it('lets a key through once per window, measured from its first sighting', () => {
    const { store, advance } = memory();
    expect(store.firstInWindow('a')).toBe(true);
    advance(60);
    expect(store.firstInWindow('a')).toBe(false);
    expect(store.firstInWindow('b')).toBe(true);
    advance(40);
    expect(store.firstInWindow('a')).toBe(true);
  });

  it('numbers a conversation’s calls and forgets it after a quiet spell', () => {
    const { store, advance } = memory();
    expect(store.nextInConversation('c', 'one')).toEqual({ call_index: 1 });
    advance(250);
    expect(store.nextInConversation('c', 'two')).toEqual({
      call_index: 2,
      previous_tool: 'one',
      ms_since_previous_call: 250,
    });
    advance(1000);
    expect(store.nextInConversation('c', 'three')).toEqual({ call_index: 1 });
  });

  it('keeps at most its bound, dropping the least recently used key', () => {
    const { store } = memory();
    for (const key of ['a', 'b', 'c']) store.nextInConversation(key, 'tool');
    store.nextInConversation('a', 'tool');
    store.nextInConversation('d', 'tool');
    expect(store.nextInConversation('b', 'tool').call_index).toBe(1);
    expect(store.nextInConversation('a', 'tool').call_index).toBe(3);
  });
});

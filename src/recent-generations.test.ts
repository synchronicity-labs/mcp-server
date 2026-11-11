import { describe, expect, it } from 'vitest';
import { runWithAuth } from './auth/async-context.js';
import {
  generationContextKey,
  recentGeneration,
  rememberGeneration,
} from './recent-generations.js';

const ID = '0b6c6a1e-3c5e-4a51-9f0e-4b7c2b1d9a10';
const OTHER = '00000000-0000-4000-8000-000000000002';
const owner = (name: string) => JSON.stringify([name, 'client', null]);
const inOwner = <T>(name: string, fn: () => T) => runWithAuth('token', 'client', fn, owner(name));

describe('recent generations', () => {
  it('keys calls by owner and conversation, falling back to the session', () => {
    const meta = { 'openai/session': 'conversation-a' };
    const a = inOwner('alice', () => generationContextKey(meta, 'session-1', 'http'));
    expect(inOwner('alice', () => generationContextKey(meta, 'session-2', 'http'))).toBe(a);
    expect(inOwner('bob', () => generationContextKey(meta, 'session-1', 'http'))).not.toBe(a);
    expect(inOwner('alice', () => generationContextKey(undefined, 'session-1', 'http'))).not.toBe(
      a,
    );
    // No owner on the hosted server, or nothing to scope by: no key at all.
    expect(generationContextKey(meta, 'session-1', 'http')).toBeUndefined();
    expect(
      inOwner('alice', () => generationContextKey(undefined, undefined, 'http')),
    ).toBeUndefined();
    expect(generationContextKey(undefined, undefined, 'stdio')).toBeDefined();
  });

  it('remembers the generation a create returned or a read described, for half an hour', () => {
    const key = 'k1';
    rememberGeneration(key, 'lipsync_create', { structuredContent: { id: ID } }, 0);
    expect(recentGeneration(key, 1000)).toBe(ID);
    rememberGeneration(key, 'generations_get', { id: OTHER, status: 'COMPLETED' }, 2000);
    expect(recentGeneration(key, 3000)).toBe(OTHER);
    // A result with no generation changes nothing.
    rememberGeneration(key, 'assets_list', { items: [] }, 4000);
    expect(recentGeneration(key, 5000)).toBe(OTHER);
    // The raw generations_create (stdio's all toolset) creates one too.
    rememberGeneration('k2', 'generations_create', { id: ID, status: 'PENDING' }, 0);
    expect(recentGeneration('k2', 1000)).toBe(ID);
    // A translation preview's id is a job, not a generation.
    rememberGeneration(key, 'translation-previews_create', { structuredContent: { id: ID } }, 4500);
    expect(recentGeneration(key, 5000)).toBe(OTHER);
    expect(recentGeneration(key, 2000 + 30 * 60_000)).toBeUndefined();
    expect(recentGeneration(undefined)).toBeUndefined();
  });
});

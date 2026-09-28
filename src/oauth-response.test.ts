import { describe, expect, it, vi } from 'vitest';
import { readOAuthResponseText } from './oauth-response.js';

describe('OAuth response body cancellation', () => {
  it('preserves UTF-8 split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"message":"café 🚀"}');
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    expect(await readOAuthResponseText(new Response(body), new AbortController().signal)).toBe(
      '{"message":"café 🚀"}',
    );
    expect(body.locked).toBe(false);
  });

  it('returns an empty revocation response unchanged', async () => {
    expect(await readOAuthResponseText(new Response(null), new AbortController().signal)).toBe('');
  });

  it('cancels a pending read even when the underlying cancel never settles', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
      },
      cancel,
    });
    const controller = new AbortController();
    const pending = readOAuthResponseText(new Response(body), controller.signal);
    const rejected = expect(pending).rejects.toThrow('deadline');
    await Promise.resolve();
    controller.abort(new Error('deadline'));
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('cancels an unread response when the request already aborted', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    controller.abort(new Error('disconnected'));
    await expect(readOAuthResponseText(new Response(body), controller.signal)).rejects.toThrow(
      'disconnected',
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it('propagates body errors and releases the reader', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream failed'));
      },
    });
    await expect(
      readOAuthResponseText(new Response(body), new AbortController().signal),
    ).rejects.toThrow('upstream failed');
    expect(body.locked).toBe(false);
  });
});

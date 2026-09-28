/** Cancel the body reader explicitly, including when fetch's abort does not settle it. */
export async function readOAuthResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body) {
    signal.throwIfAborted();
    return '';
  }
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Compose cancellation on every supported Node runtime; dispose listeners after work. */
export function combineSignals(signals: AbortSignal[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  const dispose = () => {
    for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener);
    listeners.clear();
  };
  for (const signal of signals) {
    const abort = () => {
      controller.abort(signal.reason);
      dispose();
    };
    if (signal.aborted) {
      abort();
      break;
    }
    listeners.set(signal, abort);
    signal.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, dispose };
}

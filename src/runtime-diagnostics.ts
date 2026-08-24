export type HttpRequestCompletion = {
  statusCode: number;
  aborted: boolean;
  responseDelivered: boolean;
  durationMs: number;
};

export type HttpRequestStats = {
  total: number;
  inFlight: number;
  completed: number;
  aborted: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  durationMsTotal: number;
  durationMsMax: number;
};

export class HttpRequestMetrics {
  readonly #stats: HttpRequestStats = {
    total: 0,
    inFlight: 0,
    completed: 0,
    aborted: 0,
    status2xx: 0,
    status3xx: 0,
    status4xx: 0,
    status5xx: 0,
    durationMsTotal: 0,
    durationMsMax: 0,
  };

  start(): (completion: HttpRequestCompletion) => void {
    this.#stats.total += 1;
    this.#stats.inFlight += 1;
    let completed = false;

    return (completion) => {
      if (completed) return;
      completed = true;
      this.#stats.inFlight = Math.max(0, this.#stats.inFlight - 1);
      this.#stats.completed += 1;
      if (completion.aborted) this.#stats.aborted += 1;
      if (completion.responseDelivered) {
        if (completion.statusCode >= 200 && completion.statusCode < 300) this.#stats.status2xx += 1;
        if (completion.statusCode >= 300 && completion.statusCode < 400) this.#stats.status3xx += 1;
        if (completion.statusCode >= 400 && completion.statusCode < 500) this.#stats.status4xx += 1;
        if (completion.statusCode >= 500) this.#stats.status5xx += 1;
      }
      this.#stats.durationMsTotal += completion.durationMs;
      this.#stats.durationMsMax = Math.max(this.#stats.durationMsMax, completion.durationMs);
    };
  }

  snapshot(): HttpRequestStats {
    return { ...this.#stats };
  }
}

export function serializeError(error: unknown): {
  name?: string;
  message: string;
  stack?: string;
  code?: string;
} {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
      ...(typeof code === 'string' ? { code } : {}),
    };
  }
  return { message: String(error) };
}

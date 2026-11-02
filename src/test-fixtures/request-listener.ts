import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Node ignores a request listener's returned promise. On failure, close the response so
 * the client is not left waiting, then rethrow so the test runner still reports it.
 */
export function asyncRequestListener(
  listener: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void listener(req, res).catch((error: unknown) => {
      res.destroy();
      throw error;
    });
  };
}

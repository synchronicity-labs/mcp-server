import type { IncomingMessage, RequestListener, Server, ServerResponse } from 'node:http';

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

/**
 * Create results name their organization from GET /v2/account. For stubs that assert the
 * exact calls a workflow makes, leave it unserved so results omit the organization.
 */
export function skipAccountReads(server: Server): void {
  const listeners = server.listeners('request') as RequestListener[];
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/v2/account') return void res.writeHead(404).end('{}');
    for (const listener of listeners) listener(req, res);
  });
}

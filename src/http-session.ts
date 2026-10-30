import {
  CancelledNotificationSchema,
  InitializedNotificationSchema,
  JSONRPCMessageSchema,
  JSONRPCNotificationSchema,
} from '@modelcontextprotocol/core';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';

export function isSessionControlRequest(body: unknown): boolean {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  return (
    messages.length > 0 &&
    messages.every(
      (message) =>
        JSONRPCNotificationSchema.safeParse(message).success &&
        (InitializedNotificationSchema.safeParse(message).success ||
          CancelledNotificationSchema.safeParse(message).success),
    )
  );
}

/** Only handshake metadata survives between requests; SDK graphs never do. */
export class HttpSession {
  readonly #active = new Map<
    string | number,
    { cancel: (notification: unknown) => Promise<void> }
  >();
  readonly #running = new Map<McpServer, Response>();
  #initialized = false;
  #closed = false;
  constructor(
    readonly clientName: string,
    private readonly createServer: (clientName?: string, handshakeClientName?: string) => McpServer,
    private readonly reportProtocol: (version: string) => void,
    private readonly reportError: (details: Record<string, unknown>) => void = () => {},
  ) {}

  async handleRequest(req: Request, res: Response, initialize = false): Promise<void> {
    if (this.#closed) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const body: unknown = req.body;
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, DELETE');
      res.status(405).end();
      return;
    }
    const protocol = req.headers['mcp-protocol-version'];
    if (
      protocol !== undefined &&
      (typeof protocol !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.includes(protocol))
    ) {
      res.status(400).json({ error: 'Unsupported protocol version' });
      return;
    }
    const accept = req.headers.accept;
    if (!accept?.includes('application/json') || !accept.includes('text/event-stream')) {
      res.status(406).end();
      return;
    }
    const notification = JSONRPCNotificationSchema.safeParse(body).success;
    // No per-request server is needed for these lifecycle notifications.
    if (notification && InitializedNotificationSchema.safeParse(body).success) {
      this.#initialized = true;
      res.status(202).end();
      return;
    }
    const cancelled = CancelledNotificationSchema.safeParse(body);
    if (notification && cancelled.success && cancelled.data.params.requestId !== undefined) {
      const target = this.#active.get(cancelled.data.params.requestId);
      await target?.cancel(body);
      res.status(202).end();
      return;
    }
    const messages = Array.isArray(body) ? body : [body];
    const parsed = messages.map((value) => JSONRPCMessageSchema.safeParse(value));
    if (parsed.some((result) => !result.success)) {
      res.status(400).json({ error: 'Invalid JSON-RPC message' });
      return;
    }
    for (const result of parsed) {
      if (!result.success) continue;
      const notification = JSONRPCNotificationSchema.safeParse(result.data);
      if (!notification.success) continue;
      if (InitializedNotificationSchema.safeParse(notification.data).success)
        this.#initialized = true;
      const cancelled = CancelledNotificationSchema.safeParse(notification.data);
      if (cancelled.success && cancelled.data.params.requestId !== undefined)
        await this.#active.get(cancelled.data.params.requestId)?.cancel(notification.data);
    }
    if (isSessionControlRequest(body)) {
      res.status(202).end();
      return;
    }
    if (!initialize && !this.#initialized) {
      res.status(400).json({ error: 'Complete MCP initialization before sending requests' });
      return;
    }
    const ids: Array<string | number> = [];
    for (const result of parsed) {
      if (!result.success || !('method' in result.data)) continue;
      if (!initialize && result.data.method === 'initialize') {
        res.status(400).json({ error: 'Session is already initialized' });
        return;
      }
      if ('id' in result.data) ids.push(result.data.id);
    }
    if (new Set(ids).size !== ids.length || ids.some((id) => this.#active.has(id))) {
      res.status(400).json({ error: 'Request ID is already in flight in this session' });
      return;
    }
    const server = this.createServer(initialize ? undefined : this.clientName, this.clientName);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const completed = new Set<string | number>();
    const send = transport.send.bind(transport);
    transport.send = async (reply, options) => {
      if ('id' in reply && reply.id !== undefined && ('result' in reply || 'error' in reply))
        completed.add(reply.id);
      if ('error' in reply || ('result' in reply && reply.result.isError === true)) {
        this.reportError({
          requestId: res.locals.requestId,
          category: 'error' in reply ? 'protocol' : 'tool',
          ...('error' in reply ? { code: reply.error.code } : {}),
        });
      }
      if (initialize && 'result' in reply && typeof reply.result.protocolVersion === 'string')
        this.reportProtocol(reply.result.protocolVersion);
      return send(reply, options);
    };
    this.#running.set(server, res);
    if (!initialize)
      for (const id of ids)
        this.#active.set(id, {
          cancel: async (notification) => {
            if (completed.has(id)) return;
            const parsed = JSONRPCNotificationSchema.parse(notification);
            transport.onmessage?.(parsed);
            if (ids.length === 1) {
              res.destroy();
              await server.close();
            } else {
              // Legacy JSON batches need a terminal slot to deliver unrelated results.
              await transport.send({
                jsonrpc: '2.0',
                id,
                error: { code: -32800, message: 'Request cancelled' },
              });
            }
          },
        });
    let disconnected!: () => void;
    const closedResponse = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const onClose = () => {
      if (!res.writableFinished) disconnected();
    };
    res.once('close', onClose);
    try {
      await server.connect(transport);
      if (req.aborted || res.destroyed) return;
      // A disconnected client must release the SDK graph and abort its handlers,
      // even when no JSON response can finish.
      await Promise.race([transport.handleRequest(req, res, req.body), closedResponse]);
    } finally {
      res.off('close', onClose);
      if (!initialize) for (const id of ids) this.#active.delete(id);
      this.#running.delete(server);
      await server.close();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(
      [...this.#running].map(async ([server, response]) => {
        response.destroy();
        await server.close();
      }),
    );
  }
}

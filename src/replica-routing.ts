import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { request } from 'node:http';
import { isIPv4 } from 'node:net';
import type { RequestHandler } from 'express';
import ipaddr from 'ipaddr.js';

export type ReplicaRoutingConfig = { address: string; service: string; port: number };
const resolver = new Resolver({ timeout: 2000, tries: 1 });
const discoverPeers = (service: string) => resolver.resolve4(service);

/** Opt-in: the discovery name is operator configuration, never request input. */
export function getReplicaRoutingConfig(
  env: Record<string, string | undefined> = process.env,
): ReplicaRoutingConfig | undefined {
  if (!env.MCP_REPLICA_SERVICE) return undefined;
  const address = env.PORTER_POD_IP ?? env.MCP_REPLICA_IP;
  const port = Number(env.MCP_REPLICA_PORT ?? env.PORT ?? 3002);
  const service = env.MCP_REPLICA_SERVICE;
  if (!address || !isIPv4(address) || ipaddr.parse(address).range() !== 'private')
    throw new Error('Replica routing requires a private IPv4 pod address.');
  if (!/^[a-z0-9-]+\.[a-z0-9-]+\.svc\.cluster\.local$/.test(service))
    throw new Error('MCP_REPLICA_SERVICE must name a headless Kubernetes service.');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid MCP_REPLICA_PORT.');
  return { address, service, port };
}

export function createReplicaId(config = getReplicaRoutingConfig()): string {
  const nonce = randomBytes(32).toString('hex');
  return config
    ? `r1-${Buffer.from(config.address.split('.').map(Number)).toString('hex')}-${nonce}`
    : nonce;
}

function ownerAddress(id: string): string | undefined {
  const match = /^r1-([a-f0-9]{8})-[a-f0-9]{64}$/.exec(id);
  return match?.[1] ? [...Buffer.from(match[1], 'hex')].join('.') : undefined;
}

const FORWARDED = 'x-sync-replica-hop';
const REQUEST_HEADERS = [
  'authorization',
  'accept',
  'content-type',
  'content-length',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
  'origin',
  'x-request-id',
  'user-agent',
] as const;
const RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'mcp-session-id',
  'mcp-protocol-version',
  'www-authenticate',
  'retry-after',
  'x-request-id',
] as const;

/** Route to the live owning MCP pod, without retries or buffering media/SSE. */
export function createReplicaRouter(
  kind: 'mcp' | 'upload',
  config = getReplicaRoutingConfig(),
  discover: (service: string) => Promise<string[]> = discoverPeers,
): RequestHandler {
  let cached: { until: number; addresses: Set<string> } | undefined;
  let pending: Promise<Set<string>> | undefined;
  const peers = async () => {
    if (cached && cached.until > Date.now()) return cached.addresses;
    pending ??= discover(config!.service)
      .then((addresses) => {
        const result = new Set(
          addresses.filter(
            (address) => isIPv4(address) && ipaddr.parse(address).range() === 'private',
          ),
        );
        cached = { until: Date.now() + 2000, addresses: result };
        return result;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  return async (req, res, next) => {
    if (!config) return next();
    if (kind === 'mcp' && !['/', '/mcp'].includes(req.path)) return next();
    const id = kind === 'mcp' ? req.headers['mcp-session-id'] : req.query.ticket;
    const owner = typeof id === 'string' ? ownerAddress(id) : undefined;
    // Legacy identifiers remain valid only on their original pod during rollout.
    if (!owner || owner === config.address) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers[FORWARDED]) {
      res.status(503).json({ error: 'Replica routing loop prevented.' });
      return;
    }
    try {
      if (!(await peers()).has(owner)) {
        res.status(kind === 'mcp' ? 404 : 403).json({
          error:
            kind === 'mcp'
              ? 'Session not found'
              : 'Upload permission expired. Choose the file again.',
        });
        return;
      }
    } catch {
      res.status(503).json({ error: 'Replica discovery unavailable. Retry later.' });
      return;
    }
    const headers: Record<string, string | string[]> = { [FORWARDED]: '1' };
    for (const name of REQUEST_HEADERS) {
      if (kind === 'upload' && name === 'authorization') continue;
      const value = req.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    // Preserve the ingress-verified client IP across the extra internal hop.
    // Never copy a caller-provided forwarding chain.
    if (req.ip) headers['x-forwarded-for'] = req.ip;
    if (typeof res.locals.requestId === 'string') headers['x-request-id'] = res.locals.requestId;
    process.stderr.write(
      `${JSON.stringify({
        event: 'replica_request_routed',
        timestamp: new Date().toISOString(),
        kind,
        entry: config.address,
        owner,
        method: req.method,
        requestId: headers['x-request-id'],
      })}\n`,
    );
    const upstream = request(
      {
        hostname: owner,
        port: config.port,
        method: req.method,
        path: kind === 'mcp' ? '/mcp' : `/app-upload?ticket=${encodeURIComponent(String(id))}`,
        headers,
        // Bound idle connections; normal long-running calls and uploads keep streaming.
        timeout: 15 * 60_000,
      },
      (incoming) => {
        res.statusCode = incoming.statusCode ?? 502;
        for (const name of RESPONSE_HEADERS) {
          const value = incoming.headers[name];
          if (value !== undefined) res.setHeader(name, value);
        }
        incoming.on('error', () => res.destroy());
        res.flushHeaders();
        incoming.pipe(res);
      },
    );
    const abort = () => {
      if (!res.writableFinished) upstream.destroy();
    };
    req.once('aborted', abort);
    res.once('close', abort);
    upstream.once('timeout', () => upstream.destroy(new Error('Replica request timed out.')));
    upstream.once('error', (error: NodeJS.ErrnoException) => {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) {
        // No replay: an interrupted paid request can have completed on the owner.
        const gone = error.code === 'ECONNREFUSED';
        res.status(gone ? (kind === 'mcp' ? 404 : 403) : 502).json({
          error: gone
            ? kind === 'mcp'
              ? 'Session not found'
              : 'Upload permission expired. Choose the file again.'
            : 'Replica connection interrupted. Check operation status before retrying.',
        });
      }
    });
    res.once('close', () => req.off('aborted', abort));
    req.pipe(upstream);
  };
}

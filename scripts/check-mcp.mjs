import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// The scheduler supplies a fresh OAuth access token. Never persist credentials,
// log account results, or invoke a configurable (potentially paid) tool.
export async function checkMcp(url, token) {
  const endpoint = new URL(url);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('MCP monitor URL must not contain credentials, query or fragment');
  if (endpoint.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(endpoint.hostname))
    throw new Error('MCP monitor requires HTTPS outside loopback');
  if (!token) throw new Error('MCP_MONITOR_ACCESS_TOKEN is required');
  const requestInit = { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' };
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(15_000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
  });
  const client = new Client({ name: 'sync-availability-monitor', version: '1' });
  const options = { timeout: 15_000 };
  let stage = 'initialize';
  let failure;
  let capacity;
  try {
    await client.connect(transport, options);
    stage = 'tools/list';
    const catalog = await client.listTools({}, options);
    if (!catalog.tools.some((tool) => tool.name === 'get-account-context'))
      throw new Error('Missing account tool');
    stage = 'read-only tool';
    const result = await client.callTool(
      { name: 'get-account-context', arguments: {} },
      undefined,
      options,
    );
    if (result.isError) throw new Error('Account read failed');
    stage = 'capacity';
    const response = await fetch(new URL('/status', endpoint), {
      ...requestInit,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('Capacity read failed');
    const status = await response.json();
    const { active, pending, limit, rejectedCapacity, rejectedMemory, created } = status.sessions;
    const { heapUsedBytes, heapLimitBytes } = status.memory;
    const { inFlight, limit: requestLimit } = status.requests;
    const values = [
      active,
      pending,
      limit,
      rejectedCapacity,
      rejectedMemory,
      created,
      heapUsedBytes,
      heapLimitBytes,
      inFlight,
      requestLimit,
    ];
    if (
      !values.every((value) => Number.isFinite(value) && value >= 0) ||
      limit <= 0 ||
      heapLimitBytes <= 0 ||
      requestLimit <= 0
    )
      throw new Error('Invalid capacity metrics');
    capacity = {
      active,
      pending,
      limit,
      rejectedCapacity,
      rejectedMemory,
      created,
      heapUsedBytes,
      heapLimitBytes,
      inFlight,
      requestLimit,
    };
  } catch {
    // Upstream exceptions may contain authorization headers or private data.
    failure = new Error(`MCP availability check failed at ${stage}`);
  } finally {
    if (transport.sessionId) {
      try {
        await transport.terminateSession();
      } catch {
        failure ??= new Error('MCP availability check could not close its session');
      }
    }
    try {
      await client.close();
    } catch {
      failure ??= new Error('MCP availability check could not close its transport');
    }
  }
  if (failure) throw failure;
  return capacity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const capacity = await checkMcp(
      process.env.MCP_MONITOR_URL ?? 'https://mcp.sync.so/mcp',
      process.env.MCP_MONITOR_ACCESS_TOKEN,
    );
    console.log(JSON.stringify({ event: 'mcp_availability', ok: true, ...capacity }));
    if (
      (capacity.active + capacity.pending) / capacity.limit >= 0.8 ||
      capacity.heapUsedBytes / capacity.heapLimitBytes >= 0.6 ||
      capacity.inFlight / capacity.requestLimit >= 0.8
    ) {
      console.error('MCP capacity warning: session, request or heap headroom is low');
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

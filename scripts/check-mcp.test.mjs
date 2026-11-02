import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { checkMcp } from './check-mcp.mjs';

// Node ignores a request listener's returned promise. On failure, close the response so the
// client is not left waiting, then rethrow so the failure is still reported.
function asyncRequestListener(listener) {
  return (req, res) => {
    void listener(req, res).catch((error) => {
      res.destroy();
      throw error;
    });
  };
}

void test('monitor detects tool failure inside HTTP 200 and closes its session on success and failure', async () => {
  let toolFails = false;
  let deleted = 0;
  const server = createServer(
    asyncRequestListener(async (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer fixture');
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET' && req.url === '/mcp') {
        res.statusCode = 405;
        res.end();
        return;
      }
      if (req.method === 'DELETE') {
        deleted++;
        res.end('{}');
        return;
      }
      if (req.url === '/status') {
        res.end(
          JSON.stringify({
            sessions: {
              active: 1,
              pending: 0,
              limit: 1000,
              created: 1,
              rejectedCapacity: 0,
              rejectedMemory: 0,
            },
            memory: { heapUsedBytes: 10, heapLimitBytes: 100 },
            requests: { inFlight: 0, limit: 32 },
          }),
        );
        return;
      }
      let input = '';
      for await (const chunk of req) input += chunk;
      const body = JSON.parse(input);
      if (body.id === undefined) {
        res.statusCode = 202;
        res.end();
        return;
      }
      let result;
      if (body.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'fixture');
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        };
      } else if (body.method === 'tools/list')
        result = { tools: [{ name: 'get-account-context', inputSchema: { type: 'object' } }] };
      else
        result = {
          isError: toolFails,
          content: [{ type: 'text', text: toolFails ? 'private failure detail' : '{}' }],
        };
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  try {
    assert.equal((await checkMcp(url, 'fixture')).active, 1);
    assert.equal(deleted, 1);
    toolFails = true;
    await assert.rejects(checkMcp(url, 'fixture'), {
      message: 'MCP availability check failed at read-only tool',
    });
    assert.equal(deleted, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

void test('monitor refuses unsafe targets before connecting', async () => {
  await assert.rejects(checkMcp('https://user:pass@mcp.example.test/mcp', 'fixture'), {
    message: 'MCP monitor URL must not contain credentials, query or fragment',
  });
  await assert.rejects(checkMcp('https://mcp.example.test/mcp?debug=1', 'fixture'), {
    message: 'MCP monitor URL must not contain credentials, query or fragment',
  });
  await assert.rejects(checkMcp('http://mcp.example.test/mcp', 'fixture'), {
    message: 'MCP monitor requires HTTPS outside loopback',
  });
  await assert.rejects(checkMcp('https://mcp.example.test/mcp', ''), {
    message: 'MCP_MONITOR_ACCESS_TOKEN is required',
  });
});

import { createInterface } from 'node:readline';

// Consume structured logs via stdin. Emit aggregates only, never session refs.
const clients = new Map();
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.event !== 'mcp_session_closed') continue;
  const key = JSON.stringify([event.clientName, event.clientProfile, event.protocol]);
  const group = clients.get(key) ?? {
    sessions: 0,
    singleToolSessions: 0,
    unusedSessions: 0,
    requests: 0,
    tools: 0,
    lifetimeMsTotal: 0,
    reasons: {},
  };
  group.sessions++;
  group.singleToolSessions += event.toolCalls === 1 ? 1 : 0;
  group.unusedSessions += event.toolCalls === 0 ? 1 : 0;
  group.requests += event.requests;
  group.tools += event.toolCalls;
  group.lifetimeMsTotal += event.lifetimeMs;
  group.reasons[event.reason] = (group.reasons[event.reason] ?? 0) + 1;
  clients.set(key, group);
}
for (const [key, values] of clients) {
  const [client, profile, protocol] = JSON.parse(key);
  console.log(JSON.stringify({ client, profile, protocol, ...values }));
}

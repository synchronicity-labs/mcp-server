import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpec } from '../dist/openapi/index.js';
import { HOSTED_HTTP_TOOL_ALLOWLIST } from '../dist/server.js';
import { operationIdToToolName } from '../dist/tools/index.js';
import { loadCatalog, ROOT } from './skill-files.mjs';

const CHATGPT_EXCLUSIONS = new Set(['create-timeline-lipsync', 'send-feedback']);
const KINDS = new Set(['workflow-or-helper', 'app-workflow', 'widget-internal', 'stdio-generated']);

export function validateCoverage(capture, coverage, spec, catalog) {
  const mapped = new Map(coverage.tools.map((entry) => [entry.name, entry]));
  assert.equal(mapped.size, coverage.tools.length, 'Duplicate coverage entries.');
  const owners = new Set(catalog.skills.map((s) => s.name));
  for (const entry of mapped.values()) {
    assert(owners.has(entry.owner), `Unknown owner for ${entry.name}.`);
    assert(KINDS.has(entry.kind), `Unknown classification for ${entry.name}.`);
  }
  for (const name of HOSTED_HTTP_TOOL_ALLOWLIST)
    assert(mapped.has(name), `Unclassified hosted policy entry: ${name}`);
  const observed = new Set();
  const expectedProfiles = {
    http: ['openai-mcp', 'openai-mcp (Codex)', 'claude-ai', 'claude-code'],
    stdio: ['openai-mcp', 'openai-mcp (Codex)', 'claude-ai', 'claude-code'],
  };
  for (const [transport, profiles] of Object.entries(expectedProfiles)) {
    const clients = transport === 'http' ? capture.http?.clients : capture.stdio;
    for (const profile of profiles)
      assert(
        Array.isArray(clients?.[profile]?.tools),
        `Missing ${transport}/${profile} tool capture.`,
      );
    for (const [profile, client] of Object.entries(clients)) {
      assert(Array.isArray(client.tools), `Invalid ${transport}/${profile} tool list.`);
      checkProfile(transport, profile, client.tools, mapped, observed);
    }
  }
  for (const name of mapped.keys())
    assert(observed.has(name), `Inventory entry never registered in approved fixture: ${name}`);
  const operations = parseSpec(spec);
  const selected = new Set(operations.map((op) => op.operationId));
  for (const op of operations) {
    const name = operationIdToToolName(op.operationId);
    if (observed.has(name)) continue;
    const replacements = coverage.apiReplacements[name];
    assert(replacements?.length, `Unclassified parser-selected operation: ${op.operationId}`);
    for (const tool of replacements)
      assert(observed.has(tool), `${op.operationId}: missing wrapper ${tool}.`);
  }
  const filtered = Object.values(spec.paths)
    .flatMap((path) =>
      Object.entries(path)
        .filter(
          ([method, op]) =>
            ['get', 'post', 'patch', 'put', 'delete'].includes(method) &&
            op.operationId &&
            !selected.has(op.operationId),
        )
        .map(([, op]) => op.operationId),
    )
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    filtered,
    [...coverage.filteredApiOperations].sort((a, b) => a.localeCompare(b)),
    'Parser exclusions changed; classify them explicitly.',
  );
  return { skills: owners.size, tools: observed.size, operations: operations.length };
}

function checkProfile(transport, profile, tools, mapped, observed) {
  const app = ['openai-mcp', 'openai-mcp (Codex)'].includes(profile);
  for (const tool of tools) {
    const entry = mapped.get(tool.name);
    assert(entry, `Unclassified ${transport}/${profile} tool: ${tool.name}`);
    observed.add(tool.name);
    if (transport === 'http')
      assert(HOSTED_HTTP_TOOL_ALLOWLIST.has(tool.name), `Unhosted tool leaked: ${tool.name}`);
    const widgetOnly =
      tool._meta?.ui?.visibility?.length === 1 && tool._meta.ui.visibility[0] === 'app';
    assert.equal(
      entry.kind === 'widget-internal',
      widgetOnly,
      `${tool.name}: widget classification drift.`,
    );
    if (entry.kind === 'widget-internal' || entry.kind === 'app-workflow')
      assert(app, `${tool.name}: app tool leaked to ${profile}.`);
    if (profile === 'openai-mcp')
      assert(!CHATGPT_EXCLUSIONS.has(tool.name), `${tool.name}: tool leaked to ChatGPT.`);
    if (entry.kind === 'stdio-generated')
      assert.equal(transport, 'stdio', `${tool.name}: stdio tool leaked.`);
  }
  const expected = [...mapped.values()]
    .filter((entry) => {
      if (entry.kind === 'stdio-generated' && transport !== 'stdio') return false;
      if (['widget-internal', 'app-workflow'].includes(entry.kind) && !app) return false;
      return profile !== 'openai-mcp' || !CHATGPT_EXCLUSIONS.has(entry.name);
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(
    tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b)),
    expected,
    `${transport}/${profile}: registration differs from classified profile policy.`,
  );
}

function main() {
  const coverage = JSON.parse(readFileSync(resolve(ROOT, 'docs/skills/coverage.json'), 'utf8'));
  const fixture = readFileSync(resolve(ROOT, coverage.source.spec));
  assert.equal(
    createHash('sha256').update(fixture).digest('hex'),
    coverage.source.apiSha256,
    'Approved API fixture hash changed.',
  );
  mkdirSync(resolve(ROOT, 'temp'), { recursive: true });
  const supplied = process.argv.indexOf('--capture');
  const path = supplied >= 0 ? process.argv[supplied + 1] : resolve(ROOT, 'temp/skills-wire.json');
  assert(path, '--capture requires a path.');
  if (supplied < 0) {
    const result = spawnSync(
      process.execPath,
      ['scripts/capture-wire.mjs', 'capture', '--out', path, '--spec', coverage.source.spec],
      { cwd: ROOT, stdio: 'inherit' },
    );
    assert.equal(result.status, 0, 'MCP wire capture failed.');
  }
  const result = validateCoverage(
    JSON.parse(readFileSync(path, 'utf8')),
    coverage,
    JSON.parse(fixture.toString('utf8')),
    loadCatalog(),
  );
  console.log(
    `MCP skill coverage passed: ${result.skills} skills, ${result.tools} tools, ${result.operations} selected API operations across HTTP/stdio profiles.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

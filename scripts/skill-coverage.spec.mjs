// Runs after the fresh wire capture in skills:check; build and package the server first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { validateCoverage } from './check-skill-coverage.mjs';
import { loadCatalog, ROOT } from './skill-files.mjs';

const readJson = (path) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
const inventory = readJson('docs/skills/coverage.json');
const baseline = {
  capture: readJson('temp/skills-wire.json'),
  coverage: inventory,
  spec: readJson(inventory.source.spec),
  catalog: loadCatalog(),
};

function validate({ capture, coverage, spec, catalog }) {
  return validateCoverage(capture, coverage, spec, catalog);
}

void test('the real approved HTTP/stdio capture passes before negative mutations', () => {
  assert.doesNotThrow(() => validate(baseline));
});

const cases = [
  {
    name: 'missing HTTP profile',
    mutate: ({ capture }) => delete capture.http.clients['claude-ai'],
    error: /Missing http\/claude-ai tool capture/,
  },
  {
    name: 'missing stdio profile',
    mutate: ({ capture }) => delete capture.stdio['claude-code'],
    error: /Missing stdio\/claude-code tool capture/,
  },
  {
    name: 'invalid profile tool list',
    mutate: ({ capture }) => {
      capture.http.clients['cursor-vscode'].tools = null;
    },
    error: /Invalid http\/cursor-vscode tool list/,
  },
  {
    name: 'workflow absent from only one profile',
    mutate: ({ capture }) => {
      const client = capture.http.clients['claude-code'];
      client.tools = client.tools.filter((tool) => tool.name !== 'create-lipsync');
    },
    error: /http\/claude-code: registration differs/,
  },
  {
    name: 'unclassified registered tool',
    mutate: ({ capture }) => {
      capture.stdio['claude-code'].tools.push({ name: 'unclassified-tool' });
    },
    error: /Unclassified stdio\/claude-code tool: unclassified-tool/,
  },
  {
    name: 'stdio operation leaked into HTTP',
    mutate: ({ capture }) => {
      const tool = capture.stdio['claude-code'].tools.find(
        (entry) => entry.name === 'generate_create-generation',
      );
      assert(tool, 'Raw generation must be present in the valid stdio capture.');
      capture.http.clients['claude-code'].tools.push(tool);
    },
    error: /Unhosted tool leaked: generate_create-generation/,
  },
  {
    name: 'app workflow leaked into model-only stdio',
    mutate: ({ capture }) => {
      const tool = capture.stdio['openai-mcp'].tools.find(
        (entry) => entry.name === 'get-studio-view',
      );
      assert(tool, 'Studio must be present in the valid app capture.');
      capture.stdio['claude-code'].tools.push(tool);
    },
    error: /get-studio-view: app tool leaked to claude-code/,
  },
  {
    name: 'widget-only tool becomes model-visible',
    mutate: ({ capture }) => {
      const tool = capture.http.clients['openai-mcp'].tools.find(
        (entry) => entry.name === 'get-asset-creators',
      );
      assert(tool, 'Widget creator lookup must be present in the valid app capture.');
      tool._meta.ui.visibility = ['model', 'app'];
    },
    error: /get-asset-creators: widget classification drift/,
  },
  ...['create-timeline-lipsync', 'send-feedback'].map((name) => ({
    name: `${name} leaked into ChatGPT`,
    mutate: ({ capture }) => {
      const tool = capture.http.clients['openai-mcp (Codex)'].tools.find(
        (entry) => entry.name === name,
      );
      assert(tool, `${name} must be present in the valid Codex app capture.`);
      capture.http.clients['openai-mcp'].tools.push(tool);
    },
    error: new RegExp(`${name}: tool leaked to ChatGPT`),
  })),
  {
    name: 'duplicate tool ownership',
    mutate: ({ coverage }) => coverage.tools.push(coverage.tools[0]),
    error: /Duplicate coverage entries/,
  },
  {
    name: 'unknown skill owner',
    mutate: ({ coverage }) => {
      coverage.tools[0].owner = 'missing-skill';
    },
    error: /Unknown owner/,
  },
  {
    name: 'unknown tool classification',
    mutate: ({ coverage }) => {
      coverage.tools[0].kind = 'unrecognized-kind';
    },
    error: /Unknown classification/,
  },
  {
    name: 'hosted policy entry without an inventory classification',
    mutate: ({ coverage }) => {
      coverage.tools = coverage.tools.filter((tool) => tool.name !== 'create-lipsync');
    },
    error: /Unclassified hosted policy entry: create-lipsync/,
  },
  {
    name: 'new parser-selected operation without a tool or wrapper',
    mutate: ({ spec }) => {
      spec.paths['/v2/projects/coverage-probe'] = {
        get: {
          operationId: 'ProjectsController_coverageProbe',
          tags: ['Projects'],
          responses: { 200: { description: 'Probe response' } },
        },
      };
    },
    error: /Unclassified parser-selected operation: ProjectsController_coverageProbe/,
  },
  {
    name: 'missing wrapper classification for a selected API operation',
    mutate: ({ coverage }) => delete coverage.apiReplacements['dubbing_estimate-dubbing-cost'],
    error: /Unclassified parser-selected operation: DubbingController_estimateDubbingCost/,
  },
  {
    name: 'classified replacement wrapper was not registered',
    mutate: ({ coverage }) => {
      coverage.apiReplacements['dubbing_estimate-dubbing-cost'] = ['missing-wrapper'];
    },
    error: /DubbingController_estimateDubbingCost: missing wrapper missing-wrapper/,
  },
  {
    name: 'parser exclusions drift',
    mutate: ({ spec }) => {
      spec.paths['/v2/batches/coverage-probe'] = {
        get: {
          operationId: 'BatchController_coverageProbe',
          tags: ['Batch'],
          responses: { 200: { description: 'Probe response' } },
        },
      };
    },
    error: /Parser exclusions changed/,
  },
];

for (const { name, mutate, error } of cases) {
  void test(`coverage gate rejects ${name}`, () => {
    // The unmodified real capture remains the control; mutations never reach shared state.
    const input = structuredClone(baseline);
    mutate(input);
    assert.throws(() => validate(input), error);
  });
}

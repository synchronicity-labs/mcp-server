import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { syncPluginSkills } from './sync-plugin-skills.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sync-skill-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put(
    'skills/catalog.json',
    JSON.stringify({
      schemaVersion: 1,
      skills: [
        {
          name: 'sync-example',
          title: 'Example',
          availability: 'all',
          plugin: {
            name: 'published-example',
            interfaceYaml:
              'interface:\n  display_name: "Example"\n  short_description: "An example workflow for package checks"\n  default_prompt: "Use $published-example for this request."\n',
          },
        },
      ],
    }),
  );
  put(
    'skills/sync-example/SKILL.md',
    '---\nname: sync-example\ndescription: Complete an example task.\n---\n\nRead [details](references/details.md).\n',
  );
  put(
    'skills/sync-example/references/details.md',
    'Instructions needed by the installed workflow.\n',
  );
  return { root, put };
}

void test('a generated plugin is self-contained, keeps its published identity and checks without writing', (t) => {
  const { root, put } = fixture(t);
  syncPluginSkills({ root });
  const target = join(root, 'chatgpt-plugin/skills/published-example');
  assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /^name: published-example$/m);
  assert.equal(
    readFileSync(join(target, 'references/details.md'), 'utf8'),
    'Instructions needed by the installed workflow.\n',
  );
  assert.deepEqual(syncPluginSkills({ root }), []);
  put('skills/sync-example/references/details.md', 'Updated useful instructions.\n');
  assert.throws(() => syncPluginSkills({ root, check: true }), /stale plugin files/);
  assert.equal(
    readFileSync(join(target, 'references/details.md'), 'utf8'),
    'Instructions needed by the installed workflow.\n',
  );
  syncPluginSkills({ root });
  assert.equal(
    readFileSync(join(target, 'references/details.md'), 'utf8'),
    'Updated useful instructions.\n',
  );
});

void test('missing or escaping resources cannot produce a falsely complete package', (t) => {
  const { root, put } = fixture(t);
  rmSync(join(root, 'skills/sync-example/references/details.md'));
  assert.throws(() => syncPluginSkills({ root }), /missing or external skill resource/);
  put('skills/sync-example/references/details.md', '[outside](../../catalog.json)\n');
  assert.throws(() => syncPluginSkills({ root }), /missing or external skill resource/);
});

void test('malformed metadata and missing catalogued skill folders fail before packaging', (t) => {
  const { root, put } = fixture(t);
  put(
    'skills/sync-example/SKILL.md',
    '---\nname: sync-example\ndescription: [not, a, string]\n---\n',
  );
  assert.throws(() => syncPluginSkills({ root }), /expected string/);
  rmSync(join(root, 'skills/sync-example'), { recursive: true });
  assert.throws(() => syncPluginSkills({ root }), /directories differ/);
});

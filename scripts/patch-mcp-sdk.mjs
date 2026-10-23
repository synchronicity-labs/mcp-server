import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(
  dirname(require.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js')),
  '../../..',
);
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
assert.equal(version, '1.32.1', 'Review the JSON response cleanup patch before upgrading the SDK.');

// The JSON branch resolves its Response but leaves the resolver in _streamMapping,
// retaining the serialized body until the session closes. Match the SSE cleanup.
const before = `                        stream.resolveJson(new Response(JSON.stringify(responses), { status: 200, headers }));
                    }
                }
                else {`;
const after = `                        stream.resolveJson(new Response(JSON.stringify(responses), { status: 200, headers }));
                    }
                    stream.cleanup();
                }
                else {`;

// Validate both module formats before writing either. Reject dependency drift
// rather than silently shipping an unpatched transport after an SDK update.
const files = await Promise.all(
  ['esm', 'cjs'].map(async (format) => {
    const path = resolve(root, `dist/${format}/server/webStandardStreamableHttp.js`);
    const source = await readFile(path, 'utf8');
    if (source.includes(after)) {
      assert.equal(source.split(after).length, 2, `Ambiguous patched SDK source: ${path}`);
      assert(!source.includes(before), `Mixed patched SDK source: ${path}`);
      return { path, source, patched: source };
    }
    assert.equal(source.split(before).length, 2, `Unexpected SDK source: ${path}`);
    return { path, source, patched: source.replace(before, after) };
  }),
);
for (const { path, source, patched } of files) {
  if (source !== patched) await writeFile(path, patched);
}

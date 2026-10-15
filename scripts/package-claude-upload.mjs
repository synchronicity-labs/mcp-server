import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const source = new URL('../deploy/claude-upload/', import.meta.url);
const output = new URL('../dist/claude-upload/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', source), 'utf8'));
assert.equal(manifest.version, 1);
assert.equal(manifest.file, 'app.html');
assert.equal(manifest.repository, 'synchronicity-labs/sync-api-v2');
assert.match(manifest.commit, /^[a-f0-9]{40}$/);
assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
const html = gunzipSync(await readFile(new URL('app.html.gz', source)), {
  maxOutputLength: 8 * 1024 * 1024,
});
assert.equal(createHash('sha256').update(html).digest('hex'), manifest.sha256);
assert.equal(html.length, manifest.htmlBytes);
await mkdir(output, { recursive: true });
await writeFile(new URL('app.html', output), html);
await writeFile(new URL('manifest.json', output), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Packaged Sync upload ${manifest.commit}: ${manifest.sha256} (${html.length} bytes)`);

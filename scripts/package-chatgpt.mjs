import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { loadChatgptApp } from '../dist/chatgpt-app.js';
import { chatgptReleaseSchema } from '../dist/chatgpt-release.js';

// Check in the approved bytes so production builds need no cross-repository credentials.
const source = new URL('../deploy/chatgpt/', import.meta.url);
const output = new URL('../chatgpt-dist/', import.meta.url);
const catalog = chatgptReleaseSchema.parse(
  JSON.parse(await readFile(new URL('releases.json', source), 'utf8')),
);
const releases = [catalog.current, ...catalog.previous];
assert.deepEqual(
  (await readdir(source)).filter((name) => name !== 'releases.json').sort(),
  [...releases].sort(),
  'Every packaged directory must be declared in releases.json.',
);
assert(
  releases.length > 0 && releases.length <= 9,
  'Package one current and at most eight retained releases.',
);
// Rebuilding after pruning a retained release must not carry stale output forward.
await rm(output, { recursive: true, force: true });
for (const digest of releases.sort()) {
  assert.match(digest, /^[a-f0-9]{64}$/);
  const input = new URL(`${digest}/`, source);
  const destination = new URL(`${digest}/`, output);
  const release = JSON.parse(await readFile(new URL('release.json', input), 'utf8'));
  assert.equal(release.repository, 'synchronicity-labs/sync-api-v2');
  assert.match(release.commit, /^[a-f0-9]{40}$/);
  assert.equal(release.htmlSha256, digest);
  const html = gunzipSync(await readFile(new URL('app.html.gz', input)), {
    maxOutputLength: 8 * 1024 * 1024,
  });
  assert.equal(html.length, release.htmlBytes);
  await mkdir(destination, { recursive: true });
  await writeFile(new URL('app.html', destination), html);
  await copyFile(new URL('manifest.json', input), new URL('manifest.json', destination));
  await copyFile(new URL('release.json', input), new URL('release.json', destination));
  const app = await loadChatgptApp({
    directory: fileURLToPath(destination),
    domain: 'https://packaging.fixture.invalid',
    resourceDomains: [],
  });
  assert.equal(app.uri, `ui://sync/app-${digest}.html`);
  console.log(`Packaged ${release.commit}: ${digest} (${html.length} bytes)`);
}

await writeFile(new URL('releases.json', output), `${JSON.stringify(catalog, null, 2)}\n`);

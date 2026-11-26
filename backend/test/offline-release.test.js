import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OFFLINE_FORMAT, OFFLINE_PLATFORM, OFFLINE_TOOLS, RUNTIME_LICENSES,
  nativeFileInventory, sha256File, verifyOfflineRelease,
} from '../src/verify-offline-release.js';

const revision = 'a'.repeat(40);
const lockPath = 'backend/package-lock.json';
const markerPath = 'backend/release-revision.txt';
const nativePath = 'runtime/media/codec.dll';
const licensePath = 'runtime/media/LICENSE.txt';

async function fixture(t) {
  const work = await mkdtemp(join(tmpdir(), 'fai-release-test-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const root = join(work, 'payload');
  const file = path => join(root, path);
  async function put(path, content = 'example file for ' + path) {
    await mkdir(dirname(file(path)), { recursive: true });
    await writeFile(file(path), content);
    return sha256File(file(path));
  }
  const tools = await Promise.all(OFFLINE_TOOLS.map(async ([name, path, , source]) =>
    ({ name, path, source, version: '1.2.3', sha256: await put('runtime/' + path) })));
  const licenses = await Promise.all(RUNTIME_LICENSES.map(async ([path, source]) =>
    ({ path, source, sha256: await put(path) })));
  const lockSha256 = await put(lockPath, '{"lockfileVersion":3}\n');
  await put(markerPath, revision + '\n');
  await put(nativePath);
  await put('runtime/postgres/lib/postgres.lib');
  await put('backend/node_modules/native-addon/addon.node');
  const nativeFiles = await nativeFileInventory(root);
  const manifest = {
    format: OFFLINE_FORMAT, platform: OFFLINE_PLATFORM, revision, dependencies: { lockSha256 }, tools, licenses, nativeFiles,
  };
  const seal = async () => ({
    revision, manifestSha256: await put('release.json', JSON.stringify(manifest) + '\n'),
  });
  return { work, root, file, put, manifest, seal, expected: await seal() };
}

test('the library and operator command verify the extracted release', async t => {
  const { root, manifest, expected } = await fixture(t);
  const evidence = {
    ...expected, lockSha256: manifest.dependencies.lockSha256,
    nativeFiles: 12, tools: 9, licenses: 4,
  };
  assert.deepEqual(await verifyOfflineRelease(root, expected), evidence);
  const script = fileURLToPath(new URL('../src/verify-offline-release.js', import.meta.url));
  const result = spawnSync(process.execPath, [script, root, revision, expected.manifestSha256], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), evidence);
  const failure = spawnSync(process.execPath, [script, root, revision, '0'.repeat(64)], { encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /SHA-256 mismatch for release.json/);
});

test('expected revision and manifest digest are verified independently', async t => {
  const { root, expected, manifest, seal } = await fixture(t);
  await assert.rejects(verifyOfflineRelease(root, { revision }), /SHA-256 for release\.json/);
  await assert.rejects(verifyOfflineRelease(root, { ...expected, revision: 'b'.repeat(40) }), /revision mismatch/);
  manifest.dependencies.lockSha256 = '0'.repeat(64);
  await seal();
  await assert.rejects(verifyOfflineRelease(root, expected), /SHA-256 mismatch for release\.json/);
});

test('native files, lockfile, licenses, and revision marker must match', async t => {
  for (const [path, pattern] of [
    [nativePath, /SHA-256 mismatch for runtime\/media\/codec\.dll/],
    [lockPath, /SHA-256 mismatch for backend\/package-lock\.json/],
    [licensePath, /SHA-256 mismatch for runtime\/media\/LICENSE\.txt/],
    [markerPath, /Invalid packaged revision marker/],
  ]) {
    await t.test(path, async subtest => {
      const { root, expected, put } = await fixture(subtest);
      await put(path, 'changed\n');
      await assert.rejects(verifyOfflineRelease(root, expected), pattern);
    });
  }
});

test('extra and missing Windows native binaries fail verification', async t => {
  const { root, expected, file, put } = await fixture(t);
  const extra = 'backend/public/unlisted.DLL';
  await put(extra);
  await assert.rejects(verifyOfflineRelease(root, expected), /Unexpected native file backend\/public\/unlisted\.DLL/);
  await rm(file(extra));
  await rm(file(nativePath));
  await assert.rejects(verifyOfflineRelease(root, expected), /Missing release file runtime\/media\/codec\.dll/);
});

test('the manifest must account for every tool and its source and license evidence', async t => {
  for (const [alter, error] of [
    [manifest => { manifest.tools.pop(); }, /Incomplete runtime tool inventory/],
    [manifest => { manifest.tools[0].sha256 = '0'.repeat(64); }, /Invalid runtime tool evidence for node/],
    [manifest => { manifest.tools[0].source = 'file:///tmp/node.zip'; }, /public HTTPS source for node/],
    [manifest => { manifest.licenses.pop(); }, /Incomplete runtime license evidence/],
  ]) {
    await t.test(String(error), async subtest => {
      const { root, manifest, seal } = await fixture(subtest);
      alter(manifest);
      await assert.rejects(verifyOfflineRelease(root, await seal()), error);
    });
  }
});

test('unsafe Windows aliases, traversals, and duplicate native paths fail verification', async t => {
  const { root, manifest, seal } = await fixture(t);
  const sha256 = '0'.repeat(64);
  for (const path of [
    'runtime/../escaped.exe', 'C:/escaped.exe', 'runtime\\escaped.exe',
    '/runtime/escaped.exe', 'runtime/stream:escaped.exe', 'runtime/NUL.exe',
    'runtime/alias.dll.', 'runtime/alias.dll ',
  ]) {
    manifest.nativeFiles.push({ path, sha256 });
    await assert.rejects(verifyOfflineRelease(root, await seal()), /Unsafe release path/);
    manifest.nativeFiles.pop();
  }
  manifest.nativeFiles.push({ path: nativePath.toUpperCase(), sha256 });
  await assert.rejects(verifyOfflineRelease(root, await seal()), /Duplicate release path/);
});

test('verification rejects a linked directory within the extracted payload', async t => {
  const { work, root, file, expected } = await fixture(t);
  const external = join(work, 'external');
  await mkdir(external);
  await symlink(external, file('redirected'), 'junction');
  await assert.rejects(verifyOfflineRelease(root, expected), /Unsafe release file type for redirected/);
});

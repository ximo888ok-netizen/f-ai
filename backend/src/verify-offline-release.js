import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OFFLINE_FORMAT = 2;
export const OFFLINE_PLATFORM = 'win32-x64';
const postgresDistribution = 'https://www.enterprisedb.com/download-postgresql-binaries';
const mediaDistribution = 'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases';
export const OFFLINE_TOOLS = [
  ['node', 'node.exe', ['--version'], 'https://nodejs.org/dist/'],
  ...['postgres', 'initdb', 'pg_ctl', 'psql', 'pg_dump', 'pg_restore'].map(name =>
    [name, 'postgres/bin/' + name + '.exe', ['--version'], postgresDistribution]),
  ['ffmpeg', 'media/ffmpeg.exe', ['-version'], mediaDistribution],
  ['ffprobe', 'media/ffprobe.exe', ['-version'], mediaDistribution],
];
export const RUNTIME_LICENSES = [
  ['runtime/NODE-LICENSE', 'https://github.com/nodejs/node/blob/main/LICENSE'],
  ['runtime/postgres/server_license.txt', 'https://www.postgresql.org/about/licence/'],
  ['runtime/postgres/commandlinetools_3rd_party_licenses.txt', postgresDistribution],
  ['runtime/media/LICENSE.txt', 'https://ffmpeg.org/legal.html'],
];

const sha256Pattern = /^[a-f0-9]{64}$/i;
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const nativeExtension = /\.(exe|dll|node|lib|ocx|cpl|sys|drv|scr|efi)$/i;
const windowsDevice = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])$/i;

function requireDigest(value, description) {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) {
    throw new Error('Expected SHA-256 for ' + description);
  }
  return value.toLowerCase();
}

function requireSafePath(path) {
  if (typeof path !== 'string' || path.split('/').some(segment =>
    !segment || /[<>:"\\|?*\x00-\x1f\x7f]|[. ]$/.test(segment) ||
    windowsDevice.test(segment.split('.', 1)[0].trimEnd()))) {
    throw new Error('Unsafe release path ' + JSON.stringify(path));
  }
}

function requireSource(source, name) {
  const url = typeof source === 'string' && URL.canParse(source) ? new URL(source) : null;
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Expected a public HTTPS source for ' + name);
  }
}

export async function sha256File(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function releaseFiles(root) {
  if (!(await lstat(root)).isDirectory()) throw new Error('Expected a release directory');
  const files = new Map();
  async function visit(directory, prefix) {
    const names = new Set();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      requireSafePath(path);
      const folded = entry.name.toLowerCase();
      if (names.has(folded)) throw new Error('Case-colliding release path ' + path);
      names.add(folded);
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file, path + '/');
      else if (entry.isFile()) files.set(path, file);
      else throw new Error('Unsafe release file type for ' + path);
    }
  }
  await visit(root, '');
  return files;
}

async function requireRegularFile(file, path) {
  if (!file) throw new Error('Missing release file ' + path);
  const stats = await lstat(file);
  if (!stats.isFile() || stats.nlink !== 1 || stats.size === 0) {
    throw new Error('Expected a nonempty regular release file ' + path);
  }
}

export async function nativeFileInventory(root) {
  const inventory = [];
  for (const [path, file] of await releaseFiles(root)) {
    if (!nativeExtension.test(path)) continue;
    await requireRegularFile(file, path);
    inventory.push({ path, sha256: await sha256File(file) });
  }
  return inventory.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

function manifestEntries(entries, description) {
  if (!Array.isArray(entries)) throw new Error('Missing release ' + description);
  const paths = new Set();
  const result = new Map();
  for (const entry of entries) {
    requireSafePath(entry?.path);
    const folded = entry.path.toLowerCase();
    if (paths.has(folded)) throw new Error('Duplicate release path ' + entry.path);
    paths.add(folded);
    result.set(entry.path, requireDigest(entry.sha256, entry.path));
  }
  return result;
}

async function verifyFile(files, path, digest) {
  const file = files.get(path);
  await requireRegularFile(file, path);
  if (await sha256File(file) !== digest) throw new Error('SHA-256 mismatch for ' + path);
}

export async function verifyOfflineRelease(root, { revision, manifestSha256 } = {}) {
  const expectedDigest = requireDigest(manifestSha256, 'release.json from the delivery record');
  if (typeof revision !== 'string' || !revisionPattern.test(revision)) {
    throw new Error('Expected the full Git revision from the delivery record');
  }
  root = resolve(root);
  // Check the trust anchor before using paths or metadata supplied by the manifest.
  if (!(await lstat(root)).isDirectory()) throw new Error('Expected a release directory');
  const manifestFile = join(root, 'release.json');
  await requireRegularFile(manifestFile, 'release.json');
  const bytes = await readFile(manifestFile);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest) {
    throw new Error('SHA-256 mismatch for release.json');
  }
  const manifest = JSON.parse(bytes);
  if (manifest?.format !== OFFLINE_FORMAT || manifest.platform !== OFFLINE_PLATFORM) {
    throw new Error('Unsupported offline release manifest format or platform');
  }
  if (manifest.revision !== revision.toLowerCase()) throw new Error('Offline release revision mismatch');

  const nativeFiles = manifestEntries(manifest.nativeFiles, 'native file inventory');
  const licenses = manifestEntries(manifest.licenses, 'runtime license inventory');
  if (licenses.size !== RUNTIME_LICENSES.length ||
      !RUNTIME_LICENSES.every(([path, source]) =>
        licenses.has(path) && manifest.licenses.find(entry => entry.path === path).source === source)) {
    throw new Error('Incomplete runtime license evidence');
  }
  if (!Array.isArray(manifest.tools) || manifest.tools.length !== OFFLINE_TOOLS.length) {
    throw new Error('Incomplete runtime tool inventory');
  }
  for (const [name, path] of OFFLINE_TOOLS) {
    const tool = manifest.tools.find(entry => entry?.name === name);
    const nativePath = 'runtime/' + path;
    if (tool?.path !== path || typeof tool.version !== 'string' || !tool.version.trim() ||
        requireDigest(tool.sha256, name) !== nativeFiles.get(nativePath)) {
      throw new Error('Invalid runtime tool evidence for ' + name);
    }
    requireSource(tool.source, name);
  }

  const files = await releaseFiles(root);
  for (const path of files.keys()) {
    if (nativeExtension.test(path) && !nativeFiles.has(path)) throw new Error('Unexpected native file ' + path);
  }
  for (const [path, digest] of nativeFiles) {
    if (!nativeExtension.test(path)) throw new Error('Unexpected native inventory entry ' + path);
    await verifyFile(files, path, digest);
  }
  for (const [path, digest] of licenses) await verifyFile(files, path, digest);
  const lockSha256 = requireDigest(manifest.dependencies?.lockSha256, 'backend/package-lock.json');
  await verifyFile(files, 'backend/package-lock.json', lockSha256);

  const revisionPath = 'backend/release-revision.txt';
  await requireRegularFile(files.get(revisionPath), revisionPath);
  if ((await readFile(files.get(revisionPath), 'utf8')).trim() !== manifest.revision) {
    throw new Error('Invalid packaged revision marker');
  }
  return {
    revision: manifest.revision, manifestSha256: expectedDigest, lockSha256,
    nativeFiles: nativeFiles.size, tools: manifest.tools.length, licenses: licenses.size,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [root, revision, manifestSha256] = process.argv.slice(2);
    if (process.argv.length !== 5) {
      throw new Error('Usage: node verify-offline-release.js <extracted directory> <Git revision> <release.json SHA-256>');
    }
    console.log(JSON.stringify(await verifyOfflineRelease(root, { revision, manifestSha256 })));
  } catch (error) {
    console.error('Offline release verification failed: ' + error.message);
    process.exitCode = 1;
  }
}

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const script = fileURLToPath(new URL('../src/ops-observation.js', import.meta.url));
const minute = 60_000;
const required = 7 * 24 * 60 * minute;
const env = {
  FAI_RELEASE_REVISION: 'a'.repeat(40),
  FAI_PROBE_ORIGIN: 'https://candidate.example.test',
  FAI_PROBE_WORKSPACE_ID: 'example-private-workspace',
  FAI_PROBE_SESSION: '',
};
const iso = time => new Date(time).toISOString();
const fingerprint = settings => createHash('sha256').update(JSON.stringify([
  settings.FAI_RELEASE_REVISION, settings.FAI_PROBE_ORIGIN, settings.FAI_PROBE_WORKSPACE_ID || null,
])).digest('hex');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fai-observation-evidence-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return {dir, dbPath: join(dir, 'evidence.sqlite')};
}

async function observe(mode, dbPath, settings = {}) {
  const result = await run(process.execPath, [script, mode, dbPath], {
    env: {...process.env, ...env, ...settings},
  });
  return JSON.parse(result.stdout);
}

function seed(dbPath, write) {
  const db = new DatabaseSync(dbPath);
  try {
    // Legacy database from once/watch before the evidence report included issue details.
    db.exec('CREATE TABLE samples (seq INTEGER PRIMARY KEY, target TEXT NOT NULL, time INTEGER NOT NULL, ok INTEGER NOT NULL, issues TEXT NOT NULL); CREATE INDEX by_target ON samples(target,seq); BEGIN');
    const insert = db.prepare('INSERT INTO samples(target,time,ok,issues) VALUES(?,?,?,?)');
    write((time, ok = true, issues = '[]', settings = env) => {
      insert.run(fingerprint(settings), time, Number(ok), issues);
    });
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

test('report reads a live loopback sample without making requests or exposing workspace credentials', async t => {
  const {dbPath} = await fixture(t);
  const session = 'example-private-session';
  let requests = 0, workspaceAuthenticated = false, deployed = env.FAI_RELEASE_REVISION;
  const server = createServer((req, res) => {
    requests++;
    const body = {
      '/health': {status: 'ok'},
      '/ready': {status: 'ready'},
      '/version': {revision: deployed},
      '/v1/diagnostics/alerts': {alerts: []},
    }[req.url];
    if (req.url === '/v1/diagnostics/alerts') {
      workspaceAuthenticated = req.headers['x-workspace-id'] === env.FAI_PROBE_WORKSPACE_ID &&
        req.headers.authorization === 'Bearer ' + session;
      if (!workspaceAuthenticated) res.statusCode = 401;
    }
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const FAI_PROBE_ORIGIN = 'http://127.0.0.1:' + server.address().port;
  const settings = {...env, FAI_PROBE_ORIGIN};
  const sample = await observe('once', dbPath, {...settings, FAI_PROBE_SESSION: session});
  assert.equal(workspaceAuthenticated, true);
  assert.equal(sample.samples, 1);
  assert.equal(sample.failures, 0);
  assert.equal(sample.qualified, false);
  const healthy = await observe('report', dbPath, settings);
  assert.equal(healthy.windowStartedAt, sample.lastObservedAt);
  assert.equal(healthy.windowEndedAt, sample.lastObservedAt);
  assert.deepEqual(healthy.blockers, ['INSUFFICIENT_CONTINUOUS_TIME']);

  deployed = 'b'.repeat(40);
  await observe('once', dbPath, {...settings, FAI_PROBE_SESSION: session});
  const bytes = await readFile(dbPath);
  const report = await observe('report', dbPath, settings);
  assert.equal(requests, 8);
  assert.equal(report.target, fingerprint(settings));
  assert.equal(report.revision, settings.FAI_RELEASE_REVISION);
  assert.equal(report.scope, 'workspace');
  assert.equal(report.windowStartedAt, null);
  assert.equal(report.windowEndedAt, null);
  assert.deepEqual(report.blockers, ['LATEST_SAMPLE_FAILED']);
  assert.deepEqual(report.failureCounts, {RELEASE_MISMATCH: 1});
  assert.deepEqual(report.interruptions, [{kind: 'failure', observedAt: report.lastObservedAt, issues: ['RELEASE_MISMATCH']}]);
  const output = JSON.stringify(report);
  for (const privateValue of [session, env.FAI_PROBE_WORKSPACE_ID, FAI_PROBE_ORIGIN, deployed]) {
    assert.equal(output.includes(privateValue), false);
  }
  assert.deepEqual(await readFile(dbPath), bytes);
});

test('legacy evidence qualifies only a fresh uninterrupted seven-day window of the exact target', async t => {
  const {dbPath} = await fixture(t);
  const now = Date.now();
  const start = now - required;
  const staleSettings = {...env, FAI_PROBE_WORKSPACE_ID: 'stale-workspace'};
  const futureSettings = {...env, FAI_PROBE_WORKSPACE_ID: 'future-workspace'};
  const recentGapSettings = {...env, FAI_PROBE_WORKSPACE_ID: 'interrupted-workspace'};
  seed(dbPath, insert => {
    insert(start - 6 * minute, false, '["DATABASE_NOT_READY","private-legacy-data","DATABASE_NOT_READY"]');
    insert(start - 3 * minute);
    insert(start - 4 * minute, false, 'private-malformed-data');
    for (let offset = 0; offset <= required; offset += minute) {
      insert(start + offset);
      insert(start + offset - 3 * minute, true, '[]', staleSettings);
      insert(start + offset + 3 * minute, true, '[]', futureSettings);
      insert(start + offset - 3 * minute, true, '[]', recentGapSettings);
    }
    insert(now, true, '[]', recentGapSettings);
  });

  const report = await observe('report', dbPath);
  assert.equal(report.qualified, true);
  assert.equal(report.stale, false);
  assert.equal(report.requiredMs, required);
  assert.equal(report.maxGapMs, 2 * minute);
  assert.equal(report.continuousMs, required);
  assert.equal(report.windowStartedAt, iso(start));
  assert.equal(report.windowEndedAt, iso(now));
  assert.equal(report.failures, 2);
  assert.equal(report.gaps, 3);
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.failureCounts, {DATABASE_NOT_READY: 1, UNCLASSIFIED_PROBE_FAILURE: 2});
  assert.deepEqual(report.gapCounts, {HEARTBEAT_GAP: 2, CLOCK_REGRESSION: 1});
  assert.deepEqual(report.interruptions, [
    {kind: 'failure', observedAt: iso(start - 6 * minute), issues: ['DATABASE_NOT_READY', 'UNCLASSIFIED_PROBE_FAILURE']},
    {kind: 'gap', reason: 'HEARTBEAT_GAP', previousObservedAt: iso(start - 6 * minute), observedAt: iso(start - 3 * minute), elapsedMs: 3 * minute},
    {kind: 'gap', reason: 'CLOCK_REGRESSION', previousObservedAt: iso(start - 3 * minute), observedAt: iso(start - 4 * minute), elapsedMs: -minute},
    {kind: 'failure', observedAt: iso(start - 4 * minute), issues: ['UNCLASSIFIED_PROBE_FAILURE']},
    {kind: 'gap', reason: 'HEARTBEAT_GAP', previousObservedAt: iso(start - 4 * minute), observedAt: iso(start), elapsedMs: 4 * minute},
  ]);
  const reports = await Promise.all([
    observe('report', dbPath, {FAI_RELEASE_REVISION: 'c'.repeat(40)}),
    observe('report', dbPath, {FAI_PROBE_ORIGIN: 'https://other.example.test'}),
    observe('report', dbPath, {FAI_PROBE_WORKSPACE_ID: ''}),
    observe('report', dbPath, staleSettings),
    observe('report', dbPath, futureSettings),
    observe('report', dbPath, recentGapSettings),
  ]);
  for (const empty of reports.slice(0, 3)) {
    assert.equal(empty.samples, 0);
    assert.equal(empty.windowStartedAt, null);
    assert.equal(empty.qualified, false);
    assert.notEqual(empty.target, report.target);
    assert.deepEqual(empty.blockers, ['NO_SAMPLES']);
  }
  assert.equal(reports[2].scope, 'service');
  for (const old of reports.slice(3, 5)) {
    assert.equal(old.stale, true);
    assert.equal(old.qualified, false);
    assert.equal(old.continuousMs, required);
  }
  assert.deepEqual(reports[3].blockers, ['HEARTBEAT_STALE']);
  assert.deepEqual(reports[4].blockers, ['CLOCK_BEHIND_LAST_SAMPLE']);
  const resumed = reports[5];
  assert.equal(resumed.stale, false);
  assert.equal(resumed.qualified, false);
  assert.equal(resumed.windowStartedAt, iso(now));
  assert.equal(resumed.windowEndedAt, iso(now));
  assert.equal(resumed.continuousMs, 0);
  assert.deepEqual(resumed.blockers, ['INSUFFICIENT_CONTINUOUS_TIME']);
  assert.deepEqual(resumed.gapCounts, {HEARTBEAT_GAP: 1});
});

test('report summarizes all interruptions with bounded detail and leaves a missing evidence database untouched', async t => {
  const {dir, dbPath} = await fixture(t);
  await assert.rejects(observe('report', dbPath), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Observation failed/);
    assert.equal(error.stderr.includes(dir), false);
    return true;
  });
  assert.deepEqual(await readdir(dir), []);

  const now = Date.now();
  seed(dbPath, insert => {
    for (let offset = 54; offset >= 0; offset--) insert(now - offset * minute, false, '["QUEUE_DELAY"]');
  });
  const report = await observe('report', dbPath);
  assert.equal(report.qualified, false);
  assert.equal(report.failures, 55);
  assert.deepEqual(report.failureCounts, {QUEUE_DELAY: 55});
  assert.equal(report.interruptionsOmitted, 5);
  assert.equal(report.interruptions.length, 50);
  assert.equal(report.interruptions[0].observedAt, iso(now - 49 * minute));
  assert.equal(report.interruptions.at(-1).observedAt, iso(now));
});

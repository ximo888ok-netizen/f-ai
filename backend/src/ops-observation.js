import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { diagnosticAlerts } from './diagnostic-alerts.js';
import { probe } from './ops-probe.js';

const minute = 60_000;
const maxGapMs = 2 * minute;
const requiredMs = 7 * 24 * 60 * minute;
const interruptionLimit = 50;
const knownIssues = new Set([
  ...diagnosticAlerts,
  'PROCESS_UNAVAILABLE', 'DATABASE_NOT_READY', 'WORKSPACE_PROBE_FAILED',
  'RELEASE_MISMATCH', 'RELEASE_UNVERIFIED',
]);
const issueFallback = 'UNCLASSIFIED_PROBE_FAILURE';
const iso = time => time === null ? null : new Date(time).toISOString();

function failureIssues(stored) {
  try {
    const issues = JSON.parse(stored);
    if (Array.isArray(issues) && issues.length) {
      return [...new Set(issues.map(issue => knownIssues.has(issue) ? issue : issueFallback))];
    }
  } catch {
    // Older or damaged records can still interrupt the window without exposing their contents.
  }
  return [issueFallback];
}

function summarize(samples, asOf, includeEvidence = false) {
  let start = null, last = null, failures = 0, gaps = 0, count = 0;
  let lastFailed = false, interruptionsOmitted = 0;
  const failureCounts = {};
  const gapCounts = {};
  const interruptions = [];

  function record(interruption) {
    if (interruptions.length === interruptionLimit) {
      interruptions.shift();
      interruptionsOmitted++;
    }
    interruptions.push(interruption);
  }

  // Sample order is insertion order so the timestamps can reveal clock regressions.
  for (const {time, ok, issues} of samples) {
    count++;
    const elapsedMs = last === null ? null : time - last;
    if (elapsedMs !== null && (elapsedMs > maxGapMs || elapsedMs <= 0)) {
      gaps++;
      start = null;
      if (includeEvidence) {
        const reason = elapsedMs <= 0 ? 'CLOCK_REGRESSION' : 'HEARTBEAT_GAP';
        gapCounts[reason] = (gapCounts[reason] ?? 0) + 1;
        record({kind: 'gap', reason, previousObservedAt: iso(last), observedAt: iso(time), elapsedMs});
      }
    }
    lastFailed = !ok;
    if (lastFailed) {
      failures++;
      start = null;
      if (includeEvidence) {
        const reasons = failureIssues(issues);
        for (const reason of reasons) failureCounts[reason] = (failureCounts[reason] ?? 0) + 1;
        record({kind: 'failure', observedAt: iso(time), issues: reasons});
      }
    } else start ??= time;
    last = time;
  }

  const checkedAt = includeEvidence ? Date.now() : asOf;
  const heartbeatAgeMs = last === null || checkedAt === undefined ? null : checkedAt - last;
  const stale = last === null || (heartbeatAgeMs !== null && (heartbeatAgeMs > maxGapMs || heartbeatAgeMs < 0));
  const continuousMs = start === null ? 0 : last - start;
  const summary = {
    samples: count, failures, gaps, lastObservedAt: iso(last),
    continuousMs, stale, qualified: !stale && continuousMs >= requiredMs,
  };
  if (!includeEvidence) return summary;

  const blockers = [];
  if (last === null) blockers.push('NO_SAMPLES');
  else {
    if (heartbeatAgeMs < 0) blockers.push('CLOCK_BEHIND_LAST_SAMPLE');
    if (heartbeatAgeMs > maxGapMs) blockers.push('HEARTBEAT_STALE');
    if (lastFailed) blockers.push('LATEST_SAMPLE_FAILED');
    else if (continuousMs < requiredMs) blockers.push('INSUFFICIENT_CONTINUOUS_TIME');
  }

  return {
    ...summary, reportedAt: iso(checkedAt), heartbeatAgeMs, maxGapMs, requiredMs,
    windowStartedAt: iso(start), windowEndedAt: start === null ? null : iso(last),
    blockers, failureCounts, gapCounts, interruptions, interruptionsOmitted,
  };
}

export function observationSummary(samples, asOf) {
  return summarize(samples, asOf);
}

async function run() {
  const [mode,path,...extra]=process.argv.slice(2);
  const env=process.env, revision=env.FAI_RELEASE_REVISION;
  if (!['once','watch','report'].includes(mode) || !isAbsolute(path||'') || extra.length || !/^[a-f0-9]{40}$/.test(revision) ||
      !env.FAI_PROBE_ORIGIN) throw new Error();
  const key=createHash('sha256').update(JSON.stringify([revision,env.FAI_PROBE_ORIGIN,env.FAI_PROBE_WORKSPACE_ID || null])).digest('hex');
  const report = mode === 'report';
  const db=new DatabaseSync(path, {readOnly: report});
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (report) {
      const samples = db.prepare('SELECT time,ok,issues FROM samples WHERE target=? ORDER BY seq').iterate(key);
      console.log(JSON.stringify({
        revision, target: key, scope: env.FAI_PROBE_WORKSPACE_ID ? 'workspace' : 'service',
        ...summarize(samples, undefined, true),
      }));
      return;
    }
    db.exec('CREATE TABLE IF NOT EXISTS samples (seq INTEGER PRIMARY KEY, target TEXT NOT NULL, time INTEGER NOT NULL, ok INTEGER NOT NULL, issues TEXT NOT NULL); CREATE INDEX IF NOT EXISTS by_target ON samples(target,seq)');
    do {
      const sample=await probe(env);
      try {
        const response=await fetch(new URL('/version',env.FAI_PROBE_ORIGIN),{redirect:'error',signal:AbortSignal.timeout(5000)});
        if (!response.ok || (await response.json()).revision!==revision) sample.issues.push('RELEASE_MISMATCH');
      } catch {sample.issues.push('RELEASE_UNVERIFIED');}
      db.prepare('INSERT INTO samples(target,time,ok,issues) VALUES(?,?,?,?)').run(key,Date.now(),Number(!sample.issues.length),JSON.stringify(sample.issues));
      const summary=observationSummary(db.prepare('SELECT time,ok FROM samples WHERE target=? ORDER BY seq').iterate(key),Date.now());
      console.log(JSON.stringify({revision,...summary}));
      if (mode!=='watch' || summary.qualified) break;
      await delay(minute);
    } while (true);
  } finally {db.close();}
}
if(import.meta.main) {
  try {await run();} catch {console.error('Observation failed. Check candidate identity, probe configuration and evidence path.');process.exitCode=1;}
}

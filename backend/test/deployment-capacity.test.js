import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assessDeploymentCapacity } from '../src/deployment-capacity.js';

function minimumCapacity() {
  return {
    cpu: { cores: 8, coreSource: 'topology', threads: 16, threadSource: 'topology' },
    memory: { total: 16_000_000_000n, source: 'memory' },
    volume: { total: 500_000_000_000n, free: 0n, available: 0n, source: 'volume' },
  };
}

test('qualifies inclusive hardware thresholds and records free space separately', () => {
  const report = assessDeploymentCapacity(minimumCapacity());

  assert.equal(report.eligibility, 'meets');
  assert.deepEqual(report.checks, {
    physicalCpuCores: { value: 8, minimum: 8, source: 'topology', status: 'meets' },
    logicalCpuThreads: { value: 16, minimum: 16, source: 'topology', status: 'meets' },
    totalMemoryBytes: { value: '16000000000', minimum: '16000000000', source: 'memory', status: 'meets' },
    volumeTotalBytes: { value: '500000000000', minimum: '500000000000', source: 'volume', status: 'meets' },
  });
  assert.equal(report.volumeFreeBytes, '0');
  assert.equal(report.volumeAvailableBytes, '0');
});

test('returns below for any metric just below its threshold', () => {
  const cases = [
    ['physicalCpuCores', 'cpu', 'cores', 7],
    ['logicalCpuThreads', 'cpu', 'threads', 15],
    ['totalMemoryBytes', 'memory', 'total', 15_999_999_999n],
    ['volumeTotalBytes', 'volume', 'total', 499_999_999_999n],
  ];
  for (const [check, group, metric, below] of cases) {
    const measurements = minimumCapacity();
    measurements[group][metric] = below;
    const report = assessDeploymentCapacity(measurements);
    assert.equal(report.eligibility, 'below', check);
    assert.equal(report.checks[check].status, 'below', check);
  }
});

test('leaves unavailable measurements unknown and preserves measured shortfalls', () => {
  const measurements = minimumCapacity();
  delete measurements.cpu.cores;
  delete measurements.volume.free;
  delete measurements.volume.available;
  const report = assessDeploymentCapacity(measurements);
  assert.equal(report.eligibility, 'unknown');
  assert.deepEqual(report.checks.physicalCpuCores, {
    value: null, minimum: 8, source: null, status: 'unknown',
  });
  assert.equal(report.volumeFreeBytes, null);
  assert.equal(report.volumeAvailableBytes, null);

  measurements.cpu.threads = 15;
  assert.equal(assessDeploymentCapacity(measurements).eligibility, 'below');
  assert.equal(assessDeploymentCapacity().eligibility, 'unknown');
});

test('CLI measures the chosen volume and redacts its directory', () => {
  const script = fileURLToPath(new URL('../src/deployment-capacity.js', import.meta.url));
  const { status, stdout, stderr, error } = spawnSync(process.execPath, [script, process.cwd()], {
    encoding: 'utf8',
    timeout: 25_000,
  });

  assert.ifError(error);
  assert.equal(stderr, '');
  const report = JSON.parse(stdout);
  assert.equal(status, { meets: 0, below: 1, unknown: 2 }[report.eligibility]);
  assert.equal(report.checks.volumeTotalBytes.source, 'statfs');
  assert.match(report.checks.volumeTotalBytes.value, /^\d+$/);
  assert.equal(JSON.stringify(report).includes(JSON.stringify(process.cwd()).slice(1, -1)), false);
});

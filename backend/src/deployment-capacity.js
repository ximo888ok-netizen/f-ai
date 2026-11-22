import { execFile } from 'node:child_process';
import { readFile, stat, statfs } from 'node:fs/promises';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const gigabyte = 1_000_000_000n;
const minimum = {
  physicalCpuCores: 8,
  logicalCpuThreads: 16,
  totalMemoryBytes: 16n * gigabyte,
  volumeTotalBytes: 500n * gigabyte,
};

const windowsTopologyScript = String.raw`$ErrorActionPreference = 'Stop'
$result = [ordered]@{ cores = $null; threads = $null; hypervisorPresent = $null; cpuSource = $null }

try {
    $system = Get-CimInstance -ClassName Win32_ComputerSystem -Property HypervisorPresent -OperationTimeoutSec 5
    if ($null -ne $system.HypervisorPresent) {
        $result.hypervisorPresent = [bool] $system.HypervisorPresent
    }
} catch { }

try {
    $processors = @(Get-CimInstance -ClassName Win32_Processor -Property NumberOfCores,NumberOfLogicalProcessors -OperationTimeoutSec 5)
    $incomplete = @($processors | Where-Object { $_.NumberOfCores -le 0 -or $_.NumberOfLogicalProcessors -lt $_.NumberOfCores })
    if ($processors.Count -gt 0 -and $incomplete.Count -eq 0) {
        $result.cores = ($processors | Measure-Object -Property NumberOfCores -Sum).Sum
        $result.threads = ($processors | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum
        $result.cpuSource = 'windows-cim'
    }
} catch { }

if ($null -eq $result.cores) {
    try {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class CapacityTopology {
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetLogicalProcessorInformationEx(
        int relationship, IntPtr buffer, ref int length);

    public static int CoreCount() {
        // RelationProcessorCore (0) returns one record per OS-visible core.
        int length = 0;
        GetLogicalProcessorInformationEx(0, IntPtr.Zero, ref length);
        if (length <= 0) throw new Win32Exception();
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try {
            if (!GetLogicalProcessorInformationEx(0, buffer, ref length))
                throw new Win32Exception();
            int cores = 0;
            for (int offset = 0; offset < length;) {
                if (length - offset < 8) throw new InvalidOperationException();
                int size = Marshal.ReadInt32(buffer, offset + 4);
                if (size < 8 || size > length - offset)
                    throw new InvalidOperationException();
                cores++;
                offset += size;
            }
            return cores;
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
'@
        $result.cores = [CapacityTopology]::CoreCount()
        $result.cpuSource = 'windows-kernel-topology'
    } catch { }
}

$result | ConvertTo-Json -Compress`;

function positiveCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function serializeValue(value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function assessDeploymentCapacity({ cpu = {}, memory = {}, volume = {} } = {}) {
  const measurements = {
    physicalCpuCores: [cpu.cores, cpu.coreSource],
    logicalCpuThreads: [cpu.threads, cpu.threadSource],
    totalMemoryBytes: [memory.total, memory.source],
    volumeTotalBytes: [volume.total, volume.source],
  };
  const checks = Object.fromEntries(Object.entries(minimum).map(([key, threshold]) => {
    const [value = null, source = null] = measurements[key];
    const status = value === null ? 'unknown' : value < threshold ? 'below' : 'meets';
    return [key, {
      value: serializeValue(value),
      minimum: serializeValue(threshold),
      source: value === null ? null : source,
      status,
    }];
  }));
  const statuses = Object.values(checks).map(check => check.status);
  const eligibility = statuses.includes('below') ? 'below' :
    statuses.includes('unknown') ? 'unknown' : 'meets';

  return {
    eligibility,
    byteUnit: '1 GB = 1000000000 bytes',
    checks,
    volumeFreeBytes: serializeValue(volume.free ?? null),
    volumeAvailableBytes: serializeValue(volume.available ?? null),
  };
}

async function windowsCpuTopology() {
  const executable = join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const encoded = Buffer.from(windowsTopologyScript, 'utf16le').toString('base64');
    const { stdout } = await run(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
    ], { timeout: 20_000, maxBuffer: 65_536, windowsHide: true });
    const result = JSON.parse(stdout);
    return {
      cores: positiveCount(result.cores),
      coreSource: result.cpuSource,
      threads: positiveCount(result.threads),
      threadSource: result.cpuSource,
      hypervisorPresent: typeof result.hypervisorPresent === 'boolean' ? result.hypervisorPresent : null,
    };
  } catch {
    return {};
  }
}

async function linuxCpuTopology() {
  try {
    const cpuDirectory = '/sys/devices/system/cpu';
    const rangeList = (await readFile(join(cpuDirectory, 'online'), 'utf8')).trim();
    if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(rangeList)) return {};

    const online = [];
    for (const range of rangeList.split(',')) {
      const [start, end = start] = range.split('-').map(Number);
      for (let cpu = start; cpu <= end; cpu += 1) online.push(cpu);
    }
    const siblings = [];
    for (const id of online) {
      const topology = join(cpuDirectory, 'cpu' + id, 'topology');
      const group = await readFile(join(topology, 'core_cpus_list'), 'utf8')
        .catch(() => readFile(join(topology, 'thread_siblings_list'), 'utf8'));
      const core = group.trim();
      if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(core)) return {};
      siblings.push(core);
    }
    return {
      cores: positiveCount(new Set(siblings).size),
      coreSource: 'linux-sysfs-core-siblings',
      threads: positiveCount(online.length),
      threadSource: 'linux-sysfs-online-cpus',
    };
  } catch {
    return {};
  }
}

async function readVolume(directory) {
  try {
    if (!(await stat(directory)).isDirectory()) return {};
    const data = await statfs(directory, { bigint: true });
    const block = data.frsize > 0n ? data.frsize : data.bsize;
    if (block <= 0n || data.blocks <= 0n) return {};
    return {
      total: data.blocks * block,
      free: data.bfree >= 0n && data.bfree <= data.blocks ? data.bfree * block : null,
      available: data.bavail >= 0n && data.bavail <= data.blocks ? data.bavail * block : null,
      source: 'statfs',
    };
  } catch {
    return {};
  }
}

async function measureCapacity(directory) {
  const [cpu, volume] = await Promise.all([
    process.platform === 'win32' ? windowsCpuTopology() :
      process.platform === 'linux' ? linuxCpuTopology() : {},
    readVolume(directory),
  ]);
  if (!cpu.threads) {
    cpu.threads = positiveCount(cpus().length);
    cpu.threadSource = 'node-os-cpus';
  }
  if (cpu.threads && cpu.cores > cpu.threads) cpu.cores = null;

  const memoryBytes = positiveCount(totalmem());
  const memory = { total: memoryBytes === null ? null : BigInt(memoryBytes), source: 'node-os-totalmem' };
  return {
    observedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    scope: 'os-visible-topology-and-selected-filesystem-volume',
    hypervisorPresent: cpu.hypervisorPresent ?? null,
    processAvailableParallelism: positiveCount(availableParallelism()),
    ...assessDeploymentCapacity({ cpu, memory, volume }),
  };
}

async function main(args) {
  const usage = 'Usage: node src/deployment-capacity.js <existing deployment-volume directory>';
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return 0;
  }
  if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
    console.error(usage);
    return 2;
  }
  const report = await measureCapacity(args[0]);
  console.log(JSON.stringify(report, null, 2));
  return { meets: 0, below: 1, unknown: 2 }[report.eligibility];
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch {
    console.error('Unable to complete deployment capacity measurement.');
    process.exitCode = 2;
  }
}

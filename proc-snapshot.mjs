// What the processes under this one are doing, read from Linux's /proc, for the line a Chromium launch that misses
// its limit logs before the service exits (ops I-2278). Each process gives its name, its state (R running, S
// sleeping, D waiting on the disk), the CPU time and the major page faults (pages read from the image) it has used,
// its thread count and the kernel function it waits in; the instance gives its load and its CPU, I/O and memory
// pressure. So the line tells a busy start (R, CPU time near the time waited) from one waiting on its files (D,
// major faults) or on nothing it says (S, little CPU). No process's command line or environment is read.
// Without /proc (macOS) every figure is "-".

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

// /proc/<pid>/stat counts CPU time in clock ticks of USER_HZ, 100 a second on Linux (proc(5), sysconf(_SC_CLK_TCK)).
const USER_HZ = 100;
// Chromium starts with a browser, a zygote or two and a few helpers; a list longer than this is cut.
const MAX_LISTED = 12;
const PRESSURES = ['cpu', 'io', 'memory'];

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

// A name or kernel symbol as one token of the log line: letters, digits, '.', '_' and '-' only.
function token(text) {
  const cleaned = String(text).trim().replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : '-';
}

/**
 * One /proc/<pid>/stat line (proc(5)). The name sits in parentheses and may hold spaces or parentheses itself, so
 * the fields are counted from its last ')'.
 * @returns {{ pid: number, name: string, state: string, ppid: number, majflt: number, cpuMs: number,
 *   threads: number } | null}
 */
export function parseStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  // From field 3, state: rest[0] is field 3, rest[k] is field k + 3.
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const field = (n) => Number(rest[n - 3]);
  const parsed = {
    pid,
    name: text.slice(open + 1, close),
    state: rest[0],
    ppid: field(4),
    majflt: field(12),
    cpuMs: Math.round(((field(14) + field(15)) * 1000) / USER_HZ),
    threads: field(20),
  };
  const numbers = [parsed.pid, parsed.ppid, parsed.majflt, parsed.cpuMs, parsed.threads];
  return numbers.every(Number.isFinite) && /^[A-Za-z]$/.test(parsed.state) ? parsed : null;
}

/** Every process below `rootPid` (children, their children, ...), in pid order, each with its wait channel. */
export async function processesUnder(rootPid, { procRoot = '/proc' } = {}) {
  let entries;
  try {
    entries = await readdir(procRoot);
  } catch {
    return null;
  }
  const stats = await Promise.all(entries.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    const text = await readText(path.join(procRoot, name, 'stat'));
    return text === null ? null : parseStat(text);
  }));
  const children = new Map();
  for (const stat of stats) {
    if (!stat) continue;
    if (!children.has(stat.ppid)) children.set(stat.ppid, []);
    children.get(stat.ppid).push(stat);
  }
  const found = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) || []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  found.sort((a, b) => a.pid - b.pid);
  return Promise.all(found.map(async (stat) => {
    const wchan = await readText(path.join(procRoot, String(stat.pid), 'wchan'));
    return { ...stat, wchan: wchan === null || wchan.trim() === '' || wchan.trim() === '0' ? '-' : token(wchan) };
  }));
}

// "some avg10=12.50 avg60=..." (the kernel's pressure stall information): the share of the last 10 s in which at
// least one task waited for the resource, in percent.
function someAvg10(text) {
  const match = text === null ? null : /^some avg10=(\d+(?:\.\d+)?)/m.exec(text);
  return match ? match[1] : '-';
}

/**
 * The fields of the stuck-launch line, after "[RENDER_BROWSER] stuck launch ": the instance's load, its pressure
 * figures and each process under `rootPid`.
 */
export async function describeProcesses({ procRoot = '/proc', rootPid = process.pid } = {}) {
  const loadavg = await readText(path.join(procRoot, 'loadavg'));
  const load = loadavg === null ? null : loadavg.trim().split(/\s+/);
  const pressures = await Promise.all(PRESSURES.map(async (name) => (
    `psi_${name}=${someAvg10(await readText(path.join(procRoot, 'pressure', name)))}`)));
  const processes = await processesUnder(rootPid, { procRoot });
  const listed = (processes || []).slice(0, MAX_LISTED).map((p) => (
    `${token(p.name)}:${token(p.state)}:cpu_ms=${p.cpuMs}:majflt=${p.majflt}:threads=${p.threads}:wchan=${p.wchan}`));
  return [
    `load=${load && load.length >= 3 ? load.slice(0, 3).map(token).join(',') : '-'}`,
    `tasks=${load && /^\d+\/\d+$/.test(load[3] || '') ? load[3] : '-'}`,
    ...pressures,
    `procs=${processes === null ? '-' : processes.length}`,
    ...listed,
  ].join(' ');
}

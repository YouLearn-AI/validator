// What the processes under this one are doing, read from Linux's /proc, for the line a Chromium launch that misses
// its limit logs before the service exits (ops I-2278). Each process gives its name, its state (R running, S
// sleeping, D waiting on the disk), the CPU time and the major page faults (pages read from the image) it has used,
// its thread count and the kernel function it waits in; the instance gives its load and its CPU, I/O and memory
// pressure. So the line tells a busy start (R, CPU time near the time waited) from one waiting on its files (D,
// major faults) or on nothing it says (S, little CPU). No process's command line or environment is read.
// Without /proc (macOS) every figure is "-".

import { readFile as fsReadFile, readdir as fsReaddir } from 'node:fs/promises';
import path from 'node:path';

// /proc/<pid>/stat counts CPU time in clock ticks of USER_HZ, 100 a second on Linux (proc(5), sysconf(_SC_CLK_TCK)).
const USER_HZ = 100;
// Chromium starts with a browser, a zygote or two and a few helpers; a list longer than this is cut.
const MAX_LISTED = 12;
// The read gives up well inside the 2000 ms the services wait before they exit (check-server.mjs,
// video-server.mjs): a stalled disk is one of the things the line is for.
export const READ_DEADLINE_MS = 1_000;
const PRESSURES = ['cpu', 'io', 'memory'];
// The names the image's programs run under (/proc/<pid>/comm: the executable's file name cut to 15 characters):
// Chrome for Testing's headless shell, the only program in its zip (install-chrome-headless-shell.sh; Playwright
// starts it with no shell), and Debian's ffmpeg (Dockerfile.video, video-renderer.mjs). A process can give itself
// any name, so every other name is written as "other".
const KNOWN_NAMES = new Set(['chrome-headless', 'ffmpeg']);
// A kernel function's name (wchan), cut to this length.
const MAX_WCHAN = 64;

export class ProcReadTimeout extends Error {
  constructor() {
    super('/proc was not read in time');
    this.name = 'ProcReadTimeout';
  }
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
  // From field 3, state: rest[0] is field 3, rest[k] is field k + 3.
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const field = (n) => Number(rest[n - 3]);
  const parsed = {
    pid: Number(text.slice(0, open).trim()),
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

/** Every process below `rootPid` (children, their children, ...) in pid order, or null without a process table. */
export async function processesUnder(rootPid, { procRoot = '/proc', readdir = fsReaddir, readFile = fsReadFile } = {}) {
  let entries;
  try {
    entries = await readdir(procRoot);
  } catch {
    return null;
  }
  const stats = await Promise.all(entries.filter((name) => /^\d+$/.test(name)).map(async (name) => {
    const text = await readText(readFile, path.join(procRoot, name, 'stat'));
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
  return found.sort((a, b) => a.pid - b.pid);
}

async function readText(readFile, file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function decimal(text) {
  return typeof text === 'string' && /^\d+(\.\d+)?$/.test(text) ? text : '-';
}

function waitChannel(text) {
  const name = text === null ? '' : text.trim();
  return name === '' || name === '0' ? '-' : name.replace(/[^A-Za-z0-9_.]/g, '_').slice(0, MAX_WCHAN);
}

// "some avg10=12.50 avg60=..." (the kernel's pressure stall information): the share of the last 10 s in which at
// least one task waited for the resource, in percent.
function someAvg10(text) {
  const match = text === null ? null : /^some avg10=(\d+(?:\.\d+)?)/m.exec(text);
  return match ? match[1] : '-';
}

async function readFields({ procRoot = '/proc', rootPid = process.pid, readdir = fsReaddir, readFile = fsReadFile }) {
  const loadavg = await readText(readFile, path.join(procRoot, 'loadavg'));
  const load = loadavg === null ? [] : loadavg.trim().split(/\s+/);
  const pressures = await Promise.all(PRESSURES.map(async (name) => (
    `psi_${name}=${someAvg10(await readText(readFile, path.join(procRoot, 'pressure', name)))}`)));
  const processes = await processesUnder(rootPid, { procRoot, readdir, readFile });
  const listed = await Promise.all((processes || []).slice(0, MAX_LISTED).map(async (p) => {
    const wchan = waitChannel(await readText(readFile, path.join(procRoot, String(p.pid), 'wchan')));
    const name = KNOWN_NAMES.has(p.name) ? p.name : 'other';
    return `${name}:${p.state}:cpu_ms=${p.cpuMs}:majflt=${p.majflt}:threads=${p.threads}:wchan=${wchan}`;
  }));
  return [
    `load=${load.length >= 3 ? load.slice(0, 3).map(decimal).join(',') : '-'}`,
    `tasks=${/^\d+\/\d+$/.test(load[3] || '') ? load[3] : '-'}`,
    ...pressures,
    `procs=${processes === null ? '-' : processes.length}`,
    ...listed,
  ].join(' ');
}

/**
 * The fields of the stuck-launch line, after "[RENDER_BROWSER] stuck launch ": the instance's load, its pressure
 * figures and each process under `rootPid`. Rejects with ProcReadTimeout after `deadlineMs`; its timer never
 * keeps the process alive.
 * @param {{ procRoot?: string, rootPid?: number, deadlineMs?: number, readdir?: Function, readFile?: Function }}
 *   [options] readdir and readFile as node:fs/promises has them (tests only: a fake process table)
 */
export async function describeProcesses({ deadlineMs = READ_DEADLINE_MS, ...options } = {}) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ProcReadTimeout()), deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([readFields(options), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

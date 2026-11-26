// The line a Chromium launch that misses its limit logs before the service exits (ops I-2278): what the processes
// under the service were doing and the instance's load, read from a fake /proc. No browser starts.

import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GuardedBrowser } from '../guarded-browser.mjs';

const STUCK_LINE = '[RENDER_BROWSER] stuck launch ';

// A /proc/<pid>/stat line (proc(5)), fields 1 to 24.
function statLine({ pid, name, state, ppid, majflt, utime, stime, threads }) {
  return `${pid} (${name}) ${state} ${ppid} ${pid} 1 0 -1 4194560 3000 0 ${majflt} 0 ${utime} ${stime} 0 0 20 0 `
    + `${threads} 0 12345 1000000 5000\n`;
}

function writeProc(root, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
}

// A logger that keeps every line and resolves once the stuck-launch line is written.
function capture() {
  const lines = [];
  let found;
  const stuckLine = new Promise((resolve) => { found = resolve; });
  const keep = (line) => {
    lines.push(String(line));
    if (String(line).startsWith(STUCK_LINE)) found(String(line));
  };
  return { log: { info: keep, warn: keep, error: keep, log: keep }, lines, stuckLine };
}

describe('a launch that misses its limit says what Chromium was doing', { timeout: 10_000 }, () => {
  const dirs = [];
  const browsers = [];
  afterEach(async () => {
    await Promise.all(browsers.splice(0).map((b) => b.close()));
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function stuckBrowser(procRoot, log, onStuckLaunch) {
    const guarded = new GuardedBrowser({
      killable: true,
      log,
      procRoot,
      launchTimeoutMs: 1,
      launchServer: () => new Promise(() => {}), // started, never ready
      onStuckLaunch,
    });
    browsers.push(guarded);
    guarded.browser().catch(() => {});
    return guarded;
  }

  test('each process under the service with its state, CPU time and page faults, and the instance\'s load', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
    dirs.push(root);
    writeProc(root, {
      loadavg: '3.10 1.20 0.40 4/210 5003\n',
      'pressure/cpu': 'some avg10=12.50 avg60=3.00 avg300=1.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
      'pressure/io': 'some avg10=80.25 avg60=20.00 avg300=5.00 total=999\nfull avg10=70.00 avg60=0.00 avg300=0.00 total=0\n',
      'pressure/memory': 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n',
      // Chromium, started by this process, waiting on its files; its zygote below it.
      '5001/stat': statLine({ pid: 5001, name: 'chrome-headless', state: 'D', ppid: process.pid, majflt: 1200, utime: 25, stime: 6, threads: 7 }),
      '5001/wchan': 'folio_wait_bit_common',
      '5002/stat': statLine({ pid: 5002, name: 'chrome-headless', state: 'S', ppid: 5001, majflt: 40, utime: 1, stime: 1, threads: 1 }),
      '5002/wchan': 'do_wait',
      // Not under this process: not listed.
      '5003/stat': statLine({ pid: 5003, name: 'sh (x)', state: 'R', ppid: 1, majflt: 0, utime: 9, stime: 9, threads: 1 }),
    });
    const { log, stuckLine } = capture();
    let stuckCalls = 0;
    stuckBrowser(root, log, () => { stuckCalls += 1; });

    assert.equal(
      await stuckLine,
      `${STUCK_LINE}load=3.10,1.20,0.40 tasks=4/210 psi_cpu=12.50 psi_io=80.25 psi_memory=0.00 procs=2 `
        + 'chrome-headless:D:cpu_ms=310:majflt=1200:threads=7:wchan=folio_wait_bit_common '
        + 'chrome-headless:S:cpu_ms=20:majflt=40:threads=1:wchan=do_wait',
    );
    assert.equal(stuckCalls, 1, 'the service still restarts as before');
  });

  test('with no /proc (a local run) the line still comes, with every figure unknown', async () => {
    const root = path.join(os.tmpdir(), 'no-such-proc-i2278');
    const { log, stuckLine } = capture();
    let stuckCalls = 0;
    stuckBrowser(root, log, () => { stuckCalls += 1; });

    assert.equal(await stuckLine, `${STUCK_LINE}load=- tasks=- psi_cpu=- psi_io=- psi_memory=- procs=-`);
    assert.equal(stuckCalls, 1);
  });
});

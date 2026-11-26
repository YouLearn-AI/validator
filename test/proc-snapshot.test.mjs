// The line a Chromium launch that misses its limit logs before the service exits (ops I-2278): what the processes
// under the service were doing and the instance's load, read from an in-memory /proc. No browser starts; the
// launch watchdog and the read's deadline run on mocked timers.

import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardedBrowser } from '../guarded-browser.mjs';

const STUCK = '[RENDER_BROWSER] stuck launch';
const LAUNCH_MS = 50;

// A /proc/<pid>/stat line (proc(5)), fields 1 to 24.
function statLine({ pid, name, state, ppid, majflt, utime, stime, threads }) {
  return `${pid} (${name}) ${state} ${ppid} ${pid} 1 0 -1 4194560 3000 0 ${majflt} 0 ${utime} ${stime} 0 0 20 0 `
    + `${threads} 0 12345 1000000 5000\n`;
}

// readdir and readFile as node:fs/promises has them, answered from `files` (paths under /proc) at once.
function fakeProc(files) {
  const missing = (file) => Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  return {
    procRoot: '/proc',
    readFile: async (file) => {
      if (!(file in files)) throw missing(file);
      return files[file];
    },
    readdir: async (dir) => {
      const names = Object.keys(files).filter((f) => f.startsWith(`${dir}/`))
        .map((f) => f.slice(dir.length + 1).split('/')[0]);
      if (names.length === 0) throw missing(dir);
      return [...new Set(names)];
    },
  };
}

const pressure = (some) => `some avg10=${some} avg60=0.00 avg300=0.00 total=1\n`
  + 'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n';
const chrome = { name: 'chrome-headless', majflt: 0, utime: 0, stime: 0, threads: 1 };
const TABLE = {
  '/proc/loadavg': '3.10 1.20 0.40 4/210 5004\n',
  '/proc/pressure/cpu': pressure('12.50'),
  '/proc/pressure/io': pressure('80.25'),
  '/proc/pressure/memory': pressure('0.00'),
  // Chromium, started by this process, waiting on its files; its zygote below it.
  '/proc/5001/stat': statLine({
    ...chrome, pid: 5001, state: 'D', ppid: process.pid, majflt: 1200, utime: 25, stime: 6, threads: 7,
  }),
  '/proc/5001/wchan': 'folio_wait_bit_common',
  '/proc/5002/stat': statLine({ ...chrome, pid: 5002, state: 'S', ppid: 5001, majflt: 40, utime: 1, stime: 1 }),
  '/proc/5002/wchan': 'do_wait',
  // Under this process, with a name the image never runs (a process can give itself any name).
  '/proc/5003/stat': statLine({ ...chrome, pid: 5003, name: 'tok3n abc', state: 'R', ppid: 5001, utime: 2 }),
  '/proc/5003/wchan': '0',
  // Not under this process: not listed.
  '/proc/5004/stat': statLine({ ...chrome, pid: 5004, state: 'R', ppid: 1, utime: 9, stime: 9 }),
};

// One turn of the event loop (setImmediate is not mocked): an in-memory read is done after one.
const turn = () => new Promise((resolve) => { setImmediate(resolve); });
// Turns until `done()` holds, at most TURNS of them, never a sleep; then one more for anything it sets off.
const TURNS = 10_000;
async function until(done) {
  for (let i = 0; i < TURNS && !done(); i += 1) await turn();
  await turn();
}

describe('a launch that misses its limit says what Chromium was doing', () => {
  const browsers = [];
  beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }); });
  afterEach(async () => {
    mock.timers.reset();
    await Promise.all(browsers.splice(0).map((b) => b.close()));
  });

  // A GuardedBrowser whose Chromium starts and never gets ready, past its limit; returns onStuckLaunch's calls.
  async function stuckLaunch({ log, proc }) {
    let launched;
    const launchCalled = new Promise((resolve) => { launched = resolve; });
    const stuck = { calls: 0 };
    const guarded = new GuardedBrowser({
      killable: true,
      log,
      proc,
      launchTimeoutMs: LAUNCH_MS,
      launchServer: () => {
        launched();
        return new Promise(() => {});
      },
      onStuckLaunch: () => { stuck.calls += 1; },
    });
    browsers.push(guarded);
    guarded.browser().catch(() => {});
    await launchCalled;
    mock.timers.tick(LAUNCH_MS);
    return stuck;
  }

  function capture() {
    const lines = [];
    const keep = (line) => { lines.push(String(line)); };
    const stuckLines = () => lines.filter((l) => l.startsWith(STUCK));
    return { log: { info: keep, warn: keep, error: keep, log: keep }, stuckLines };
  }

  test('each process under the service, an unknown name as "other", and the load; the exit is not held', async () => {
    const { log, stuckLines } = capture();
    const stuck = await stuckLaunch({ log, proc: fakeProc(TABLE) });
    assert.equal(stuck.calls, 1, 'onStuckLaunch ran at once');
    assert.deepEqual(stuckLines(), [], 'before the read finished');

    await until(() => stuckLines().length > 0);
    assert.deepEqual(stuckLines(), [
      `${STUCK} load=3.10,1.20,0.40 tasks=4/210 psi_cpu=12.50 psi_io=80.25 psi_memory=0.00 procs=3 `
        + 'chrome-headless:D:cpu_ms=310:majflt=1200:threads=7:wchan=folio_wait_bit_common '
        + 'chrome-headless:S:cpu_ms=20:majflt=40:threads=1:wchan=do_wait '
        + 'other:R:cpu_ms=20:majflt=0:threads=1:wchan=-',
    ]);
    assert.equal(stuck.calls, 1);
  });

  test('a read that never ends gives up at its deadline with one line; the exit was not held', async () => {
    const { log, stuckLines } = capture();
    const never = () => new Promise(() => {});
    const proc = { procRoot: '/proc', readdir: never, readFile: never, deadlineMs: 100 };
    const stuck = await stuckLaunch({ log, proc });
    assert.equal(stuck.calls, 1, 'onStuckLaunch ran at once');
    await turn();
    assert.deepEqual(stuckLines(), [], 'no line before the deadline');

    mock.timers.tick(100);
    await until(() => stuckLines().length > 0);
    assert.deepEqual(stuckLines(), [`${STUCK} unreadable reason=timeout`]);
    assert.equal(stuck.calls, 1);
  });

  test('a logger that throws on the line leaves no unhandled rejection', async () => {
    const rejections = [];
    const onRejection = (reason) => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      let attempts = 0;
      const quiet = () => {};
      const log = {
        info: quiet,
        warn: quiet,
        log: quiet,
        error: (line) => {
          if (!String(line).startsWith(STUCK)) return;
          attempts += 1;
          throw new Error('logger down');
        },
      };
      const stuck = await stuckLaunch({ log, proc: fakeProc(TABLE) });
      await until(() => attempts > 0);
      assert.equal(attempts, 1, 'the line was written once');
      assert.deepEqual(rejections, []);
      assert.equal(stuck.calls, 1);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('with no /proc (a local run) the line still comes, with every figure unknown', async () => {
    const { log, stuckLines } = capture();
    const stuck = await stuckLaunch({ log, proc: fakeProc({}) });
    await until(() => stuckLines().length > 0);
    assert.deepEqual(stuckLines(), [`${STUCK} load=- tasks=- psi_cpu=- psi_io=- psi_memory=- procs=-`]);
    assert.equal(stuck.calls, 1);
  });
});

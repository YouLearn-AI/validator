// Child process for test/video-renderer.test.mjs: a GuardedBrowser whose Chromium is started but never gets
// ready (a fake executable that writes its pid and sleeps), wired as video-server.mjs wires it: exit on a
// stuck launch. Usage: node stuck-launch.mjs <fake executable> <pid file>
import { chromium } from 'playwright';
import { GuardedBrowser } from '../../guarded-browser.mjs';

const [, , executablePath] = process.argv;
const browser = new GuardedBrowser({
  log: { info() {}, warn() {}, error() {}, log() {} },
  launchTimeoutMs: 1000,
  launchServer: (options) => chromium.launchServer({ ...options, executablePath }),
  onStuckLaunch: () => setTimeout(() => process.exit(3), 100),
});
browser.browser().catch(() => {});
setTimeout(() => process.exit(9), 20_000); // never reached when the watchdog works

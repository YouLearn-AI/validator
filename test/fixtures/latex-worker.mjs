// Worker thread for test/latex-validator.test.mjs: runs LaTeX validation off the test runner's thread, so a call
// that never returns fails its test at a deadline instead of stopping the runner (ops I-743 F-08).
//   workerData.mode 'call':  posts 'ready', then answers each { fn, args } message with { result } or { error }.
//   workerData.mode 'serve': serves the validator's app on a free local port and posts the port.
import { parentPort, workerData } from 'node:worker_threads';

if (workerData.mode === 'serve') {
  const { createApp } = await import('../../app.mjs');
  const app = createApp({
    renderScreenshot: async () => { throw new Error('not used'); },
    auth: (_req, _res, next) => next(),
    validateAuth: (_req, _res, next) => next(),
  });
  const server = app.listen(0, '127.0.0.1', () => parentPort.postMessage(server.address().port));
} else {
  const latex = await import('../../latex-validator.mjs');
  parentPort.on('message', ({ fn, args }) => {
    try {
      parentPort.postMessage({ result: latex[fn](...args) });
    } catch (error) {
      parentPort.postMessage({ error: { name: error.name, message: error.message } });
    }
  });
  parentPort.postMessage('ready');
}

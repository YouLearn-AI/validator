// Test-only: a Word converter worker that takes every job and never answers (export.test.mjs: the render's deadline
// must end it).
import { parentPort } from 'node:worker_threads';

parentPort.on('message', () => {});

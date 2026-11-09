// The Word converter's worker thread (ops I-1313): pandoc, as the pandoc project's own WebAssembly build (npm
// pandoc-wasm), turns the print page's HTML into a .docx. It runs here, off the service's event loop, so a
// conversion that runs too long is ended by terminating this thread (export-docx.mjs).
//
// pandoc.wasm has no network and no file system but the files it is handed: an image the HTML names that is not
// one of the page's pictures is left out, never read from disk or fetched. Its messages can quote the document, so
// this thread prints nothing: the console is silenced before pandoc loads, and only codes and counts go back.

import { parentPort } from 'node:worker_threads';

for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

const { convert } = await import('pandoc-wasm');

const OUTPUT = 'export.docx';

parentPort.on('message', async ({ id, html, images, metadata }) => {
  try {
    const files = Object.fromEntries(images.map(({ name, bytes }) => [name, new Blob([bytes])]));
    const result = await convert({ from: 'html', to: 'docx', 'output-file': OUTPUT, metadata }, html, files);
    const docx = result.files[OUTPUT];
    if (!docx) {
      parentPort.postMessage({ id, code: 'no_output' });
      return;
    }
    const bytes = new Uint8Array(await docx.arrayBuffer());
    // How many images pandoc could not load: each is left out of the file, so the caller counts them.
    const missing = (result.warnings || []).filter((w) => w?.type === 'CouldNotFetchResource').length;
    parentPort.postMessage({ id, bytes, missing }, [bytes.buffer]);
  } catch {
    parentPort.postMessage({ id, code: 'pandoc_failed' });
  }
});

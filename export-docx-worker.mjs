// The Word converter's worker thread (ops I-1313): pandoc, as the pandoc project's own WebAssembly build (npm
// pandoc-wasm), turns the print page's HTML into a .docx. It runs here, off the service's event loop, so a
// conversion that runs too long is ended by terminating this thread (export-docx.mjs).
//
// pandoc.wasm has no network and no file system but the files it is handed: an image the HTML names that is not
// one of the page's pictures is left out, never read from disk or fetched. Its messages can quote the document, so
// this thread prints nothing: the console is silenced before pandoc loads, and only codes and counts go back.

import { parentPort } from 'node:worker_threads';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

const { convert } = await import('pandoc-wasm');
const { rightToLeftTables } = await import('./export-docx.mjs');

const OUTPUT = 'export.docx';
// Not "reference.docx": pandoc reads a file of that name in its data folder as the reference document by itself,
// and fails on the empty placeholder of an output so named.
const BASE = 'base.docx';
const REFERENCE = 'styles.docx';
// A thin grey grid on every table, as the chat and the PDF draw tables; pandoc's own table style has only a rule
// under the header. OOXML orders a table style's properties: the borders go right after its indent (tblInd).
const TABLE_BORDERS = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF" />`).join('')}</w:tblBorders>`;

/** pandoc's own reference document with TABLE_BORDERS in its "Table" style; null (pandoc's own is used) if a
 * pandoc version no longer has that style in that shape. Made once per worker. */
async function referenceDoc() {
  const base = await convert({ from: 'html', to: 'docx', 'output-file': BASE }, '<p></p>', {});
  const files = unzipSync(new Uint8Array(await base.files[BASE].arrayBuffer()));
  const styles = strFromU8(files['word/styles.xml']);
  const bordered = styles.replace(/(<w:style [^>]*w:styleId="Table"[^>]*>[\s\S]*?<w:tblInd [^>]*\/>)/, `$1${TABLE_BORDERS}`);
  if (bordered === styles) return null;
  files['word/styles.xml'] = strToU8(bordered);
  return new Blob([zipSync(files)]);
}
const reference = referenceDoc().catch(() => null);

/** The .docx with its right-to-left tables laid out right to left (export-docx.mjs rightToLeftTables). */
function withRightToLeftTables(bytes) {
  const files = unzipSync(bytes);
  const xml = strFromU8(files['word/document.xml']);
  const marked = rightToLeftTables(xml);
  if (marked === xml) return bytes;
  files['word/document.xml'] = strToU8(marked);
  return zipSync(files);
}

parentPort.on('message', async ({ id, html, images, metadata }) => {
  try {
    const files = Object.fromEntries(images.map(({ name, bytes }) => [name, new Blob([bytes])]));
    const options = { from: 'html', to: 'docx', 'output-file': OUTPUT, metadata };
    const styled = await reference;
    if (styled) {
      files[REFERENCE] = styled;
      options['reference-doc'] = REFERENCE;
    }
    const result = await convert(options, html, files);
    const docx = result.files[OUTPUT];
    if (!docx) {
      parentPort.postMessage({ id, code: 'no_output' });
      return;
    }
    const bytes = withRightToLeftTables(new Uint8Array(await docx.arrayBuffer()));
    // How many images pandoc could not load: each is left out of the file, so the caller counts them.
    const missing = (result.warnings || []).filter((w) => w?.type === 'CouldNotFetchResource').length;
    parentPort.postMessage({ id, bytes, missing }, [bytes.buffer]);
  } catch {
    parentPort.postMessage({ id, code: 'pandoc_failed' });
  }
});

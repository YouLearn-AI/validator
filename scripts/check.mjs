import { parse } from '@mermaid-js/parser';

const tests = [
  { name: 'invalid missing target', type: 'flowchart', text: 'graph TD; A-->;' },
  { name: 'invalid missing arrowhead', type: 'flowchart', text: 'graph TD; A-B;' },
  { name: 'simple valid', type: 'flowchart', text: 'graph TD; A-->B;' },
];

for (const t of tests) {
  try {
    parse(t.type, t.text);
    console.log(`${t.name}: OK`);
  } catch (e) {
    console.log(`${t.name}: ERR ${e.message}`);
  }
}



import { parse as parseMermaid } from '@mermaid-js/parser';

export async function validateDiagramSyntax(diagramText) {
  if (typeof diagramText !== 'string' || diagramText.trim().length === 0) {
    return { valid: false, error: 'Body must include a non-empty "diagram" string' };
  }

  // Infer diagram type from the first keyword
  // Only a subset is supported by @mermaid-js/parser: pie, treemap, radar, architecture, info, packet, gitGraph
  const firstWord = diagramText.trim().split(/\s|;/)[0];
  let diagramType;
  if (firstWord === 'pie') diagramType = 'pie';
  else if (firstWord === 'treemap') diagramType = 'treemap';
  else if (firstWord === 'radar') diagramType = 'radar';
  else if (firstWord === 'architecture') diagramType = 'architecture';
  else if (firstWord === 'info') diagramType = 'info';
  else if (firstWord === 'packet') diagramType = 'packet';
  else if (firstWord === 'gitGraph') diagramType = 'gitGraph';

  try {
    // parse throws on syntax errors
    await parseMermaid(diagramType, diagramText);
    return { valid: true };
  } catch (error) {
    const message = error?.message || 'Parse error';
    const trace = error?.stack || String(error);
    const details = error?.hash ? {
      text: error?.hash?.text,
      token: error?.hash?.token,
      line: error?.hash?.loc?.first_line ?? error?.hash?.line,
      column: error?.hash?.loc?.first_column ?? error?.hash?.column,
      expected: error?.hash?.expected,
      recoverable: error?.hash?.recoverable,
    } : undefined;
    return { valid: false, error: message, trace, details };
  }
}



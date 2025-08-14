import { JSDOM } from 'jsdom';

// Create DOM environment for Mermaid
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
const { window } = dom;

// Set up globals that Mermaid expects
global.window = window;
global.document = window.document;
global.Element = window.Element;
global.Node = window.Node;

// Import mermaid after DOM is set up
const mermaid = (await import('mermaid')).default;

export async function validateDiagramSyntax(diagramText) {
  if (typeof diagramText !== 'string' || diagramText.trim().length === 0) {
    return { valid: false, error: 'Body must include a non-empty "diagram" string' };
  }

  try {
    // Initialize mermaid with loose security to avoid DOMPurify dependency
    mermaid.initialize({ 
      startOnLoad: false, 
      securityLevel: 'loose',
      theme: 'default'
    });
    
    // mermaid.parse validates syntax without rendering
    await mermaid.parse(diagramText);
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
import katex from "katex";

// What the scan looks for when a caller sends no delimiters (the backend sends none). The math environments,
// equation to array, are checked whole and in display mode, as the web app's first list had them (frontend
// d68a9e104a): KaTeX draws equation and align only in display mode.
export const defaultDelimiters = [
  { left: "\\(", right: "\\)", display: false },
  { left: "\\[", right: "\\]", display: true },
  { left: "\\begin{equation}", right: "\\end{equation}", display: true },
  { left: "\\begin{align}", right: "\\end{align}", display: true },
  { left: "\\begin{align*}", right: "\\end{align*}", display: true },
  { left: "\\begin{cases}", right: "\\end{cases}", display: true },
  { left: "\\begin{matrix}", right: "\\end{matrix}", display: true },
  { left: "\\begin{bmatrix}", right: "\\end{bmatrix}", display: true },
  { left: "\\begin{pmatrix}", right: "\\end{pmatrix}", display: true },
  { left: "\\begin{array}", right: "\\end{array}", display: true },
  { left: "\\section*{", right: "}", display: false },
  { left: "\\section{", right: "}", display: false },
  { left: "\\subsection*{", right: "}", display: false },
  { left: "\\subsection{", right: "}", display: false },
  { left: "\\textbf{", right: "}", display: false },
  { left: "\\begin{enumerate}", right: "\\end{enumerate}", display: false },
  { left: "\\begin{itemize}", right: "\\end{itemize}", display: false },
  { left: "\\item", right: "", display: false },
  { left: "\\textit{", right: "}", display: false },
  { left: "\\textrm{", right: "}", display: false },
  { left: "\\text{", right: "}", display: false },
  { left: "\\begin{theorem}", right: "\\end{theorem}", display: false },
  { left: "\\begin{proof}", right: "\\end{proof}", display: false },
  { left: "\\begin{definition}", right: "\\end{definition}", display: false },
  { left: "\\begin{example}", right: "\\end{example}", display: false },
  { left: "\\begin{table}", right: "\\end{table}", display: false },
  { left: "\\begin{tabular}", right: "\\end{tabular}", display: false },
  { left: "\\frac{", right: "}", display: false },
  { left: "\\hat{", right: "}", display: false },
  { left: "\\vec{", right: "}", display: false },
  { left: "\\overline{", right: "}", display: false },
];

// Every environment KaTeX 0.16.22 defines (node_modules/katex/src/environments/array.js). A delimiter pair
// \begin{name} ... \end{name} for one of these is checked whole, its \begin and \end included, as KaTeX's
// auto-render passes it (contrib/auto-render/splitAtDelimiters.js). Its body alone is not valid TeX: '&' and '\\'
// separate cells and rows only inside the environment, so valid cases and matrices were flagged (ops I-1691).
// Environments KaTeX lacks (itemize, theorem, tabular, ...) keep the body check.
export const KATEX_ENVIRONMENTS = new Set([
  "array", "darray", "subarray",
  "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix",
  "matrix*", "pmatrix*", "bmatrix*", "Bmatrix*", "vmatrix*", "Vmatrix*",
  "cases", "dcases", "rcases", "drcases",
  "align", "align*", "aligned", "split", "alignat", "alignat*", "alignedat",
  "gather", "gather*", "gathered",
  "equation", "equation*",
  "CD",
]);

const ENVIRONMENT_OPENER = /^\\begin\{([^{}]+)\}$/;

/**
 * Whether a delimiter pair is one KaTeX environment's \begin and \end, which is checked whole.
 * @param {{ left: string, right: string }} delimiter
 */
function isKatexEnvironment({ left, right }) {
  const name = ENVIRONMENT_OPENER.exec(left)?.[1];
  return name !== undefined && KATEX_ENVIRONMENTS.has(name) && right === `\\end{${name}}`;
}

// Limits for custom delimiters from a caller (POST /validate/latex, ops I-743 F-08). A caller's set replaces the
// 31 defaults (the backend sends none); 64 entries is about twice the default set, and 64 characters over three times
// its longest delimiter (18).
const MAX_DELIMITERS = 64;
const MAX_DELIMITER_LENGTH = 64;

// The scan stops at this many errors. Each unclosed opener scans to the end of the text, so a text of them took
// time in the square of its length on Node's only thread: 32 KB of "\(" took 3.3 s, and 170 KB, the most a 256 KB
// body holds, 46 s, with a 17.6 MB answer listing every error (ops I-1238). The cap bounds a check to 50 such
// scans and its error list to 50 entries.
const MAX_ERRORS = 50;

/**
 * Why custom delimiters can't be used, or null when they can: an array of 1 to MAX_DELIMITERS objects, each
 * with a non-empty `left` string, a `right` string (empty for an opener that has no closer, like \item), both
 * at most MAX_DELIMITER_LENGTH characters, and a boolean `display`. An empty `left` matches at every position
 * and never moves the scan forward.
 * @param {unknown} delimiters
 * @returns {string | null}
 */
export function delimitersProblem(delimiters) {
  if (!Array.isArray(delimiters)) return '"delimiters" must be an array';
  if (delimiters.length === 0 || delimiters.length > MAX_DELIMITERS) {
    return `"delimiters" must have 1 to ${MAX_DELIMITERS} entries`;
  }
  for (const [i, delimiter] of delimiters.entries()) {
    if (delimiter === null || typeof delimiter !== "object" || Array.isArray(delimiter)) {
      return `delimiters[${i}] must be an object`;
    }
    const { left, right, display } = delimiter;
    if (typeof left !== "string" || left.length === 0 || left.length > MAX_DELIMITER_LENGTH) {
      return `delimiters[${i}].left must be a non-empty string of at most ${MAX_DELIMITER_LENGTH} characters`;
    }
    if (typeof right !== "string" || right.length > MAX_DELIMITER_LENGTH) {
      return `delimiters[${i}].right must be a string of at most ${MAX_DELIMITER_LENGTH} characters`;
    }
    if (typeof display !== "boolean") return `delimiters[${i}].display must be true or false`;
  }
  return null;
}

/**
 * A scanning pass that did not move forward. Thrown instead of repeating the pass forever, which would hold
 * Node's only thread and stall every request on the instance (ops I-743 F-08).
 */
class LatexScanStalled extends Error {
  constructor(position) {
    super(`LaTeX scan made no progress at position ${position}`);
    this.name = "LatexScanStalled";
  }
}

// Utility functions (copied from local utilities to be self-contained)
function escapeRegex(text) {
  return text.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * Where the delimiter opened before `start` closes, or -1. A closer counts only outside braces, and a backslash
 * escapes the character after it. In a KaTeX environment, its own \begin opens a nested one that the next
 * \end closes first, so a matrix inside a matrix ends at the outer \end.
 * @param {string} text
 * @param {number} start The first index after the opening delimiter.
 * @param {{ left: string, right: string }} delimiter
 */
function findClose(text, start, delimiter) {
  const nests = isKatexEnvironment(delimiter);
  let index = start;
  let braceLevel = 0;
  let depth = 0;

  while (index < text.length) {
    if (braceLevel <= 0 && text.startsWith(delimiter.right, index)) {
      if (depth === 0) return index;
      depth--;
      index += delimiter.right.length;
      continue;
    }
    if (nests && braceLevel <= 0 && text.startsWith(delimiter.left, index)) {
      depth++;
      index += delimiter.left.length;
      continue;
    }

    const character = text[index];
    if (character === "\\") {
      index++;
    } else if (character === "{") {
      braceLevel++;
    } else if (character === "}") {
      braceLevel--;
    }
    index++;
  }

  return -1;
}

function splitAtDelimiters(
  text,
  delimiters,
) {
  let index;
  const data = [];
  const totalLength = text.length;

  const regexLeft = new RegExp(
    "(" + delimiters.map((x) => escapeRegex(x.left)).join("|") + ")",
  );

  // Each pass must consume some text; an empty delimiter consumes none.
  let previousLength = Infinity;
  while (true) {
    if (text.length >= previousLength) {
      throw new LatexScanStalled(totalLength - text.length);
    }
    previousLength = text.length;
    index = text.search(regexLeft);
    if (index === -1) {
      break;
    }
    if (index > 0) {
      data.push({
        type: "text",
        data: text.slice(0, index),
      });
      text = text.slice(index); // now text starts with delimiter
    }
    // ... so this always succeeds:
    const i = delimiters.findIndex((delim) => text.startsWith(delim.left));
    index = findClose(text, delimiters[i].left.length, delimiters[i]);
    if (index === -1) {
      break;
    }
    const rawData = text.slice(0, index + delimiters[i].right.length);
    const amsRegex = /^\\begin{/;
    const math = amsRegex.test(rawData)
      ? rawData
      : text.slice(delimiters[i].left.length, index);
    data.push({
      type: "math",
      data: math,
      rawData,
      display: delimiters[i].display,
    });
    text = text.slice(index + delimiters[i].right.length);
  }

  if (text !== "") {
    data.push({
      type: "text",
      data: text,
    });
  }

  return data;
}

function findDelimiterAtPosition(
  text,
  position,
  delimiters
) {
  for (const delimiter of delimiters) {
    if (text.slice(position).startsWith(delimiter.left)) {
      return { delimiter, index: position };
    }
  }
  return null;
}

/**
 * Validates LaTeX formatting in a string based on supported delimiters
 * @param text The text to validate
 * @param delimiters Optional custom delimiters (defaults to the ones from markdown.tsx)
 * @param macros Optional KaTeX macros
 * @returns Validation result with any errors found; `truncated` when the scan stopped at MAX_ERRORS, so the
 *   text may hold more
 */
export function validateLatex(
  text,
  delimiters = defaultDelimiters,
  macros
) {
  const errors = [];
  let position = 0;

  // Create regex for finding opening delimiters
  const regexLeft = new RegExp(
    "(" + delimiters.map((x) => escapeRegex(x.left)).join("|") + ")"
  );

  // Each pass must start past the previous one; an empty delimiter would start every pass at the same place.
  // The closing scan (findClose) always moves forward.
  let previousStart = -1;
  while (position < text.length && errors.length < MAX_ERRORS) {
    if (position <= previousStart) {
      throw new LatexScanStalled(position);
    }
    previousStart = position;
    const match = text.slice(position).search(regexLeft);
    
    if (match === -1) {
      // No more LaTeX delimiters found
      break;
    }

    position += match;
    
    // Find which delimiter was matched
    const delimiterInfo = findDelimiterAtPosition(text, position, delimiters);
    if (!delimiterInfo) {
      position++;
      continue;
    }

    const { delimiter } = delimiterInfo;
    const startPos = position;
    const leftDelimLength = delimiter.left.length;

    // Special handling for delimiters with empty right side (like \item)
    if (delimiter.right === "") {
      position += leftDelimLength;
      continue;
    }

    const endPos = findClose(text, position + leftDelimLength, delimiter);
    if (endPos === -1) {
      // Unclosed delimiter
      errors.push({
        message: `Unclosed LaTeX delimiter: "${delimiter.left}" at position ${startPos}`,
        position: startPos,
        length: delimiter.left.length,
        latex: text.slice(startPos, Math.min(startPos + 50, text.length)) + "...",
        type: "unclosed",
      });
      position += leftDelimLength;
      continue;
    }

    const end = endPos + delimiter.right.length;
    const latexContent = isKatexEnvironment(delimiter)
      ? text.slice(startPos, end)
      : text.slice(startPos + leftDelimLength, endPos);

    // Validate the LaTeX syntax with KaTeX
    try {
      katex.renderToString(latexContent, {
        displayMode: delimiter.display,
        macros,
        throwOnError: true,
      });
    } catch (katexError) {
      errors.push({
        message: `Invalid LaTeX syntax: ${katexError.message}`,
        position: startPos,
        length: end - startPos,
        latex: text.slice(startPos, end),
        type: "katex_error",
      });
    }

    // Move position past the closing delimiter
    position = end;
  }

  return {
    isValid: errors.length === 0,
    errors,
    truncated: errors.length >= MAX_ERRORS,
  };
}

/**
 * Uses the existing splitAtDelimiters logic to validate LaTeX
 * This approach leverages the same parsing logic used in production
 * @param text The text to validate
 * @param delimiters Optional custom delimiters
 * @param macros Optional KaTeX macros
 * @returns Validation result
 */
export function validateLatexUsingSplitter(
  text,
  delimiters = defaultDelimiters,
  macros
) {
  const errors = [];
  
  try {
    const chunks = splitAtDelimiters(text, delimiters);
    let currentPosition = 0;
    
    for (const chunk of chunks) {
      if (chunk.type === "math") {
        // Validate this LaTeX chunk with KaTeX
        try {
          katex.renderToString(chunk.data, {
            displayMode: chunk.display,
            macros,
            throwOnError: true,
          });
        } catch (katexError) {
          const chunkLength = chunk.rawData?.length || chunk.data.length;
          errors.push({
            message: `Invalid LaTeX syntax: ${katexError.message}`,
            position: currentPosition,
            length: chunkLength,
            latex: chunk.rawData || chunk.data,
            type: "katex_error",
          });
        }
      }
      
      // Update position (approximate - not perfect but good enough for most cases)
      const chunkLength = chunk.rawData?.length || chunk.data.length;
      currentPosition += chunkLength;
    }
    
  } catch (parseError) {
    errors.push({
      message: `Parsing error: ${parseError.message}`,
      position: 0,
      length: text.length,
      latex: text,
      type: "invalid_syntax",
    });
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Pretty prints validation errors with context
 * @param text The original text
 * @param errors The validation errors
 * @returns Formatted error string
 */
export function formatValidationErrors(
  text,
  errors
) {
  if (errors.length === 0) {
    return "✓ No LaTeX errors found";
  }

  const lines = text.split("\n");
  const errorMessages = [`Found ${errors.length} LaTeX error(s):\n`];

  for (const error of errors) {
    // Find line number and column
    let currentPos = 0;
    let lineNum = 0;
    let columnNum = 0;

    for (let i = 0; i < lines.length; i++) {
      if (currentPos + lines[i].length >= error.position) {
        lineNum = i + 1;
        columnNum = error.position - currentPos + 1;
        break;
      }
      currentPos += lines[i].length + 1; // +1 for newline
    }

    errorMessages.push(
      `\n❌ Error at line ${lineNum}, column ${columnNum}:`,
      `   Type: ${error.type}`,
      `   Message: ${error.message}`,
      `   LaTeX: ${error.latex}`,
    );

    // Show context with error highlighting
    if (lineNum > 0) {
      const line = lines[lineNum - 1];
      const pointer = " ".repeat(columnNum - 1 + 3) + "^".repeat(Math.min(error.length, line.length - columnNum + 1));
      errorMessages.push(`   ${line}`, pointer);
    }
  }

  return errorMessages.join("\n");
}

/**
 * Simple validation function that returns a boolean
 * @param text The text to validate
 * @param delimiters Optional custom delimiters
 * @param macros Optional KaTeX macros
 * @returns True if valid, false if invalid
 */
export function isValidLatex(
  text,
  delimiters,
  macros
) {
  return validateLatex(text, delimiters, macros).isValid;
}

/**
 * Example usage function
 * @param text The text to validate and print results for
 */
export function checkLatexString(text) {
  const result = validateLatex(text);
  
  if (result.isValid) {
    console.log("✅ LaTeX formatting is valid!");
  } else {
    console.log(formatValidationErrors(text, result.errors));
  }
  
  return result;
}
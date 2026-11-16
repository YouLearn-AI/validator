import katex from "katex";
import { BLANK_LINE, BLOCK_ENVIRONMENTS, INLINE_ENVIRONMENTS, readAsApps, UNCLOSED } from "./app-math.mjs";

// The scan's list before it read text as the apps draw it (ops I-1237). A caller may still send it, or any list, as
// custom delimiters. With none (the backend sends none), validateLatex finds math as the web and mobile apps do
// (app-math.mjs), and checks this list's other entries (PROSE_DELIMITERS) in the text outside math and code. The
// math environments, equation to array, are checked whole and in display mode when sent as custom delimiters, as
// the web app's first list had them (frontend d68a9e104a): KaTeX draws equation and align only in display mode.
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

// Every environment KaTeX defines (node_modules/katex/src/environments/array.ts; the same set in 0.16.22 and 0.19.0,
// ops I-515). A delimiter pair \begin{name} ... \end{name} for one of these is checked whole, its \begin and \end
// included, as KaTeX's auto-render passes it (contrib/auto-render/splitAtDelimiters.js). Its body alone is not valid
// TeX: '&' and '\\' separate cells and rows only inside the environment, so valid cases and matrices were flagged
// (ops I-1691).
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

// The KaTeX environments the apps draw only inside other math: a bare one (cases, the matrices, array, ...) is left
// as text, \begin and all, since their scan opens math at it only for BLOCK_ENVIRONMENTS and INLINE_ENVIRONMENTS.
const APPS_DRAWN_BARE = new Set([...BLOCK_ENVIRONMENTS, ...INLINE_ENVIRONMENTS]);
const TEXT_ONLY_ENVIRONMENTS = new Set([...KATEX_ENVIRONMENTS].filter((name) => !APPS_DRAWN_BARE.has(name)));
// A \begin{name} in text outside math and code; KaTeX's longest environment name, smallmatrix, has 11 letters.
const BEGIN_IN_TEXT = /\\begin\{([A-Za-z]{1,16}\*?)\}/g;

// Math between single dollars, on one line, as Pandoc's tex_math_dollars reads it: the opening $ has a non-space
// after it, the closing $ a non-space before it and no digit after it, so "$5 and $10" is not math, and a backslash
// escapes the character after it, so "\$" neither opens nor closes it. Stricter than Pandoc, no letter or _ may
// follow the closing $ either, so shell variables like "$HOME_DIR/$USER" are not math. The apps draw only
// $$ ... $$, so such math shows as text. It counts only when it holds a command, a ^, or a _ between letters, digits
// or braces as in a_1 or x_{i} (MATH_SIGN): Markdown's _emphasis_ has a space or punctuation on one side.
const SINGLE_DOLLAR_MATH = /(?<![\\$])\$(?![\s$])((?:[^$\n\\]|\\[^\n])*?)(?<!\s)\$(?![\w$])/g;
const MATH_SIGN = /\\[A-Za-z]|\^|[A-Za-z0-9}]_[A-Za-z0-9{\\]/;
// A price, and a currency code ending in the second $, as in "$5/m^2 (US$)": money, not math.
const PRICE_THEN_CURRENCY = /^\d.*[\s(][A-Z]{1,3}$/;

// Error types beside "unclosed" and "katex_error": LaTeX the student sees as text because the apps don't draw it.
const SHOWN_AS_TEXT = "shown_as_text";
// U+FFFC OBJECT REPLACEMENT CHARACTER: what the prose patterns read in place of a source chip.
const OBJECT = "￼";
// How much of the text an error quotes after an opener that has no end.
const QUOTE_LENGTH = 50;

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
 * The delimiters' math in `text`, checked from `start` until `errors` holds `maxErrors`; returns where the scan
 * stopped. A delimiter's math is checked with KaTeX, a KaTeX environment whole. Quotes in the errors come from
 * `quoted`, a text of the same length (the original, when `text` blanks some of it out).
 */
function scanDelimiters(text, delimiters, macros, errors, maxErrors, quoted = text) {
  let position = 0;

  // Create regex for finding opening delimiters
  const regexLeft = new RegExp(
    "(" + delimiters.map((x) => escapeRegex(x.left)).join("|") + ")"
  );

  // Each pass must start past the previous one; an empty delimiter would start every pass at the same place.
  // The closing scan (findClose) always moves forward.
  let previousStart = -1;
  while (position < text.length && errors.length < maxErrors) {
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
      errors.push(unclosedError(quoted, startPos, delimiter.left));
      position += leftDelimLength;
      continue;
    }

    const end = endPos + delimiter.right.length;
    const latexContent = isKatexEnvironment(delimiter)
      ? text.slice(startPos, end)
      : text.slice(startPos + leftDelimLength, endPos);

    const problem = katexProblem(latexContent, delimiter.display, macros);
    if (problem) errors.push(katexError(quoted, startPos, end, problem));

    // Move position past the closing delimiter
    position = end;
  }

  return position;
}

/** KaTeX's error message for this math, or null when KaTeX draws it. */
function katexProblem(math, displayMode, macros) {
  try {
    katex.renderToString(math, { displayMode, macros, throwOnError: true });
    return null;
  } catch (error) {
    return error.message;
  }
}

function unclosedError(text, position, opener, why = "") {
  return {
    message: `Unclosed LaTeX delimiter: "${opener}" at position ${position}${why}`,
    position,
    length: opener.length,
    latex: text.slice(position, Math.min(position + QUOTE_LENGTH, text.length)) + "...",
    type: "unclosed",
  };
}

function katexError(text, start, end, message, hint = "") {
  return {
    message: `Invalid LaTeX syntax: ${message}${hint}`,
    position: start,
    length: end - start,
    latex: text.slice(start, end),
    type: "katex_error",
  };
}

function shownAsTextError(text, start, end, message) {
  return { message, position: start, length: end - start, latex: text.slice(start, end), type: SHOWN_AS_TEXT };
}

/** The error for an opener the apps leave as text (appMathScan's "refused"). */
function refusedError(text, { start, delimiter, reason, end }) {
  if (reason === UNCLOSED) return unclosedError(text, start, delimiter.open);
  if (reason === BLANK_LINE) {
    return unclosedError(text, start, delimiter.open, `: the apps never close ${delimiter.open} across a blank line`);
  }
  return shownAsTextError(
    text,
    start,
    end,
    `LaTeX shown as text: the apps don't draw the math "${delimiter.open}" opens at position ${start}, because ` +
      `${reason}. Write a lone bracket as \\lbrack or \\rbrack.`,
  );
}

/**
 * Errors for the text between math and code, from `start` to `end`: bare environments and single-dollar math. The
 * patterns run on `shown`, the text with its source chips blanked out; the errors quote `text`.
 */
function proseErrors(text, shown, start, end) {
  const prose = shown.slice(start, end);
  const found = [];
  for (const match of prose.matchAll(BEGIN_IN_TEXT)) {
    const name = match[1];
    if (!TEXT_ONLY_ENVIRONMENTS.has(name)) continue;
    const at = start + match.index;
    found.push(shownAsTextError(
      text,
      at,
      at + match[0].length,
      `LaTeX shown as text: \\begin{${name}} at position ${at} is outside math, and the apps draw it only inside ` +
        `$$ ... $$. Put the whole \\begin{${name}} ... \\end{${name}} inside $$ ... $$.`,
    ));
  }
  for (const match of prose.matchAll(SINGLE_DOLLAR_MATH)) {
    if (!MATH_SIGN.test(match[1]) || PRICE_THEN_CURRENCY.test(match[1])) continue;
    const at = start + match.index;
    found.push(shownAsTextError(
      text,
      at,
      at + match[0].length,
      `LaTeX shown as text: math between single $ at position ${at}; the apps draw only $$ ... $$ as math.`,
    ));
  }
  return found.sort((a, b) => a.position - b.position);
}

// The default list's entries the apps' scan does not cover: checked in the text outside math and code, as before.
const PROSE_DELIMITERS = defaultDelimiters.filter(({ left }) => {
  const name = ENVIRONMENT_OPENER.exec(left)?.[1];
  return left !== "\\(" && left !== "\\[" && !(name && (KATEX_ENVIRONMENTS.has(name) || APPS_DRAWN_BARE.has(name)));
});

/**
 * The text checked as the web and mobile apps draw it (ops I-1237). Math they draw is checked with KaTeX as they
 * pass it: a $$ pair whole, inline unless it stands on its own lines; \[ \] and \( \) by their content; a bare
 * equation or align-family environment by its body alone. LaTeX they leave as text is an error: an opener they
 * can't close, math whose structure they reject, a bare cases, matrix or other environment they draw only inside
 * math, and math between single dollars. The text outside math and code is then checked against PROSE_DELIMITERS.
 * What a citation the apps draw as a source chip holds is never shown, so it is not checked.
 * Stops after MAX_ERRORS errors or refused openers (each refused opener may cost a pass over the rest of the text);
 * `truncated` says the text may hold more, and a text the check did not finish is not valid.
 */
function validateAsAppsDraw(text, macros) {
  const limit = MAX_ERRORS + 1;
  const reading = readAsApps(text);
  const parts = [];
  let refused = 0;
  for (const part of reading.parts) {
    parts.push(part);
    if (part.kind === "refused" && ++refused >= limit) break;
  }
  const stoppedEarly = refused >= limit;
  const chips = reading.sourceTokens(parts);
  // The prose patterns read a chip, or a citation the apps cut from code, as one object: not a space, so
  // "$x^2【3】$" is still math between single dollars, and nothing a pattern looks for.
  const hidden = [...chips, ...reading.cutFromCode];
  const shown = blankOut(text, [...hidden], OBJECT);
  let chip = 0;
  const inChip = (position) => {
    while (chip < chips.length && chips[chip][1] <= position) chip++;
    return chip < chips.length && chips[chip][0] <= position;
  };

  const errors = [];
  const blanked = hidden;
  let proseStart = 0;
  const addProse = (end) => {
    for (const error of proseErrors(text, shown, proseStart, end)) {
      if (errors.length >= limit) return;
      errors.push(error);
      if (error.type === SHOWN_AS_TEXT) blanked.push([error.position, error.position + error.length]);
    }
  };

  for (const part of parts) {
    if (errors.length >= limit) break;
    if (part.kind === "refused") {
      if (!inChip(part.start)) errors.push(refusedError(text, part));
      continue;
    }
    addProse(part.start);
    if (errors.length >= limit) break;
    if (part.kind === "math") {
      const problem = katexProblem(part.content, part.display, macros);
      if (problem) {
        const bare = part.delimiter.open.startsWith("\\begin{")
          ? `. The apps draw a bare ${part.delimiter.open} by its body alone: put it inside $$ ... $$.`
          : "";
        errors.push(katexError(text, part.start, part.end, problem, bare));
      }
    }
    blanked.push([part.start, part.end]);
    proseStart = part.end;
  }
  if (errors.length < limit && !stoppedEarly) addProse(text.length);

  if (errors.length < limit) {
    const outside = blankOut(text, blanked);
    const end = stoppedEarly ? proseStart : text.length;
    scanDelimiters(outside.slice(0, end), PROSE_DELIMITERS, macros, errors, limit, text);
  }

  errors.sort((a, b) => a.position - b.position);
  const truncated = errors.length > MAX_ERRORS || stoppedEarly;
  return {
    isValid: errors.length === 0 && !truncated,
    errors: errors.slice(0, MAX_ERRORS),
    truncated,
  };
}

/** The text with each [start, end) span turned to `fill`, so positions stay where they were. Sorts `spans`. */
function blankOut(text, spans, fill = " ") {
  let blanked = "";
  let last = 0;
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    if (end <= last) continue;
    const from = Math.max(start, last);
    blanked += text.slice(last, from) + fill.repeat(end - from);
    last = end;
  }
  return blanked + text.slice(last);
}

/**
 * Validates LaTeX formatting in a string
 * @param text The text to validate
 * @param delimiters Optional custom delimiters; without them, the text is checked as the apps draw it
 * @param macros Optional KaTeX macros
 * @returns Validation result with any errors found, at most MAX_ERRORS; `truncated` when the scan stopped there
 *   with text left, so the text may hold more
 */
export function validateLatex(text, delimiters, macros) {
  if (delimiters === undefined) return validateAsAppsDraw(text, macros);
  const errors = [];
  const position = scanDelimiters(text, delimiters, macros, errors, MAX_ERRORS);
  return {
    isValid: errors.length === 0,
    errors,
    truncated: errors.length >= MAX_ERRORS && position < text.length,
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
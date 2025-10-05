import katex from "katex";

// Types (copied from local types to be self-contained)
export const defaultDelimiters = [
  { left: "\\(", right: "\\)", display: false },
  { left: "\\[", right: "\\]", display: true },
  { left: "\\begin{equation}", right: "\\end{equation}", display: false },
  { left: "\\begin{align}", right: "\\end{align}", display: false },
  { left: "\\begin{align*}", right: "\\end{align*}", display: false },
  { left: "\\begin{cases}", right: "\\end{cases}", display: false },
  { left: "\\begin{matrix}", right: "\\end{matrix}", display: false },
  { left: "\\begin{bmatrix}", right: "\\end{bmatrix}", display: false },
  { left: "\\begin{pmatrix}", right: "\\end{pmatrix}", display: false },
  { left: "\\begin{array}", right: "\\end{array}", display: false },
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

// Utility functions (copied from local utilities to be self-contained)
function escapeRegex(text) {
  return text.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

function findEndOfMath(
  delimiterValue,
  text,
  startIndex,
) {
  let index = startIndex;
  let braceLevel = 0;

  const delimLength = delimiterValue.length;

  while (index < text.length) {
    const character = text[index];

    if (
      braceLevel <= 0 &&
      text.slice(index, index + delimLength) === delimiterValue
    ) {
      return index;
    } else if (character === "\\") {
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

  const regexLeft = new RegExp(
    "(" + delimiters.map((x) => escapeRegex(x.left)).join("|") + ")",
  );

  while (true) {
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
    index = findEndOfMath(delimiters[i].right, text, delimiters[i].left.length);
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
 * @returns Validation result with any errors found
 */
export function validateLatex(
  text,
  delimiters = defaultDelimiters,
  macros
) {
  const errors = [];
  let position = 0;
  const originalText = text;

  // Create regex for finding opening delimiters
  const regexLeft = new RegExp(
    "(" + delimiters.map((x) => escapeRegex(x.left)).join("|") + ")"
  );

  while (position < text.length) {
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
    
    // Find the closing delimiter
    let endPos = -1;
    let searchPos = position + leftDelimLength;
    let braceLevel = 0;

    // Special handling for delimiters with empty right side (like \item)
    if (delimiter.right === "") {
      position += leftDelimLength;
      continue;
    }

    while (searchPos < text.length) {
      const char = text[searchPos];
      
      if (
        braceLevel <= 0 &&
        text.slice(searchPos).startsWith(delimiter.right)
      ) {
        endPos = searchPos;
        break;
      } else if (char === "\\") {
        searchPos++; // Skip escaped character
      } else if (char === "{") {
        braceLevel++;
      } else if (char === "}") {
        braceLevel--;
      }
      
      searchPos++;
    }

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

    // Extract the LaTeX content
    const latexContent = text.slice(position + leftDelimLength, endPos);
    
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
        length: endPos + delimiter.right.length - startPos,
        latex: text.slice(startPos, endPos + delimiter.right.length),
        type: "katex_error",
      });
    }

    // Move position past the closing delimiter
    position = endPos + delimiter.right.length;
  }

  return {
    isValid: errors.length === 0,
    errors,
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
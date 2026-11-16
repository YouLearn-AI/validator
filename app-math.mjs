// Where the web and mobile apps draw math in a text, and where they refuse to (ops I-1237).
//
// A port of the apps' shared math scan: frontend packages/libs/utils/src/lib/markdown/tokenizer.ts
// (collectCodeRanges, findClosingDelimiter, isValidMathStructure, tryMatchMath and the math loop of
// tokenizeContent) and patterns.ts (BLOCK_ENVIRONMENTS, INLINE_ENVIRONMENTS, buildMathDelimiters, SOURCE_PATTERN),
// as of frontend commit 6637ffad4b (both files last changed in d74396c6be). Both apps call it with
// singleDollarMath false (apps/web-app/components/global/markdown.tsx:1283, apps/mobile-app/components/ui/
// markdown.tsx:1359), so a single $ is never math there. Change this file when those change, and move the pin in
// test/fixtures/frontend-math.json (the two files' blob ids and the lists) with it: the hub monitor's sweep
// (apps/monitor/sweep/math_scan_drift.py) raises a CANDIDATE when the frontend's main moves past the pin or its lists
// differ from these.
//
// It differs from the original only where the original's time grows with the square of the text, which a 256 KB
// request must not do on Node's only thread (ops I-1238), and in what it reports:
// - Code ranges are found by the same two patterns, but each inline match is compared with the fences, not with
//   every range found so far, and the scan walks the sorted ranges once instead of searching them at each position.
// - A citation inside math is removed by the same pattern, tried on at most MAX_SOURCE_LENGTH characters from each
//   【, so text with many unclosed 【 can't rescan the rest of a formula each time.
// - The original removes citations inside code before it scans (stripSourcesInRanges); that changes only code,
//   which the scan skips, so this port does not, and positions stay those of the text it was given.
// - Where the original answers false (no closing delimiter, a structure it rejects), this says why.

export const BLOCK_ENVIRONMENTS = [
  "equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "displaymath",
  "eqnarray", "eqnarray*", "split", "aligned", "gathered", "flalign", "flalign*", "alignat", "alignat*",
];

export const INLINE_ENVIRONMENTS = ["math"];

// buildMathDelimiters({ singleDollarMath: false }), in its order: the first that matches at a position wins.
export const MATH_DELIMITERS = [
  { open: "$$", close: "$$", display: true, checkContext: true },
  { open: "\\[", close: "\\]", display: true },
  { open: "\\(", close: "\\)", display: false },
  ...BLOCK_ENVIRONMENTS.map((env) => ({ open: `\\begin{${env}}`, close: `\\end{${env}}`, display: true })),
  ...INLINE_ENVIRONMENTS.map((env) => ({ open: `\\begin{${env}}`, close: `\\end{${env}}`, display: false })),
];

const TEXT_COMMANDS = new Set([
  "text", "textrm", "textbf", "textit", "texttt", "textsf", "textsc", "mathrm", "mathbf", "mathit", "mathsf",
  "mathtt", "mathcal", "mathbb", "mathfrak", "mbox", "hbox", "operatorname",
]);

// After a backslash, these characters are skipped with it by the structure check (tokenizer.ts:233-260).
const ESCAPED_AFTER_BACKSLASH = new Set("{}[]()|*\\$&#%_^~'`,;!><");

const SOURCE_PATTERN =
  /【([^,】]+?)(?:,\s*type:\s*([^,】]+))?(?:,\s*bbox:\s*(?:"([^"]+)"|([-\d.,\s]+)))?(?:,\s*source:\s*(?:"([^"]+)"|([^】]+)))?\s*】/y;
const SOURCE_START = "【";
// The longest citation removed from math. The backend writes them as 【n】 or 【n, bbox: ..., source: ...】.
const MAX_SOURCE_LENGTH = 512;

// Why the apps leave an opener as text: no closing delimiter, a $$ whose closer lies past a blank line, or math
// whose structure the apps reject (STRUCTURE_REASONS).
export const UNCLOSED = "unclosed";
export const BLANK_LINE = "blank_line";

export const STRUCTURE_REASONS = {
  doubleAsterisk: 'it holds "**"',
  unclosedBegin: "a \\begin{ has no closing }",
  unmatchedEnd: "an \\end does not match the last open \\begin",
  unmatchedBracket: "a } or ] has no matching { or [",
  unclosedGroup: "a { or [ is never closed",
  unclosedEnvironment: "a \\begin has no \\end",
};

function isAlpha(c) {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/** The fenced and inline code spans, sorted and not overlapping: collectCodeRanges. */
function codeRanges(text) {
  const fences = [];
  for (const match of text.matchAll(/```[\s\S]*?```/g)) {
    fences.push({ start: match.index, end: match.index + match[0].length });
  }
  const ranges = [...fences];
  let fence = 0;
  for (const match of text.matchAll(/`+[^`]*?`+/g)) {
    const start = match.index;
    const end = start + match[0].length;
    while (fence < fences.length && fences[fence].end <= start) fence++;
    if (fence < fences.length && fences[fence].start < end) continue;
    ranges.push({ start, end });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/**
 * Where `close` sits after `start`, or why there is none: findClosingDelimiter. A backslash skips a following
 * backslash, $ or command name; a delimiter that closes with its own opener ($$) never closes past a blank line.
 * @returns {{ at: number } | { reason: string }}
 */
function findClose(text, start, open, close) {
  const symmetric = open === close;
  let pos = start;
  while (pos <= text.length - close.length) {
    const char = text[pos];
    if (symmetric && char === "\n" && text[pos + 1] === "\n") return { reason: BLANK_LINE };
    if (text.startsWith(close, pos)) return { at: pos };
    if (char === "\\") {
      const next = text[pos + 1];
      if (next === "\\" || next === "$") {
        pos += 2;
      } else if (next !== undefined && isAlpha(next)) {
        pos += 2;
        while (pos < text.length && isAlpha(text[pos])) pos++;
      } else {
        pos++;
      }
      continue;
    }
    pos++;
  }
  return { reason: UNCLOSED };
}

/** Why the apps refuse to draw this math, or null when they draw it: isValidMathStructure. */
function structureProblem(tex) {
  const groups = [];
  const environments = [];
  const pairs = { "}": "{", "]": "[" };
  let pos = 0;

  while (pos < tex.length) {
    const char = tex[pos];
    const next = pos + 1 < tex.length ? tex[pos + 1] : "";
    const prev = pos > 0 ? tex[pos - 1] : "";

    if (char === "*" && next === "*" && prev !== "\\") return STRUCTURE_REASONS.doubleAsterisk;

    if (char === "\\") {
      if (tex.startsWith("\\begin{", pos) || tex.startsWith("\\end{", pos)) {
        const isBegin = tex.startsWith("\\begin{", pos);
        const nameStart = pos + (isBegin ? 7 : 5);
        const nameEnd = tex.indexOf("}", nameStart);
        if (nameEnd === -1) return STRUCTURE_REASONS.unclosedBegin;
        const name = tex.substring(nameStart, nameEnd);
        if (isBegin) {
          environments.push(name);
        } else if (environments.length === 0 || environments.pop() !== name) {
          return STRUCTURE_REASONS.unmatchedEnd;
        }
        pos = nameEnd + 1;
        continue;
      }

      let nameEnd = pos + 1;
      while (nameEnd < tex.length && isAlpha(tex[nameEnd])) nameEnd++;
      const command = tex.substring(pos + 1, nameEnd);
      if (command.length > 0 && TEXT_COMMANDS.has(command) && tex[nameEnd] === "{") {
        groups.push("{");
        pos = nameEnd + 1;
        continue;
      }
      if (ESCAPED_AFTER_BACKSLASH.has(next)) {
        pos += 2;
        continue;
      }
      if (next && isAlpha(next)) {
        pos = nameEnd;
        continue;
      }
      pos += 2;
      continue;
    }

    if (char === "{" || char === "[") {
      groups.push(char);
    } else if ((char === "}" || char === "]") && (groups.length === 0 || groups.pop() !== pairs[char])) {
      return STRUCTURE_REASONS.unmatchedBracket;
    }
    pos++;
  }

  if (groups.length > 0) return STRUCTURE_REASONS.unclosedGroup;
  if (environments.length > 0) return STRUCTURE_REASONS.unclosedEnvironment;
  return null;
}

/** The math without its citations, as the apps draw it: stripSources. */
function stripSources(math) {
  let start = math.indexOf(SOURCE_START);
  if (start === -1) return math;
  let kept = "";
  let last = 0;
  while (start !== -1) {
    const window = math.slice(start, start + MAX_SOURCE_LENGTH);
    SOURCE_PATTERN.lastIndex = 0;
    const match = SOURCE_PATTERN.exec(window);
    if (match) {
      kept += math.slice(last, start);
      last = start + match[0].length;
      start = math.indexOf(SOURCE_START, last);
    } else {
      start = math.indexOf(SOURCE_START, start + 1);
    }
  }
  return kept + math.slice(last);
}

/** Whether a $$ pair stands alone on its lines, which makes it display math: isOnOwnLine. */
function isOnOwnLine(text, start, closeEnd) {
  let before = start - 1;
  while (before >= 0 && text[before] === " ") before--;
  let after = closeEnd;
  while (after < text.length && text[after] === " ") after++;
  return (before < 0 || text[before] === "\n") && text[after] === "\n";
}

/**
 * The text's code, math and refused openers, in order, as the apps' scan meets them:
 * - { kind: "code", start, end }: code the apps show as code.
 * - { kind: "math", start, end, content, display, delimiter }: math the apps draw, `content` as they pass it to
 *   KaTeX (between the delimiters, citations removed; a bare environment's body alone) in display or inline mode.
 * - { kind: "refused", start, delimiter, reason, end? }: an opener the apps show as text; `reason` is UNCLOSED,
 *   BLANK_LINE or one of STRUCTURE_REASONS, and `end` is where its rejected math closed, for a structure reason.
 *   The scan goes on at the next character, as the apps' does.
 * A caller may stop early. Each refused opener costs at most one pass over the rest of the text; the rest is linear.
 * @param {string} text
 */
export function* appMathScan(text) {
  const ranges = codeRanges(text);
  let range = 0;
  let pos = 0;

  while (pos < text.length) {
    while (range < ranges.length && ranges[range].end <= pos) range++;
    if (range < ranges.length && ranges[range].start <= pos) {
      yield { kind: "code", start: pos, end: ranges[range].end };
      pos = ranges[range].end;
      continue;
    }

    let refusal = null;
    let drawn = null;
    for (const delimiter of MATH_DELIMITERS) {
      if (!text.startsWith(delimiter.open, pos)) continue;
      const contentStart = pos + delimiter.open.length;
      const close = findClose(text, contentStart, delimiter.open, delimiter.close);
      if (close.reason) {
        refusal ??= { delimiter, reason: close.reason };
        continue;
      }
      const content = stripSources(text.slice(contentStart, close.at));
      const end = close.at + delimiter.close.length;
      const problem = structureProblem(content);
      if (problem) {
        refusal ??= { delimiter, reason: problem, end };
        continue;
      }
      const display = delimiter.checkContext ? isOnOwnLine(text, pos, end) : delimiter.display;
      drawn = { kind: "math", start: pos, end, content, display, delimiter };
      break;
    }

    if (drawn) {
      yield drawn;
      pos = drawn.end;
      continue;
    }
    if (refusal) yield { kind: "refused", start: pos, ...refusal };
    pos++;
  }
}

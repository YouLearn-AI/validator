// Where the web and mobile apps draw math in a text, and where they refuse to (ops I-1237).
//
// A port of the apps' shared math scan: frontend packages/libs/utils/src/lib/markdown/tokenizer.ts
// (collectCodeRanges, findClosingDelimiter, isValidMathStructure, tryMatchMath and the math loop of
// tokenizeContent) and patterns.ts (BLOCK_ENVIRONMENTS, INLINE_ENVIRONMENTS, buildMathDelimiters, SOURCE_PATTERN),
// as of frontend commit 6637ffad4b (both files last changed in d74396c6be). Both apps call it with
// singleDollarMath false (apps/web-app/components/global/markdown.tsx:1283, apps/mobile-app/components/ui/
// markdown.tsx:1359), so a single $ is never math there. Change this file when those change, and move the pin in
// test/fixtures/frontend-math.json (the frontend commit, the two files and the lists) with it: the hub monitor's sweep
// (apps/monitor/sweep/math_scan_drift.py) raises a CANDIDATE when either file on the frontend's main differs from the
// pinned commit's, or its lists differ from these.
//
// It differs from the original only where the original's time grows faster than the text, which a 256 KB request
// must not do on Node's only thread (ops I-1238), and in what it reports:
// - Code ranges are found by the same two patterns, but each inline match is compared with the fences, not with
//   every range found so far, and the scan walks the sorted ranges once instead of searching them at each position.
// - Citations (SOURCE_PATTERN) are found by citationEnd, which matches exactly what the pattern matches (a test
//   compares them) in constant time per 【: the pattern's whitespace runs overlap, so it backtracks for seconds on
//   text like "【1, bbox: " and 400 spaces, repeated.
// - The original removes the citations inside code before it scans (stripSourcesInRanges), which can join or split
//   code spans. This port does the same, and gives every position in the text it was given.
// - Where the original answers false (no closing delimiter, a structure it rejects), this says why.
// After the math scan the apps draw each citation outside math and code as a source chip (tokenizeContent's
// source tokens), so what it holds is never shown as LaTeX: sourceTokens finds them. The apps' other tokens
// (<sources> groups, mentions, <search> tags) are not ported: none of a week's 28,647 summaries held one.

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

// The apps' citation pattern (patterns.ts), kept for the test that compares citationEnd with it; never run here.
export const SOURCE_PATTERN =
  /【([^,】]+?)(?:,\s*type:\s*([^,】]+))?(?:,\s*bbox:\s*(?:"([^"]+)"|([-\d.,\s]+)))?(?:,\s*source:\s*(?:"([^"]+)"|([^】]+)))?\s*】/g;
const SOURCE_OPEN = "【";
const SOURCE_CLOSE = "】";

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

/** Whether a UTF-16 code unit is whitespace to a JavaScript pattern's \s (a test checks all 65,536). */
export function isSpace(code) {
  return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0xa0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f ||
    code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** Whether a code unit is in bbox's unquoted class, [-\d.,\s]. */
function isBboxNumber(code) {
  return isSpace(code) || code === 0x2d || code === 0x2e || code === 0x2c || (code >= 0x30 && code <= 0x39);
}

/**
 * For each position of a text, the next character of each kind SOURCE_PATTERN stops at, so citationEnd reads in
 * constant time what the pattern would find by backtracking. Built once per text, in one pass each way.
 */
class CitationIndex {
  constructor(text) {
    const n = text.length;
    this.text = text;
    this.open = new Int32Array(n + 1); // the next 【
    this.stop = new Int32Array(n + 1); // the next , or 】
    this.close = new Int32Array(n + 1); // the next 】
    this.quote = new Int32Array(n + 1); // the next "
    this.solid = new Int32Array(n + 1); // the next character that is not whitespace
    this.notNumber = new Int32Array(n + 1); // the next character outside [-\d.,\s]
    this.lastSolid = new Int32Array(n + 1); // the last character before that is not whitespace, or -1
    this.open[n] = this.stop[n] = this.close[n] = this.quote[n] = this.solid[n] = this.notNumber[n] = n;
    for (let i = n - 1; i >= 0; i--) {
      const char = text[i];
      const code = text.charCodeAt(i);
      this.open[i] = char === SOURCE_OPEN ? i : this.open[i + 1];
      this.stop[i] = char === "," || char === SOURCE_CLOSE ? i : this.stop[i + 1];
      this.close[i] = char === SOURCE_CLOSE ? i : this.close[i + 1];
      this.quote[i] = char === '"' ? i : this.quote[i + 1];
      this.solid[i] = isSpace(code) ? this.solid[i + 1] : i;
      this.notNumber[i] = isBboxNumber(code) ? this.notNumber[i + 1] : i;
    }
    let last = -1;
    for (let i = 0; i <= n; i++) {
      this.lastSolid[i] = last;
      if (i < n && !isSpace(text.charCodeAt(i))) last = i;
    }
  }
}

/**
 * Where SOURCE_PATTERN's match starting at `start` ends when run on text[0, limit), or -1 when it has none there.
 * The pattern is 【 label (, type: t)? (, bbox: b)? (, source: s)? \s* 】, tried as a backtracking engine tries it:
 * the label is lazy but holds no comma, so it ends at the first , or 】; each optional field is tried present first;
 * a quoted value before an unquoted one; and an unquoted value from its longest. The first way that reaches the
 * final 】 wins. Each field's value can end only where the field after it, or the closing 】, can start, so each
 * field has at most two ends worth trying, and the index finds each in constant time.
 * @param {CitationIndex} index
 */
function citationEnd({ text, stop, close, quote, solid, notNumber, lastSolid }, start, limit) {
  const next = (array, i) => (i >= limit ? limit : Math.min(array[i], limit));
  const at = (i) => (i < limit ? text[i] : "");
  // \s* 】 from v.
  const closes = (v) => {
    const w = next(solid, v);
    return at(w) === SOURCE_CLOSE ? w + 1 : -1;
  };
  // ", \s* name: \s*" from i; the position after "name:", or -1.
  const field = (name, i) => {
    if (at(i) !== ",") return -1;
    const j = next(solid, i + 1);
    return j + name.length <= limit && text.startsWith(name, j) ? j + name.length : -1;
  };
  // A quoted value "[^"]+" at the first non-space from k; the position after its closing ", or -1.
  const quoted = (k) => {
    const m = next(solid, k);
    if (at(m) !== '"') return -1;
    const q = next(quote, m + 1);
    return q < limit && q > m + 1 ? q + 1 : -1;
  };
  // ", source: s" then \s* 】. Unquoted, s is [^】]+: it runs to the first 】, which then closes the citation.
  const source = (i) => {
    const k = field("source:", i);
    if (k === -1) return -1;
    const v = quoted(k);
    const end = v === -1 ? -1 : closes(v);
    if (end !== -1) return end;
    const z = next(close, k);
    return z < limit && z > k ? z + 1 : -1;
  };
  const afterBbox = (v) => {
    const end = source(v);
    return end !== -1 ? end : closes(v);
  };
  // ", bbox: b" then the rest. Unquoted, b is [-\d.,\s]+ and runs to g, the first character outside it. Shorter, it
  // can end only before a comma that starts ", source:", and only before the last non-space one: a digit, - or .
  // after that comma could start neither the source field nor the closing \s* 】.
  const bbox = (i) => {
    const k = field("bbox:", i);
    if (k === -1) return -1;
    const v = quoted(k);
    const end = v === -1 ? -1 : afterBbox(v);
    if (end !== -1) return end;
    const g = next(notNumber, k);
    if (g > k && at(g) === SOURCE_CLOSE) return g + 1;
    const comma = lastSolid[g];
    return comma > k && at(comma) === "," ? source(comma) : -1;
  };
  const afterType = (v) => {
    const end = bbox(v);
    return end !== -1 ? end : afterBbox(v);
  };
  // ", type: t" then the rest. t is [^,】]+: it runs to the first , or 】, and only there can the rest start.
  const type = (i) => {
    const k = field("type:", i);
    if (k === -1) return -1;
    const h = next(stop, k);
    if (h <= k || h >= limit) return -1;
    return text[h] === SOURCE_CLOSE ? h + 1 : afterType(h);
  };

  const labelEnd = next(stop, start + 1);
  if (labelEnd <= start + 1 || labelEnd >= limit) return -1;
  if (text[labelEnd] === SOURCE_CLOSE) return labelEnd + 1;
  const end = type(labelEnd);
  return end !== -1 ? end : afterType(labelEnd);
}

/**
 * The citations in text[from, limit) as SOURCE_PATTERN's global search finds them in that slice: leftmost first,
 * each search going on after the last match. Spans are [start, end) pairs.
 * @param {CitationIndex} index
 */
function citationSpans(index, from = 0, limit = index.text.length) {
  const spans = [];
  let start = from < limit ? index.open[from] : limit;
  while (start < limit) {
    const end = citationEnd(index, start, limit);
    if (end === -1) {
      start = index.open[start + 1];
    } else {
      spans.push([start, end]);
      start = index.open[end];
    }
  }
  return spans;
}

/** The citations in text[from, limit), as [start, end) spans: citationSpans for one text. */
export function findCitations(text, from = 0, limit = text.length) {
  return citationSpans(new CitationIndex(text), from, limit);
}

/** text[from, limit) without its citations, as stripSources returns it for that slice. */
function stripSources(text, index, from, limit) {
  if (index === null || index.open[from] >= limit) return text.slice(from, limit);
  let kept = "";
  let last = from;
  for (const [start, end] of citationSpans(index, from, limit)) {
    kept += index.text.slice(last, start);
    last = end;
  }
  return kept + index.text.slice(last, limit);
}

/**
 * The text as the apps scan it: without the citations inside code (stripSourcesInRanges), with its code ranges
 * read again, its citation index, and the map from its positions to the given text's.
 * @param {string} input
 */
function prepare(input) {
  const inputIndex = input.includes(SOURCE_OPEN) ? new CitationIndex(input) : null;
  const inputRanges = codeRanges(input);
  // removed[i] = [where in the result the i-th citation was cut out, the characters cut up to and including it]
  const removed = [];
  let text = input;
  if (inputIndex !== null && inputRanges.length > 0) {
    let kept = "";
    let last = 0;
    let cut = 0;
    for (const range of inputRanges) {
      for (const [start, end] of citationSpans(inputIndex, range.start, range.end)) {
        kept += input.slice(last, start);
        cut += end - start;
        removed.push([kept.length, cut]);
        last = end;
      }
    }
    if (removed.length > 0) text = kept + input.slice(last);
  }
  if (removed.length === 0) {
    const same = (position) => position;
    return { text, index: inputIndex, ranges: inputRanges, toInputStart: same, toInputEnd: same };
  }

  // The characters cut before position p of the result: those at a place < p, or <= p for a character's start.
  const cutBefore = (p, orAt) => {
    let low = 0;
    let high = removed.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (removed[mid][0] < p || (orAt && removed[mid][0] === p)) low = mid + 1;
      else high = mid;
    }
    return low === 0 ? 0 : removed[low - 1][1];
  };
  return {
    text,
    index: text.includes(SOURCE_OPEN) ? new CitationIndex(text) : null,
    ranges: codeRanges(text),
    toInputStart: (p) => p + cutBefore(p, true),
    toInputEnd: (p) => p + cutBefore(p, false),
  };
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
 * Reads a text as the apps' scan does. `parts` yields its code, math and refused openers in order:
 * - { kind: "code", start, end }: code the apps show as code.
 * - { kind: "math", start, end, content, display, delimiter }: math the apps draw, `content` as they pass it to
 *   KaTeX (between the delimiters, citations removed; a bare environment's body alone) in display or inline mode.
 * - { kind: "refused", start, delimiter, reason, end? }: an opener the apps don't draw; `reason` is UNCLOSED,
 *   BLANK_LINE or one of STRUCTURE_REASONS, and `end` is where its rejected math closed, for a structure reason.
 *   The scan goes on at the next character, as the apps' does.
 * A caller may stop early. Each refused opener costs at most one pass over the rest of the text; the rest is linear.
 * `sourceTokens(parts)` then gives the citations the apps draw as source chips: those that overlap none of the
 * math and code in `parts`. Positions are the given text's, as [start, end) spans.
 * @param {string} input
 */
export function readAsApps(input) {
  const { text, index, ranges, toInputStart, toInputEnd } = prepare(input);

  function* parts() {
    let range = 0;
    let pos = 0;

    while (pos < text.length) {
      while (range < ranges.length && ranges[range].end <= pos) range++;
      if (range < ranges.length && ranges[range].start <= pos) {
        yield { kind: "code", start: toInputStart(pos), end: toInputEnd(ranges[range].end) };
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
        const content = stripSources(text, index, contentStart, close.at);
        const end = close.at + delimiter.close.length;
        const problem = structureProblem(content);
        if (problem) {
          refusal ??= { delimiter, reason: problem, end: toInputEnd(end) };
          continue;
        }
        const display = delimiter.checkContext ? isOnOwnLine(text, pos, end) : delimiter.display;
        drawn = { kind: "math", start: pos, end, content, display, delimiter };
        break;
      }

      if (drawn) {
        yield { ...drawn, start: toInputStart(drawn.start), end: toInputEnd(drawn.end) };
        pos = drawn.end;
        continue;
      }
      if (refusal) yield { kind: "refused", start: toInputStart(pos), ...refusal };
      pos++;
    }
  }

  function sourceTokens(scanned) {
    if (index === null) return [];
    const taken = scanned.filter(({ kind }) => kind === "math" || kind === "code");
    const tokens = [];
    let next = 0;
    for (const [start, end] of citationSpans(index)) {
      const span = [toInputStart(start), toInputEnd(end)];
      while (next < taken.length && taken[next].end <= span[0]) next++;
      if (next < taken.length && taken[next].start < span[1]) continue;
      tokens.push(span);
    }
    return tokens;
  }

  return { parts: parts(), sourceTokens };
}

/** The parts of readAsApps alone. */
export function appMathScan(input) {
  return readAsApps(input).parts;
}

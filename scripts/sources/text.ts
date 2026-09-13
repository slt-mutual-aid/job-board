// A description is reviewed by a person in a spreadsheet cell before it reaches
// the job board, so the value has to stay readable at that width.
export const MAX_DESCRIPTION_LENGTH = 4000;

const ELLIPSIS = "…";

// The entities a rich-text editor emits into a job description. An entity
// outside this set is left as written rather than guessed at.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  deg: "°",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  eacute: "é",
  egrave: "è",
  ntilde: "ñ",
};

const ENTITY_PATTERN = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

const MAX_CODE_POINT = 0x10ffff;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const SURROGATE_END = 0xdfff;

// A half of a surrogate pair is not a character, and a control character is
// invisible in the spreadsheet cell while still counting against the cap.
function isWritable(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
    return true;
  }
  return (
    codePoint > 0x1f &&
    codePoint <= MAX_CODE_POINT &&
    !(codePoint >= 0x7f && codePoint <= 0x9f) &&
    !(codePoint >= HIGH_SURROGATE_START && codePoint <= SURROGATE_END)
  );
}

function decodeEntity(source: string, body: string): string {
  if (body.startsWith("#")) {
    const hexadecimal = body[1] === "x" || body[1] === "X";
    const digits = hexadecimal ? body.slice(2) : body.slice(1);
    const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
    return Number.isInteger(codePoint) && isWritable(codePoint)
      ? String.fromCodePoint(codePoint)
      : source;
  }

  const named = NAMED_ENTITIES[body];
  return named === undefined ? source : named;
}

// One pass only. A second pass would turn text that a writer escaped on purpose,
// such as "&amp;amp;", into markup the reader never wrote.
function decodeEntities(text: string): string {
  return text.replace(ENTITY_PATTERN, decodeEntity);
}

// A character above U+FFFF occupies two positions, and keeping only the first
// leaves a half that renders as a replacement box.
function cutAt(text: string, end: number): string {
  const last = text.charCodeAt(end - 1);
  const splitsCharacter =
    last >= HIGH_SURROGATE_START && last <= HIGH_SURROGATE_END;
  return text.slice(0, splitsCharacter ? end - 1 : end);
}

function truncate(text: string): string {
  if (text.length <= MAX_DESCRIPTION_LENGTH) {
    return text;
  }

  // One character of the budget belongs to the ellipsis.
  const head = cutAt(text, MAX_DESCRIPTION_LENGTH);
  const lastGap = head.search(/\s\S*$/);
  const body =
    lastGap > 0
      ? head.slice(0, lastGap)
      : cutAt(head, MAX_DESCRIPTION_LENGTH - 1);
  return body.trimEnd() + ELLIPSIS;
}

const MARKUP_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ""],
  [/<br\b[^>]*>/gi, "\n"],
  [/<li\b[^>]*>/gi, "- "],
  [/<\/(?:p|div|li)\s*>/gi, "\n"],
  // Runs after the tags that carry meaning, so an entity held in an attribute
  // leaves with its tag instead of decoding into the text. Quoted values are
  // skipped whole, so a ">" written inside one does not end the tag early.
  [/<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g, ""],
];

// A single sweep is defeatable: deleting one match splices the text on either
// side of it into a tag the finished sweep never revisits, which is how
// "<sc<script></script>ript>alert(1)</script>" keeps its body. Every sweep that
// changes the text also shortens it, so repeating one reaches a fixpoint. The
// cap holds the work to ten sweeps for an input nested deeper than that.
const MAX_SWEEPS = 10;

function replaceToFixpoint(
  text: string,
  pattern: RegExp,
  replacement: string,
): string {
  let current = text;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep += 1) {
    const next = current.replace(pattern, replacement);
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

function stripMarkup(html: string): string {
  return MARKUP_REPLACEMENTS.reduce(
    (text, [pattern, replacement]) =>
      replaceToFixpoint(text, pattern, replacement),
    html,
  );
}

export function htmlToPlainText(html: string): string {
  // Entities decode only once stripMarkup has removed every tag, so a written
  // "&lt;script&gt;" reaches the reader as text rather than becoming a tag.
  const text = decodeEntities(stripMarkup(html))
    .replace(/ /g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/^﻿/, "")
    .replace(/[​-‍⁠]/g, "")
    // Trimming each line first empties a whitespace-only line, so the collapse
    // below sees the whole run of newlines around it.
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return truncate(text);
}

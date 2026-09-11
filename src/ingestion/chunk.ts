export interface ChunkOptions {
  /** Maximum characters per chunk. Default CHUNK_SIZE. */
  size?: number | undefined;
  /** How many characters the next chunk goes back into the previous one. Default CHUNK_OVERLAP. */
  overlap?: number | undefined;
}

/** ~2-3 chunks for the median Gazeta article (2.007 chars), ~9 for the longest measured. */
export const CHUNK_SIZE = 900;

/** ~17% of CHUNK_SIZE — enough to carry a sentence across the cut. */
export const CHUNK_OVERLAP = 150;

function validateOptions(size: number, overlap: number): void {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunkText: size (${size}) must be an integer >= 1`);
  }
  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new Error(`chunkText: overlap (${overlap}) must be an integer >= 0`);
  }
  if (overlap >= size) {
    throw new Error(`chunkText: overlap (${overlap}) must be smaller than size (${size})`);
  }
}

/** Index of the last whitespace character in `window`, or -1 if there is none. */
function lastWhitespaceIndex(window: string): number {
  for (let index = window.length - 1; index >= 0; index -= 1) {
    if (/\s/.test(window[index] as string)) return index;
  }
  return -1;
}

/**
 * Moves `from` forward to the start of a word. Three cases:
 *
 * 1. `from` is already at a word start (position 0, or a non-whitespace character
 *    immediately preceded by whitespace) — stays put.
 * 2. `from` lands in the middle of a word — skips to the end of *that* word, then past
 *    the whitespace run right after it, landing on the following word.
 * 3. `from` lands on or inside a run of whitespace (one space or many) — skips past the
 *    *entire* run to the next word.
 *
 * Only ever moves forward — a caller that needs "not past some cap" clamps the result
 * itself (rule 4 of the spec).
 *
 * Case 3 is the one an earlier version got wrong: it only checked `text[from - 1]`, which
 * treats *any* position inside a whitespace run longer than one character as "already a
 * word start" — the character right before it is whitespace too — and returned `from`
 * unchanged. That produced empty chunks and, worse, a `nextStart` that never advanced,
 * hanging `chunkText` in an infinite loop on text with irregular spacing.
 */
function advanceToWordStart(text: string, from: number): number {
  let index = Math.max(from, 0);
  if (index >= text.length) return text.length;

  const atWordStart = index === 0 || (!/\s/.test(text[index] as string) && /\s/.test(text[index - 1] as string));
  if (atWordStart) return index;

  if (!/\s/.test(text[index] as string)) {
    // Mid-word: reach the end of the current word before looking for whitespace to skip.
    while (index < text.length && !/\s/.test(text[index] as string)) {
      index += 1;
    }
  }
  while (index < text.length && /\s/.test(text[index] as string)) {
    index += 1;
  }
  return index;
}

/**
 * Splits a passage text into overlapping fixed-size chunks, never cutting inside a word.
 * Pure and deterministic: same input, same output, always. See
 * docs/learning/04-chunking.md for the concept and docs/tasks/03-vector-index.md §3 for
 * the rules this implements.
 */
export function chunkText(text: string, options?: ChunkOptions): string[] {
  const size = options?.size ?? CHUNK_SIZE;
  const overlap = options?.overlap ?? CHUNK_OVERLAP;
  validateOptions(size, overlap);

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("chunkText: empty text");
  }

  if (trimmed.length <= size) {
    return [trimmed];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < trimmed.length) {
    const hardEnd = Math.min(start + size, trimmed.length);
    let end = hardEnd;

    if (hardEnd < trimmed.length) {
      const window = trimmed.slice(start, hardEnd);
      const whitespaceIndex = lastWhitespaceIndex(window);
      // whitespaceIndex === 0 means the window starts sitting ON whitespace (only
      // reachable when `start` itself landed inside a run of 2+ spaces) — honoring it
      // as the cut would make `end === start`: an empty chunk, and a next-start
      // computation with nothing to advance past. Same fallback as "no whitespace at
      // all": cut at the hard end instead. There's always at least one real character
      // between `start` and `hardEnd` (the while condition guarantees `start <
      // trimmed.length`, and `size >= 1`), so this always makes a non-empty chunk.
      if (whitespaceIndex > 0) {
        end = start + whitespaceIndex;
      }
      // else: no whitespace strictly inside the window (e.g. a giant URL, or the window
      // starting on whitespace) — cut at the hard end. There's no usable word boundary,
      // and getting stuck is worse than cutting.
    }

    chunks.push(trimmed.slice(start, end).trim());

    if (end >= trimmed.length) {
      break;
    }

    // The highest the next start can go without skipping real content. Whether `end`
    // sits on whitespace decides this — not `endIsWhitespace` (which only tracks *how*
    // `end` was found, not what's actually there): a hard cut can coincidentally land
    // exactly on a word boundary too, when the window's last word ends precisely at
    // `hardEnd` (a word exactly `size` characters long). If `trimmed[end]` is
    // whitespace, the next word begins after skipping that whitespace run — advancing
    // past it is fine and necessary. If `trimmed[end]` is itself mid-word (a true hard
    // cut with no boundary in reach), there's nowhere to skip to: the cap is `end`
    // itself, so the next chunk resumes exactly where this one was cut off.
    const endSitsOnWhitespace = end < trimmed.length && /\s/.test(trimmed[end] as string);
    const cap = endSitsOnWhitespace ? advanceToWordStart(trimmed, end) : end;

    let nextStart = advanceToWordStart(trimmed, Math.max(0, end - overlap));
    if (nextStart > cap) {
      // The advance would open a hole in the text — collapse the overlap to zero
      // instead of skipping content.
      nextStart = cap;
    }
    if (nextStart <= start) {
      // The requested overlap reaches back before this chunk even started (e.g. a tiny
      // chunk followed by a large one) — there's no room for it, so continue right after
      // this chunk instead. `cap` is always > start here (rule: chunks are never empty).
      nextStart = cap;
    }

    // Defense in depth for the "Progress" invariant (spec §3): the logic above is
    // subtle enough that a future edit could reintroduce a stall without either of the
    // two fallbacks above catching it. A silent infinite loop is the worst failure mode
    // a hand-triggered batch command can have — fail loud instead.
    if (nextStart <= start) {
      throw new Error(`chunkText: internal invariant violated — no forward progress from index ${start}`);
    }

    start = nextStart;
  }

  return chunks;
}

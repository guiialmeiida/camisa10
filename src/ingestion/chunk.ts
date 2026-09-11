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
 * Moves `from` forward to the start of a word: if `from` is already right after
 * whitespace (or at position 0), it's already a word start and stays put; otherwise it
 * jumps past the next whitespace it finds. Only ever moves forward — a caller that needs
 * "not past some cap" clamps the result itself (rule 4 of the spec).
 */
function advanceToWordStart(text: string, from: number): number {
  if (from <= 0 || /\s/.test(text[from - 1] as string)) {
    return from;
  }
  const relativeIndex = text.slice(from).search(/\s/);
  return relativeIndex === -1 ? text.length : from + relativeIndex + 1;
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
    // Whether `end` landed on an actual whitespace character (rule 3's normal case) or
    // on a hard cut with no word boundary in reach (the degenerate branch below). This
    // decides what "would open a hole" means for the next start, right below.
    let endIsWhitespace = false;

    if (hardEnd < trimmed.length) {
      const window = trimmed.slice(start, hardEnd);
      const whitespaceIndex = lastWhitespaceIndex(window);
      if (whitespaceIndex >= 0) {
        end = start + whitespaceIndex;
        endIsWhitespace = true;
      }
      // else: no whitespace anywhere in the window (e.g. a giant URL) — cut at the hard
      // end. There's no word boundary available, and getting stuck is worse than cutting.
    }

    chunks.push(trimmed.slice(start, end).trim());

    if (end >= trimmed.length) {
      break;
    }

    // The highest the next start can go without skipping real content: when `end` is a
    // whitespace character, the very next word begins right after it (zero-gap
    // continuation) — advancing past `end` itself is fine and necessary. When `end` is a
    // hard cut mid-word, there's no word boundary to skip to, so the cap is `end` itself.
    const cap = endIsWhitespace ? advanceToWordStart(trimmed, end) : end;

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
    start = nextStart;
  }

  return chunks;
}

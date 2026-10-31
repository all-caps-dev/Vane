// TypeScript: pure scan of [n] citation markers in an answer. Reads the text, never changes it.

export type CitationStats = {
  citations: number[]; // every [n] found, in order of appearance (repeats kept)
  uniqueCitations: number[]; // distinct numbers, sorted ascending
  citationCount: number; // total markers found
  maxIndex: number; // highest number cited, 0 when there are none
  sourceCount: number; // the number of sources the answer could cite
  outOfRangeCount: number; // markers below 1 or above sourceCount
};

// Matches [1], [12], and each number of a grouped marker like [1, 2].
const MARKER = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

export const scanCitations = (
  answer: string,
  sourceCount: number,
): CitationStats => {
  const citations: number[] = [];

  for (const match of (answer ?? '').matchAll(MARKER)) {
    for (const part of match[1].split(',')) {
      const n = parseInt(part.trim(), 10);
      if (Number.isFinite(n)) citations.push(n);
    }
  }

  const uniqueCitations = Array.from(new Set(citations)).sort((a, b) => a - b);

  return {
    citations,
    uniqueCitations,
    citationCount: citations.length,
    maxIndex: citations.length > 0 ? Math.max(...citations) : 0,
    sourceCount,
    outOfRangeCount: citations.filter((n) => n < 1 || n > sourceCount).length,
  };
};

export default scanCitations;

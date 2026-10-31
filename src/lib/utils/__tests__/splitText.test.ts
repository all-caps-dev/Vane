// TypeScript: unit tests for splitText and getTokenCount (src/lib/utils/splitText.ts).
import { describe, expect, it } from 'vitest';
import { getTokenCount, splitText } from '@/lib/utils/splitText';

// 200 short sentences. Words only (no digits before ". "), so each sentence
// is exactly one segment for the split regex.
const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const sentences = Array.from(
  { length: 200 },
  (_, i) => `The ${words[i % words.length]} sentence is here. `,
);
const longText = sentences.join('');

describe('splitText', () => {
  it('returns no chunks for empty input', () => {
    expect(splitText('')).toEqual([]);
  });

  it('returns the text as a single chunk when it fits', () => {
    const text = 'One short sentence. Another one.';
    expect(splitText(text, 512, 64)).toEqual([text]);
  });

  it('keeps every chunk within maxTokens plus overlapTokens', () => {
    const maxTokens = 50;
    const overlapTokens = 10;
    const chunks = splitText(longText, maxTokens, overlapTokens);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(getTokenCount(chunk)).toBeLessThanOrEqual(
        maxTokens + overlapTokens,
      );
    }
  });

  it('starts each later chunk with the tail of the previous chunk', () => {
    const chunks = splitText(longText, 50, 10);

    for (let i = 1; i < chunks.length; i++) {
      const previousSentences = chunks[i - 1].split(/(?<=\. )/);
      const lastSentence = previousSentences[previousSentences.length - 1];
      expect(chunks[i].startsWith(lastSentence)).toBe(true);
    }
  });

  it('reconstructs the input exactly when overlap is 0', () => {
    const chunks = splitText(longText, 50, 0);
    expect(chunks.join('')).toBe(longText);
  });
});

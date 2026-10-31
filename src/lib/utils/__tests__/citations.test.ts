// TypeScript: unit tests for scanCitations (src/lib/utils/citations.ts).
import { describe, expect, it } from 'vitest';
import { scanCitations } from '@/lib/utils/citations';

describe('scanCitations', () => {
  it('finds adjacent markers like [1][2]', () => {
    const stats = scanCitations('Paris is the capital [1][2].', 3);
    expect(stats.citations).toEqual([1, 2]);
    expect(stats.citationCount).toBe(2);
    expect(stats.maxIndex).toBe(2);
    expect(stats.outOfRangeCount).toBe(0);
  });

  it('reads multi-digit markers like [12]', () => {
    const stats = scanCitations('See the table [12].', 12);
    expect(stats.citations).toEqual([12]);
    expect(stats.maxIndex).toBe(12);
    expect(stats.outOfRangeCount).toBe(0);
  });

  it('handles an answer with no citations', () => {
    const stats = scanCitations('No sources were used here.', 5);
    expect(stats.citations).toEqual([]);
    expect(stats.citationCount).toBe(0);
    expect(stats.maxIndex).toBe(0);
    expect(stats.outOfRangeCount).toBe(0);
    expect(stats.sourceCount).toBe(5);
  });

  it('counts markers above sourceCount and [0] as out of range', () => {
    const stats = scanCitations('A [1]. B [4]. C [0]. D [4].', 3);
    expect(stats.outOfRangeCount).toBe(3);
    expect(stats.uniqueCitations).toEqual([0, 1, 4]);
  });

  it('treats every marker as out of range when there are no sources', () => {
    expect(scanCitations('Claim [1].', 0).outOfRangeCount).toBe(1);
  });

  it('splits grouped markers like [1, 3]', () => {
    expect(scanCitations('Both agree [1, 3].', 3).citations).toEqual([1, 3]);
  });

  it('ignores markdown links and non-numeric brackets', () => {
    const stats = scanCitations('[link](http://x.test) and [a] and [ 2 ]', 5);
    expect(stats.citations).toEqual([]);
  });
});

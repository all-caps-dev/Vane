// TypeScript: unit tests for sanitizeCitations (src/lib/utils/sanitizeCitations.ts).
import { describe, expect, it } from 'vitest';
import { sanitizeCitations } from '@/lib/utils/sanitizeCitations';

describe('sanitizeCitations', () => {
  it('leaves valid markers alone and returns the same text', () => {
    const answer = 'A fact [1]. Another [2][3].';
    expect(sanitizeCitations(answer, 3)).toEqual({ text: answer, removed: [] });
  });

  it('removes markers past sourceCount and below 1', () => {
    expect(sanitizeCitations('A fact [1]. Made up [9]. Zero [0].', 2)).toEqual({
      text: 'A fact [1]. Made up. Zero.',
      removed: [9, 0],
    });
  });

  it('keeps the valid parts of a grouped marker', () => {
    expect(sanitizeCitations('Both [1, 7] say so.', 2)).toEqual({
      text: 'Both [1] say so.',
      removed: [7],
    });
    expect(sanitizeCitations('None [5, 6] here.', 2)).toEqual({
      text: 'None here.',
      removed: [5, 6],
    });
  });

  it('collapses the spaces a removed marker leaves', () => {
    expect(sanitizeCitations('word [9] next', 1).text).toBe('word next');
    expect(sanitizeCitations('word [1][9][10].', 1).text).toBe('word [1].');
    expect(sanitizeCitations('word [9]\nnext', 1).text).toBe('word\nnext');
    expect(sanitizeCitations('[9] Starts a line', 1).text).toBe(
      'Starts a line',
    );
  });

  it('never touches fenced code blocks or inline code', () => {
    const answer =
      'Claim [9].\n\n```js\nconst x = arr[9];\n```\n\nUse `a[5]` here [1].';
    expect(sanitizeCitations(answer, 1)).toEqual({
      text: 'Claim.\n\n```js\nconst x = arr[9];\n```\n\nUse `a[5]` here [1].',
      removed: [9],
    });
  });

  it('never touches markdown links', () => {
    const answer = 'See [3](https://example.com) and [9].';
    expect(sanitizeCitations(answer, 1)).toEqual({
      text: 'See [3](https://example.com) and.',
      removed: [9],
    });
  });

  it('removes every marker when there are no sources', () => {
    expect(sanitizeCitations('No search was made [1].', 0)).toEqual({
      text: 'No search was made.',
      removed: [1],
    });
  });

  it('handles empty input', () => {
    expect(sanitizeCitations('', 3)).toEqual({ text: '', removed: [] });
  });
  // Cases raised by the upstream review bot on ItzCrazyKns/Vane#1227.
  it('protects inline code with more than one backtick', () => {
    const answer = 'Use ``a[9] ` b`` here [9].';
    expect(sanitizeCitations(answer, 1)).toEqual({
      text: 'Use ``a[9] ` b`` here.',
      removed: [9],
    });
  });

  it('does not close a fence at a ``` inside a code line', () => {
    const answer = '```md\nx ``` arr[9]\ny[8]\n```\nAfter [9].';
    expect(sanitizeCitations(answer, 1)).toEqual({
      text: '```md\nx ``` arr[9]\ny[8]\n```\nAfter.',
      removed: [9],
    });
  });

  it('honours longer fences and tilde fences', () => {
    const answer = '````\n```\na[9]\n```\n````\n~~~\nb[9]\n~~~\nEnd [9].';
    expect(sanitizeCitations(answer, 1).text).toBe(
      '````\n```\na[9]\n```\n````\n~~~\nb[9]\n~~~\nEnd.',
    );
  });

  it('leaves link destinations and link text alone', () => {
    const answer = 'See [the [9] page](https://x.test/a[9]b) and [9].';
    expect(sanitizeCitations(answer, 1)).toEqual({
      text: 'See [the [9] page](https://x.test/a[9]b) and.',
      removed: [9],
    });
  });

  it('leaves reference links whose label is defined', () => {
    const answer =
      'Read [the docs][12] or [12]. Fake [9].\n\n[12]: https://x.test';
    expect(sanitizeCitations(answer, 1)).toEqual({
      text: 'Read [the docs][12] or [12]. Fake.\n\n[12]: https://x.test',
      removed: [9],
    });
  });
});

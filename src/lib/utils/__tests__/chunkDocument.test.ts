// TypeScript: unit tests for section-aware chunking in src/lib/utils/chunkDocument.ts.
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { chunkDocument, chunkText } from '@/lib/utils/chunkDocument';
import { getTokenCount } from '@/lib/utils/splitText';

// Wraps body HTML in a page Readability will accept as an article.
const doc = (body: string) =>
  `<html><head><title>Test page</title></head><body><article>${body}</article></body></html>`;

const filler = (topic: string, n = 8) =>
  `<p>${`This paragraph talks about ${topic} in some detail. `.repeat(n)}</p>`;

describe('chunkDocument', () => {
  it('gives each chunk its heading path and a heading line', () => {
    const chunks = chunkDocument(
      doc(
        `<h2>Install</h2>${filler('installing')}<h3>Linux</h3>${filler('linux')}<h2>Usage</h2>${filler('usage')}`,
      ),
    );
    const paths = chunks.map((c) => c.headingPath);
    expect(paths).toContainEqual(['Install']);
    expect(paths).toContainEqual(['Install', 'Linux']);
    expect(paths).toContainEqual(['Usage']);

    const linux = chunks.find((c) => c.headingPath.join() === 'Install,Linux');
    expect(linux?.text.split('\n')[0]).toBe('Install > Linux');
    expect(linux?.text).toContain('linux');
    // A chunk never crosses into the next section.
    expect(linux?.text).not.toContain('usage');
  });

  it('keeps headings wrapped with an edit link (Wikipedia style)', () => {
    const wrapped = (title: string) =>
      `<div class="mw-heading mw-heading2"><h2 id="${title}">${title}</h2><span class="mw-editsection">[<a href="/edit">edit</a>]</span></div>`;
    const chunks = chunkDocument(
      doc(
        `${filler('the lede')}${wrapped('Demographics')}${filler('population')}${wrapped('Economy')}${filler('companies')}`,
      ),
    );
    const population = chunks.find((c) => c.text.includes('population'));
    expect(population?.headingPath).toEqual(['Demographics']);
    const economy = chunks.find((c) => c.text.includes('companies'));
    expect(economy?.headingPath).toEqual(['Economy']);
  });

  it('keeps a code block whole and verbatim, even when it is long', () => {
    const code = Array.from(
      { length: 120 },
      (_, i) => `  const value${i} = compute(${i});`,
    ).join('\n');
    const chunks = chunkDocument(
      doc(
        `<h2>Code</h2>${filler('code')}<pre><code>${code}</code></pre>${filler('after')}`,
      ),
      { maxTokens: 200 },
    );
    const holding = chunks.filter((c) => c.text.includes('value0 ='));
    expect(holding).toHaveLength(1);
    expect(holding[0].text).toContain(code);
  });

  it('renders a table row by row and keeps it in one chunk', () => {
    const rows = Array.from(
      { length: 6 },
      (_, i) => `<tr><td>Model ${i}</td><td>${i}.5 kg</td></tr>`,
    ).join('');
    const chunks = chunkDocument(
      doc(
        `<h2>Specs</h2>${filler('specs', 4)}<table><thead><tr><th>Model</th><th>Weight</th></tr></thead><tbody>${rows}</tbody></table>${filler('more specs', 4)}`,
      ),
      { maxTokens: 120 },
    );
    const holding = chunks.filter((c) => c.text.includes('Model | Weight'));
    expect(holding).toHaveLength(1);
    for (let i = 0; i < 6; i++) {
      expect(holding[0].text).toContain(`Model ${i} | ${i}.5 kg`);
    }
  });

  it('keeps list bullets', () => {
    const chunks = chunkDocument(
      doc(
        `<h2>List</h2>${filler('lists', 4)}<ul><li>First item here</li><li>Second item here</li></ul>`,
      ),
    );
    const text = chunks.map((c) => c.text).join('\n');
    expect(text).toContain('- First item here\n- Second item here');
  });

  it('splits a paragraph longer than the budget on sentence ends', () => {
    const sentences = Array.from(
      { length: 60 },
      (_, i) => `Sentence number ${i} carries a few words.`,
    );
    const chunks = chunkDocument(
      doc(`<h2>Long</h2><p>${sentences.join(' ')}</p>`),
      { maxTokens: 80 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(getTokenCount(c.text)).toBeLessThanOrEqual(80);
      // Every chunk body ends at a sentence end, never mid-sentence.
      expect(c.text.trim().endsWith('.')).toBe(true);
    }
    const all = chunks.map((c) => c.text).join(' ');
    sentences.forEach((s) => expect(all).toContain(s));
  });

  it('overlaps consecutive chunks of a section by one block', () => {
    const paragraphs = Array.from(
      { length: 6 },
      (_, i) => `<p>${`Block ${i} words go here. `.repeat(6)}</p>`,
    ).join('');
    const chunks = chunkDocument(doc(`<h2>Overlap</h2>${paragraphs}`), {
      maxTokens: 90,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // The last block of one chunk is the first block of the next.
    const lastBlock = chunks[0].text.split('\n\n').pop()!;
    expect(chunks[1].text).toContain(lastBlock);
  });

  it('chunks pre-extracted article HTML the same as the full page', () => {
    const page = doc(
      `<h2>Install</h2>${filler('installing')}<h3>Linux</h3>${filler('linux')}<pre>npm   install</pre>`,
    );
    // What Scraper.scrape returns as articleHtml.
    const articleHtml = new Readability(
      new JSDOM(page).window.document,
    ).parse()!.content!;

    const fromPage = chunkDocument(page);
    expect(fromPage.length).toBeGreaterThan(0);
    expect(chunkDocument(page, { articleHtml })).toEqual(fromPage);
    // The page html is not needed when the article is given.
    expect(chunkDocument('', { articleHtml })).toEqual(fromPage);
  });

  it('falls back to the page when the given article HTML is empty', () => {
    const page = doc(`<h2>Usage</h2>${filler('usage')}`);
    expect(chunkDocument(page, { articleHtml: '<div> </div>' })).toEqual(
      chunkDocument(page),
    );
  });

  it('returns [] for empty input', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('   ')).toEqual([]);
    expect(chunkDocument('<html><body></body></html>')).toEqual([]);
    expect(chunkText('')).toEqual([]);
  });
});

describe('chunkText', () => {
  it('uses markdown headings, keeps fenced code and bullets', () => {
    const chunks = chunkText(
      '# Guide\n\nIntro text.\n\n## Setup\n- step one\n- step two\n\n```\nnpm   install\n```\n',
    );
    expect(chunks[0]).toEqual({
      headingPath: ['Guide'],
      text: 'Guide\nIntro text.',
    });
    expect(chunks[1].headingPath).toEqual(['Guide', 'Setup']);
    expect(chunks[1].text).toContain('- step one\n- step two');
    expect(chunks[1].text).toContain('```\nnpm   install\n```');
  });
});

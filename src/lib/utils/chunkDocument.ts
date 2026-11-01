// TypeScript: section-aware chunking of a fetched page (HTML) or plain text into passages for the reranker.

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { getTokenCount } from './splitText';

export type DocumentChunk = { headingPath: string[]; text: string };

/* One unit of content found in the page. Blocks are packed into chunks and
   are never cut, except a single text block bigger than the budget. */
type Block = {
  text: string;
  headingPath: string[];
  // 'code' blocks are never split; 'table' blocks split by rows only if
  // the table alone is bigger than the budget; 'text' splits on sentences.
  kind: 'text' | 'code' | 'table';
};

export const DEFAULT_MAX_TOKENS = 350;

// Elements whose text flows inside a paragraph rather than starting a block.
const INLINE_TAGS = new Set([
  'A',
  'ABBR',
  'B',
  'BDI',
  'BDO',
  'CITE',
  'CODE',
  'DATA',
  'DFN',
  'EM',
  'I',
  'KBD',
  'MARK',
  'Q',
  'S',
  'SAMP',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TIME',
  'U',
  'VAR',
]);

// Elements that never carry readable text.
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'SVG',
  'BUTTON',
  'FORM',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'IFRAME',
  'IMG',
]);

// Collapses runs of whitespace the way a browser would display them.
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

// Renders a table as one "cell | cell" line per row.
const tableRows = (table: Element): string[] =>
  Array.from(table.querySelectorAll('tr'))
    .map((tr) =>
      Array.from(tr.children)
        .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
        .map((c) => collapse(c.textContent ?? ''))
        .join(' | '),
    )
    .filter((row) => row.replace(/[|\s]/g, '') !== '');

/*
  Walks the article and returns its blocks in reading order. h1-h6 update
  the heading path; p, li, pre, table and blockquote become blocks; loose
  text inside container elements (div, section) becomes a paragraph block.
*/
const extractBlocks = (root: Element): Block[] => {
  const blocks: Block[] = [];
  // The open headings, outermost first, with their levels.
  const headings: { level: number; text: string }[] = [];
  const currentPath = () => headings.map((h) => h.text);
  let inlineBuffer = '';

  const push = (text: string, kind: Block['kind']) => {
    if (kind === 'code' ? text.trim() === '' : collapse(text) === '') return;
    blocks.push({ text, headingPath: currentPath(), kind });
  };

  const flushInline = () => {
    const text = collapse(inlineBuffer);
    inlineBuffer = '';
    if (text) push(text, 'text');
  };

  const walk = (node: Element) => {
    for (const child of Array.from(node.childNodes)) {
      // Text node (nodeType 3): part of the running paragraph.
      if (child.nodeType === 3) {
        inlineBuffer += child.textContent ?? '';
        continue;
      }
      if (child.nodeType !== 1) continue;

      const el = child as Element;
      const tag = el.tagName.toUpperCase();

      if (SKIP_TAGS.has(tag)) continue;

      if (tag === 'BR') {
        inlineBuffer += ' ';
        continue;
      }

      if (INLINE_TAGS.has(tag)) {
        inlineBuffer += el.textContent ?? '';
        continue;
      }

      // Everything below starts a new block, so close the running paragraph.
      flushInline();

      const heading = /^H([1-6])$/.exec(tag);
      if (heading) {
        const level = Number(heading[1]);
        const text = collapse(el.textContent ?? '');
        if (!text) continue;
        // Close headings at the same or a deeper level, then open this one.
        while (headings.length && headings[headings.length - 1].level >= level)
          headings.pop();
        headings.push({ level, text });
        continue;
      }

      if (tag === 'PRE') {
        // Verbatim: no whitespace collapsing inside code.
        push((el.textContent ?? '').replace(/^\n+|\s+$/g, ''), 'code');
        continue;
      }

      if (tag === 'TABLE') {
        push(tableRows(el).join('\n'), 'table');
        continue;
      }

      if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'FIGCAPTION') {
        const text = collapse(el.textContent ?? '');
        push(tag === 'BLOCKQUOTE' ? `> ${text}` : text, 'text');
        continue;
      }

      if (tag === 'LI') {
        // The item's own text; nested lists become their own bullets.
        const own = el.cloneNode(true) as Element;
        own.querySelectorAll('ul, ol, pre, table').forEach((n) => n.remove());
        const text = collapse(own.textContent ?? '');
        if (text) push(`- ${text}`, 'text');
        el.querySelectorAll(
          ':scope > ul, :scope > ol, :scope > pre, :scope > table',
        ).forEach((nested) => {
          const wrapper = el.ownerDocument.createElement('div');
          wrapper.appendChild(nested.cloneNode(true));
          walk(wrapper);
        });
        continue;
      }

      // A container (div, section, ul, ol, article...): look inside.
      walk(el);
      flushInline();
    }
  };

  walk(root);
  flushInline();
  return blocks;
};

// Splits text into sentences, keeping the end punctuation.
const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

// Packs small pieces into strings of at most maxTokens, joined by `sep`.
// A piece that alone is too big is cut on word boundaries.
const packPieces = (
  pieces: string[],
  maxTokens: number,
  sep: string,
): string[] => {
  const out: string[] = [];
  let current = '';

  const add = (piece: string) => {
    const candidate = current ? current + sep + piece : piece;
    if (!current || getTokenCount(candidate) <= maxTokens) {
      current = candidate;
    } else {
      out.push(current);
      current = piece;
    }
  };

  for (const piece of pieces) {
    if (getTokenCount(piece) <= maxTokens) {
      add(piece);
      continue;
    }
    // One sentence (or row) longer than the budget: cut it on word
    // boundaries (joined by spaces), then add the parts. A single "word"
    // with no spaces at all is kept whole.
    const words = piece.split(/\s+/).filter(Boolean);
    if (words.length <= 1) {
      add(piece);
      continue;
    }
    for (const part of packPieces(words, maxTokens, ' ')) {
      if (current) out.push(current);
      current = part;
    }
  }

  if (current) out.push(current);
  return out;
};

// Breaks blocks that are bigger than the budget into pieces that fit.
// Code blocks are never broken.
const splitOversized = (block: Block, maxTokens: number): Block[] => {
  if (block.kind === 'code' || getTokenCount(block.text) <= maxTokens)
    return [block];

  if (block.kind === 'table') {
    // Split by rows; repeat the first row (usually the header) in each part.
    const rows = block.text.split('\n');
    const header = rows[0];
    const body = rows.slice(1);
    const headerTokens = getTokenCount(header) + 1;
    const parts = packPieces(body, Math.max(maxTokens - headerTokens, 1), '\n');
    return parts.map((p) => ({ ...block, text: `${header}\n${p}` }));
  }

  return packPieces(sentences(block.text), maxTokens, ' ').map((text) => ({
    ...block,
    text,
  }));
};

// Joins blocks with a blank line, but keeps consecutive bullets together.
const joinParts = (parts: Block[]): string =>
  parts
    .map((p, i) =>
      i === 0
        ? p.text
        : (p.text.startsWith('- ') && parts[i - 1].text.startsWith('- ')
            ? '\n'
            : '\n\n') + p.text,
    )
    .join('');

// Two heading paths are the same section when every heading matches.
const samePath = (a: string[], b: string[]) =>
  a.length === b.length && a.every((h, i) => h === b[i]);

/*
  Packs blocks into chunks of at most maxTokens. A chunk never crosses a
  section boundary. Consecutive chunks of a section share one block of
  overlap when it fits. Each chunk's text starts with "A > B" (its heading
  path) on the first line when there is a heading.
*/
const packBlocks = (blocks: Block[], maxTokens: number): DocumentChunk[] => {
  const chunks: DocumentChunk[] = [];

  // Group consecutive blocks with the same heading path into sections.
  const sections: Block[][] = [];
  for (const block of blocks) {
    const last = sections[sections.length - 1];
    if (last && samePath(last[0].headingPath, block.headingPath))
      last.push(block);
    else sections.push([block]);
  }

  for (const section of sections) {
    const headingPath = section[0].headingPath;
    const prefix = headingPath.length ? headingPath.join(' > ') + '\n' : '';
    // The heading line counts against the budget, but always leave room.
    const budget = Math.max(
      maxTokens - getTokenCount(prefix),
      Math.floor(maxTokens / 2),
    );

    const parts = section.flatMap((b) => splitOversized(b, budget));
    const tokens = parts.map((p) => getTokenCount(p.text));

    let start = 0;
    while (start < parts.length) {
      // Always take at least one block, then add while the budget allows.
      let end = start + 1;
      let used = tokens[start];
      while (end < parts.length && used + tokens[end] <= budget) {
        used += tokens[end];
        end++;
      }

      chunks.push({
        headingPath,
        text: prefix + joinParts(parts.slice(start, end)),
      });

      if (end >= parts.length) break;

      // One block of overlap, but only a text block (a table or code block
      // stays in exactly one chunk), and only when it leaves room to move
      // forward (the overlapped block plus the next block must fit).
      const canOverlap =
        end - 1 > start &&
        parts[end - 1].kind === 'text' &&
        tokens[end - 1] + tokens[end] <= budget;
      start = canOverlap ? end - 1 : end;
    }
  }

  return chunks;
};

/*
  Readability removes small wrapper divs that hold only a heading and an
  "[edit]" link (Wikipedia's div.mw-heading, and similar on other wikis),
  and the heading is lost with them. Lift such a heading out of its wrapper
  first so the section structure survives.
*/
export const liftWrappedHeadings = (document: Document) => {
  document.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    const parent = heading.parentElement;
    if (!parent || !['DIV', 'HEADER', 'HGROUP'].includes(parent.tagName))
      return;
    // Only when the wrapper adds a few characters at most (an edit link).
    const extra =
      collapse(parent.textContent ?? '').length -
      collapse(heading.textContent ?? '').length;
    if (extra > 40) return;
    parent.replaceWith(heading);
  });
};

/*
  Chunks an HTML page. Readability picks the article; its `content` (HTML,
  not textContent) is walked so headings, code and tables keep their shape.
  When Readability finds nothing, the page body is used instead.

  opts.articleHtml: Readability's article HTML that the caller already has
  (Scraper.scrape returns it). When given and it holds text, the page is not
  parsed and Readability does not run again; only the small article is
  parsed. Without it (or when it is empty) `html` is handled as before.
*/
export const chunkDocument = (
  html: string,
  opts: { url?: string; maxTokens?: number; articleHtml?: string } = {},
): DocumentChunk[] => {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  let root: Element | null = null;

  // Fast path: the article was already extracted by the scraper.
  if (opts.articleHtml && opts.articleHtml.trim()) {
    try {
      const articleDom = new JSDOM(`<body>${opts.articleHtml}</body>`);
      const body = articleDom.window.document.body;
      if (collapse(body.textContent ?? '')) root = body;
    } catch {
      root = null;
    }
    if (root) return packBlocks(extractBlocks(root), maxTokens);
  }

  if (!html || !html.trim()) return [];

  try {
    const page = new JSDOM(html, opts.url ? { url: opts.url } : undefined);
    liftWrappedHeadings(page.window.document);
    const article = new Readability(page.window.document).parse();

    if (article?.content && collapse(article.textContent ?? '')) {
      // Parse the article HTML on its own so we walk only the article.
      const articleDom = new JSDOM(`<body>${article.content}</body>`);
      root = articleDom.window.document.body;
    } else {
      // Readability mutates the document, so parse the page again.
      root = new JSDOM(html).window.document.body;
      root
        .querySelectorAll('nav, header, footer, aside')
        .forEach((n) => n.remove());
    }
  } catch {
    return [];
  }

  if (!root) return [];
  return packBlocks(extractBlocks(root), maxTokens);
};

/*
  Chunks plain text (uploads, text/plain pages). Paragraphs are split on
  blank lines; a markdown heading line ("## Title") opens a new section;
  lines starting with "- " or "* " stay as bullets.
*/
export const chunkText = (
  text: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
): DocumentChunk[] => {
  if (!text || !text.trim()) return [];

  const blocks: Block[] = [];
  const headings: { level: number; text: string }[] = [];
  let paragraph: string[] = [];
  let inFence = false;
  let fence: string[] = [];

  const flush = () => {
    const joined = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    paragraph = [];
    if (joined)
      blocks.push({
        text: joined,
        headingPath: headings.map((h) => h.text),
        kind: 'text',
      });
  };

  for (const line of text.split(/\r?\n/)) {
    // ``` fences: keep the code verbatim as one block.
    if (/^\s*```/.test(line)) {
      if (inFence) {
        fence.push(line);
        blocks.push({
          text: fence.join('\n'),
          headingPath: headings.map((h) => h.text),
          kind: 'code',
        });
        fence = [];
        inFence = false;
      } else {
        flush();
        inFence = true;
        fence = [line];
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      while (headings.length && headings[headings.length - 1].level >= level)
        headings.pop();
      headings.push({ level, text: heading[2] });
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    // A bullet starts its own block so lists keep one item per line.
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      paragraph.push(`- ${line.replace(/^\s*[-*]\s+/, '')}`);
      flush();
      continue;
    }

    paragraph.push(line);
  }

  // An unclosed fence is still code.
  if (inFence && fence.length)
    blocks.push({
      text: fence.join('\n'),
      headingPath: headings.map((h) => h.text),
      kind: 'code',
    });
  flush();

  return packBlocks(blocks, maxTokens);
};

// TypeScript: unit tests for the researcher's compact digest and user message (M3).
import { describe, expect, it } from 'vitest';
import {
  buildResearcherUserMessage,
  formatResearchDigest,
} from '@/lib/agents/search/researcher/context';
import type { SourceGroup } from '@/lib/evidence';

const passage = (content: string, meta: Record<string, any> = {}) => ({
  content,
  metadata: { extraction: 'ok', ...meta },
});

describe('formatResearchDigest', () => {
  it('writes one line per source and a count line', () => {
    const groups: SourceGroup[] = [
      {
        index: 2,
        sourceId: 'sa',
        url: 'https://www.w3.org/TR/WCAG22/',
        title: 'WCAG 2.2',
        kind: 'full_page',
        passages: [
          passage('low score text', { score: 0.1 }),
          passage('New in 2.2 > Focus\nFocus Not Obscured is new.', {
            score: 0.9,
          }),
        ],
      },
      {
        index: 5,
        sourceId: 'sb',
        url: 'https://example.com/x',
        title: 'Snippet\nsource',
        kind: 'search_snippet',
        passages: [passage('x'.repeat(300))],
      },
    ];

    const lines = formatResearchDigest(groups).split('\n');
    expect(lines).toHaveLength(3);
    // The best-scoring passage is shown, flattened to one line.
    expect(lines[0]).toBe(
      '[2] WCAG 2.2 (w3.org) kind=full_page extraction=ok: New in 2.2 > Focus Focus Not Obscured is new.',
    );
    expect(lines[1]).toMatch(
      /^\[5\] Snippet source \(example\.com\) kind=search_snippet extraction=ok: x{200}…$/,
    );
    expect(lines[2]).toBe('selected 3 passages from 2 sources');
  });

  it('handles uploads and chunks without extraction', () => {
    const out = formatResearchDigest([
      {
        index: 1,
        sourceId: 'sc',
        url: 'file_id://abc',
        title: 'notes.pdf',
        kind: 'upload',
        passages: [{ content: 'hello', metadata: {} }],
      },
    ]);
    expect(out).toBe(
      '[1] notes.pdf (upload) kind=upload extraction=n/a: hello\nselected 1 passage from 1 source',
    );
  });
});

describe('buildResearcherUserMessage', () => {
  it('carries freshness, intent, entities and the queries already run', () => {
    const msg = buildResearcherUserMessage({
      chatHistory: [],
      followUp: 'what about the older version?',
      classification: {
        classification: {
          skipSearch: false,
          personalSearch: false,
          academicSearch: false,
          discussionSearch: false,
          showWeatherWidget: false,
          showStockWidget: false,
          showCalculationWidget: false,
          freshness: 'recent',
          entities: ['Proxmox VE 8'],
          intent: 'fact',
        },
        standaloneFollowUp: 'What changed in Proxmox VE 8?',
      },
      queriesRun: ['Proxmox VE 8 release notes'],
    });
    expect(msg).toContain('Standalone question: What changed in Proxmox VE 8?');
    expect(msg).toContain('Freshness: recent');
    expect(msg).toContain('Intent: fact');
    expect(msg).toContain('Entities to keep verbatim: "Proxmox VE 8"');
    expect(msg).toContain('Queries already run:\n- Proxmox VE 8 release notes');
  });
});

// TypeScript: unit tests for the search started while the classifier answers (Fleet #346 item 1).
import { describe, expect, it, vi } from 'vitest';

// The real SearXNG client reads the config file; the tests pass a fake search.
vi.mock('@/lib/searxng', () => ({
  searchSearxng: vi.fn(async () => ({ results: [], suggestions: [] })),
}));
import {
  maybeStartPrefetch,
  Prefetch,
  prefetchDecision,
  shouldPrefetch,
} from '@/lib/agents/search/prefetch';
import { Tracer } from '@/lib/trace';

const web = ['web'] as const;

describe('shouldPrefetch', () => {
  it.each([
    'What are the new features in Proxmox VE 12?',
    'Is Bun faster than Node for HTTP servers',
    'summarize the history of the Roman empire',
    'how do I reset a UniFi U7 Pro',
  ])('prefetches a searchable question: %s', (q) => {
    expect(shouldPrefetch(q, [], [...web])).toBe(true);
  });

  it('needs web as an enabled source', () => {
    const q = 'What are the new features in Proxmox VE 12?';
    expect(shouldPrefetch(q, [], [])).toBe(false);
    expect(shouldPrefetch(q, [], ['academic', 'discussions'])).toBe(false);
  });

  it.each(['WCAG 2.2 changes', 'hello', '  what is  rust  ', ''])(
    'skips fewer than 4 words: %j',
    (q) => {
      expect(shouldPrefetch(q, [], [...web])).toBe(false);
    },
  );

  it.each([
    'hi there, how are you today?',
    'Hello! Can you help me with something',
    'thanks, that was really helpful',
    'Thank you so much for that',
    'good morning, what is new today',
  ])('skips greetings and thanks: %s', (q) => {
    expect(shouldPrefetch(q, [], [...web])).toBe(false);
  });

  it.each([
    'Tell me about the Treaty of Westphalia from memory',
    'answer without searching: what is a monad',
    "don't search, just explain what a monad is",
    'Don’t search the web for this one please',
    'do not search, explain closures in JavaScript',
  ])('skips requests not to search: %s', (q) => {
    expect(shouldPrefetch(q, [], [...web])).toBe(false);
  });

  it.each([
    'rewrite this paragraph to sound friendlier',
    'Translate "good night" into Japanese please',
    'summarize this article for me please',
    'Please rephrase the following sentence for clarity',
    'proofread my cover letter below',
  ])('skips rewriting requests: %s', (q) => {
    expect(shouldPrefetch(q, [], [...web])).toBe(false);
  });
});

describe('prefetchDecision', () => {
  const raw = 'What is new in Proxmox VE 12?';

  it('replaces a planned query equal to the raw question', () => {
    expect(prefetchDecision(raw, [raw])).toEqual({ mode: 'replace', index: 0 });
    // queryKey: case and spacing do not matter, and any position counts.
    expect(
      prefetchDecision(raw, [
        'Proxmox VE 12 notes',
        ' what is NEW in  proxmox ve 12? ',
      ]),
    ).toEqual({ mode: 'replace', index: 1 });
  });

  it('merges as an extra query when no planned query matches', () => {
    expect(prefetchDecision(raw, ['Proxmox VE 12 new features'])).toEqual({
      mode: 'extra',
    });
    expect(prefetchDecision(raw, [])).toEqual({ mode: 'extra' });
  });

  it('merges as an extra query when the search narrows by time', () => {
    // The planned time-ranged query still runs; the prefetch is added.
    expect(prefetchDecision(raw, [raw], { time_range: 'month' })).toEqual({
      mode: 'extra',
    });
    expect(prefetchDecision(raw, [raw], { time_range: undefined })).toEqual({
      mode: 'replace',
      index: 0,
    });
  });
});

describe('Prefetch', () => {
  const response = {
    results: [{ title: 'A', url: 'https://a.test/' }],
    suggestions: [],
  };

  const setup = (search = vi.fn(async () => response)) => {
    const trace = new Tracer('on');
    const events = vi.spyOn(trace, 'event');
    const prefetch = new Prefetch(
      'What is new in Proxmox VE 12?',
      trace,
      search,
    );
    const prefetchEvents = () =>
      events.mock.calls
        .filter(([name]) => name === 'prefetch')
        .map(([, data]) => data as Record<string, unknown>);
    return { prefetch, search, prefetchEvents };
  };

  it('replaces a matching query, once', async () => {
    const { prefetch, search, prefetchEvents } = setup();
    const claim = prefetch.claim(['what is new in proxmox ve 12?']);
    expect(claim).toMatchObject({ mode: 'replace', index: 0 });
    await expect(claim!.result).resolves.toBe(response);
    // A second web_search never gets it.
    expect(prefetch.claim(['what is new in proxmox ve 12?'])).toBeNull();
    expect(search).toHaveBeenCalledTimes(1);

    expect(prefetchEvents().map((e) => e.status)).toEqual([
      'started',
      'reused_as_replacement',
    ]);
    expect(
      prefetchEvents()[1].savedMsEstimate as number,
    ).toBeGreaterThanOrEqual(0);
  });

  it('is merged as an extra query when nothing matches', async () => {
    const { prefetch, prefetchEvents } = setup();
    const claim = prefetch.claim(['Proxmox VE 12 features']);
    expect(claim).toMatchObject({
      mode: 'extra',
      query: 'What is new in Proxmox VE 12?',
    });
    await expect(claim!.result).resolves.toBe(response);
    // Already used: research ending later records nothing more.
    prefetch.discard('no_web_search');
    expect(prefetchEvents().map((e) => e.status)).toEqual([
      'started',
      'reused_as_extra',
    ]);
  });

  it('is discarded when the classifier skips search', () => {
    const { prefetch, prefetchEvents } = setup();
    prefetch.discard('skip_search');
    expect(prefetch.isDecided).toBe(true);
    expect(prefetch.claim(['anything'])).toBeNull();
    expect(prefetchEvents()[1]).toMatchObject({
      status: 'discarded',
      reason: 'skip_search',
    });
  });

  it('is discarded when no web_search ran', () => {
    const { prefetch, prefetchEvents } = setup();
    prefetch.discard('no_web_search');
    expect(prefetchEvents()[1]).toMatchObject({
      status: 'discarded',
      reason: 'no_web_search',
    });
  });

  it('resolves to null when the prefetched query failed, without throwing', async () => {
    const { prefetch, prefetchEvents } = setup(
      vi.fn(async () => {
        throw new Error('SearXNG search timed out');
      }),
    );
    const claim = prefetch.claim(['Proxmox VE 12 features']);
    await expect(claim!.result).resolves.toBeNull();
    expect(prefetchEvents().at(-1)).toMatchObject({
      status: 'discarded',
      reason: 'failed',
    });
  });
});

describe('maybeStartPrefetch', () => {
  const base = {
    followUp: 'What are the new features in Proxmox VE 12?',
    history: [],
    sources: ['web'] as ('web' | 'academic' | 'discussions')[],
    trace: new Tracer('off'),
  };

  it('starts nothing when the switch is off', () => {
    expect(maybeStartPrefetch({ ...base, enabled: false })).toBeUndefined();
  });

  it('starts nothing for a greeting', () => {
    expect(
      maybeStartPrefetch({
        ...base,
        enabled: true,
        followUp: 'hi there friend!',
      }),
    ).toBeUndefined();
  });

  it('starts a prefetch for the raw question', () => {
    const p = maybeStartPrefetch({ ...base, enabled: true });
    expect(p).toBeInstanceOf(Prefetch);
    expect(p?.query).toBe(base.followUp);
    p?.discard('skip_search');
  });
});

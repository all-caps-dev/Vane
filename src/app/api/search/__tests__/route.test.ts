// TypeScript: unit tests for /api/search (src/app/api/search/route.ts). Models and the search agent are mocked.
import { describe, expect, it, vi } from 'vitest';

// What the fake agent does: 'error' emits an error event, 'ok' answers.
const agentMode = vi.hoisted(() => ({ value: 'error' as 'error' | 'ok' }));

vi.mock('@/lib/models/registry', () => ({
  default: class {
    loadChatModel = async () => ({});
    loadEmbeddingModel = async () => ({});
  },
}));

vi.mock('@/lib/agents/search/api', () => ({
  default: class {
    async searchAsync(session: any) {
      // Let the route subscribe first, as with a real search.
      await new Promise((r) => setTimeout(r, 0));
      if (agentMode.value === 'error') {
        session.emit('error', { data: 'model server unreachable' });
        throw new Error('model server unreachable');
      }
      session.emit('data', { type: 'response', data: 'Answer [1].' });
      session.emit('end', {});
    }
  },
}));

import { POST } from '@/app/api/search/route';

const request = (body: Record<string, unknown>) =>
  new Request('http://localhost/api/search', {
    method: 'POST',
    body: JSON.stringify({
      sources: ['web'],
      query: 'q',
      chatModel: { providerId: 'p', key: 'k' },
      embeddingModel: { providerId: 'p', key: 'e' },
      ...body,
    }),
  });

describe('POST /api/search (no stream)', () => {
  it('answers a failed search with the 500 JSON body', async () => {
    agentMode.value = 'error';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await POST(request({}));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      message: 'Search error',
      error: { data: 'model server unreachable' },
    });
  });

  it('still answers a good search with 200', async () => {
    agentMode.value = 'ok';
    const res = await POST(request({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sources: [] });
  });
});

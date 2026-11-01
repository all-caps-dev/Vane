// TypeScript: unit tests for claimMessageEnd (src/lib/utils/messageEndGuard.ts).
import { describe, expect, it } from 'vitest';
import { claimMessageEnd } from '@/lib/utils/messageEndGuard';

describe('claimMessageEnd', () => {
  it('handles a stream end once and skips a duplicate on the same stream', () => {
    const handled = new Set<string>();
    expect(claimMessageEnd(handled, 'backend-1')).toBe(true);
    expect(claimMessageEnd(handled, 'backend-1')).toBe(false);
  });

  it('handles the end of a rewrite stream for the same message', () => {
    // First answer and its rewrite share a messageId; each stream has its own backendId.
    const handled = new Set<string>();
    expect(claimMessageEnd(handled, 'backend-first')).toBe(true);
    expect(claimMessageEnd(handled, 'backend-rewrite')).toBe(true);
  });
});

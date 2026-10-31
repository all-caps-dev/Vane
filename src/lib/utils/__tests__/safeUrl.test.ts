// TypeScript: unit tests for the SSRF guard (src/lib/utils/safeUrl.ts). DNS is mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted lets the mock factory below use this function.
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock('node:dns', () => ({
  default: { promises: { lookup } },
  promises: { lookup },
}));

import {
  assertPublicHttpUrl,
  BlockedUrlError,
  isPrivateAddress,
} from '@/lib/utils/safeUrl';

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1',
    '0.0.0.0',
    '169.254.169.254',
    '100.64.0.1',
    '100.127.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%en0',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:192.168.0.1',
    'not-an-ip',
  ])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('assertPublicHttpUrl', () => {
  it('accepts a public http(s) URL and returns it parsed', async () => {
    const url = await assertPublicHttpUrl('https://example.com/a');
    expect(url.hostname).toBe('example.com');
    expect(lookup).toHaveBeenCalledWith('example.com', { all: true });
  });

  it.each(['file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)'])(
    'rejects the scheme of %s',
    async (url) => {
      await expect(assertPublicHttpUrl(url)).rejects.toBeInstanceOf(
        BlockedUrlError,
      );
    },
  );

  it.each([
    'http://localhost:3000/',
    'http://LOCALHOST./',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'https://pve-yolo.salamander-ghoul.ts.net/',
    'http://127.0.0.1/',
    'http://2130706433/', // 127.0.0.1 written as one number
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
  ])('rejects %s without a DNS lookup', async (url) => {
    await expect(assertPublicHttpUrl(url)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a host when ANY resolved address is private', async () => {
    lookup.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(
      assertPublicHttpUrl('https://rebind.example/'),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('passes DNS errors through as they are', async () => {
    lookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND nope.example'));
    await expect(assertPublicHttpUrl('https://nope.example/')).rejects.toThrow(
      'ENOTFOUND',
    );
  });
});

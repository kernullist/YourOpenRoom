// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { extractEmbeddedIpv4, isAoiPrivateOrLocalHostname } from '../aoiHostUrlSafety';
import {
  assertPublicHttpUrl,
  fetchPublicUrl,
  PublicUrlRejectedError,
  type PublicUrlLookup,
} from '../publicUrlFetch';

const publicLookup: PublicUrlLookup = async () => [{ address: '93.184.216.34' }];

function response(status: number, headers: Record<string, string> = {}, body = ''): Response {
  return new Response(status === 204 || (status >= 300 && status < 400) ? null : body, {
    status,
    headers,
  });
}

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PublicUrlRejectedError);
    return (error as PublicUrlRejectedError).reason;
  }
  throw new Error('expected a rejection');
}

describe('isAoiPrivateOrLocalHostname with URL-shaped hostnames', () => {
  it('sees through the brackets URL.hostname keeps on IPv6', () => {
    for (const raw of [
      'http://[::ffff:127.0.0.1]/',
      'http://[::ffff:a9fe:a9fe]/',
      'http://[::127.0.0.1]/',
      'http://[64:ff9b::10.0.0.1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://[::1]/',
    ]) {
      expect(isAoiPrivateOrLocalHostname(new URL(raw).hostname), raw).toBe(true);
    }
    expect(isAoiPrivateOrLocalHostname(new URL('http://[2606:4700::1111]/').hostname)).toBe(false);
    expect(isAoiPrivateOrLocalHostname(new URL('http://[::ffff:8.8.8.8]/').hostname)).toBe(false);
  });
});

describe('extractEmbeddedIpv4', () => {
  it('reads the dotted tail and the hex tail the URL parser rewrites it to', () => {
    expect(extractEmbeddedIpv4('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(extractEmbeddedIpv4('[::ffff:7f00:1]')).toBe('127.0.0.1');
    expect(extractEmbeddedIpv4('64:ff9b::c0a8:101')).toBe('192.168.1.1');
  });

  it('returns null for addresses that embed no IPv4', () => {
    expect(extractEmbeddedIpv4('2001:db8::1')).toBeNull();
    expect(extractEmbeddedIpv4('::1')).toBeNull();
    expect(extractEmbeddedIpv4('::ffff:zz')).toBeNull();
  });
});

describe('assertPublicHttpUrl', () => {
  it('refuses schemes, credentials, private literals and private resolutions', async () => {
    expect(await rejection(assertPublicHttpUrl(new URL('file:///etc/passwd'), publicLookup))).toBe(
      'unsupported_scheme',
    );
    expect(
      await rejection(assertPublicHttpUrl(new URL('http://u:p@example.com/'), publicLookup)),
    ).toBe('credentials_in_url');
    expect(
      await rejection(assertPublicHttpUrl(new URL('http://169.254.169.254/latest'), publicLookup)),
    ).toBe('private_host');
    expect(
      await rejection(
        assertPublicHttpUrl(new URL('http://rebind.example/'), async () => [
          { address: '93.184.216.34' },
          { address: '10.0.0.7' },
        ]),
      ),
    ).toBe('private_address');
    expect(
      await rejection(
        assertPublicHttpUrl(new URL('http://nowhere.example/'), async () => {
          throw new Error('ENOTFOUND');
        }),
      ),
    ).toBe('unresolvable_host');
    expect(
      await rejection(assertPublicHttpUrl(new URL('http://empty.example/'), async () => [])),
    ).toBe('unresolvable_host');
    await expect(
      assertPublicHttpUrl(new URL('https://example.com/a'), publicLookup),
    ).resolves.toBeUndefined();
  });
});

describe('fetchPublicUrl', () => {
  it('follows public redirects by hand and reports the final URL', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, { location: '/next' }))
      .mockResolvedValueOnce(response(200, { 'content-type': 'text/html' }, '<p>ok</p>'));
    const result = await fetchPublicUrl(new URL('https://example.com/start'), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: publicLookup,
    });
    expect(result.finalUrl).toBe('https://example.com/next');
    expect(await result.response.text()).toBe('<p>ok</p>');
    for (const call of fetchImpl.mock.calls) {
      expect((call[1] as RequestInit).redirect).toBe('manual');
    }
  });

  it('refuses a public page that redirects into the private network', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(302, { location: 'http://[::ffff:127.0.0.1]:3000/api/x' }));
    expect(
      await rejection(
        fetchPublicUrl(new URL('https://example.com/'), {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          lookup: publicLookup,
        }),
      ),
    ).toBe('private_host');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after too many redirects', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => response(301, { location: '/loop' }));
    expect(
      await rejection(
        fetchPublicUrl(new URL('https://example.com/'), {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          lookup: publicLookup,
          maxRedirects: 2,
        }),
      ),
    ).toBe('too_many_redirects');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns a 3xx without Location as the final response', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(304));
    const result = await fetchPublicUrl(new URL('https://example.com/'), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      lookup: publicLookup,
    });
    expect(result.response.status).toBe(304);
  });
});

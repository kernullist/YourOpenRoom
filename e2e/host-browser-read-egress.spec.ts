import { test, expect } from '@playwright/test';
import * as http from 'http';
import type { AddressInfo } from 'net';

import {
  resolveAoiHostBrowserExecutable,
  runAoiHostBrowserRead,
} from '../apps/webuiapps/src/lib/aoiHostBrowserRead';
import { startAoiHostBrowserEgressGuard } from '../apps/webuiapps/src/lib/aoiHostBrowserEgressGuard';

// host_browser_read checks a URL's host by name and hands the rest to headless
// Chrome. Chrome follows redirects itself, so a public page that redirected to
// 127.0.0.1 used to be read like any other. This runs the real browser through
// the egress guard against a server on loopback: "reader.example" stands in for
// a public site (the test-only exemption); 127.0.0.1 itself gets no exemption.

const systemBrowser = resolveAoiHostBrowserExecutable();

const PAGE =
  '<!doctype html><title>Public page</title><body><article><p>' +
  'This public page has an ordinary paragraph that is long enough for the reader to keep it.' +
  '</p></article></body>';
const SECRET =
  '<!doctype html><title>Admin</title><body><article><p>' +
  'TOP SECRET router password list that must never leave this machine through the reader.' +
  '</p></article></body>';

test.describe('the headless reader cannot be redirected onto this machine', () => {
  test.describe.configure({ timeout: 90_000 });

  let server: http.Server;
  let port = 0;

  test.beforeEach(async () => {
    test.skip(!systemBrowser, 'no Chrome or Edge is installed on this machine');
    server = http.createServer((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: `http://127.0.0.1:${port}/secret` });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(request.url === '/secret' ? SECRET : PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  test.afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  const guard = () =>
    startAoiHostBrowserEgressGuard({
      lookup: async (host) =>
        host === 'reader.example' ? [{ address: '127.0.0.1', family: 4 }] : [],
      treatAsPublicForTest: (host) => host === 'reader.example',
    });

  test('reads an ordinary page through the guard', async () => {
    const result = await runAoiHostBrowserRead({
      url: `http://reader.example:${port}/page`,
      browserPath: systemBrowser?.path,
      startEgressGuard: guard,
    });
    expect(result.ok).toBe(true);
    expect('text' in result ? result.text : '').toContain('ordinary paragraph');
  });

  test('does not follow a redirect to 127.0.0.1', async () => {
    const result = await runAoiHostBrowserRead({
      url: `http://reader.example:${port}/start`,
      browserPath: systemBrowser?.path,
      startEgressGuard: guard,
    });
    expect(JSON.stringify(result)).not.toContain('TOP SECRET');
  });
});

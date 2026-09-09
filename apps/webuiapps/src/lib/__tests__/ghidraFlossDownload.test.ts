// @vitest-environment node
//
// This route puts an executable on the operator's machine, so the tests that
// matter most are the refusals: the repository, the hosts and the destination
// are pinned, and nothing about the request comes from a caller. A downloader
// that could be pointed somewhere else would be a remote-code-execution feature
// with a friendly button on it.
import { afterEach, describe, expect, it } from 'vitest';

import {
  findFlossExecutable,
  flossToolsDir,
  installFloss,
  isAllowedDownloadUrl,
  pickFlossAsset,
} from '../ghidraFlossDownload';

const RELEASE = {
  tag_name: 'v3.1.1',
  assets: [
    {
      name: 'floss-v3.1.1-linux.zip',
      browser_download_url:
        'https://github.com/mandiant/flare-floss/releases/download/v3.1.1/floss-v3.1.1-linux.zip',
    },
    {
      name: 'floss-v3.1.1-windows.zip',
      browser_download_url:
        'https://github.com/mandiant/flare-floss/releases/download/v3.1.1/floss-v3.1.1-windows.zip',
    },
  ],
};

describe('pickFlossAsset', () => {
  it('picks by platform name, not by position', () => {
    // The asset order in the API answer is not a contract; taking assets[0]
    // would install the Linux build on Windows.
    const asset = pickFlossAsset(RELEASE, 'win32');
    expect(asset?.name).toBe('floss-v3.1.1-windows.zip');
    expect(asset?.tag).toBe('v3.1.1');
    expect(pickFlossAsset(RELEASE, 'linux')?.name).toBe('floss-v3.1.1-linux.zip');
  });

  it('returns nothing when there is no archive for this platform', () => {
    expect(pickFlossAsset(RELEASE, 'darwin')).toBeNull();
    expect(pickFlossAsset({ assets: [] }, 'win32')).toBeNull();
    expect(pickFlossAsset(null, 'win32')).toBeNull();
    expect(pickFlossAsset({ assets: [{ name: 'floss-windows.txt' }] }, 'win32')).toBeNull();
  });
});

describe('isAllowedDownloadUrl', () => {
  it('accepts the hosts GitHub actually serves releases from', () => {
    expect(isAllowedDownloadUrl('https://github.com/mandiant/flare-floss/releases/x.zip')).toBe(
      true,
    );
    expect(isAllowedDownloadUrl('https://objects.githubusercontent.com/x.zip')).toBe(true);
  });

  it('refuses anywhere else, and refuses plain HTTP', () => {
    for (const url of [
      'https://evil.example.com/floss.zip',
      'http://github.com/x.zip',
      'https://github.com.evil.example/x.zip',
      'file:///C:/floss.zip',
      'not a url',
    ]) {
      expect(isAllowedDownloadUrl(url), url).toBe(false);
    }
  });
});

describe('findFlossExecutable', () => {
  it('finds the executable wherever the archive put it', () => {
    expect(
      findFlossExecutable(['C:\\t\\floss-v3.1.1-windows\\floss.exe', 'C:\\t\\readme.md'], 'win32'),
    ).toBe('C:\\t\\floss-v3.1.1-windows\\floss.exe');
  });

  it('prefers the shallowest copy, since a nested one is a bundled dependency', () => {
    expect(
      findFlossExecutable(['C:\\t\\deep\\lib\\vendor\\floss.exe', 'C:\\t\\floss.exe'], 'win32'),
    ).toBe('C:\\t\\floss.exe');
  });

  it('returns empty when the archive held no executable', () => {
    expect(findFlossExecutable(['C:\\t\\readme.md'], 'win32')).toBe('');
  });
});

describe('installFloss', () => {
  const HOME = 'C:\\home';

  function deps(overrides: Parameters<typeof installFloss>[1] = {}) {
    const written: string[] = [];
    return {
      written,
      value: {
        fetchJson: async () => RELEASE,
        fetchBinary: async () => new Uint8Array([0x50, 0x4b]),
        extract: async () => '',
        mkdir: () => {},
        writeFile: (path: string) => {
          written.push(path);
        },
        listFilesDeep: () => [`${flossToolsDir(HOME)}\\floss.exe`],
        removeFile: () => {},
        ...overrides,
      },
    };
  }

  it('installs into the lab tools folder and hands back the path', async () => {
    const { value } = deps();
    const result = await installFloss(HOME, value);
    expect(result.ok).toBe(true);
    expect(result.flossExePath).toContain('floss.exe');
    expect(result.detail).toContain('v3.1.1');
  });

  it('removes the archive once it has been unpacked', async () => {
    const removed: string[] = [];
    const { value } = deps({
      removeFile: (path: string) => {
        removed.push(path);
      },
    });
    await installFloss(HOME, value);
    expect(removed[0]).toContain('.zip');
  });

  it('refuses an asset URL that is not a GitHub release host', async () => {
    // The API answered with something we do not recognise. Stop, rather than
    // download and run whatever it points at.
    const { value } = deps({
      fetchJson: async () => ({
        tag_name: 'v1',
        assets: [
          { name: 'floss-windows.zip', browser_download_url: 'https://evil.example.com/x.zip' },
        ],
      }),
    });
    const result = await installFloss(HOME, value);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not a GitHub release host');
  });

  it('reports a network failure rather than throwing', async () => {
    const { value } = deps({
      fetchJson: async () => {
        throw new Error('ENOTFOUND api.github.com');
      },
    });
    const result = await installFloss(HOME, value);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('ENOTFOUND');
  });

  it('reports a download failure with its reason', async () => {
    const { value } = deps({
      fetchBinary: async () => {
        throw new Error('HTTP 503');
      },
    });
    expect((await installFloss(HOME, value)).detail).toContain('HTTP 503');
  });

  it('reports a directory it cannot write into', async () => {
    const { value } = deps({
      writeFile: () => {
        throw new Error('EACCES');
      },
    });
    const result = await installFloss(HOME, value);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('EACCES');
  });

  it('reports an archive it could not unpack', async () => {
    const { value } = deps({ extract: async () => 'tar: unrecognized archive format' });
    const result = await installFloss(HOME, value);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unrecognized archive format');
  });

  it('says so when the archive unpacked but held no executable', async () => {
    const { value } = deps({ listFilesDeep: () => ['C:\\home\\ghidra-lab\\tools\\README.md'] });
    const result = await installFloss(HOME, value);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no FLOSS executable');
  });

  it('says so when the release has nothing for this platform', async () => {
    const { value } = deps({ fetchJson: async () => ({ tag_name: 'v1', assets: [] }) });
    expect((await installFloss(HOME, value)).detail).toContain('no archive for this platform');
  });
});

describe('the real Node implementations', () => {
  // The injected fakes above prove the decision tree. These prove the defaults
  // behind them, which is the code that actually runs when the operator clicks.
  const globalAny = globalThis as { fetch?: unknown };

  afterEach(() => {
    delete globalAny.fetch;
  });

  it('asks GitHub for the release list and refuses a non-200', async () => {
    const seen: string[] = [];
    globalAny.fetch = async (url: string) => {
      seen.push(String(url));
      return { ok: false, status: 503, json: async () => ({}) };
    };
    const result = await installFloss('C:\\home', {});
    expect(seen[0]).toBe('https://api.github.com/repos/mandiant/flare-floss/releases/latest');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('503');
  });

  it('refuses a download whose declared size is over the cap, before reading it', async () => {
    globalAny.fetch = async (url: string) => {
      if (String(url).includes('api.github.com')) {
        return { ok: true, status: 200, json: async () => RELEASE };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(500 * 1024 * 1024) },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    };
    const result = await installFloss('C:\\home', { mkdir: () => {}, writeFile: () => {} });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('cap');
  });

  it('refuses a body that turns out to be over the cap once read', async () => {
    // Content-Length is a claim, not a guarantee.
    globalAny.fetch = async (url: string) => {
      if (String(url).includes('api.github.com')) {
        return { ok: true, status: 200, json: async () => RELEASE };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(201 * 1024 * 1024),
      };
    };
    const result = await installFloss('C:\\home', { mkdir: () => {}, writeFile: () => {} });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('over the');
  });

  it('reports a download that answers non-200', async () => {
    globalAny.fetch = async (url: string) =>
      String(url).includes('api.github.com')
        ? { ok: true, status: 200, json: async () => RELEASE }
        : { ok: false, status: 404 };
    const result = await installFloss('C:\\home', { mkdir: () => {}, writeFile: () => {} });
    expect(result.detail).toContain('404');
  });

  it('unpacks a real archive with tar and finds the executable in it', async () => {
    // The whole default path except the network: write a real zip, extract it
    // with the real tar, walk the real directory.
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'floss-home-'));
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'floss-src-'));
    const exeName = process.platform === 'win32' ? 'floss.exe' : 'floss';
    fs.writeFileSync(path.join(staging, exeName), 'not really an executable');
    const archive = path.join(staging, 'floss-windows.zip');
    // `tar -a -cf` writes a zip when the name ends in .zip.
    const { spawnSync } = await import('child_process');
    const made = spawnSync('tar', ['-a', '-cf', archive, '-C', staging, exeName], {
      windowsHide: true,
    });
    if (made.status !== 0) {
      // No zip-capable tar here; the injected-extract tests still cover the flow.
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(staging, { recursive: true, force: true });
      return;
    }
    const bytes = new Uint8Array(fs.readFileSync(archive));

    globalAny.fetch = async (url: string) =>
      String(url).includes('api.github.com')
        ? { ok: true, status: 200, json: async () => RELEASE }
        : {
            ok: true,
            status: 200,
            headers: { get: () => String(bytes.byteLength) },
            arrayBuffer: async () => bytes.buffer.slice(0),
          };

    const result = await installFloss(home);
    expect(result.ok, result.detail).toBe(true);
    expect(result.flossExePath.toLowerCase()).toContain('floss');
    expect(fs.existsSync(result.flossExePath)).toBe(true);
    // The archive is scratch and must not be left behind.
    expect(fs.existsSync(path.join(flossToolsDir(home), 'floss-v3.1.1-windows.zip'))).toBe(false);

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(staging, { recursive: true, force: true });
  }, 120_000);

  it('reports tar refusing a file that is not an archive', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'floss-bad-'));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalAny.fetch = async (url: string) =>
      String(url).includes('api.github.com')
        ? { ok: true, status: 200, json: async () => RELEASE }
        : {
            ok: true,
            status: 200,
            headers: { get: () => '4' },
            arrayBuffer: async () => bytes.buffer.slice(0),
          };
    const result = await installFloss(home);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Could not unpack');
    fs.rmSync(home, { recursive: true, force: true });
  }, 120_000);
});

describe('the real directory walk', () => {
  const globalAny = globalThis as { fetch?: unknown };

  afterEach(() => {
    delete globalAny.fetch;
  });

  it('finds the executable a real unpack left on disk, however deep', async () => {
    // Everything real except the network and the unpack itself: the archive is
    // simulated by pre-placing what tar would have written, so the walk that
    // finds the executable is the production one.
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'floss-walk-'));
    const exeName = process.platform === 'win32' ? 'floss.exe' : 'floss';

    globalAny.fetch = async (url: string) =>
      String(url).includes('api.github.com')
        ? { ok: true, status: 200, json: async () => RELEASE }
        : {
            ok: true,
            status: 200,
            headers: { get: () => '2' },
            arrayBuffer: async () => new Uint8Array([0x50, 0x4b]).buffer,
          };

    const result = await installFloss(home, {
      extract: async (_archive: string, dir: string) => {
        const nested = path.join(dir, 'floss-v3.1.1-windows', 'lib');
        fs.mkdirSync(nested, { recursive: true });
        fs.writeFileSync(path.join(nested, exeName), 'nested copy');
        fs.writeFileSync(path.join(dir, 'floss-v3.1.1-windows', exeName), 'the real one');
        fs.writeFileSync(path.join(dir, 'README.md'), 'docs');
        return '';
      },
    });

    expect(result.ok, result.detail).toBe(true);
    // The shallower copy wins: the nested one is a bundled dependency.
    expect(result.flossExePath).not.toContain(`lib${path.sep}`);
    expect(fs.readFileSync(result.flossExePath, 'utf-8')).toBe('the real one');
    // The archive is scratch and the real removeFile has to take it away.
    expect(fs.existsSync(path.join(flossToolsDir(home), 'floss-v3.1.1-windows.zip'))).toBe(false);

    fs.rmSync(home, { recursive: true, force: true });
  }, 60_000);
});

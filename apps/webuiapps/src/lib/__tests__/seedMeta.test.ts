import { beforeEach, describe, expect, it, vi } from 'vitest';

const putTextFilesByJSON = vi.fn(async (_payload: unknown) => undefined);
vi.mock('../diskStorage', () => ({
  putTextFilesByJSON: (payload: unknown) => putTextFilesByJSON(payload),
}));

describe('seedMetaFiles', () => {
  beforeEach(() => {
    vi.resetModules();
    putTextFilesByJSON.mockReset();
    putTextFilesByJSON.mockResolvedValue(undefined);
  });

  async function load() {
    const sessionPath = await import('../sessionPath');
    const seedMeta = await import('../seedMeta');
    return { ...sessionPath, ...seedMeta };
  }

  it('seeds each session once, and a new session again', async () => {
    const { setSessionPath, seedMetaFiles } = await load();
    setSessionPath('aoi/a');
    await seedMetaFiles();
    await seedMetaFiles();
    expect(putTextFilesByJSON).toHaveBeenCalledTimes(1);

    // A character/mod switch used to find the module flag set and seed nothing.
    setSessionPath('aoi/b');
    await seedMetaFiles();
    expect(putTextFilesByJSON).toHaveBeenCalledTimes(2);
    const files = (putTextFilesByJSON.mock.calls[0][0] as { files: { name: string }[] }).files;
    expect(files.some((file) => file.name === 'meta.yaml')).toBe(true);
  });

  it('re-seeds the same session when forced (after a reset)', async () => {
    const { setSessionPath, seedMetaFiles } = await load();
    setSessionPath('aoi/a');
    await seedMetaFiles();
    await seedMetaFiles({ force: true });
    expect(putTextFilesByJSON).toHaveBeenCalledTimes(2);
  });

  it('lets the next caller retry after a failed write', async () => {
    const { setSessionPath, seedMetaFiles } = await load();
    setSessionPath('aoi/a');
    putTextFilesByJSON.mockRejectedValueOnce(new Error('disk busy'));
    await expect(seedMetaFiles()).rejects.toThrow('disk busy');
    await seedMetaFiles();
    expect(putTextFilesByJSON).toHaveBeenCalledTimes(2);
  });
});

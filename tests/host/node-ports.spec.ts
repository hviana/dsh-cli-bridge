import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeFiles } from '../../src/host/node-ports.ts';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cli-bridge-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('reading', () => {
  it('reads a file back', async () => {
    const path = join(root, 'a.txt');
    await writeFile(path, 'contents', 'utf8');
    expect(await nodeFiles.readText(path)).toBe('contents');
  });

  it('answers undefined for a file that is not there', async () => {
    expect(await nodeFiles.readText(join(root, 'missing.txt'))).toBeUndefined();
  });

  it('propagates a failure that is not absence', async () => {
    // A directory is not a file; the error is real and must not be swallowed.
    await expect(nodeFiles.readText(root)).rejects.toThrow();
  });
});

describe('writing', () => {
  it('creates parent directories', async () => {
    const path = join(root, 'deep', 'nested', 'accounts.json');
    await nodeFiles.writeText(path, '{}');
    expect(await readFile(path, 'utf8')).toBe('{}');
  });

  it('replaces an existing file', async () => {
    const path = join(root, 'accounts.json');
    await nodeFiles.writeText(path, 'first');
    await nodeFiles.writeText(path, 'second');
    expect(await readFile(path, 'utf8')).toBe('second');
  });

  it('leaves no staging file behind', async () => {
    await nodeFiles.writeText(join(root, 'accounts.json'), '{}');
    expect(await readdir(root)).toEqual(['accounts.json']);
  });

  it('cleans up its staging file when the write cannot complete', async () => {
    // A path whose parent is a FILE cannot be created; the rename fails after
    // the staging file exists, which is exactly the branch that must clean up.
    const file = join(root, 'blocker');
    await writeFile(file, 'x', 'utf8');
    await expect(nodeFiles.writeText(join(file, 'child.json'), '{}')).rejects
      .toThrow();
    expect(await readdir(root)).toEqual(['blocker']);
  });

  it('survives concurrent writers, leaving one whole document', async () => {
    const path = join(root, 'accounts.json');
    await Promise.all(
      Array.from(
        { length: 12 },
        (_unused, index) =>
          nodeFiles.writeText(path, `${JSON.stringify({ index })}\n`),
      ),
    );
    const text = await readFile(path, 'utf8');
    expect(() => JSON.parse(text) as unknown).not.toThrow();
    expect(await readdir(root)).toEqual(['accounts.json']);
  });
});

describe('directories', () => {
  it('creates one, and creating it twice is fine', async () => {
    const path = join(root, 'homes', 'claude', 'work');
    await nodeFiles.makeDirectory(path);
    await nodeFiles.makeDirectory(path);
    expect(await nodeFiles.exists(path)).toBe(true);
  });

  it('removes one and everything under it', async () => {
    const path = join(root, 'homes', 'claude', 'work');
    await nodeFiles.makeDirectory(path);
    await nodeFiles.writeText(join(path, 'creds.json'), '{}');
    await nodeFiles.removeDirectory(path);
    expect(await nodeFiles.exists(path)).toBe(false);
  });

  it('removing an absent directory is not a failure', async () => {
    await expect(nodeFiles.removeDirectory(join(root, 'nothing'))).resolves
      .toBeUndefined();
  });

  it('reports absence rather than throwing', async () => {
    expect(await nodeFiles.exists(join(root, 'nothing'))).toBe(false);
  });
});

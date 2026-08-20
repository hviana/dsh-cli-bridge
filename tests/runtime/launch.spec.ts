import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  batchArgv,
  binEntry,
  globalPackageDir,
  isBatchFile,
  isJavaScriptEntry,
  npmEntryCandidates,
  quoteForCmd,
} from '../../src/runtime/launch.ts';

describe('globalPackageDir', () => {
  it('uses npm’s POSIX global layout', () => {
    expect(
      globalPackageDir(
        '/state/toolchain/claude',
        '@anthropic-ai/claude-code',
        'linux',
      ),
    ).toBe(
      '/state/toolchain/claude/lib/node_modules/@anthropic-ai/claude-code',
    );
  });

  it('uses npm’s Windows global layout, with real backslashes', () => {
    expect(globalPackageDir('C:\\prefix', '@openai/codex', 'win32'))
      .toBe('C:\\prefix\\node_modules\\@openai\\codex');
  });

  it('handles an unscoped package', () => {
    expect(globalPackageDir('/prefix', 'codex', 'darwin')).toBe(
      '/prefix/lib/node_modules/codex',
    );
  });
});

describe('binEntry', () => {
  it('reads a string bin', () => {
    expect(binEntry({ bin: './cli.js' }, 'claude')).toBe('./cli.js');
  });

  it('reads the named entry of a bin map', () => {
    expect(binEntry({ bin: { claude: 'cli.js', other: 'x.js' } }, 'claude'))
      .toBe('cli.js');
  });

  it('accepts a single differently-named entry, which is unambiguous', () => {
    expect(binEntry({ bin: { 'claude-code': 'cli.js' } }, 'claude')).toBe(
      'cli.js',
    );
  });

  it('refuses to guess between several differently-named entries', () => {
    expect(binEntry({ bin: { a: 'a.js', b: 'b.js' } }, 'claude'))
      .toBeUndefined();
  });

  it.each([
    ['no manifest', undefined],
    ['a non-object', 'text'],
    ['no bin field', { name: 'x' }],
    ['a non-string bin', { bin: 42 }],
  ])('returns undefined for %s', (_label, manifest) => {
    expect(binEntry(manifest, 'claude')).toBeUndefined();
  });
});

describe('isJavaScriptEntry', () => {
  it.each(['bin/codex.js', 'cli.mjs', 'x.CJS'])(
    'puts Node in front of %s',
    (path) => {
      expect(isJavaScriptEntry(path)).toBe(true);
    },
  );

  it.each([
    // What `@anthropic-ai/claude-code` actually ships: a native binary that
    // carries the `.exe` name on every platform.
    'bin/claude.exe',
    'bin/claude',
    'claude.cmd',
  ])('spawns %s as itself', (path) => {
    expect(isJavaScriptEntry(path)).toBe(false);
  });
});

describe('isBatchFile', () => {
  it.each(['C:\\p\\claude.cmd', 'c:\\p\\claude.CMD', '/p/x.bat'])(
    'recognizes %s',
    (path) => {
      expect(isBatchFile(path)).toBe(true);
    },
  );

  it.each(['/usr/bin/claude', 'C:\\p\\claude.exe', '/p/cli.js'])(
    'leaves %s alone',
    (path) => {
      expect(isBatchFile(path)).toBe(false);
    },
  );
});

describe('quoteForCmd', () => {
  it('quotes a plain argument', () => {
    expect(quoteForCmd('hello')).toBe('"hello"');
  });

  it('quotes a path with spaces', () => {
    expect(quoteForCmd('C:\\Program Files\\claude.cmd')).toBe(
      '"C:\\Program Files\\claude.cmd"',
    );
  });

  it('doubles an embedded quote', () => {
    expect(quoteForCmd('say "hi"')).toBe('"say ""hi"""');
  });

  it.each(['&', '<', '>', '^', '|'])(
    'escapes the cmd metacharacter %s',
    (character) => {
      expect(quoteForCmd(`a${character}b`)).toBe(`"a^${character}b"`);
    },
  );
});

describe('batchArgv', () => {
  it('runs the shim through cmd.exe as a single command string', () => {
    expect(batchArgv('C:\\p\\claude.cmd', ['--print', '--model', 'opus']))
      .toEqual([
        'cmd.exe',
        '/d',
        '/s',
        '/c',
        '"C:\\p\\claude.cmd" "--print" "--model" "opus"',
      ]);
  });

  it('cannot be talked into running a second command', () => {
    const argv = batchArgv('C:\\p\\claude.cmd', ['& calc.exe']);
    expect(argv.at(-1)).toBe('"C:\\p\\claude.cmd" "^& calc.exe"');
  });
});

describe('npmEntryCandidates', () => {
  it('looks beside the Node executable in every layout it might use', () => {
    const candidates = npmEntryCandidates('/opt/node/bin/node');
    expect(candidates).toContain(
      join('/opt/node/bin', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
    expect(candidates).toContain(
      join('/opt/node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
    expect(candidates).toContain(
      join('/opt/node', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  });
});

/**
 * `prepare` lifecycle hook.
 *
 * A git install (`dsh plugin add github:owner/dsh-cli-bridge`) fetches sources
 * without `lib/`, so the package must build itself on arrival. A registry or
 * tarball install already carries `lib/` and never runs this hook. A local
 * developer install runs it too, where it must stay a no-op until sources and
 * the toolchain are both present — otherwise the very first `install` fails
 * before it can put the compiler on disk.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const compiler = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const buildable = existsSync(join(root, 'src', 'index.ts')) &&
  existsSync(compiler);

if (!buildable) {
  process.stdout.write(
    'dsh-cli-bridge: prepare skipped (no sources or no toolchain)\n',
  );
  process.exit(0);
}

// On Windows npm is a `.cmd` shim, which cannot be spawned without a shell —
// the same rule the plugin's own launcher enforces for the delegate CLIs.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const { status, error } = spawnSync(npm, ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (error !== undefined) {
  process.stderr.write(
    `dsh-cli-bridge: prepare failed to spawn ${npm}: ${error.message}\n`,
  );
}
process.exit(status ?? 1);

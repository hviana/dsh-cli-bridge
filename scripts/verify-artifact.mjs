/**
 * Publication gate for the built artifacts.
 *
 * The test suite exercises the SOURCES; this asserts the properties only the
 * built package has, and every one of them is a way a plugin can be broken
 * without a single test failing:
 *
 * - the Node half must import nothing but Node builtins, because a harness
 *   profile resolves nothing else beside it;
 * - the browser half must register itself through the shell's module loader and
 *   request only modules the shell publishes;
 * - the plugin's own surface (`name`, `inject`, `apply`, `Config`) must load and
 *   default correctly from the artifact, not from the sources.
 */
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];

/** Record a failed expectation. */
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

// --- the Node half -----------------------------------------------------------

const host = await readFile(join(root, 'lib', 'index.js'), 'utf8');
const imported = [
  ...host.matchAll(/(?:^|\n)import\s[^;]*?from\s*["']([^"']+)["']/gu),
].map((match) => match[1]);
const external = [...new Set(imported)].filter((specifier) =>
  !isBuiltin(specifier)
);
expect(
  external.length === 0,
  `lib/index.js must import only Node builtins, but imports: ${
    external.join(', ')
  }`,
);
expect(
  Object.keys(manifest.dependencies ?? {}).length === 0,
  'the package must declare no runtime dependencies; the artifact is self-contained',
);

const plugin = await import(join(root, 'lib', 'index.js'));
expect(
  plugin.name === 'cli-bridge',
  'the artifact must export the plugin name',
);
expect(typeof plugin.apply === 'function', 'the artifact must export apply()');
expect(
  Array.isArray(plugin.inject) && plugin.inject.includes('tools'),
  'the artifact must declare its injections',
);

const config = new plugin.Config({});
expect(
  config.defaultCli === 'claude',
  "the artifact's config schema must default defaultCli",
);
expect(
  config.direction.marker.length > 0,
  "the artifact's config schema must default the direction marker",
);
expect(
  config.channel.basePath.startsWith('/'),
  "the artifact's config schema must default the channel base path",
);

// --- the browser half --------------------------------------------------------

const client = await readFile(join(root, 'lib', 'client.cjs'), 'utf8');
expect(
  client.startsWith('window.__ModuleLoader__.load('),
  "lib/client.cjs must hand its factory to the shell's module loader",
);
expect(
  client.includes('return module.exports;'),
  'lib/client.cjs must return its exports from the factory',
);

/** Specifiers the web shell publishes into its module table. */
const shellModules = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]);
const required = [
  ...new Set(
    [...client.matchAll(/require\("([^"]+)"\)/gu)].map((match) => match[1]),
  ),
];
const unavailable = required.filter((specifier) =>
  !shellModules.has(specifier)
);
expect(
  unavailable.length === 0,
  `lib/client.cjs may only require shell modules, but requires: ${
    unavailable.join(', ')
  }`,
);

// --- the manifest ------------------------------------------------------------

expect(
  manifest.dsh?.bundle?.patch === './cordis.patch.yml',
  'the manifest must declare its bundle patch',
);
expect(
  manifest.dsh?.client?.platform === 'web',
  'the manifest must declare its web client half',
);
expect(
  manifest.exports['./client'].default === './lib/client.cjs',
  'the client export must point at the bundle',
);

// --- report ------------------------------------------------------------------

if (failures.length > 0) {
  process.stderr.write(
    `artifact verification failed:\n${
      failures.map((line) => `  - ${line}`).join('\n')
    }\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `dsh-cli-bridge artifact verified: self-contained host half, ${
    String(required.length)
  } shell module(s) required by the client half\n`,
);

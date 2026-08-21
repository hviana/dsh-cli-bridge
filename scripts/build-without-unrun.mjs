/**
 * Build driver — a plain-JS stand-in for the `tsdown` CLI on this machine.
 *
 * `tsdown` loads its config file, TS or JS, through `unrun`, which is not
 * installed in this checkout, so the CLI cannot start at all. This calls
 * tsdown's API with `config: false` and the SAME two option objects
 * `tsdown.config.ts` exports, skipping config discovery entirely.
 *
 * It also needs Node >= 22 (`Promise.withResolvers`), so run it with a modern
 * Node if the one on PATH is older. `tsdown.config.ts` remains the source of
 * truth; keep this file in step with it.
 */
import { createRequire, isBuiltin } from 'node:module';
import { build } from 'tsdown';

const manifest = createRequire(import.meta.url)('../package.json');

const SHELL_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]);

const isNodeExternal = (specifier) => isBuiltin(specifier);

await build({
  config: false,
  name: manifest.name,
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: isNodeExternal,
    alwaysBundle: (specifier) => !isNodeExternal(specifier),
  },
  outputOptions: { entryFileNames: 'index.js' },
});

await build({
  config: false,
  name: `${manifest.name}/client`,
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier) => SHELL_MODULES.has(specifier),
    alwaysBundle: (specifier) => !SHELL_MODULES.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV ?? 'production',
    ),
  },
  plugins: [{
    name: 'dsh-cli-bridge-bundle-purity',
    resolveId(source) {
      if (!source.startsWith('@deepseek-ai/') || SHELL_MODULES.has(source)) {
        return null;
      }
      throw new Error(
        `client bundle purity: "${source}" is not a shell module-table row — ` +
          'import it type-only, or collaborate through a cordis service',
      );
    },
  }],
  outputOptions: {
    entryFileNames: 'client.cjs',
    banner: `window.__ModuleLoader__.load({ id: ${
      JSON.stringify(manifest.name)
    }, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
});

console.log('build: ok');

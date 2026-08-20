/**
 * Two artifacts, one bundler pass, both fed by `tsc -b` output under
 * `lib/types`:
 *
 * - `lib/index.js` — the Node half. ESM, dependencies stay imports.
 * - `lib/client.js` — the browser half. CJS wrapped in the DeepSeek Harness
 *   client-module handoff: the bundle registers a factory with the shell's
 *   loader, and every specifier the shell already shares is resolved through
 *   the injected `require` instead of being duplicated into these bytes.
 *
 * The externals list is the whole contract with the shell. A specifier that is
 * NOT on it must be inlined, because the module table cannot answer a
 * `require` it never registered.
 */
import { isBuiltin } from 'node:module';
import { createRequire } from 'node:module';
import type { UserConfig } from 'tsdown';

const manifest = createRequire(import.meta.url)('./package.json') as {
  readonly name: string;
};

/**
 * Specifiers the web shell publishes into its frozen module table. Mirrors
 * `PLATFORM_MODULES` + `PRELOADED_CLIENT_EXTERNALS` of `@deepseek-ai/dsh-client-web`.
 */
const SHELL_MODULES: ReadonlySet<string> = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]);

/**
 * The Node half is SELF-CONTAINED: only Node builtins stay imports.
 *
 * A plugin installed into a harness profile can rely on nothing being resolvable
 * beside it — the harness's own packages are not that profile's dependencies,
 * and one of them declares a peer that is not published at all, which would
 * break the install outright. So the wire and schema layers this plugin uses are
 * inlined, exactly as the harness inlines them into its own client bundles:
 * they carry no cross-plugin runtime identity. The framework itself does, and
 * this plugin never imports a value from it.
 */
const isNodeExternal = (specifier: string): boolean => isBuiltin(specifier);

const host: UserConfig = {
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
    alwaysBundle: (specifier: string) => !isNodeExternal(specifier),
  },
  outputOptions: { entryFileNames: 'index.js' },
};

const client: UserConfig = {
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
    neverBundle: (specifier: string) => SHELL_MODULES.has(specifier),
    alwaysBundle: (specifier: string) => !SHELL_MODULES.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV ?? 'production',
    ),
  },
  plugins: [{
    // Build-time mirror of the runtime rule: a shell package that is not a
    // module-table row would either duplicate a live runtime instance or
    // request a specifier the table cannot answer. Type-only imports are
    // erased before this gate and never reach it.
    name: 'dsh-cli-bridge-bundle-purity',
    resolveId(source: string) {
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
    // `.cjs` states what the file is: the shell executes it as a classic
    // script, and the package is otherwise ESM.
    entryFileNames: 'client.cjs',
    banner: `window.__ModuleLoader__.load({ id: ${
      JSON.stringify(manifest.name)
    }, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
};

export default [host, client];

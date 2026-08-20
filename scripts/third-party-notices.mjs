/**
 * The third-party notice file, derived from the build rather than remembered.
 *
 * The published bundles INLINE their dependencies — that is what makes the
 * plugin loadable inside a harness profile that resolves nothing beside it — so
 * the artifact really does redistribute other people's code, and their licences
 * really do require their notices to travel with it. A source-available licence
 * changes nothing about that obligation.
 *
 * The list of what was inlined is not maintained by hand: it is read out of the
 * bundles' own source maps, which name every file that went in. `--check` fails
 * when the committed notices no longer match the build, so adding a dependency
 * cannot quietly drop a notice.
 *
 * Usage: `node scripts/third-party-notices.mjs [--check]`
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const NOTICES = join(root, 'THIRD-PARTY-NOTICES.md');
const BUNDLES = [
  {
    label: 'lib/index.js (the Node half)',
    map: join(root, 'lib', 'index.js.map'),
  },
  {
    label: 'lib/client.cjs (the browser half)',
    map: join(root, 'lib', 'client.cjs.map'),
  },
];

/**
 * Packages inlined into one bundle, from its source map.
 *
 * The map's own paths locate each package, which matters under pnpm: a
 * transitive dependency lives in the store rather than beside the project, and
 * looking it up by name in `node_modules` would simply miss it.
 * @param mapPath - path of the `.map` file.
 * @returns each package name mapped to the directory it was read from.
 */
async function inlined(mapPath) {
  const map = JSON.parse(await readFile(mapPath, 'utf8'));
  const found = new Map();
  for (const source of map.sources ?? []) {
    const marker = source.lastIndexOf('node_modules/');
    if (marker < 0) continue;
    const parts = source.slice(marker + 'node_modules/'.length).split('/');
    const segments = parts[0]?.startsWith('@')
      ? parts.slice(0, 2)
      : parts.slice(0, 1);
    const name = segments.join('/');
    if (name.length === 0 || found.has(name)) continue;
    found.set(
      name,
      resolve(
        dirname(mapPath),
        source.slice(0, marker + 'node_modules/'.length),
        ...segments,
      ),
    );
  }
  return new Map(
    [...found].toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * One package's identity and licence text.
 * @param name - the package name.
 * @param base - the directory it was bundled from.
 * @returns its version, declared licence, and full licence text.
 */
async function notice(name, base) {
  const manifest = JSON.parse(
    await readFile(join(base, 'package.json'), 'utf8'),
  );
  const text = await Promise.any(
    ['LICENSE', 'LICENSE.md', 'LICENCE', 'LICENSE.txt'].map(async (file) =>
      readFile(join(base, file), 'utf8')
    ),
  ).catch(() => undefined);
  if (text === undefined) {
    throw new Error(
      `${name} is bundled but ships no licence file; its notice cannot be reproduced`,
    );
  }
  return {
    name,
    version: manifest.version ?? 'unknown',
    license: manifest.license ?? 'unknown',
    homepage: manifest.homepage ?? manifest.repository?.url ?? '',
    text: text.trim(),
  };
}

const sections = [];
for (const bundle of BUNDLES) {
  // Sequential on purpose: the document reads in bundle order.
  // eslint-disable-next-line no-await-in-loop
  const packages = await inlined(bundle.map);
  // eslint-disable-next-line no-await-in-loop
  const notices = await Promise.all(
    [...packages].map(async ([name, base]) => notice(name, base)),
  );
  sections.push({ bundle: bundle.label, notices });
}

const all = new Map();
for (const section of sections) {
  for (const entry of section.notices) all.set(entry.name, entry);
}

const document = [
  '# Third-party notices',
  '',
  '`dsh-cli-bridge` is source-available software (see [LICENSE](./LICENSE)), and its',
  'published bundles inline the open-source components listed below so that the',
  'plugin loads inside a harness profile that resolves nothing beside it.',
  '',
  'Those components remain governed by their own licences, reproduced in full in',
  'this file. Nothing in the plugin’s own licence limits the rights they grant in',
  'them.',
  '',
  'This file is generated from the bundles’ source maps by',
  '`scripts/third-party-notices.mjs`; `pnpm run verify:package` fails if it drifts',
  'from what was actually built.',
  '',
  '## What is inlined, and where',
  '',
  ...sections.flatMap((section) => [
    `**${section.bundle}**`,
    '',
    ...section.notices.length === 0
      ? ['- nothing: it requires its modules from the host instead.', '']
      : [
        '| Component | Version | Licence |',
        '|---|---|---|',
        ...section.notices.map((entry) =>
          `| \`${entry.name}\` | ${entry.version} | ${entry.license} |`
        ),
        '',
      ],
  ]),
  '## Licences',
  '',
  ...[...all.values()].flatMap((entry) => [
    `### \`${entry.name}\` ${entry.version} — ${entry.license}`,
    '',
    '```text',
    entry.text,
    '```',
    '',
  ]),
].join('\n');

if (process.argv.includes('--check')) {
  const current = await readFile(NOTICES, 'utf8').catch(() => undefined);
  if (current !== document) {
    process.stderr.write(
      'THIRD-PARTY-NOTICES.md does not match the built bundles.\n' +
        'Run `pnpm run notices` and commit the result.\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `third-party notices verified: ${String(all.size)} inlined component(s)\n`,
  );
} else {
  await writeFile(NOTICES, document, 'utf8');
  process.stdout.write(
    `THIRD-PARTY-NOTICES.md written: ${
      String(all.size)
    } inlined component(s)\n`,
  );
}

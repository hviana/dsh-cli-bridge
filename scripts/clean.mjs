/**
 * Remove build output.
 *
 * A script rather than an inline `node -e`: the inline form relies on Node
 * exposing `fs` as a global, which is a convenience of the current runtime
 * rather than a contract, and this has to work on every machine that runs CI.
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const target of ['lib', '.tsbuildinfo', 'coverage']) {
  rmSync(join(root, target), { recursive: true, force: true });
}

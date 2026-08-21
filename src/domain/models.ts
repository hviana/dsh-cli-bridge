/**
 * The model catalog: which model names each delegate answers to.
 *
 * A caller — a person, or a model deciding for itself — names a model as a
 * short word (`opus`), as the vendor's full id (`claude-opus-5`), or as
 * something in between that it half remembers (`opus-5`, `Claude Opus 5`,
 * `claude-opus-5-20260101`). All four mean the same model, and only one of them
 * is a string the delegate CLI accepts. So this module is the one place that
 * turns any of those spellings into the canonical id, and the one place that can
 * say what the accepted names ARE — which is what lets every surface state them
 * up front instead of letting a caller guess and find out from a failed run.
 *
 * Two rules, both deliberate:
 *
 * - Matching is FORGIVING. Case, spaces, dots, dashes and a trailing date stamp
 *   are all noise; `Opus 5`, `opus-5` and `claude-opus-5` resolve identically.
 * - An unknown name is PASSED THROUGH, not refused. This catalog is a snapshot
 *   of names that existed when it was written, and a model released tomorrow
 *   must not be unusable because a list in here is a month old. What an unknown
 *   name earns is a warning beside the result, and a hint appended to the
 *   failure if the CLI does end up rejecting it.
 *
 * @module dsh-cli-bridge/domain/models
 */
import type { CliId } from '../shared/protocol.ts';

/** One model a delegate accepts, and the spellings that mean it. */
export interface ModelEntry {
  /** The canonical id, exactly as it is given to the CLI. */
  readonly id: string;
  /** Short spellings the caller may use instead, including the CLI's own aliases. */
  readonly aliases: readonly string[];
  /** One phrase on what it is for, shown wherever the catalog is listed. */
  readonly summary: string;
}

/**
 * The models each delegate is known to accept, best-first.
 *
 * "Best-first" is load-bearing: the first entry of each list is what every
 * surface offers as the obvious choice, so the order is the recommendation.
 *
 * Both vendors ship new models faster than a plugin ships releases, so treat
 * this as a HELP TEXT rather than a gate — {@link resolveModel} never refuses a
 * name that is missing from it. A deployment that wants a newer model listed
 * beside these adds it to `delegates.<cli>.extraModels`.
 */
export const MODEL_CATALOG: Readonly<Record<CliId, readonly ModelEntry[]>> = {
  claude: [
    {
      id: 'claude-opus-5',
      aliases: ['opus'],
      summary: 'the default choice for real coding work',
    },
    {
      id: 'claude-fable-5',
      aliases: ['fable'],
      summary: 'the most capable, for the hardest long-running work',
    },
    {
      id: 'claude-sonnet-5',
      aliases: ['sonnet'],
      summary: 'cheaper and quick, for well-specified work',
    },
    {
      id: 'claude-haiku-4-5',
      aliases: ['haiku'],
      summary: 'cheapest and fastest, for small mechanical work',
    },
    { id: 'claude-opus-4-8', aliases: [], summary: 'the previous Opus' },
    { id: 'claude-opus-4-7', aliases: [], summary: 'an older Opus' },
    { id: 'claude-sonnet-4-6', aliases: [], summary: 'the previous Sonnet' },
  ],
  codex: [
    {
      id: 'gpt-5.6-sol',
      aliases: ['sol'],
      summary: 'the default choice for difficult autonomous work',
    },
    {
      id: 'gpt-5.6-terra',
      aliases: ['terra'],
      summary: 'everyday engineering work',
    },
    {
      id: 'gpt-5.6-luna',
      aliases: ['luna'],
      summary: 'fast and focused, for small subtasks',
    },
    {
      id: 'gpt-5.2-codex',
      aliases: [],
      summary: 'the previous coding model',
    },
    {
      id: 'gpt-5.1-codex-max',
      aliases: [],
      summary: 'an older long-horizon coding model',
    },
  ],
};

/** A trailing vendor date stamp, which is noise on every id here. */
const DATE_SUFFIX = /[-_]?\d{8}$/u;

/** Everything that is not a letter or a digit, which is also noise. */
const PUNCTUATION = /[^a-z0-9]/gu;

/**
 * Reduce a model name to the form two spellings of one model share.
 *
 * `Claude Opus 5`, `claude-opus-5`, `claude_opus_5` and
 * `claude-opus-5-20260101` all reduce to `claudeopus5`, which is the whole
 * trick: the caller's punctuation and the vendor's date stamp stop being
 * differences that matter.
 * @param value - the name as it was written.
 * @returns the comparison key.
 */
export function normalizeModelKey(value: string): string {
  return value.trim().toLowerCase().replace(DATE_SUFFIX, '').replace(
    PUNCTUATION,
    '',
  );
}

/**
 * The vendor prefixes a caller drops when it writes a model name short.
 *
 * `opus-5` is `claude-opus-5` with the vendor's name left off — a spelling
 * nobody would call wrong, and one both a person and a model produce
 * constantly. Registering the stripped form as well is what makes it resolve
 * instead of reaching the CLI as an id it has never heard of.
 */
const VENDOR_PREFIXES: Readonly<Record<CliId, readonly string[]>> = {
  claude: ['claude-'],
  codex: ['gpt-'],
};

/** Every accepted key of one delegate, mapped to the canonical id. */
const KEYS: Readonly<Record<CliId, ReadonlyMap<string, string>>> = {
  claude: keysOf('claude'),
  codex: keysOf('codex'),
};

/**
 * Index one delegate's catalog by every spelling that resolves to it.
 *
 * The first entry to claim a key keeps it, so the catalog's own order decides
 * any collision rather than the map's insertion order deciding it by accident.
 * @param cli - the delegate to index.
 * @returns each accepted key mapped to a canonical id.
 */
function keysOf(cli: CliId): ReadonlyMap<string, string> {
  const keys = new Map<string, string>();
  const claim = (spelling: string, id: string): void => {
    const key = normalizeModelKey(spelling);
    if (key.length > 0 && !keys.has(key)) keys.set(key, id);
  };
  for (const entry of MODEL_CATALOG[cli]) {
    claim(entry.id, entry.id);
    for (const prefix of VENDOR_PREFIXES[cli]) {
      if (entry.id.startsWith(prefix)) {
        claim(entry.id.slice(prefix.length), entry.id);
      }
    }
    for (const alias of entry.aliases) claim(alias, entry.id);
  }
  return keys;
}

/** What a name resolved to, and whether the catalog recognized it. */
export interface ResolvedModel {
  /** The id to give the CLI: canonical when known, the caller's own text when not. */
  readonly model: string;
  /** Whether the name was recognized — by the catalog or by the deployment's own list. */
  readonly known: boolean;
}

/**
 * Resolve one model name for one delegate.
 *
 * An unknown name comes back UNCHANGED and flagged, never refused: the catalog
 * is a snapshot, and refusing a model this file has not heard of would make a
 * new release unusable until the plugin caught up. The flag is what the caller
 * turns into a warning, and into a hint if the run then fails.
 * @param cli - the delegate the model is for.
 * @param value - the name as the caller wrote it; blank counts as absent.
 * @param extra - model ids this deployment has declared as well.
 * @returns the id to use, or `undefined` when no model was named at all.
 */
export function resolveModel(
  cli: CliId,
  value: string | undefined,
  extra: readonly string[] = [],
): ResolvedModel | undefined {
  const written = value?.trim();
  if (written === undefined || written.length === 0) return undefined;
  const key = normalizeModelKey(written);
  const declared = extra.find((candidate) =>
    normalizeModelKey(candidate) === key
  );
  if (declared !== undefined) return { model: declared, known: true };
  const canonical = KEYS[cli].get(key);
  return canonical === undefined
    ? { model: written, known: false }
    : { model: canonical, known: true };
}

/**
 * The accepted names of one delegate, on one line.
 *
 * This is the string every surface states BEFORE a caller has to choose, which
 * is the whole point of having a catalog: naming a model correctly should never
 * require a failed run first.
 * @param cli - the delegate.
 * @param extra - model ids this deployment has declared as well.
 * @returns the names, canonical id first with its short alias in parentheses.
 */
export function modelChoices(
  cli: CliId,
  extra: readonly string[] = [],
): string {
  return [
    ...MODEL_CATALOG[cli].map((entry) =>
      entry.aliases.length === 0
        ? entry.id
        : `${entry.id} (or "${entry.aliases[0] ?? ''}")`
    ),
    ...extra,
  ].join(', ');
}

/**
 * The accepted names of one delegate, one per line, with what each is for.
 * @param cli - the delegate.
 * @param extra - model ids this deployment has declared as well.
 * @returns one line per model, for a human-facing listing.
 */
export function modelLines(
  cli: CliId,
  extra: readonly string[] = [],
): readonly string[] {
  return [
    ...MODEL_CATALOG[cli].map((entry) =>
      `${entry.id}${
        entry.aliases.length === 0 ? '' : ` (${entry.aliases.join(', ')})`
      } — ${entry.summary}`
    ),
    ...extra.map((id) => `${id} — configured for this deployment`),
  ];
}

/**
 * What to say about a model name the catalog does not recognize.
 *
 * Said the same way in both places it is needed — beside a result that used the
 * name, and appended to the failure if the CLI rejected it — because a caller
 * that has to correct a model name wants the accepted list, not a verdict.
 * @param cli - the delegate.
 * @param value - the name the caller wrote.
 * @param extra - model ids this deployment has declared as well.
 * @returns one sentence naming the accepted models.
 */
export function unknownModelHint(
  cli: CliId,
  value: string,
  extra: readonly string[] = [],
): string {
  return `${JSON.stringify(value)} is not a model ${cli} is known to accept.` +
    ` Known models: ${modelChoices(cli, extra)}.` +
    ' Leave model empty to use the default, or name one of those.';
}

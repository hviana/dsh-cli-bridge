import { describe, expect, it } from 'vitest';
import {
  MODEL_CATALOG,
  modelChoices,
  modelLines,
  normalizeModelKey,
  resolveModel,
  unknownModelHint,
} from '../../src/domain/models.ts';
import { CLI_IDS } from '../../src/shared/protocol.ts';

describe('resolveModel: the spellings one model answers to', () => {
  it.each([
    ['the canonical id', 'claude-opus-5'],
    ['the short alias the CLI itself accepts', 'opus'],
    ['the id without its vendor prefix', 'opus-5'],
    ['the same with no punctuation', 'opus5'],
    ['the same as a person writes it', 'Claude Opus 5'],
    ['the same shouted', 'CLAUDE-OPUS-5'],
    ['an underscored variant', 'claude_opus_5'],
    ['a hallucinated date stamp', 'claude-opus-5-20260101'],
  ])('resolves %s', (_label, written) => {
    // Every one of these is a spelling a caller actually produces, and only one
    // of them is a string Claude Code accepts.
    expect(resolveModel('claude', written)).toEqual({
      model: 'claude-opus-5',
      known: true,
    });
  });

  it('resolves each delegate on its own vocabulary', () => {
    expect(resolveModel('codex', 'sol')).toEqual({
      model: 'gpt-5.6-sol',
      known: true,
    });
    expect(resolveModel('claude', 'sonnet')).toEqual({
      model: 'claude-sonnet-5',
      known: true,
    });
    // Claude's alias means nothing to Codex, and must not be silently rewritten
    // into a model that delegate has never heard of.
    expect(resolveModel('codex', 'opus')).toEqual({
      model: 'opus',
      known: false,
    });
  });

  it('treats an absent or blank name as no model at all', () => {
    expect(resolveModel('claude', undefined)).toBeUndefined();
    expect(resolveModel('claude', '   ')).toBeUndefined();
  });

  it('passes an unrecognized name through, flagged rather than refused', () => {
    // The catalog is a snapshot; a model released after this plugin must still
    // be usable, so the caller's own text survives and the flag is what earns it
    // a warning beside the result.
    expect(resolveModel('claude', ' some-future-model ')).toEqual({
      model: 'some-future-model',
      known: false,
    });
  });

  it('counts a deployment’s own model ids as recognized', () => {
    expect(resolveModel('claude', 'deepseek-chat', ['deepseek-chat'])).toEqual({
      model: 'deepseek-chat',
      known: true,
    });
    // And it is matched as forgivingly as a built-in one, keeping the spelling
    // the deployment declared.
    expect(resolveModel('claude', 'DeepSeek Chat', ['deepseek-chat'])).toEqual({
      model: 'deepseek-chat',
      known: true,
    });
  });
});

describe('the catalog itself', () => {
  it.each([...CLI_IDS])('offers %s a first choice and no id twice', (cli) => {
    const entries = MODEL_CATALOG[cli];
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((entry) => entry.id)).size)
      .toBe(entries.length);
  });

  it.each([...CLI_IDS])('gives %s no two models the same spelling', (cli) => {
    // A collision would make one model unreachable by its own alias, silently.
    const spellings = MODEL_CATALOG[cli].flatMap((entry) => [
      entry.id,
      ...entry.aliases,
    ]);
    const keys = spellings.map(normalizeModelKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.each([...CLI_IDS])('resolves every %s spelling to its own id', (cli) => {
    for (const entry of MODEL_CATALOG[cli]) {
      for (const spelling of [entry.id, ...entry.aliases]) {
        expect(resolveModel(cli, spelling)).toEqual({
          model: entry.id,
          known: true,
        });
      }
    }
  });
});

describe('what a caller is told before it has to choose', () => {
  it('names the canonical id first, with its short form', () => {
    expect(modelChoices('claude')).toContain('claude-opus-5 (or "opus")');
  });

  it('appends a deployment’s own ids to the offer', () => {
    expect(modelChoices('claude', ['deepseek-chat'])).toContain(
      'deepseek-chat',
    );
  });

  it('says what each model is for, one per line', () => {
    const lines = modelLines('codex', ['house-model']);
    expect(lines[0]).toMatch(/^gpt-5\.6-sol \(sol\) — /u);
    expect(lines.at(-1)).toBe('house-model — configured for this deployment');
  });

  it('turns an unknown name into the accepted ones', () => {
    const hint = unknownModelHint('claude', 'opus-9');
    expect(hint).toContain('"opus-9" is not a model claude is known to accept');
    expect(hint).toContain('claude-opus-5');
    expect(hint).toContain('Leave model empty to use the default');
  });
});

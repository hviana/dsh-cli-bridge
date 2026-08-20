/**
 * The composition root's outside world.
 *
 * Everything the runtime treats as a port is bound to something real here, and
 * only here: the harness's subprocess seam, the local filesystem, the harness's
 * credential seam, and the clock.
 *
 * @module dsh-cli-bridge/host/node-ports
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { CredentialRef } from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-llm';
import type { UserQuestionsPort } from '../runtime/inquiry.ts';
import type { FilePort, RuntimePorts } from '../runtime/ports.ts';

/** Local filesystem, with the durability the account registry needs. */
export const nodeFiles: FilePort = {
  async readText(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },

  /**
   * Write through a temporary file in the same directory, then rename.
   *
   * The rename is what makes it atomic: a reader sees either the old document
   * or the new one, never a half-written registry. The rename is retried a few
   * times because a concurrent writer can hold the destination for a moment,
   * which surfaces as a transient `EPERM`/`EBUSY` rather than a real failure.
   */
  async writeText(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const staging = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(staging, text, 'utf8');
      await renameOver(staging, path);
    } catch (error) {
      await rm(staging, { force: true }).catch(() => undefined);
      throw error;
    }
  },

  async makeDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },

  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  },
};

/**
 * Bind the runtime's ports to this harness context.
 *
 * `ctx.subprocess` is passed straight through: the port was defined in the
 * harness's own subprocess vocabulary precisely so no adapter is needed, and so
 * a composition that mounts a remote-sandbox provider moves the delegate CLIs
 * into that sandbox with it.
 *
 * The model seam and the user-questions seam are both OPTIONAL, and their
 * absence is meaningful rather than degraded: without a model there is nothing
 * to make an autonomous decision with, and without a way to reach the human
 * there is nobody to ask. The delegation loop reads both absences as "stop and
 * report" instead of guessing.
 * @param ctx - the host plugin context.
 * @returns the bound ports.
 */
export function nodePorts(ctx: Context): RuntimePorts {
  const credentials = ctx.get('credentials');
  const llm = ctx.get('llm');
  const questions = userQuestionsOf(ctx);
  return {
    process: ctx.subprocess,
    files: nodeFiles,
    now: () => Date.now(),
    platform: process.platform,
    nodePath: process.execPath,
    ...llm === undefined ? {} : { llm },
    ...questions === undefined ? {} : { questions },
    ...credentials === undefined ? {} : {
      credentials: {
        async resolve(ref: string): Promise<string | undefined> {
          // A reference is a branded environment-variable name. Branding it
          // here rather than importing the brand's constructor keeps the
          // credential package a types-only dependency; the shape is validated
          // where an account is created.
          return (await credentials.resolve(ref as CredentialRef))?.value;
        },
      },
    },
  };
}

/**
 * The harness's user-questions seam, when this composition mounts it.
 *
 * Its declarations ship in a harness package that is not published yet, so the
 * seam is resolved by the one call the inquiry port makes rather than by
 * importing a type that cannot be installed. It still goes through `get`, so a
 * service mounted after this plugin is resolved the same way every other
 * optional seam is.
 * @param ctx - the host plugin context.
 * @returns the seam, or `undefined` when the composition has none.
 */
function userQuestionsOf(ctx: Context): UserQuestionsPort | undefined {
  // Widened at the call site, not by detaching `get`: it is a method, and it
  // needs the context as its receiver.
  return (ctx as unknown as {
    get(name: string): UserQuestionsPort | undefined;
  }).get('userQuestions');
}

/** Whether a filesystem error means "there is nothing there". */
function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Rename over any existing destination, retrying a transient lock.
 *
 * A rename can briefly fail with `EPERM`/`EBUSY`/`EEXIST` when another writer
 * is replacing the same destination at the same instant; a short back-off
 * absorbs that race without masking a genuine failure.
 * @param from - the staging file.
 * @param to - the final path.
 */
async function renameOver(
  from: string,
  to: string,
  attempt = 0,
): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isTransientLock(error) || attempt >= 4) throw error;
    await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    await renameOver(from, to, attempt + 1);
  }
}

/** Whether a rename failure is a transient lock rather than a real error. */
function isTransientLock(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' ||
    code === 'EEXIST';
}

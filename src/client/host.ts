/**
 * The slice of the harness client runtime the browser half uses.
 *
 * `@deepseek-ai/dsh-client-runtime` cannot currently be installed from npm — its
 * published manifest names a dependency that was never published — so the two
 * calls this plugin makes are declared here instead of imported. The shapes
 * mirror the harness's own registrants exactly (`ctx.slots.inject(key, () =>
 * ctx.slots.register({ name, key }, Component))`), and the specifier stays a
 * module-table row at runtime, so the browser still receives the real service.
 *
 * The component props are NOT hand-written: they come from
 * `@deepseek-ai/dsh-client-ui-tool`, which does install, so the one contract
 * that would actually break a render is checked by the compiler.
 *
 * @module dsh-cli-bridge/client/host
 */
import type { ReactNode } from 'react';

/** One synchronous effect installed while an injected slot declaration is live. */
export type SlotInjectionEffect =
  | (() => void)
  | Iterable<() => void, void, void>;

/** The registration face, erased: the typed overloads live in the harness. */
export interface SlotsFace {
  /**
   * Run a registration while the named slot is declared, re-running it if the
   * declaring plugin reloads.
   * @param key - the slot to follow.
   * @param callback - performs the registration and yields its disposers.
   * @returns disposer retiring the injection.
   */
  inject(key: string, callback: () => SlotInjectionEffect): () => void;
  /**
   * Contribute a component to a declared slot.
   * @param options - target `name`, plus the shape fields of that slot's kind.
   * @param component - the view.
   * @returns disposer removing the contribution.
   */
  register(
    options: { name: string; key?: string; id?: string; order?: number },
    component: unknown,
  ): () => void;
}

/** The client context, as far as this plugin needs to know. */
export interface ClientHost {
  readonly slots: SlotsFace;
  /**
   * Register an effect owned by this plugin's fiber.
   * @param factory - performs the effect and returns its disposer.
   * @param label - diagnostic label.
   */
  effect(factory: () => (() => void) | undefined, label?: string): void;
}

/** A React component, as the erased registration face accepts it. */
export type View<P> = (props: P) => ReactNode;

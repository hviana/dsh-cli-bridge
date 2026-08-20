/**
 * The browser half's stylesheet.
 *
 * One inlined string, injected once, scoped under a single class prefix. The
 * harness's own UI packages compile CSS Modules through its build; an
 * out-of-tree plugin would have to reproduce that pipeline, and a plain
 * stylesheet with a prefix is the smaller honest answer. Every colour is
 * inherited or derived from `currentColor`, so the plugin follows the harness
 * theme instead of guessing at it.
 *
 * @module dsh-cli-bridge/client/styles
 */

/** Class prefix owned by this plugin. */
export const CSS_PREFIX = 'dsh-cli-bridge';

/** Attribute marking the injected style element, so injection is idempotent. */
const STYLE_MARKER = 'data-dsh-cli-bridge';

/**
 * The stylesheet.
 *
 * Every rule below is written for two properties at once: it must never force a
 * horizontal scrollbar, and it must keep working as the content grows. Text that
 * carries delegate output, a direction, a URL, or a model name can be arbitrarily
 * long and arbitrarily unbroken, so it is always given `overflow-wrap: anywhere`
 * and the flex items that hold it are always allowed to shrink (`min-width: 0`).
 * Scrollable regions (`log`, `panel`) bound their own height so dynamic content
 * grows a scrollbar instead of the page.
 */
export const STYLES = `
.${CSS_PREFIX}-row { display: flex; flex-direction: column; gap: 6px; font-size: 12px; line-height: 1.5; }
.${CSS_PREFIX}-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.${CSS_PREFIX}-title { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
.${CSS_PREFIX}-badge {
  border: 1px solid currentColor; border-radius: 999px; padding: 0 6px;
  font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.75; white-space: nowrap;
}
.${CSS_PREFIX}-badge[data-status="running"], .${CSS_PREFIX}-badge[data-status="starting"] { opacity: 1; }
.${CSS_PREFIX}-badge[data-status="failed"] { color: #d64545; }
.${CSS_PREFIX}-badge[data-status="needs_direction"] { color: #c98a1b; }
.${CSS_PREFIX}-badge[data-status="completed"] { color: #2f855a; }
.${CSS_PREFIX}-badge[data-status="awaiting-human"] { color: #c98a1b; opacity: 1; }
.${CSS_PREFIX}-delegation {
  display: flex; flex-direction: column; gap: 8px;
  padding: 8px 0; border-top: 1px solid currentColor;
}
.${CSS_PREFIX}-delegation:first-of-type { border-top: none; }
.${CSS_PREFIX}-delegation[data-status="awaiting-human"] { border-left: 2px solid #c98a1b; padding-left: 8px; }
.${CSS_PREFIX}-merge { font-size: 11px; opacity: 0.7; overflow-wrap: anywhere; }
.${CSS_PREFIX}-merge[data-merge="conflict"], .${CSS_PREFIX}-merge[data-merge="failed"] { color: #d64545; opacity: 1; }
.${CSS_PREFIX}-merge[data-merge="merged"] { color: #2f855a; opacity: 1; }
.${CSS_PREFIX}-decisions { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.${CSS_PREFIX}-decision { display: flex; gap: 6px; align-items: baseline; opacity: 0.7; font-size: 11px; }
.${CSS_PREFIX}-direction { border-left: 2px solid currentColor; padding-left: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.${CSS_PREFIX}-meta { opacity: 0.6; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; min-width: 0; }
.${CSS_PREFIX}-activities { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.${CSS_PREFIX}-activity { display: flex; gap: 6px; align-items: baseline; }
.${CSS_PREFIX}-activity-kind { opacity: 0.5; min-width: 62px; font-size: 10px; text-transform: uppercase; flex-shrink: 0; }
.${CSS_PREFIX}-activity-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.${CSS_PREFIX}-activity[data-tone="error"] .${CSS_PREFIX}-activity-text { color: #d64545; }
.${CSS_PREFIX}-activity[data-tone="warn"] .${CSS_PREFIX}-activity-text { color: #c98a1b; }
.${CSS_PREFIX}-activity[data-tone="reasoning"] .${CSS_PREFIX}-activity-text { opacity: 0.65; font-style: italic; }
.${CSS_PREFIX}-question { border-left: 2px solid #c98a1b; padding-left: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.${CSS_PREFIX}-log {
  margin: 0; padding: 8px; max-height: 320px; overflow: auto;
  border: 1px solid currentColor; border-radius: 6px; opacity: 0.9;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  white-space: pre-wrap; overflow-wrap: anywhere;
  overscroll-behavior: contain;
}
.${CSS_PREFIX}-toggle {
  background: none; border: none; padding: 0; cursor: pointer;
  color: inherit; font: inherit; text-decoration: underline; opacity: 0.7;
}
.${CSS_PREFIX}-panel {
  position: absolute; right: 16px; bottom: 16px; pointer-events: auto; z-index: 30;
  display: flex; flex-direction: column; gap: 10px;
  max-width: min(520px, calc(100vw - 32px)); max-height: min(70vh, 720px); overflow: auto;
  padding: 12px 14px; border: 1px solid currentColor; border-radius: 10px;
  background: Canvas; color: CanvasText; font-size: 12px;
  box-shadow: 0 8px 32px rgb(0 0 0 / 18%);
  overscroll-behavior: contain;
}
.${CSS_PREFIX}-pill {
  position: absolute; right: 16px; bottom: 16px; pointer-events: auto; z-index: 30;
  padding: 6px 12px; border: 1px solid currentColor; border-radius: 999px;
  background: Canvas; color: CanvasText; font-size: 11px; cursor: pointer;
}
.${CSS_PREFIX}-pill[data-asking="true"] { color: #c98a1b; font-weight: 600; }
.${CSS_PREFIX}-section { display: flex; flex-direction: column; gap: 4px; }
.${CSS_PREFIX}-section > h4 { margin: 0; font-size: 11px; text-transform: uppercase; opacity: 0.55; }
.${CSS_PREFIX}-line { display: flex; align-items: center; gap: 8px; justify-content: space-between; flex-wrap: wrap; }
.${CSS_PREFIX}-label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.${CSS_PREFIX}-actions { display: flex; gap: 6px; flex-shrink: 0; margin-left: auto; }
.${CSS_PREFIX}-button {
  border: 1px solid currentColor; border-radius: 6px; padding: 1px 8px;
  background: none; color: inherit; font: inherit; font-size: 11px; cursor: pointer;
  white-space: nowrap;
}
.${CSS_PREFIX}-button:disabled { opacity: 0.4; cursor: default; }
.${CSS_PREFIX}-input {
  flex: 1; min-width: 0; border: 1px solid currentColor; border-radius: 6px;
  padding: 2px 6px; background: none; color: inherit; font: inherit; font-size: 11px;
}
.${CSS_PREFIX}-error { color: #d64545; white-space: pre-wrap; overflow-wrap: anywhere; }
.${CSS_PREFIX}-button:focus-visible,
.${CSS_PREFIX}-input:focus-visible,
.${CSS_PREFIX}-toggle:focus-visible,
.${CSS_PREFIX}-pill:focus-visible {
  outline: 2px solid currentColor; outline-offset: 2px;
}
@media (max-width: 560px) {
  .${CSS_PREFIX}-form .${CSS_PREFIX}-line { flex-direction: column; align-items: stretch; }
  .${CSS_PREFIX}-actions { margin-left: 0; }
}
`;

/**
 * Inject the stylesheet once.
 *
 * The plugin's own module body runs at materialization, so this is called from
 * `apply` and removed by its disposer — a reload replaces the tag instead of
 * stacking a second copy.
 * @returns the disposer removing the injected element.
 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {};
  const existing = document.querySelector(`style[${STYLE_MARKER}]`);
  if (existing !== null) {
    return () => {
      existing.remove();
    };
  }
  const element = document.createElement('style');
  element.setAttribute(STYLE_MARKER, '');
  element.textContent = STYLES;
  document.head.append(element);
  return () => {
    element.remove();
  };
}

/**
 * Build a prefixed class name.
 * @param names - suffixes to join.
 * @returns the space-separated class list.
 */
export function cls(...names: (string | false | undefined)[]): string {
  return names.filter((name): name is string =>
    typeof name === 'string' && name.length > 0
  )
    .map((name) => `${CSS_PREFIX}-${name}`)
    .join(' ');
}

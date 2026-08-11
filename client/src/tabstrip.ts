import { useRef, type KeyboardEvent } from 'react';

/**
 * The ARIA tabs pattern, in one place.
 *
 * There are four tab strips in this app — the viewer's days, the panel's tabs,
 * the roster's sections, the schedule's days — and every one of them was
 * declaring `role="tab"` (or, worse, `aria-selected` with no role at all)
 * without implementing what those roles promise. That is worse than plain
 * buttons: a screen reader announces "tab, 2 of 5", the user presses the arrow
 * key that announcement invites, and nothing moves. Plain buttons at least
 * describe themselves honestly.
 *
 * What the pattern requires, and what this supplies:
 *
 *  - **One tab stop for the whole strip**, not one per tab. Six days would
 *    otherwise be six presses of Tab between the schedule and the contact
 *    card. That is the roving `tabIndex`.
 *  - **Arrow keys move within the strip**, wrapping, with Home and End for the
 *    ends.
 *  - **Selection follows focus.** Every panel here is rendered from data
 *    already in hand, so there is nothing to load and no reason to make
 *    someone press Enter as well.
 *
 * Callers keep rendering their own markup; `aria-selected` stays on the
 * element, which is what both `.daytab` and `.admin-tab` style off.
 */
export function useTabStrip<T extends string>(
  keys: readonly T[],
  active: T | null,
  onSelect: (key: T) => void,
) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const handled = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
    if (!handled.includes(e.key) || keys.length < 2) return;
    e.preventDefault();
    const from = Math.max(0, keys.indexOf(active as T));
    const to =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? keys.length - 1
          : // Wrap, so the strip has no dead ends.
            (from + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length;
    onSelect(keys[to]);
    // Selection follows focus, so focus stays on the strip rather than moving
    // to the panel. Read from the DOM because the re-render has not happened
    // yet — this runs inside the event, before React flushes the new state.
    stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[to]?.focus();
  };

  return {
    /** Spread onto the element carrying `role="tablist"`. */
    tablistProps: { ref: stripRef, role: 'tablist' as const, onKeyDown },
    /** Spread onto each tab button. */
    tabProps: (key: T) => ({
      role: 'tab' as const,
      'aria-selected': active === key,
      tabIndex: active === key ? 0 : -1,
      onClick: () => onSelect(key),
    }),
  };
}

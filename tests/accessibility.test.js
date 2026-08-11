/**
 * The measured half of item 21.
 *
 * The device matrix — real iOS Safari, real Android, lock/wake, battery — is
 * hardware work and lives in `docs/device-matrix.md`. What *can* be pinned
 * here is the part that silently rots: the palette. Every failure this file
 * guards against was in the codebase and invisible, because low contrast does
 * not throw, does not fail a typecheck, and looks fine to whoever picked it on
 * a bright laptop. It shows up in a dark venue on a phone at arm's length.
 *
 * The stylesheet is parsed rather than mocked, so these assert the values that
 * actually ship. Adjusting a colour is fine; adjusting it below the floor
 * fails here with the number it landed on.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = readFileSync(
  fileURLToPath(new URL('../client/src/styles.css', import.meta.url)),
  'utf8',
);

/* ------------------------------ colour maths ------------------------------ */

function rgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** WCAG relative luminance. */
function luminance(c) {
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(c[0]) + 0.7152 * chan(c[1]) + 0.0722 * chan(c[2]);
}

function contrast(fg, bg) {
  const a = luminance(rgb(fg));
  const b = luminance(rgb(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* ---------------------------- reading the sheet ---------------------------- */

/** The custom properties declared on `:root`. */
function rootVars(css) {
  const block = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, ':root block not found in styles.css');
  const vars = {};
  for (const [, name, value] of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    vars[name] = value.trim();
  }
  return vars;
}

const VARS = rootVars(CSS);
const color = (name) => {
  const v = VARS[name];
  assert.ok(v, `${name} is not declared on :root`);
  assert.match(v, /^#[0-9a-f]{3,8}$/i, `${name} is not a plain hex colour (${v})`);
  return v;
};

/* ------------------------------ the contract ------------------------------ */

/**
 * Backgrounds a given text colour is actually painted on, gradients included
 * — a gradient is only as good as its lighter stop, so both ends are listed.
 */
const SURFACES = {
  page: '#0d0b14', // --bg
  card: '#17141f', // --bg-raised
  cardAlt: '#201c2b', // --bg-raised-2
  heroTop: '#241d33',
  heroBottom: '#171320',
  heroNowTop: '#3a2d16',
  heroNowBottom: '#1d1726',
  blockNowTop: '#2a2214',
  blockNowBottom: '#1a1622',
};

describe('palette contrast (item 21)', () => {
  test('the surfaces the sheet paints on are the ones tested here', () => {
    // If someone restyles a card, this fails before the ratios go stale.
    assert.equal(color('--bg'), SURFACES.page);
    assert.equal(color('--bg-raised'), SURFACES.card);
    assert.equal(color('--bg-raised-2'), SURFACES.cardAlt);
    for (const stop of ['#241d33', '#171320', '#3a2d16', '#1d1726', '#2a2214', '#1a1622']) {
      assert.ok(CSS.includes(stop), `gradient stop ${stop} is no longer in styles.css`);
    }
  });

  test('--text clears AA everywhere it lands', () => {
    for (const [where, bg] of Object.entries(SURFACES)) {
      const ratio = contrast(color('--text'), bg);
      assert.ok(ratio >= 4.5, `--text on ${where} is ${ratio.toFixed(2)}:1, needs 4.5`);
    }
  });

  test('--text-dim clears AA everywhere it lands', () => {
    for (const [where, bg] of Object.entries(SURFACES)) {
      const ratio = contrast(color('--text-dim'), bg);
      assert.ok(ratio >= 4.5, `--text-dim on ${where} is ${ratio.toFixed(2)}:1, needs 4.5`);
    }
  });

  /**
   * The one that was broken. `--text-faint` is used at 11–13px — `.tiny`,
   * `.block-time .end`, `.stat .k`, `.chip-kind`, `.tmpl th` — which is
   * ordinary text under WCAG, not large text, so it needs the full 4.5:1. At
   * #7a7190 it was 3.6–4.3:1 on the surfaces it sits on.
   *
   * The hero gradients are excluded because nothing faint is drawn on them;
   * if that changes, the exclusion is what should be revisited.
   */
  test('--text-faint clears AA at the small sizes it is used at', () => {
    const used = ['page', 'card', 'cardAlt', 'blockNowTop', 'blockNowBottom'];
    for (const where of used) {
      const ratio = contrast(color('--text-faint'), SURFACES[where]);
      assert.ok(ratio >= 4.5, `--text-faint on ${where} is ${ratio.toFixed(2)}:1, needs 4.5`);
    }
  });

  /**
   * WCAG 1.4.11: the boundary of a control has to be perceivable, because it
   * is what tells you the thing is a control. `--line` is 1.4:1 against the
   * page and was carrying every input, button and tappable card.
   */
  test('--line-strong clears 3:1 as a control boundary', () => {
    for (const where of ['page', 'card', 'cardAlt']) {
      const ratio = contrast(color('--line-strong'), SURFACES[where]);
      assert.ok(ratio >= 3, `--line-strong on ${where} is ${ratio.toFixed(2)}:1, needs 3`);
    }
  });

  test('the focus ring clears 3:1 against the page and every card', () => {
    for (const where of ['page', 'card', 'cardAlt']) {
      const ratio = contrast(color('--gold'), SURFACES[where]);
      assert.ok(ratio >= 3, `focus ring on ${where} is ${ratio.toFixed(2)}:1, needs 3`);
    }
  });

  test('text on a gold fill clears AA', () => {
    // .btn.primary, .daytab[aria-selected], .badge.now all ink on --gold.
    const ratio = contrast('#2a2109', color('--gold'));
    assert.ok(ratio >= 4.5, `ink on gold is ${ratio.toFixed(2)}:1, needs 4.5`);
  });

  test('--line stays decorative — it is not strong enough to bound a control', () => {
    // Not a style preference: this is what stops --line drifting back onto
    // inputs and buttons on the grounds that it "looks the same".
    const ratio = contrast(color('--line'), SURFACES.page);
    assert.ok(
      ratio < 3,
      `--line is now ${ratio.toFixed(2)}:1 — if it is this strong, use it and drop --line-strong`,
    );
  });
});

describe('stylesheet invariants (item 21)', () => {
  /**
   * `.input:focus-visible` referenced `var(--accent, #8b5cf6)` and `--accent`
   * was never declared anywhere, so the app painted a violet that is not in
   * the palette — for as long as nobody looked. A typo in a custom property
   * is silent by design; this is the only thing that makes it loud.
   */
  test('every custom property used is declared or carries a fallback', () => {
    const undeclared = new Set();
    for (const [, name, rest] of CSS.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,[^)]*)?\)/g)) {
      if (!VARS[name] && !rest) undeclared.add(name);
    }
    assert.deepEqual([...undeclared], [], 'used but never declared on :root');
  });

  /**
   * `viewport-fit=cover` is set in index.html, which is what makes the safe
   * area non-zero — and what puts the notch and the rounded corner over the
   * left or right edge in landscape. A gutter that only carries top and
   * bottom clips its text there.
   */
  test('every full-width gutter carries the left and right safe area', () => {
    for (const selector of ['.screen', '.topbar', '.landing', '.admin']) {
      const rule = CSS.match(new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\n\\}`));
      assert.ok(rule, `${selector} not found`);
      const padding = rule[1].match(/padding:[\s\S]*?;/)?.[0] ?? '';
      assert.match(padding, /--safe-left/, `${selector} padding drops the left safe area`);
      assert.match(padding, /--safe-right/, `${selector} padding drops the right safe area`);
    }
  });

  test('the safe-area variables come from env() with a zero fallback', () => {
    for (const side of ['top', 'bottom', 'left', 'right']) {
      assert.match(
        VARS[`--safe-${side}`] ?? '',
        /^env\(safe-area-inset-\w+,\s*0px\)$/,
        `--safe-${side} must be env(...) with an explicit 0px fallback`,
      );
    }
  });

  /** Apple's HIG floor. `.btn.sm` — "Not you?", "Sign out" — was 38px. */
  test('the compact controls are at least 44px tall', () => {
    assert.equal(VARS['--tap-min'], '44px');
    for (const selector of ['.btn.sm', '.admin-tab']) {
      const rule = CSS.match(new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\n\\}`));
      assert.ok(rule, `${selector} not found`);
      assert.match(
        rule[1],
        /min-height:\s*var\(--tap-min\)/,
        `${selector} sets its own height instead of the shared floor`,
      );
    }
  });

  /**
   * A finished block is content people scroll back to, not disabled chrome,
   * so it cannot be faded into illegibility. Element opacity fades the text
   * and the card it sits on together, which no colour choice can rescue.
   */
  test('past blocks are dimmed without opacity', () => {
    const rule = CSS.match(/\.block\.is-past\s*\{([\s\S]*?)\n\}/);
    assert.ok(rule, '.block.is-past not found');
    assert.doesNotMatch(
      rule[1],
      /opacity/,
      '.block.is-past is fading itself again — that took its text to 1.7:1',
    );
  });

  test('the reduced-motion escape hatch is still there', () => {
    assert.match(CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  /** iOS Safari zooms the page when a focused field is under 16px. */
  test('no text input is smaller than 16px', () => {
    for (const selector of ['.input', '.search', '.field input']) {
      const rule = CSS.match(new RegExp(`\\${selector.replace(' ', '[\\s\\S]*?')}[\\s\\S]*?\\{([\\s\\S]*?)\\n\\}`));
      assert.ok(rule, `${selector} not found`);
      const size = rule[1].match(/font-size:\s*(\d+)px/)?.[1];
      assert.ok(size, `${selector} declares no font-size`);
      assert.ok(Number(size) >= 16, `${selector} is ${size}px — iOS will zoom on focus`);
    }
  });
});

# Devices and accessibility — item 21

Item 21 has two halves. This file holds both: what was audited and fixed in
software on 2026-08-11, and the checks that **only real hardware can settle**,
written as a checklist to run before the dress rehearsal (item 26).

The split is not arbitrary. Everything below the line marked **hardware** fails
in ways a desktop browser at a phone-sized viewport cannot reproduce: the notch,
the radio, the real Safari, the battery.

---

## Part 1 — Accessibility audit (done)

Audited against WCAG 2.1 AA, on the viewer first — that is the surface 280
people meet on their own phones — and then the admin panel, which shares the
stylesheet and therefore most of the findings.

`npm test` includes [`tests/accessibility.test.js`](../tests/accessibility.test.js),
which parses the shipped stylesheet and fails on the ratios rather than
trusting a comment. Every fix below that can be pinned by a number is pinned.

### What was wrong, and what it now is

| Finding | Was | Now |
| --- | --- | --- |
| `--text-faint` at 11–13px | 3.6–4.3:1 — below AA on every surface it lands on | `#948aae`, ≥4.9:1 everywhere it is used |
| Finished blocks (`.block.is-past`) | `opacity: .45` — end time 1.7:1, location 2.4:1 | no opacity; the card drops its raised fill and the heading dims to `--text-dim` (≥6:1) |
| Control boundaries (`.input`, `.btn`, `.contact-btn`, `.choice`, `.search`, `.filedrop`) | `--line`, 1.4:1 — an input indistinguishable from the page it sits on | `--line-strong` `#716789`, ≥3.2:1 (WCAG 1.4.11) |
| Focus indicator | none declared app-wide; `.input` referenced `var(--accent)`, **never declared anywhere** | one `:focus-visible` rule, gold, 3px, 2px offset — 11.7:1 on the page |
| Disabled primary button | `opacity: .45` — its own label at 2.9:1 against its own fill | `opacity: .7`, 5.4:1, still visibly unavailable |
| `.btn.sm` ("Not you?", "Sign out") | 38px tall | 44px (`--tap-min`) |
| Schedule screen headings | **none at all** — every heading was a `div` | `h1` subject · `h2` now/next · `h2` full schedule · `h2` contact |
| Landmarks | `<header>` only | `<header>` + `<main>` on every screen |
| Schedule blocks | a flat run of `div`s with no boundaries | `<ul>`/`<li>`, labelled with the day |
| Day tabs | `role="tab"` with no roving tabindex, no arrow keys, no panel | full ARIA tabs pattern, shared by all four strips |
| Roster and Schedule panel strips | `aria-selected` on a plain button — **not valid ARIA** | real tab strips |
| Contact links | "📞 Call" — reads as "telephone receiver Call", and says nothing about whom | "Call Jordan Kimura"; the glyph is `aria-hidden` |
| Offline / schedule-changed banners | appeared silently | `role="status"` — a change announces itself |
| Screen changes (code → identity → schedule) | focus dropped to `<body>`; next Tab restarted at the address bar | focus moves to the new screen's `h1` |
| "Finished" state of a past block | conveyed by dimming alone | plus a visually hidden "Finished." |
| Loading screens | four of eight were a bare spinning `<span>` — nothing at all to a screen reader | one `Loading` component, always labelled, `role="status"` |
| Landscape safe area | `env(safe-area-inset-left/right)` **never used**, though `viewport-fit=cover` is set | all four gutters carry left and right |
| `100dvh` | no fallback | `100vh` first, for anything predating iOS 15.4 |

### The four tab strips are now one implementation

[`client/src/tabstrip.ts`](../client/src/tabstrip.ts). There were four
half-built copies of the ARIA tabs pattern, and a half-built one is worse than
plain buttons: the role tells a screen reader "tab, 2 of 5", the user presses
the arrow key that invites, and nothing happens. One tab stop per strip, arrow
keys with wrap, Home/End, selection following focus.

### Verified in the browser, not just implemented

At 375×812 and 320×568, signed in as a real captain against the seed data:

- accessibility tree: `banner` → `h1` → `main` → `h2 Right now` → `h2 Full
  schedule` → `tablist` → `tabpanel` → `list` of 7 `listitem`s → `h2` contact →
  three named links.
- arrow keys, Home and End move the day strip; `aria-selected`, the roving
  `tabIndex`, the panel's `aria-labelledby` and the rendered blocks all follow.
- six tab stops on the whole schedule screen, none under 44px.
- no horizontal overflow at 320px.
- the gold focus ring paints on real keyboard focus and not on tap.
- focus lands on the destination heading after picking a name, after "Not
  you?", and after "Use a different code" — and deliberately *not* on first
  load.

### Known and deliberately not changed

- **Font sizes are in `px`, not `rem`.** Browser zoom works, so this is not a
  1.4.4 failure, but it means the OS text-size setting does not scale the app on
  Android. Converting the sheet is a wide, risky change this close to the event;
  it belongs after the retro, not before the freeze.
- **No skip link.** The schedule screen has six focusable elements in total.
  There is nothing to skip.
- **The admin panel was audited, not redesigned.** It inherits every palette,
  focus and target fix, and its four tab strips are correct. Its tables and
  forms have not had a full pass — it is used by a handful of people on
  laptops, not by 280 people on phones.

---

## Part 2 — Hardware checks (yours)

**None of these can be settled in a desktop browser at a phone-sized viewport.**
Run them on real devices before item 26, and record the result in this file.

⚠️ Run them *before* the rehearsal, not during it. The rehearsal is a room full
of people whose attention lasts about ninety minutes, and it is testing whether
changes reach phones — not whether one phone renders a notch correctly. A
hardware fault found there costs the room; found here it costs an evening. The
rehearsal's own script is [dress-rehearsal.md](dress-rehearsal.md), and it asks
for the phone model against every finding so the two files stay joined up.

Minimum matrix — one row each, the two that matter most first:

| Device | OS / browser | Owner | Date | Result |
| --- | --- | --- | --- | --- |
| iPhone with a notch or Dynamic Island | iOS Safari, current | | | |
| Android phone | Chrome, current | | | |
| Older iPhone (SE or similar, 375pt) | iOS Safari | | | |
| iPad or tablet | Safari / Chrome | | | |

### 1. Safe-area insets — the reason this is on hardware

The CSS is in place and the maths is right, but `env(safe-area-inset-*)`
resolves to `0px` in every desktop browser, so **the fixed code is literally
untested until it runs on a notched phone.**

- [ ] Portrait: the top bar clears the status bar and the notch; the last block
      and the contact card clear the home indicator.
- [ ] **Landscape** — the case that was broken, and the one people forget to
      check: rotate on a notched iPhone and confirm no text sits under the
      camera cutout or the rounded corner, on the schedule *and* on the sign-in
      screen.
- [ ] Add to Home Screen, then reopen: standalone mode has different insets
      from the browser (`apple-mobile-web-app-status-bar-style` is
      `black-translucent`, which puts content under the status bar).

### 2. `tel:` and `sms:` actually dialling

The hrefs are built by stripping everything but digits and `+`
(`ContactCard.tsx`). That the *link* is well-formed is verifiable here; that
the *phone* does something useful with it is not.

- [ ] iOS Safari: **Call** opens the dialler with the right number pre-filled.
- [ ] iOS Safari: **Text** opens Messages with the right recipient.
- [ ] Android Chrome: both, same.
- [ ] Check against a **real contact number from the real roster**, not the
      seed's `+15550112` — the seed numbers are synthetic and eleven digits
      short of the formats item 12's parser has to handle.
- [ ] Email opens the mail app with the address filled in.

### 3. Socket survival across lock and wake

`live.ts` reconnects on `visibilitychange` and `online`, and refetches on both.
Desktop tab-switching exercises the same code path but not the same platform
behaviour: iOS freezes the whole process, and the socket is usually dead by the
time the screen comes back.

- [ ] Open the schedule, lock the phone, wait **5 minutes**, unlock: the
      schedule is current, the dot is green, and no reload was needed.
- [ ] Same at **30 minutes** and at **2 hours** — the interval that matters, and
      the one that gets skipped.
- [ ] Lock, make an admin change to that person's team, unlock: the change is
      there.
- [ ] Switch to another app and back (not just lock) — a different lifecycle on
      both platforms.
- [ ] Airplane mode on, reload: the "Offline · last known" banner with the
      saved schedule (item 10's work, on a real radio this time).
- [ ] Airplane mode off: it comes back on its own, without a reload.
- [ ] Walk out of wifi range into cell, and back. Venue wifi that is associated
      but passing nothing is the case the 3.5s service-worker timeout exists
      for; a real dead zone is the only way to see it.

### 4. Battery over a full day

Nothing here measures this, and nothing can: the app holds an open WebSocket
and a 30-second re-render ticker for a 14-hour day. A dancer whose phone is
flat by 6pm cannot see the awards call.

- [ ] Fully charged phone, app open in the foreground for **1 hour**, screen on:
      record the battery drop. Compare against an hour of the same phone idle.
- [ ] Backgrounded for **8 hours** with the app open: record the drop.
- [ ] Repeat on the Android device — Doze changes socket behaviour and is worth
      seeing.
- [ ] If foreground drain is bad, the ticker (`useTicker(30_000)` in
      `ScheduleScreen`) is the first thing to look at: it re-renders the whole
      timeline every 30 seconds whether or not anything moved.

### 5. Pull to refresh — a decision, not just a check

`body` carries `overscroll-behavior-y: contain`, which on **Android Chrome
disables the browser's native pull-to-refresh** (iOS Safari is unaffected).
Item 10 built the entire service worker on the premise that "refreshing is
exactly what people do when something looks stale" — so the app may be
disabling the gesture it was designed around, on half the fleet.

This was left alone rather than guessed at, because the fix is one word and the
behaviour cannot be confirmed without an Android phone.

- [ ] On Android Chrome, pull down at the top of the schedule. Does it refresh?
- [ ] If it does not, and you want it to: change `overscroll-behavior-y` on
      `body` to `auto` in `styles.css`, and move `overscroll-behavior: contain`
      onto `.scroll-list`, which is the element that actually needs it (so
      over-scrolling the name list stops rather than dragging the page).

### 6. Screen reader, on a real phone

The tree was verified in a desktop browser. VoiceOver and TalkBack have their
own reading and gesture behaviour, and this is a schedule people will listen to
while carrying costumes.

- [ ] **VoiceOver** (iOS): rotor by heading reaches subject → now/next → full
      schedule → contact. Swiping through the day reads each block as one item.
- [ ] VoiceOver: the day strip announces "tab, 2 of 2" and responds to swipes.
- [ ] **TalkBack** (Android): the same two.
- [ ] Make an admin change while a screen reader is on the schedule: the
      "your schedule just changed" banner is announced without interrupting.
- [ ] Both: the Call / Text / Email links read as "Call <name>", not "Call".

### 7. Reading it in the room it is for

- [ ] At full brightness in a dark venue, and at low brightness. The palette is
      built for dark; the check is that gold-on-dark does not bloom.
- [ ] Outdoors in daylight — check-in and load-in happen outside.
- [ ] With the phone at arm's length, which is how a dancer holds it backstage.
- [ ] iOS **Increase Contrast** and **Reduce Motion** both on.
- [ ] iOS **Zoom** / Android font scaling at maximum: nothing clipped, nothing
      overlapping. This is the `px`-not-`rem` residual above — expect the
      Android result to be the weaker one.

---

## Recording results

Fill the matrix table, and add a short dated section under it for anything
found. A failure here before item 26 is cheap; the same failure on the Saturday
is not.

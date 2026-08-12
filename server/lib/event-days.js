/**
 * Re-dating the event weekend — the arithmetic and the refusals, without the
 * database or the console. `scripts/event-days.js` is the shell around this.
 *
 * ⚠️ **Dates move; keys never do.** `schedule_blocks.day` is a foreign key onto
 * `event_days.key`, and `Sat` means "the third day of this event" rather than
 * any particular date. So re-dating carries every block with it and orphans
 * nothing — and adding or removing a day is deliberately not possible here,
 * because that is a decision about how long the event is, not about when it is.
 *
 * One date is enough because the days are contiguous, which is the model the
 * template already uses: one Friday in a yellow box, every day tab derived from
 * it. One number to get right beats four to keep consistent.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * `new Date('2027-02-30')` is not an error — it rolls over to March 2nd and
 * reports itself as a perfectly good date. A weekend one day out of place still
 * renders as a correct-looking schedule, so the round trip through ISO is the
 * check.
 */
export function parseIsoDate(value) {
  const text = String(value ?? '').trim();
  if (!ISO_DATE.test(text)) return null;
  const d = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) return null;
  return d;
}

/** The weekday a date actually falls on, in the same words `event_days.label` uses. */
export function weekdayOf(date) {
  return WEEKDAYS[date.getUTCDay()];
}

/**
 * Work out what each day's date becomes if `anchorKey` lands on `date`.
 *
 * @param {Array<{key,label,date,sort_order}>} days in `sort_order`
 * @returns {{error: string} | {plan: Array<{key,label,date,next}>, moving: [...]}}
 */
export function planEventDates(days, anchorKey, date) {
  if (!days.length) return { error: 'This database has no event days.' };

  // `--fri`, `--friday` and `--Fri` are the same flag: match the key exactly, or
  // the label by a prefix of at least three letters, so `--s` can never pick
  // between Saturday and Sunday.
  const wanted = String(anchorKey ?? '').trim().toLowerCase();
  const target =
    wanted.length >= 3 &&
    days.find(
      (d) => d.key.toLowerCase() === wanted || String(d.label).toLowerCase().startsWith(wanted)
    );
  if (!target) {
    return { error: `"${anchorKey}" is not one of this event's days (${days.map((d) => d.key).join(', ')}).` };
  }

  const anchor = parseIsoDate(date);
  if (!anchor) return { error: `"${date}" is not a real date. Use YYYY-MM-DD.` };

  /**
   * Refused rather than warned. All four days derive from this one, so a date
   * given under the wrong day's flag moves the entire weekend — and the result
   * is a schedule that looks right on every screen in the app.
   */
  const actual = weekdayOf(anchor);
  if (actual.toLowerCase() !== String(target.label).toLowerCase()) {
    return {
      error:
        `${date} is a ${actual}, but you gave it as ${target.label}. Nothing was changed. ` +
        `Check the date, or anchor on --${actual.slice(0, 3).toLowerCase()}.`,
    };
  }

  const plan = days.map((d) => ({
    key: d.key,
    label: d.label,
    date: d.date,
    next: new Date(anchor.getTime() + (d.sort_order - target.sort_order) * DAY_MS)
      .toISOString()
      .slice(0, 10),
  }));

  return { plan, moving: plan.filter((d) => d.date !== d.next) };
}

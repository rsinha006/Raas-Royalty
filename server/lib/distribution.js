/**
 * Who each access link gets sent to — item 25.
 *
 * Item 8 built the links and a CSV to mail-merge from. What it could not build
 * was the address column, because at the time nothing in this app held a
 * participant's own email: `people.contact_id` is the card they should *call*,
 * and it is shared — every dancer on a team points at that team's liaison, and
 * a dozen exec board members at the Event Director. A "Send To" built from it
 * would have mailed a dozen private links to one inbox, and the file would have
 * looked perfectly plausible on the way past. `docs/decisions.md` says to
 * revisit once real per-person details exist. Item 24 imported them.
 *
 * ⚠️ **Recipients come from `people.email` / `people.phone` and nowhere else.**
 * Never from `contact_cards`. That is the whole safety property of this module,
 * and there is a test that mails nothing to a shared card.
 *
 * The routing follows the access-code decision:
 *
 *   person code → that person. One link, one recipient, always.
 *   team code   → the team's **captains**. The code is shared within the team
 *                 by design, and the captains are who distribute it onward.
 *   role code   → nobody automatic. A role code exposes every holder's schedule
 *                 to whoever has it, so it is an explicit admin choice and so is
 *                 who receives it.
 */
import { db } from '../db.js';

/** Codes are bearer tokens in a URL; a link is only as private as its channel. */
export const CHANNELS = ['email', 'sms'];

const CAPTAIN_ROLE_ID = 'captain';

const personById = db.prepare('SELECT id, name, email, phone FROM people WHERE id = ?');

const captainsOfTeam = db.prepare(
  `SELECT p.id, p.name, p.email, p.phone
     FROM people p
     JOIN person_roles pr ON pr.person_id = p.id
    WHERE p.team_id = ? AND pr.role_id = ?
    ORDER BY p.name`
);

const anyOnTeam = db.prepare(
  'SELECT COUNT(*) AS n FROM people WHERE team_id = ?'
);

const reachable = (p) => Boolean(p && (p.email || p.phone));

const asRecipient = (p, why) => ({
  personId: p.id,
  name: p.name,
  email: p.email || null,
  phone: p.phone || null,
  why,
});

/**
 * @returns {{recipients: Array, blocked: string|null}} `blocked` is a sentence
 *   an admin can act on, not a code — this ends up in a readiness list someone
 *   reads at T-2 weeks and has to fix before Friday.
 */
export function recipientsFor(code) {
  if (code.revokedAt) return { recipients: [], blocked: 'This code is revoked.' };

  if (code.subjectType === 'person') {
    const person = personById.get(code.subjectId);
    if (!person) return { recipients: [], blocked: 'This code points at somebody who is no longer on the roster.' };
    if (!reachable(person)) {
      return {
        recipients: [],
        blocked: `${person.name} has no email or phone on the roster — add one on the People tab and re-import.`,
      };
    }
    return { recipients: [asRecipient(person, 'their own link')], blocked: null };
  }

  if (code.subjectType === 'team') {
    const captains = captainsOfTeam.all(code.subjectId, CAPTAIN_ROLE_ID);
    const sendable = captains.filter(reachable);
    if (sendable.length) {
      return {
        recipients: sendable.map((p) => asRecipient(p, 'captain — distributes to the team')),
        blocked: null,
      };
    }
    if (!captains.length) {
      const size = anyOnTeam.get(code.subjectId).n;
      return {
        recipients: [],
        blocked: size
          ? 'No captain on this team — mark one in the Roster tab’s Captain? column and re-import.'
          : 'This team has nobody on it yet.',
      };
    }
    return {
      recipients: [],
      blocked: `This team's captains (${captains.map((c) => c.name).join(', ')}) have no email or phone on the roster.`,
    };
  }

  // Role codes, deliberately. See the header.
  return {
    recipients: [],
    blocked: 'Role codes are issued by hand — decide who receives this one.',
  };
}

/**
 * Every live, non-orphaned code with its link and its recipients.
 *
 * Orphans are excluded for the same reason item 8 excluded them from the CSV: a
 * dead link in front of whoever runs the merge is worse than a missing row,
 * because a missing row gets noticed.
 *
 * @param {Array} codes from `listCodes()`
 * @param {(code) => string} link
 */
export function distributionPlan(codes, link) {
  const rows = codes
    .filter((c) => !c.revokedAt && !c.orphaned)
    .map((c) => {
      const { recipients, blocked } = recipientsFor(c);
      return {
        subjectType: c.subjectType,
        subjectLabel: c.subjectLabel,
        teamName: c.teamName ?? null,
        roleLabel: c.roleLabel ?? null,
        code: c.code,
        link: link(c),
        lastUsedAt: c.lastUsedAt ?? null,
        recipients,
        blocked,
      };
    });

  const sendable = rows.filter((r) => r.recipients.length);
  return {
    rows,
    summary: {
      total: rows.length,
      sendable: sendable.length,
      blocked: rows.length - sendable.length,
      // What the merge will actually put in a To: field. Counted separately
      // because one team link goes to two or three captains.
      recipients: sendable.reduce((n, r) => n + r.recipients.length, 0),
      withoutEmail: sendable
        .flatMap((r) => r.recipients)
        .filter((p) => !p.email).length,
      alreadyUsed: rows.filter((r) => r.lastUsedAt).length,
    },
  };
}

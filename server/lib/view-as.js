/**
 * "View as" — exactly what one team, person, or role sees.
 *
 * The question this answers arrives as "I don't see my warm-up", usually at a
 * check-in desk with a queue behind it. It has four common answers and they
 * need different fixes:
 *
 *   the block targets the wrong subject   → fix the block
 *   you're on the team view, not your own → tap your name
 *   you're not on that team any more      → fix the roster
 *   you never signed in at all            → find their link
 *
 * So this returns the schedule *and* enough to tell those apart: the targets
 * the view ORs over, and how a real person reaches it.
 *
 * ⚠️ The schedule comes from `getPersonalizedSchedule` — the viewer's own
 * function, called with the viewer's own argument shape, and returned
 * unmodified. Deriving it any other way would let the preview and the phone
 * disagree, and this tool is reached for precisely when someone suspects they
 * already do. `resolveSession` is called a second time here for the target
 * list rather than reaching inside that payload, which is a cheap query and
 * keeps the payload provably untouched.
 */
import { codeForSubject } from './access-codes.js';
import {
  describeTarget,
  getPersonalizedSchedule,
  listTeamMembers,
  resolveSession,
  rolesForPerson,
} from './queries.js';
import { db } from '../db.js';

/**
 * How a real holder arrives at this exact view.
 *
 * `team-code-then-name` is the one worth naming: a dancer's own view is behind
 * their team's code *plus* the identity step, so "her link works" and "she can
 * see her airport pickup" are two different claims.
 */
export const ROUTES = {
  OWN: 'own-code',
  TEAM: 'team-code',
  TEAM_THEN_NAME: 'team-code-then-name',
  ROLE: 'role-code',
  NONE: 'no-route',
};

function codeSummary(subjectType, subjectId) {
  const record = codeForSubject(subjectType, subjectId);
  return {
    subjectType,
    subjectId,
    label: describeTarget(subjectType, subjectId),
    live: Boolean(record),
    lastUsedAt: record?.lastUsedAt ?? null,
  };
}

/**
 * Whether a person is reached through their team rather than individually.
 *
 * ⚠️ The negative form is deliberate and has to stay in step with
 * `subjectsNeedingCodes`: a captain holds Dancer + Captain, and asking "do they
 * hold a person-selector role?" would answer yes and send us looking for a
 * personal code they are never issued. The rule is "holds *no* team-selector
 * role". There is a test asserting the two functions agree for every person.
 */
function reachedThroughTeam(personId) {
  return Boolean(
    rolesForPerson(personId).some((r) => r.selector === 'team')
  );
}

/**
 * Exported for the printed call sheets (item 28), whose desk index answers the
 * same question on paper: how does this person actually get in. One rule in one
 * place — a second copy would drift, and the drift would be discovered at a
 * check-in desk.
 */
export function accessFor(type, id) {
  if (type === 'team') {
    return {
      route: ROUTES.TEAM,
      code: codeSummary('team', id),
      // Redeeming a team code lands on "which dancer are you?". This view is
      // what is behind the "skip"/back path, and what a captain sees while
      // deciding — not nothing, but not anyone's personal schedule either.
      note: 'What a team-code holder sees before picking a name.',
    };
  }

  if (type === 'role') {
    return {
      route: ROUTES.ROLE,
      code: codeSummary('role', id),
      note: 'Role codes are never issued automatically — this view is unreachable without one.',
    };
  }

  const person = db.prepare('SELECT id, team_id FROM people WHERE id = ?').get(id);
  if (!person) return { route: ROUTES.NONE, code: null, note: 'No such person.' };

  if (reachedThroughTeam(person.id)) {
    if (!person.team_id) {
      return {
        route: ROUTES.NONE,
        code: null,
        // Item 14 unassigns a team's dancers rather than deleting them, so this
        // is a state the roster really reaches — and the person keeps a
        // schedule they now have no way to open.
        note: 'Reached through a team code, but this person is on no team — they cannot sign in.',
      };
    }
    return {
      route: ROUTES.TEAM_THEN_NAME,
      code: codeSummary('team', person.team_id),
      note: 'Behind their team’s code and then the identity step.',
    };
  }

  return { route: ROUTES.OWN, code: codeSummary('person', person.id), note: null };
}

/**
 * The preview payload. Null when the subject does not exist, which the route
 * turns into a 404 rather than an empty schedule — "nothing scheduled" and
 * "no such person" are the two answers this tool must never confuse.
 */
export function previewFor({ type, id }) {
  const resolved = resolveSession({ type, id });
  if (!resolved) return null;

  return {
    schedule: getPersonalizedSchedule({ type, id }),
    /**
     * The targets the schedule query ORs over, labelled. This is the line that
     * answers "why can't she see it": the block targets All Captains and her
     * targets are Person, All Dancers, Team — so she does not hold Captain.
     */
    targets: resolved.targets.map((t) => ({
      type: t.type,
      id: t.id,
      label: describeTarget(t.type, t.id),
    })),
    access: accessFor(type, id),
    /**
     * Only for a team: the names behind the identity step, so "now show me what
     * Maya sees" is one click from the view that prompted the question.
     */
    members: type === 'team' ? listTeamMembers(id) : null,
  };
}

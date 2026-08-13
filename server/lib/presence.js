/**
 * Which phones are connected, and which of them are showing the current
 * schedule — PLAN.md item 26.
 *
 * The dress rehearsal's central sentence is "make live changes and confirm
 * every phone updates". With fifteen people in a room, the only way to confirm
 * that today is to ask them, one at a time, and a phone whose socket quietly
 * died answers "yes, 3:05" without anybody — including its owner — being able
 * to tell that 3:05 is twenty minutes old. That is the failure this whole
 * project is built around: not an error, a *plausible wrong answer*. Item 20
 * measured 600 simulated phones; nothing has ever measured a real one.
 *
 * So each viewer reports the `updatedAt` it is currently rendering, and this
 * file compares it against what that viewer's own targets say it should be.
 *
 * ⚠️ **Against its own targets, never against the event's.** `updatedAt` has
 * been per-subject since item 14 — a viewer's is the newest of the targets they
 * hold, so comparing every phone against `scheduleUpdatedAt()` would mark all
 * fifteen stale the moment any one team changed, and the panel would be an
 * alarm that is always ringing. `versionForTargets` is the same function the
 * schedule query uses to fill the field being compared, which is what makes the
 * comparison meaningful rather than merely plausible.
 *
 * Three deliberate limits:
 *
 *   - **It is a rehearsal and event-week instrument, not a login record.** The
 *     registry lives in memory and starts empty on every restart. Nothing here
 *     is persisted, and "was Priya connected on Friday" is not a question this
 *     answers.
 *   - **A phone reports its own state.** There is no way for a server to know
 *     what a screen is showing, and a server-side guess ("we emitted, so they
 *     have it") is exactly the false confidence the panel exists to remove.
 *   - **Nothing here is on the `/api/schedule` path.** That path's per-request
 *     cost is the fan-out ceiling (see CLAUDE.md); reporting rides the socket
 *     that is already open, and the report itself is computed only when an
 *     admin asks for it.
 */
import { versionForTargets } from '../db.js';

/** socket id → what we know about that connection. */
const sockets = new Map();

/**
 * A hard ceiling, so a reconnect storm cannot grow this without bound if a
 * disconnect is ever missed. 600 is item 20's measured fleet; the room at a
 * rehearsal is fifteen.
 */
const MAX_TRACKED = 1200;

/**
 * Record or refresh what a socket is. Called from the hub's `syncRooms`, so it
 * follows a re-handshake, a roster edit, and a revoked code for free — the
 * identity here is always the one the rooms were just derived from.
 */
export function trackSocket(socketId, identity, { at = Date.now() } = {}) {
  const existing = sockets.get(socketId);
  if (!existing && sockets.size >= MAX_TRACKED) return null;

  const entry = {
    id: socketId,
    admin: identity.admin,
    subject: identity.subject,
    targets: identity.targets,
    rooms: identity.rooms,
    connectedAt: existing?.connectedAt ?? at,
    /**
     * Kept across an identity change on purpose. A dancer stepping back through
     * "Not you?" re-handshakes; dropping the held version there would report
     * her as never having reported, which reads identically to a phone that has
     * gone silent. The refetch that follows will overwrite it within the second.
     */
    held: existing?.held ?? null,
    heldAt: existing?.heldAt ?? null,
  };
  sockets.set(socketId, entry);
  return entry;
}

export function forgetSocket(socketId) {
  sockets.delete(socketId);
}

/**
 * How to ask the socket server which connections are actually still open.
 *
 * ⚠️ The `disconnect` handler is the normal path and covers everything Socket.IO
 * tells us about; this is the backstop for what it does not — a process that
 * missed an event, a transport that closed without one. Presence is read at the
 * one moment somebody is deciding whether a phone in the room is broken, so
 * "connected" reporting a socket that closed twenty minutes ago sends them to
 * debug a phone that is fine. Registered by the hub; absent in tests that drive
 * the registry directly, where the map is the truth.
 */
let liveIds = null;
export function bindLiveIds(fn) {
  liveIds = fn;
}

function prune() {
  if (!liveIds) return;
  let open;
  try {
    open = liveIds();
  } catch {
    return; // never let an observability view break itself
  }
  if (!open) return;
  for (const id of sockets.keys()) if (!open.has(id)) sockets.delete(id);
}

/**
 * A viewer reporting the version it is rendering.
 *
 * Untrusted input on a socket: it is stored as an opaque string, compared for
 * equality and never parsed, ordered, or written to the database. The worst a
 * client can do by lying is mislabel its own row in an admin-only view.
 */
export function recordHeld(socketId, updatedAt, { at = Date.now() } = {}) {
  const entry = sockets.get(socketId);
  if (!entry) return false;
  if (typeof updatedAt !== 'string' || updatedAt.length > 64) return false;
  entry.held = updatedAt;
  entry.heldAt = at;
  return true;
}

/** Test seam, and what a restart does anyway. */
export function resetPresence() {
  sockets.clear();
  liveIds = null;
}

const labelFor = (entry) => entry.subject?.name ?? (entry.admin ? 'Logistics panel' : 'Not signed in');

/**
 * The whole picture, computed on demand.
 *
 * `versionForTargets` is memoized across the report by the socket's room list:
 * fifteen phones on three teams ask the database three times, and 600 phones at
 * the load test's scale ask it once per distinct audience rather than 600
 * times. The rooms are the right key precisely because they are derived from
 * the targets.
 */
export function presenceReport({ at = Date.now() } = {}) {
  prune();

  const versions = new Map();
  const versionFor = (entry) => {
    const key = entry.rooms.join('|');
    if (!versions.has(key)) versions.set(key, entry.targets.length ? versionForTargets(entry.targets) : null);
    return versions.get(key);
  };

  const phones = [];
  let panels = 0;
  let anonymous = 0;

  for (const entry of sockets.values()) {
    /**
     * ⚠️ Admin first, subject second. Cookies are per browser, not per tab: the
     * person running the rehearsal has almost always opened a viewer link in
     * the same browser as the panel, so their `/admin` socket resolves to a
     * real viewer subject and would be listed as a phone — one that never
     * reports a version, because the panel is not the schedule screen, and
     * therefore sits in the list as a permanently silent phone belonging to
     * somebody who is standing right there. Found by opening both, which is the
     * only configuration this feature is ever used in.
     */
    if (entry.admin) {
      panels += 1;
      continue;
    }
    if (!entry.subject) {
      // A socket whose cookie no longer resolves — signed out, or revoked.
      // Counted rather than listed: it is not a phone at the rehearsal.
      anonymous += 1;
      continue;
    }
    const current = versionFor(entry);
    phones.push({
      id: entry.id,
      subjectType: entry.subject.type,
      subjectId: entry.subject.id,
      label: labelFor(entry),
      connectedAt: new Date(entry.connectedAt).toISOString(),
      held: entry.held,
      current,
      /**
       * Three states, not two. A phone that has never reported is *silent* — an
       * older bundle, or a socket that connected and whose fetch never landed —
       * and calling that "up to date" is the comfortable lie; calling it "stale"
       * would flag every phone for the second between connecting and its first
       * refetch.
       */
      state: entry.held === null ? 'silent' : entry.held === current ? 'current' : 'stale',
      reportedSecondsAgo: entry.heldAt === null ? null : Math.round((at - entry.heldAt) / 1000),
    });
  }

  phones.sort((a, b) => a.label.localeCompare(b.label));

  /**
   * Teams with nobody connected — the question a rehearsal actually asks
   * ("has UNC opened their link yet?"), and the one the phone list cannot
   * answer, because a dancer who has tapped her name shows up as a person.
   * Her session's targets contain her team, so the *rooms* know, and this is
   * read off the rooms rather than off the labels.
   */
  const teamsPresent = new Set();
  for (const entry of sockets.values()) {
    if (entry.admin) continue; // same reason as above — that is the driver's laptop
    for (const room of entry.rooms) {
      if (room.startsWith('team:')) teamsPresent.add(room.slice(5));
    }
  }

  return {
    at: new Date(at).toISOString(),
    phones,
    teamsPresent: [...teamsPresent],
    counts: {
      phones: phones.length,
      current: phones.filter((p) => p.state === 'current').length,
      stale: phones.filter((p) => p.state === 'stale').length,
      silent: phones.filter((p) => p.state === 'silent').length,
      panels,
      anonymous,
    },
  };
}

/**
 * The live channel — who may open a socket, what each socket is allowed to
 * hear, and how a change reaches only the people it affects.
 *
 * Two things happen here, and they are the same change on purpose.
 *
 * **Scoping.** Every change used to be announced to every connected client, so
 * moving one team's warm-up woke all ~280 phones and had each of them refetch a
 * schedule that had not changed. Sockets now join a room per block target, and
 * a change is emitted only to the rooms its block targets.
 *
 * **Audience stays server-side.** The obvious way to scope is to put the
 * affected `personIds` into the broadcast and let clients ignore what isn't
 * theirs. That would put a list of who-is-affected on the wire, readable by
 * anything holding a socket — and until this change *any origin* could open one.
 * Rooms get the same result with nothing on the wire: the payload is still only
 * "something changed", and a client that isn't in the room never receives it.
 *
 * **The room name is the block target.** `team:t_alpha`, `person:p_alice`,
 * `role:dancer`. A socket joins one room per entry in its session's `targets` —
 * the very list `blocksForTargets` ORs over to build that person's schedule. So
 * "who hears about this block" and "whose schedule contains this block" are the
 * same computation rather than two that can drift apart. Adding a fourth
 * targeting mode would need no change here.
 */
import { scheduleUpdatedAt } from '../db.js';
import { currentAdmin } from './auth.js';
import { resolveViewerSession, scheduleSessionFor } from './viewer-auth.js';
import { resolveSession } from './queries.js';
import { bindLiveIds, forgetSocket, recordHeld, trackSocket } from './presence.js';

/** Admins see the whole event, so they are in on every broadcast. */
export const ADMIN_ROOM = 'admin';

export const roomForTarget = (target) => `${target.type}:${target.id}`;

export function roomsForTargets(targets) {
  return [...new Set((targets || []).filter(Boolean).map(roomForTarget))];
}

/* ------------------------------------------------------------------ *
 * Origins
 * ------------------------------------------------------------------ */

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** A dev machine, a phone on the same wifi, or a container on the LAN. */
function isLocalOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname;
  if (LOCAL_HOSTNAMES.has(host)) return true;
  return (
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  );
}

const normalizeOrigin = (value) => {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Which origins may open a socket.
 *
 * Before this the option was `{ origin: true }`, which reflects whatever origin
 * asks — any page on the internet could open an authenticated socket against
 * this server using a visitor's cookie. That was survivable only while
 * broadcasts carried nothing but a timestamp.
 *
 * The default rule needs no configuration and cannot be got wrong at deploy:
 * **the request's own host is always allowed.** A page at evil.com opening a
 * socket to royalty.example sends `Origin: https://evil.com` with
 * `Host: royalty.example`, which does not match; the real app, served from the
 * same host it connects to, always does. `PUBLIC_BASE_URL` and `SOCKET_ORIGINS`
 * add the genuinely cross-origin cases (a separate front end, the Vite dev
 * server).
 *
 * A request with **no** `Origin` header is allowed: browsers always send one
 * cross-site, so its absence means a non-browser client — which carries no
 * cookie, therefore joins no rooms, and learns nothing. Rejecting it would
 * instead break same-origin polling, where browsers omit the header.
 */
export function originPolicy({
  publicBaseUrl = process.env.PUBLIC_BASE_URL,
  extra = process.env.SOCKET_ORIGINS,
  allowLocal = process.env.NODE_ENV !== 'production',
} = {}) {
  const configured = new Set();
  for (const raw of [publicBaseUrl, ...String(extra || '').split(',')]) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const origin = normalizeOrigin(value);
    if (origin) configured.add(origin);
  }

  function isAllowed(origin, host = null) {
    if (!origin) return true;
    const candidate = normalizeOrigin(origin);
    if (!candidate) return false;
    if (configured.has(candidate)) return true;
    if (host) {
      const bare = String(host).toLowerCase();
      if (candidate === `http://${bare}` || candidate === `https://${bare}`) return true;
    }
    return allowLocal && isLocalOrigin(candidate);
  }

  return {
    isAllowed,
    configured: [...configured],
    allowLocal,
    describe() {
      const parts = ['same origin'];
      if (configured.size) parts.push(...configured);
      if (allowLocal) parts.push('localhost/LAN (dev)');
      return parts.join(', ');
    },
  };
}

/* ------------------------------------------------------------------ *
 * Sessions on a socket
 * ------------------------------------------------------------------ */

/**
 * Cookies off a raw handshake. Socket.IO hands us headers, not an Express
 * request, and the session helpers only ever read `req.cookies` — so a shim
 * with that one property lets both re-use `resolveViewerSession` unchanged
 * rather than growing a second, subtly different notion of who someone is.
 */
export function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key || key in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Who a set of cookies is, and therefore what they hear. Re-derived from the
 * database every time it is called, not cached on the socket: a revoked code, a
 * deleted team, or a dancer moved between teams has to change what that socket
 * hears, and the socket may have been open since the Monday before.
 *
 * ⚠️ One derivation, two consumers. The rooms and the subject label come out of
 * the same `resolveSession` call because `presence.js` reports "this phone is
 * Priya, and it is holding a version 20 minutes old" — and a second derivation
 * of who a socket belongs to would eventually disagree with the rooms it is
 * actually in, which is the one thing that view of the room must never do.
 */
export function identifyCookies(cookies) {
  const admin = Boolean(currentAdmin({ cookies }));
  const rooms = admin ? [ADMIN_ROOM] : [];

  const session = resolveViewerSession({ cookies });
  const resolved = session ? resolveSession(scheduleSessionFor(session)) : null;
  if (resolved) rooms.push(...roomsForTargets(resolved.targets));

  return {
    admin,
    /** Null for the panel and for anyone who has not signed in. */
    subject: resolved
      ? { type: resolved.subject.kind, id: resolved.subject.id, name: resolved.subject.name }
      : null,
    targets: resolved?.targets ?? [],
    rooms: [...new Set(rooms)],
  };
}

export function roomsForCookies(cookies) {
  return identifyCookies(cookies).rooms;
}

/* ------------------------------------------------------------------ *
 * The hub
 * ------------------------------------------------------------------ */

/**
 * Wires a Socket.IO server up to the room scheme and returns the `broadcast`
 * the routes call. Takes `io` rather than creating it so the tests can drive
 * the whole thing — room membership included — without a real network.
 */
export function createLiveHub(io) {
  function syncRooms(socket) {
    let identity;
    try {
      identity = identifyCookies(parseCookieHeader(socket.handshake?.headers?.cookie));
    } catch (err) {
      // A malformed cookie or a mid-query failure must not kill the socket: the
      // fallback is "hears nothing", and the HTTP layer still guards the data.
      console.warn('[live] could not resolve socket session:', err.message);
      identity = { admin: false, subject: null, targets: [], rooms: [] };
    }
    const wanted = new Set(identity.rooms);
    for (const room of socket.rooms) {
      if (room !== socket.id && !wanted.has(room)) socket.leave(room);
    }
    for (const room of wanted) socket.join(room);
    // Presence follows room membership rather than being maintained beside it,
    // so a re-handshake, a roster edit and a revoked code all move both at once.
    trackSocket(socket.id, identity);
    return [...wanted];
  }

  bindLiveIds(() => new Set(io.sockets?.sockets?.keys?.() ?? []));

  io.on('connection', (socket) => {
    syncRooms(socket);
    socket.emit('hello', { updatedAt: scheduleUpdatedAt() });

    /**
     * What this client is currently rendering. The only message a viewer sends,
     * and it carries nothing but a timestamp it was already given — see
     * `presence.js` for why the server cannot work this out for itself.
     */
    socket.on?.('viewer:held', (payload) => {
      recordHeld(socket.id, payload?.updatedAt);
    });
    socket.on?.('disconnect', () => forgetSocket(socket.id));
  });

  /** Every connected socket re-evaluated. Cheap: a few indexed lookups each. */
  function refreshRooms() {
    for (const socket of io.sockets?.sockets?.values?.() ?? []) syncRooms(socket);
  }

  /**
   * @param rooms  the block targets' rooms; omit for a change that could touch
   *               anyone (a roster edit, an import that rewrote the board).
   * @param refreshRooms  re-derive membership afterwards — a roster change can
   *               move someone between teams, and their socket has to follow.
   */
  function broadcast(event, payload, { rooms = null, refreshRooms: refresh = false } = {}) {
    const body = { ...payload, at: new Date().toISOString() };
    if (rooms && rooms.length) {
      io.to([ADMIN_ROOM, ...new Set(rooms)]).emit(event, body);
    } else if (rooms) {
      // An empty (not absent) room list means "nobody but the panel" — a block
      // whose target no longer resolves to anyone still has to reach the admin
      // who just edited it.
      io.to(ADMIN_ROOM).emit(event, body);
    } else {
      io.emit(event, body);
    }
    if (refresh) refreshRooms();
  }

  return { broadcast, refreshRooms, syncRooms };
}

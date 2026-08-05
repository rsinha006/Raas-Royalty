import crypto from 'node:crypto';
import { db, getMeta, setMeta } from '../db.js';

/**
 * Single admin tier, one shared password. No accounts — this is a two-day event,
 * not a SaaS. The password grants a signed cookie; admins optionally identify
 * themselves by name so the edit log records who did what.
 */

const COOKIE = 'royalty_admin';
const TTL_MS = 1000 * 60 * 60 * 24; // 24h — long enough for the whole event

function secret() {
  let s = getMeta('session_secret');
  if (!s) {
    s = crypto.randomBytes(32).toString('hex');
    setMeta('session_secret', s);
  }
  return process.env.SESSION_SECRET || s;
}

export function adminPassword() {
  return process.env.ADMIN_PASSWORD || 'royalty-admin';
}

export function usingDefaultPassword() {
  return !process.env.ADMIN_PASSWORD;
}

/**
 * Shared with the viewer session in viewer-auth.js on purpose: one secret, one
 * signing implementation, one place to get constant-time comparison right.
 */
export function signPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPayload(token) {
  return verify(token);
}

function sign(payload) {
  return signPayload(payload);
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function checkPassword(candidate) {
  const expected = adminPassword();
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function issueSession(res, { name }) {
  const token = sign({ name: name || 'admin', exp: Date.now() + TTL_MS });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: TTL_MS,
    secure: process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE);
}

export function currentAdmin(req) {
  return verify(req.cookies?.[COOKIE]);
}

/** Coarse in-memory throttle — enough to make guessing tedious over a weekend. */
const attempts = new Map();
export function throttle(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { count: 0, first: now };
  if (now - rec.first > 15 * 60_000) {
    rec.count = 0;
    rec.first = now;
  }
  rec.count++;
  attempts.set(ip, rec);
  return rec.count > 20;
}

export function resetThrottle(ip) {
  attempts.delete(ip);
}

export function requireAdmin(req, res, next) {
  const admin = currentAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Admin sign-in required' });
  req.admin = admin;
  next();
}

/** Name recorded in the edit log for this request. */
export function editorName(req) {
  return req.admin?.name || 'admin';
}

export { db };

import express from 'express';
import { getBootstrap, getPersonalizedSchedule } from '../lib/queries.js';
import { scheduleUpdatedAt } from '../db.js';

export function publicRouter() {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({ ok: true, updatedAt: scheduleUpdatedAt() });
  });

  /** Roles, teams, and names — everything the landing page needs to identify someone. */
  router.get('/bootstrap', (req, res) => {
    res.json(getBootstrap());
  });

  /**
   * The personalized schedule. `type` is 'team' (dancers) or 'person'.
   * This is the exact payload the client caches for offline use.
   */
  router.get('/schedule', (req, res) => {
    const { type, id } = req.query;
    if (!['team', 'person'].includes(type) || !id) {
      return res.status(400).json({ error: 'type must be "team" or "person", and id is required' });
    }
    const payload = getPersonalizedSchedule({ type, id: String(id) });
    if (!payload) {
      return res.status(404).json({ error: 'That selection is no longer in the roster.' });
    }
    res.json(payload);
  });

  return router;
}

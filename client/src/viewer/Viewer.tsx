import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import {
  clearCachedSchedules,
  forgetEverything,
  hasBeenSeen,
  markSeen,
  purgeLegacyKeys,
  readAnyCachedSchedule,
} from '../session';
import type { Bootstrap, SignInReason, ViewerSession } from '../types';
import CodeEntry from './CodeEntry';
import IdentityPicker from './IdentityPicker';
import ScheduleScreen from './ScheduleScreen';

/**
 * Four states, in the order someone meets them:
 *
 *   checking   asking the server whether the cookie is still good
 *   signed-out the code screen, possibly explaining why
 *   identify   a team code, waiting on "which dancer are you?"
 *   ready      the schedule
 *
 * A returning visitor should pass through `checking` and land on `ready`
 * without typing anything, because the session is a cookie the server issued.
 */
type Phase = 'checking' | 'signed-out' | 'identify' | 'ready';

/** `/?signin=revoked` — set by the magic link when redemption failed. */
function takeSignInReasonFromUrl(): SignInReason | null {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('signin');
  if (!raw) return null;
  // Clean it out of the address bar so a refresh doesn't re-show the error.
  params.delete('signin');
  const query = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
  return (['invalid', 'revoked', 'orphaned', 'rate'] as const).includes(raw as never)
    ? (raw as SignInReason)
    : null;
}

export default function Viewer() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [session, setSession] = useState<ViewerSession | null>(null);
  const [reason, setReason] = useState<SignInReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [eventName, setEventName] = useState('Royalty');

  useEffect(() => {
    purgeLegacyKeys();
    setReason(takeSignInReasonFromUrl());
  }, []);

  // The event name is all an unauthenticated visitor is told, and it is only
  // needed on the code screen.
  useEffect(() => {
    if (phase !== 'signed-out') return;
    api
      .get<Bootstrap>('/api/bootstrap')
      .then((b) => setEventName(b.eventName))
      .catch(() => {
        /* the screen reads fine with the fallback name */
      });
  }, [phase]);

  const applySession = useCallback((next: ViewerSession) => {
    setSession(next);
    markSeen();
    setPhase(next.needsIdentity ? 'identify' : 'ready');
  }, []);

  const checkSession = useCallback(async () => {
    try {
      applySession(await api.get<ViewerSession>('/api/session'));
      setReason(null);
    } catch (err) {
      if (err instanceof ApiError) {
        // A real 401: the cookie is missing, expired, or its code was revoked.
        setPhase('signed-out');
        setReason((prev) => prev ?? (hasBeenSeen() ? 'expired' : null));
        return;
      }
      // Not a 401 — the server is unreachable. Someone who has been here
      // before should still get their last known schedule rather than a code
      // prompt they cannot complete offline.
      if (hasBeenSeen() && readAnyCachedSchedule()) {
        setSession(null);
        setPhase('ready');
        return;
      }
      setPhase('signed-out');
      setReason('network');
    }
  }, [applySession]);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const submitCode = async (code: string) => {
    setBusy(true);
    setReason(null);
    try {
      applySession(await api.post<ViewerSession>('/api/session', { code }));
    } catch (err) {
      if (err instanceof ApiError) {
        const reported = (err.payload as { reason?: SignInReason } | null)?.reason;
        setReason(reported ?? 'invalid');
      } else {
        setReason('network');
      }
    } finally {
      setBusy(false);
    }
  };

  /** Full sign-out: drop the cookie and everything cached about this person. */
  const signOut = useCallback(async () => {
    try {
      await api.del('/api/session');
    } catch {
      /* going back to the code screen regardless */
    }
    forgetEverything();
    setSession(null);
    setReason(null);
    setPhase('signed-out');
  }, []);

  /** Team codes only: back to the name list without losing the session. */
  const changePerson = useCallback(async () => {
    try {
      applySession(await api.del<ViewerSession>('/api/session/identify'));
      clearCachedSchedules();
    } catch {
      await signOut();
    }
  }, [applySession, signOut]);

  if (phase === 'checking') {
    return (
      <div className="loading-screen">
        <span className="spinner" />
        <span>Loading…</span>
      </div>
    );
  }

  if (phase === 'signed-out') {
    return (
      <CodeEntry eventName={eventName} reason={reason} busy={busy} onSubmit={submitCode} />
    );
  }

  if (phase === 'identify') {
    return (
      <IdentityPicker
        teamName={session?.subject?.name ?? 'Your team'}
        onPicked={checkSession}
        onUseDifferentCode={signOut}
      />
    );
  }

  return (
    <ScheduleScreen
      // A team member can step back to the name list; everyone else signs out.
      onSwitch={session?.subjectType === 'team' ? changePerson : signOut}
      switchLabel={session?.subjectType === 'team' ? 'Not you?' : 'Sign out'}
      onSessionLost={() => {
        // A 401 means we reached the server and it refused us — the code was
        // revoked, or the session ran out. Being offline does not land here.
        // Drop the cached schedule too: the likeliest reason a code gets
        // revoked mid-event is that the device holding it went missing.
        clearCachedSchedules();
        setPhase('signed-out');
        setReason('expired');
      }}
    />
  );
}

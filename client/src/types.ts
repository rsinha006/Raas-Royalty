export type Selector = 'team' | 'person';
export type TargetType = 'team' | 'person' | 'role';

export interface Role {
  id: string;
  label: string;
  selector: Selector;
  blurb: string | null;
  sortOrder: number;
  active: boolean;
}

export interface Team {
  id: string;
  name: string;
  liaisonContactId: string | null;
  memberCount: number;
  /** Running order, 1–8. Null until the draw. */
  showOrder: number | null;
}

export interface RoleLite {
  id: string;
  label: string;
  selector: Selector;
}

export interface PersonLite {
  id: string;
  name: string;
  /** Every role held, display order first. Captains hold Dancer + Captain. */
  roles: RoleLite[];
  roleIds: string[];
  /** The display role — the first of `roles`. Null only if someone holds none. */
  roleId: string | null;
  roleLabel: string | null;
  teamId: string | null;
}

export interface Person extends PersonLite {
  teamName: string | null;
  contactId: string | null;
}

export interface EventDay {
  key: string;
  label: string;
  date: string;
  sortOrder: number;
  /** Midnight to midnight at the venue, resolved server-side. */
  startsAt: string | null;
  endsAt: string | null;
}

export interface Contact {
  id: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
  note: string | null;
}

export interface BlockLocation {
  id: string;
  venue: string;
  subLocation: string | null;
  display: string;
}

export interface Block {
  id: string;
  day: string;
  /** Venue wall-clock, as written on the call sheet. For display. */
  startTime: string;
  endTime: string;
  /**
   * The same times as absolute instants, resolved against the event timezone by
   * the server. For every comparison. Null when the block's day has no date.
   */
  startsAt: string | null;
  endsAt: string | null;
  activity: string;
  notes: string | null;
  location: BlockLocation | null;
  appliesTo: { type: TargetType; id: string };
  source: string;
  sourceKey: string | null;
  createdAt: string;
  updatedAt: string;
  lastChange: string | null;
}

/**
 * What an unauthenticated visitor is allowed to know. Roles, teams and people
 * used to be here; they left with item 6, because together they were a
 * one-request dump of the whole roster.
 */
export interface Bootstrap {
  eventName: string;
  updatedAt: string;
}

export interface Subject {
  id: string;
  name: string;
  kind: 'team' | 'person' | 'role';
  roleLabel?: string | null;
  /** Every role's label, for people who hold more than one. */
  roleLabels?: string[];
  teamName?: string | null;
}

/** What the server says about the current session. */
export interface ViewerSession {
  subjectType: TargetType;
  identified: boolean;
  /** A team code lands on "which dancer are you?" before showing a schedule. */
  needsIdentity: boolean;
  subject: Subject | null;
}

export interface TeamMember {
  id: string;
  name: string;
}

/**
 * Why sign-in isn't happening. `expired` and `network` are client-side
 * conclusions; the rest come back from the server as `reason`.
 */
export type SignInReason =
  | 'invalid'
  | 'revoked'
  | 'orphaned'
  | 'rate'
  | 'expired'
  | 'network';

export interface EventTime {
  timezone: string;
  now: string;
  wallClock: string;
  abbreviation: string;
  utcOffset: string;
}

export interface SchedulePayload {
  session: { type: Selector; id: string };
  subject: Subject;
  contact: Contact | null;
  days: EventDay[];
  blocks: Block[];
  updatedAt: string;
  fetchedAt: string;
  /** The server's clock and zone, so the client can correct its own drift. */
  eventTime: EventTime;
}


export interface EditLogEntry {
  id: string;
  blockId: string | null;
  editedBy: string;
  source: string;
  timestamp: string;
  changeType: string;
  summary: string;
  audience: { personIds: string[]; teamIds: string[] } | null;
}

/**
 * One block's part in a bulk time shift. `to` is present when it can move;
 * `blocked` when it cannot, and then the row is shown but not selectable.
 */
export interface ShiftMove {
  id: string;
  activity: string;
  appliesTo: { type: TargetType; id: string };
  /** The version this was previewed at — handed back as the concurrency token. */
  updatedAt: string;
  from: { day: string; startTime: string; endTime: string };
  to?: { day: string; startTime: string; endTime: string };
  blocked?: 'no-day' | 'unreadable';
  /** Which way it crossed midnight, when that is why it is blocked. */
  crosses?: number;
}

export interface ShiftPreview {
  day: string;
  fromTime: string;
  minutes: number;
  moves: ShiftMove[];
  blocked: ShiftMove[];
}

export interface AssignmentTarget {
  type: TargetType;
  id: string;
  label: string;
  group: string;
}

export interface TemplateColumn {
  name: string;
  required: boolean;
  note: string;
}

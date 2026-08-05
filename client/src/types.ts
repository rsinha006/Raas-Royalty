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
}

export interface PersonLite {
  id: string;
  name: string;
  roleId: string;
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
  startTime: string;
  endTime: string;
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
  kind: 'team' | 'person';
  roleLabel?: string;
  teamName?: string | null;
}

export interface SchedulePayload {
  session: { type: Selector; id: string };
  subject: Subject;
  contact: Contact | null;
  days: EventDay[];
  blocks: Block[];
  updatedAt: string;
  fetchedAt: string;
}

export interface StoredSession {
  type: Selector;
  id: string;
  roleId: string;
  label: string;
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

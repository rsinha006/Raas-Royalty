/**
 * Demo data for the RAS bid interview.
 *
 * This is NOT the placeholder seed (`server/seed.js`) and it is NOT the real
 * roster. It is the middle thing the bid needs: the event's *real* shape —
 * last year's eight teams in their real running order, the real board and its
 * committees, and a weekend built from the 2026-27 MASTER workbook's own
 * timings — carrying an invented dancer roster.
 *
 * ⚠️ Why the dancers are invented, and must stay invented. This database gets
 * hosted on a public URL for the interview. `samples/` holds ~200 real dancers
 * with real phone numbers, and an access code is a bearer token: seeding real
 * contact details here would publish them. Board members appear by name only —
 * no real phone or email for anyone, ever, in this file.
 *
 *   npm run seed:demo         # rebuild the demo database from scratch
 *
 * The dates are real (5-7 February 2027). If they move, use the script rather
 * than editing this file:
 *
 *   npm run days -- --friday YYYY-MM-DD
 */
import { db, newId, nowIso, touchRosterVersion, touchScheduleVersion, setMeta } from './db.js';
import { logEdit } from './lib/mutations.js';
import { backfillAccessCodes } from './lib/access-codes.js';
import { backfillTargetVersions, ensureEventRoles } from './migrate.js';

/* -------------------- deterministic pseudo-random -------------------- */
// Fixed seed: two runs of this script produce the same roster, so a demo
// rehearsed on Wednesday is the same demo given on Thursday.
let _seed = 20270212;
const rand = () => ((_seed = (_seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pickOne = (arr) => arr[Math.floor(rand() * arr.length)];

/* -------------------- time helpers -------------------- */
const T = (h, m = 0) => h * 60 + m;
/**
 * Minutes-from-midnight to 'HH:MM'. Wraps, because the Friday night in the
 * MASTER workbook genuinely crosses midnight: `event-time.js` reads an end time
 * at or before its start as "the next day", so 23:45 → 00:30 resolves correctly.
 * A block that *starts* after midnight would not — it would anchor to that
 * morning, 24 hours early — so there are none here by construction.
 */
const hhmm = (mins) => {
  const w = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(w / 60)).padStart(2, '0')}:${String(w % 60).padStart(2, '0')}`;
};

/* -------------------- invented roster name pools -------------------- */
const FIRST = [
  'Aanya','Aarav','Aditi','Advait','Akhil','Alisha','Amara','Ananya','Aniket','Anjali',
  'Arjun','Armaan','Arnav','Ashwin','Avani','Ayesha','Bhavya','Chirag','Darsh','Deepa',
  'Dev','Dhruv','Diya','Esha','Gaurav','Gita','Hari','Hemal','Ishaan','Ishita',
  'Jaya','Jayesh','Kabir','Kalyani','Karan','Kavya','Keya','Kiran','Krish','Lakshmi',
  'Maya','Meera','Mihir','Milan','Naina','Neel','Nikhil','Nisha','Nikita','Om',
  'Pari','Parth','Pooja','Pranav','Priya','Rahul','Raj','Rhea','Riya','Rohan',
  'Ronak','Saanvi','Sahil','Samir','Sanjana','Sarika','Shaan','Shreya','Simran','Siya',
  'Sneha','Soham','Tanvi','Tara','Tejas','Uma','Vaishnavi','Varun','Veer','Vidya',
  'Vikram','Vinay','Yash','Zoya','Anika','Aryan','Devan','Ira','Jai','Kunal',
  'Leela','Manav','Nandini','Nivea','Palak','Rishi','Sana','Tanay','Trisha','Vivek',
];
const LAST = [
  'Agarwal','Amin','Bhatt','Chauhan','Chopra','Desai','Dave','Deshpande','Gandhi','Ganguly',
  'Gupta','Iyer','Jain','Joshi','Kapoor','Khanna','Kulkarni','Kumar','Lal','Mehta',
  'Menon','Mishra','Modi','Nair','Nanda','Pandya','Parekh','Patel','Pillai','Prasad',
  'Raman','Rao','Reddy','Sharma','Shah','Sethi','Singh','Sinha','Soni','Subramanian',
  'Thakkar','Trivedi','Varma','Verma','Vora','Bose','Chandra','Dutta','Ghosh','Malhotra',
];

const usedNames = new Set();
function uniqueName() {
  for (let i = 0; i < 2000; i++) {
    const n = `${pickOne(FIRST)} ${pickOne(LAST)}`;
    if (!usedNames.has(n)) {
      usedNames.add(n);
      return n;
    }
  }
  return `Participant ${usedNames.size + 1}`;
}

// Reserve the real board names so the invented roster can never collide with
// one — two people the importer cannot tell apart is the exact bug item 12
// closed, and a demo is a bad place to rediscover it.
const reserve = (n) => usedNames.add(n);

/**
 * Contact details for the demo are synthetic and obviously so. 555 numbers are
 * unassignable by convention and `.invalid` is reserved by RFC 2606, so nothing
 * here can reach a real person even if the demo link is forwarded.
 */
let contactCounter = 0;
const demoPhone = () => `+1-555-01${String(contactCounter++ % 100).padStart(2, '0')}`;
const demoEmail = (name) =>
  `${name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@royalty.invalid`;

/* ==================== the event ==================== */

/**
 * The real competition weekend, confirmed 2026-09-08: Friday 5 February to
 * Sunday 7 February 2027, with Thursday the 4th as the arrival day — teams land
 * Thursday and fly out Sunday, which is why the event is four days and not
 * three.
 *
 * ⚠️ Verified weekdays, not just typed. 2027-02-04 really is a Thursday and
 * 2027-02-07 really is a Sunday; a date that is not the weekday it is labelled
 * with still renders as a perfectly plausible schedule, which is why both
 * `npm run days` and the weekend migration derive rather than invent. If these
 * ever move, use the script instead of editing here — it never touches the
 * keys, and `schedule_blocks.day` is a foreign key onto them.
 *
 *   npm run days -- --friday YYYY-MM-DD
 */
const EVENT_DAYS = [
  { key: 'Thu', label: 'Thursday', date: '2027-02-04', sort: 1 },
  { key: 'Fri', label: 'Friday', date: '2027-02-05', sort: 2 },
  { key: 'Sat', label: 'Saturday', date: '2027-02-06', sort: 3 },
  { key: 'Sun', label: 'Sunday', date: '2027-02-07', sort: 4 },
];

/**
 * The eight teams, in the running order they danced last year. `show_order`
 * drives the tech and show slot arithmetic below, so this array is the only
 * place the order is written down.
 */
const TEAMS = [
  { name: 'UNC Taar Heel Raas', short: 'UNC', order: 1 },
  { name: 'Illini Raas', short: 'Illini', order: 2 },
  { name: 'UTD Taraas', short: 'UTD', order: 3 },
  { name: 'UVA Hooraas', short: 'UVA', order: 4 },
  { name: 'UMD Entouraas', short: 'UMD', order: 5 },
  { name: 'Michigan Wolveraas', short: 'UMich', order: 6 },
  { name: 'MSU Raasparty', short: 'MSU', order: 7 },
  { name: 'GT Ramblin Raas', short: 'GT', order: 8 },
];

/**
 * The exec board, by committee, as it stood for RRXVI.
 *
 * ⚠️ These are real people's names and nothing else — no contact details. They
 * are last year's board; if this year's differs, this array is the one place to
 * fix it and the rest of the file follows.
 *
 * Everyone here holds `exec` plus their committee role. That is the captain
 * pattern from `docs/decisions.md`: `exec` sorts first so it stays their
 * display role, and the committee role exists so "Logistics, report to the
 * dock" is one block rather than four.
 */
const BOARD = [
  ['directors', 'Directors', ['Pranathi Penumada', 'Niki Velavan']],
  ['advisors', 'Senior Advisors', ['Nitya Shah', 'Shivani Vyas']],
  ['logistics-cmte', 'Logistics', ['Anvi Vadlamudi', 'Akshath Kumaresan', 'Ashka Patel', 'Yash Dandamudi']],
  ['hospitality', 'Hospitality', ['Shreya Wunnava', 'Nikhil Singh', 'Ria Challa', 'Vraj Jariwala']],
  ['creative', 'Creative', ['Sarayu Kalwa', 'Tanaya Bhatt', 'Kirthana Marepalli', 'Ira Singh']],
  ['registration', 'Registration', ['Raj Raghuwanshi']],
  ['head-liaisons', 'Head Liaisons', ['Amy Patel', 'Parth Patel', 'Abhi Ankaraju']],
  ['pr', 'PR', ['Meghana Thota', 'Vivek Thakkar', 'Anushka Parandekar']],
  ['external', 'External', ['Ronin Shah', 'Rohan Tyagi']],
  ['judging-cmte', 'Judging', ['Shreyas Mishra', 'Tejas Ravishankar']],
  ['fundraising', 'Fundraising', ['Mehar Oberoi']],
  ['wellness', 'Campus Wellness', ['Rhea Mehta']],
  ['freshreps', 'FreshReps', ['Abhinav Gurram', 'Saahil Sheth', 'Trisha Mehta', 'Ritika Vijay', 'Vishak Ravishankar']],
];

/* ==================== build ==================== */

db.exec(`
  DELETE FROM edit_log;
  DELETE FROM schedule_blocks;
  DELETE FROM target_versions;
  DELETE FROM person_roles;
  DELETE FROM people;
  DELETE FROM teams;
  DELETE FROM support_contacts;
  DELETE FROM contact_cards;
  DELETE FROM locations;
  DELETE FROM event_days;
  DELETE FROM roles;
  DELETE FROM meta;
  DELETE FROM access_codes;
`);

const build = db.transaction(() => {
  setMeta('event_name', 'Raas Royalty XVII');

  const insDay = db.prepare(
    'INSERT INTO event_days (key, label, date, sort_order) VALUES (?, ?, ?, ?)'
  );
  EVENT_DAYS.forEach((d) => insDay.run(d.key, d.label, d.date, d.sort));

  /* -------------------- roles -------------------- */
  const insRole = db.prepare(
    'INSERT INTO roles (id, label, selector, blurb, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  const baseRoles = [
    ['dancer', 'Dancer', 'team', 'Find your team', 1],
    ['exec', 'Exec Board', 'person', 'Find your name', 2],
    ['judge', 'Judge', 'person', 'Find your name', 3],
    ['videographer', 'Videographer', 'person', 'Find your name', 4],
    ['sponsor', 'Sponsor', 'person', 'Find your name', 5],
    ['logistics', 'Logistics & Admin', 'person', 'Find your name', 6],
    ['captain', 'Captain', 'person', 'Team captains', 20],
  ];
  baseRoles.forEach((r) => insRole.run(...r));
  // `liaison` and `ras-rep` are owned by migrate.js for every database.
  ensureEventRoles(db);
  // Committee roles sort after the display roles for the same reason `captain`
  // does: a committee is an overlay carrying blocks, never someone's identity.
  BOARD.forEach(([id, label], i) =>
    insRole.run(id, label, 'person', 'Exec board committee', 30 + i)
  );

  /* -------------------- locations -------------------- */
  // ⚠️ Keyed by an explicit short name, not by `sub_location`. Two venues here
  // have a Lobby, and keying on the sub-location silently pointed every hotel
  // block at the auditorium — a wrong location that still renders perfectly.
  const locs = [
    ['stage', 'IU Auditorium', 'Main Stage'],
    ['backstage', 'IU Auditorium', 'Backstage'],
    ['greenA', 'IU Auditorium', 'Green Room A'],
    ['greenB', 'IU Auditorium', 'Green Room B'],
    ['greenC', 'IU Auditorium', 'Green Room C'],
    ['balcony', 'IU Auditorium', 'Balcony'],
    ['dock', 'IU Auditorium', 'Loading Dock'],
    ['audLobby', 'IU Auditorium', 'Lobby'],
    ['alumniHall', 'Indiana Memorial Union', 'Alumni Hall'],
    ['georgian', 'Indiana Memorial Union', 'Georgian Room'],
    ['hotelLobby', 'Hyatt Place Bloomington', 'Lobby'],
    ['regRoom', 'Hyatt Place Bloomington', 'Registration Room'],
    ['meetingRoom', 'Hyatt Place Bloomington', 'Meeting Room'],
    ['practice', 'Wilkie Auditorium', 'Practice Space'],
    ['airport', 'Indianapolis International Airport', 'Baggage Claim'],
  ];
  const insLoc = db.prepare(
    'INSERT INTO locations (id, venue_name, sub_location) VALUES (?, ?, ?)'
  );
  const L = {};
  locs.forEach(([key, venue, sub]) => {
    const id = newId('loc');
    insLoc.run(id, venue, sub);
    L[key] = id;
  });

  /* -------------------- contact cards -------------------- */
  const insContact = db.prepare(
    'INSERT INTO contact_cards (id, name, title, phone, email, note) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const makeContact = (name, title, note = null) => {
    const id = newId('con');
    insContact.run(id, name, title, demoPhone(), demoEmail(name), note);
    return id;
  };

  const directorCard = makeContact('Pranathi Penumada', 'Event Director', 'Escalations only');
  const logisticsCard = makeContact('Anvi Vadlamudi', 'Logistics Chair', 'Runs the call sheet');
  const headLiaisonCard = makeContact('Amy Patel', 'Head Liaison', 'Any team question starts here');
  const judgingCard = makeContact('Shreyas Mishra', 'Judging Chair');
  const creativeCard = makeContact('Sarayu Kalwa', 'Creative Chair', 'Media and stage design');
  const externalCard = makeContact('Ronin Shah', 'External Chair', 'Sponsors and RAS');
  setMeta('default_contact_id', logisticsCard);

  /**
   * The support contacts — the board members a participant can reach about
   * sexual assault or harassment, shown to every viewer under their liaison.
   *
   * ⚠️ Two things to confirm before this is shown to anyone outside a demo:
   * *who* holds it (these two are placeholders, picked because the board has no
   * Social committee row in this file), and that they have agreed to. The
   * phone numbers here are invented like every other number in this file. The
   * assignment is changed in the panel's Contacts section, not by editing this.
   */
  const insSupport = db.prepare(
    'INSERT INTO support_contacts (contact_id, sort_order) VALUES (?, ?)'
  );
  const supportNote = 'Reach out any time during the weekend — call or text.';
  [
    makeContact('Shreya Wunnava', 'Social Chair', supportNote),
    makeContact('Ria Challa', 'Social Chair', supportNote),
  ].forEach((id, i) => insSupport.run(id, i));

  /* -------------------- teams -------------------- */
  const insTeam = db.prepare(
    'INSERT INTO teams (id, name, liaison_contact_id, show_order) VALUES (?, ?, ?, ?)'
  );
  const insPerson = db.prepare(
    'INSERT INTO people (id, name, team_id, contact_id, email, phone) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insPersonRole = db.prepare(
    'INSERT INTO person_roles (person_id, role_id) VALUES (?, ?)'
  );
  /**
   * ⚠️ `email`/`phone` are this person's own — the address item 25 sends their
   * access link to. `contactId` is somebody *else's* card, the coordinator they
   * should call, and it is shared across a whole team. Building a send list out
   * of the second mails a team's worth of bearer tokens to one inbox.
   */
  const addPerson = (name, roleIds, teamId, contactId) => {
    const id = newId('per');
    insPerson.run(id, name, teamId, contactId, demoEmail(name), demoPhone());
    for (const roleId of roleIds) insPersonRole.run(id, roleId);
    return { id, name, teamId };
  };

  BOARD.forEach(([, , names]) => names.forEach(reserve));

  const teams = TEAMS.map((t) => {
    const id = newId('team');
    // The card a dancer taps is their liaison's, not the board's.
    const liaisonName = uniqueName();
    const card = makeContact(liaisonName, `Team Liaison — ${t.short}`, 'Your first point of contact');
    insTeam.run(id, t.name, card, t.order);
    return { ...t, id, card, liaisonName };
  });

  /* -------------------- people -------------------- */
  const dancers = [];
  const captains = [];
  const liaisons = [];
  const board = [];

  // Dancers: ~25 per team, matching last year's real team sizes, with three
  // captains each holding Dancer + Captain.
  teams.forEach((t) => {
    const size = 22 + Math.floor(rand() * 7); // 22–28
    for (let i = 0; i < size; i++) {
      const isCaptain = i < 3;
      const p = addPerson(uniqueName(), isCaptain ? ['dancer', 'captain'] : ['dancer'], t.id, t.card);
      dancers.push(p);
      if (isCaptain) captains.push({ ...p, team: t });
    }
  });

  // Three liaisons per team, as last year. They hold `liaison` and are reached
  // individually — a liaison is staff, not a member of the team they shadow, so
  // they carry no team_id and do not appear in that team's roster.
  teams.forEach((t) => {
    for (let i = 0; i < 3; i++) {
      const p = addPerson(uniqueName(), ['liaison'], null, headLiaisonCard);
      liaisons.push({ ...p, team: t, lead: i === 0 });
    }
  });

  // The board, by committee.
  const boardByCommittee = new Map();
  BOARD.forEach(([roleId, , names]) => {
    const members = names.map((n) => addPerson(n, ['exec', roleId], null, directorCard));
    boardByCommittee.set(roleId, members);
    board.push(...members);
  });

  const judges = Array.from({ length: 5 }, () =>
    addPerson(uniqueName(), ['judge'], null, judgingCard)
  );
  const videographers = Array.from({ length: 4 }, () =>
    addPerson(uniqueName(), ['videographer'], null, creativeCard)
  );
  const rasReps = Array.from({ length: 2 }, () =>
    addPerson(uniqueName(), ['ras-rep'], null, externalCard)
  );
  const sponsors = Array.from({ length: 4 }, () =>
    addPerson(uniqueName(), ['sponsor'], null, externalCard)
  );

  /* -------------------- schedule -------------------- */
  const insBlock = db.prepare(
    `INSERT INTO schedule_blocks
       (id, day, start_time, end_time, location_id, activity_label,
        applies_to_type, applies_to_id, notes, source, source_key,
        created_at, updated_at, last_change)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', NULL, ?, ?, NULL)`
  );
  /**
   * ⚠️ `source` is 'seed', not 'demo', and that is deliberate. `readiness.js`
   * reads provenance to answer "did this schedule come from a real import or
   * from placeholder data", and it does that by counting `source = 'seed'`.
   * Inventing a third value here would make `npm run rehearsal` report this
   * demo as real event data — a green gate that means nothing, which is the one
   * failure mode item 26 exists to prevent. This data is realistic; it is not
   * real, and the gate should keep saying so.
   */
  const ts = nowIso();
  let blocks = 0;
  const block = (day, start, end, locId, activity, type, targetId, notes = null) => {
    insBlock.run(newId('blk'), day, hhmm(start), hhmm(end), locId, activity, type, targetId, notes, ts, ts);
    blocks++;
  };

  /* ---- Thursday: arrivals ---- */
  block('Thu', T(9), T(21), L.airport, 'Airport pickup window — liaisons on shift',
    'role', 'liaison', 'Two liaisons per run. Confirm flight numbers the night before.');
  block('Thu', T(8), T(10), L.regRoom, 'Registration room setup',
    'role', 'registration');
  block('Thu', T(10), T(12), L.dock, 'Equipment and decor load-in',
    'role', 'logistics-cmte');
  block('Thu', T(20), T(21), L.meetingRoom, 'Board check-in — day one debrief', 'role', 'exec');

  // Staggered arrivals, team by team. Person- and team-targeted blocks read at
  // an airport are the reason Thursday is a day at all.
  teams.forEach((t, i) => {
    const land = T(11) + i * 75;
    block('Thu', land, land + 45, L.airport, `Flight arrival — ${t.short}`, 'team', t.id,
      'Stay together at baggage claim. Your liaison is holding a Royalty sign.');
    block('Thu', land + 45, land + 105, L.hotelLobby,
      'Transport to hotel', 'team', t.id);
    block('Thu', land + 105, land + 135, L.regRoom, 'Hotel check-in & registration',
      'team', t.id, 'One captain collects room keys and wristbands for the whole team.');
  });

  /* ---- Friday: the mixer, straight off the MASTER workbook ---- */
  block('Fri', T(15, 30), T(15, 45), L.alumniHall, 'Venue access / unlock', 'role', 'logistics-cmte',
    'Initial venue access');
  block('Fri', T(15, 30), T(15, 45), L.alumniHall, 'Board arrival & check-in', 'role', 'exec');
  block('Fri', T(15, 45), T(16, 30), L.alumniHall, 'Setup begins — decor, tables, signage',
    'role', 'logistics-cmte');
  block('Fri', T(15, 45), T(16, 30), L.alumniHall, 'AV setup — speakers & microphones',
    'role', 'creative');
  block('Fri', T(16), T(16, 30), L.alumniHall, 'Registration setup', 'role', 'registration',
    'Check-in materials');
  block('Fri', T(16, 15), T(16, 45), L.georgian, 'Catering setup', 'role', 'hospitality',
    'Food and beverages');
  block('Fri', T(16, 30), T(17), L.alumniHall, 'Team arrival window', 'role', 'liaison');
  block('Fri', T(16, 30), T(17, 15), L.alumniHall, 'Team check-in', 'role', 'registration');
  block('Fri', T(17), T(17, 10), L.alumniHall, 'Opening remarks', 'everyone', 'all',
    'Directors on the mic. Everyone in the room, please.');
  block('Fri', T(17, 10), T(18), L.alumniHall, 'Programming & activities', 'role', 'dancer');
  block('Fri', T(18), T(18, 45), L.georgian, 'Food & networking', 'everyone', 'all');
  block('Fri', T(18, 45), T(18, 55), L.alumniHall, 'Final announcements', 'everyone', 'all');
  block('Fri', T(19), T(19, 45), L.alumniHall, 'Mixer teardown', 'role', 'logistics-cmte');
  block('Fri', T(19, 45), T(20), L.alumniHall, 'Venue clear', 'role', 'logistics-cmte');

  // Post-mixer practice. This is the run that crosses midnight.
  teams.forEach((t, i) => {
    const load = T(20) + i * 10;
    block('Fri', load, load + 15, L.alumniHall, 'Bus loading — practice', 'team', t.id,
      'Bring everything. You do not come back here.');
    const practice = T(20, 50) + i * 20;
    block('Fri', practice, practice + 115, L.practice, 'Post-mixer practice', 'team', t.id,
      'Your one full run on a real floor before tech.');
    block('Fri', practice + 115, practice + 175, L.hotelLobby,
      'Return transport & hotel check-in', 'team', t.id);
  });
  block('Fri', T(23, 45), T(24, 30), L.meetingRoom, 'Board meeting — next-day logistics',
    'role', 'exec', 'End-of-night check. Saturday call time is 4:45 AM.');
  block('Fri', T(20), T(24, 30), L.practice, 'Practice supervision', 'role', 'liaison',
    'Stay with your team until they are in their rooms.');

  /* ---- Saturday: tech in the morning, show at night ---- */
  block('Sat', T(5), T(7), L.stage, 'Production setup', 'role', 'creative', '2 hours');
  block('Sat', T(5), T(7), L.dock, 'Production setup — load & rig', 'role', 'logistics-cmte');
  block('Sat', T(7), T(7, 30), L.stage, 'Tech setup', 'role', 'videographer');
  block('Sat', T(4, 45), T(5), L.hotelLobby, 'Board call time',
    'role', 'exec', 'Lobby, ready to move. Coffee is at the venue.');

  /**
   * Tech slots: 15 minutes each with a 7-minute transition, from the workbook's
   * Tech Time tab. Run in reverse show order — the team that closes the show
   * techs first, so nobody techs and performs back to back.
   */
  const techOrder = [...teams].reverse();
  techOrder.forEach((t, i) => {
    const start = T(7, 30) + i * 22;
    block('Sat', start - 30, start, L[['greenA', 'greenB', 'greenC'][i % 3]],
      'Tech hold — stage right', 'team', t.id, 'Costume optional. Shoes on.');
    block('Sat', start, start + 15, L.stage, 'TECH TIME', 'team', t.id,
      'Fifteen minutes, hard out. Spacing, lighting and sound cues.');
  });
  block('Sat', T(7, 30), T(10, 20), L.stage, 'Tech time — booth', 'role', 'videographer',
    'Cue sheet per team. Card swap after team 4.');
  block('Sat', T(7, 30), T(10, 20), L.stage, 'Tech time — floor', 'role', 'liaison',
    'Get your team on and off stage on time.');

  block('Sat', T(11), T(12), L.georgian, 'Lunch — teams', 'role', 'dancer',
    'Grab and go. Dietary restrictions are flagged at the table.');
  block('Sat', T(12), T(13), L.meetingRoom, 'Judges orientation & rubric walkthrough',
    'role', 'judge');
  block('Sat', T(13), T(13, 45), L.meetingRoom, "Captains' meeting", 'role', 'captain',
    'One captain per team minimum. Placings protocol and stage etiquette.');
  block('Sat', T(14), T(15), L.meetingRoom, 'RAS rep briefing', 'role', 'ras-rep');
  block('Sat', T(15), T(16, 30), L.balcony, 'Sponsor reception', 'role', 'sponsor');

  /* Show, from the workbook's Show Schedule tab. */
  block('Sat', T(16, 30), T(17), L.audLobby, 'Doors open', 'everyone', 'all',
    'House is open. Performers backstage from this point.');
  block('Sat', T(17), T(17, 30), L.stage, 'Director speech & intro video', 'everyone', 'all');
  block('Sat', T(18, 33), T(18, 48), L.audLobby, 'Intermission', 'everyone', 'all');
  block('Sat', T(20, 36), T(21, 16), L.stage, 'PLACINGS', 'everyone', 'all',
    'All eight teams on stage.');
  block('Sat', T(21, 16), T(21, 56), L.dock, 'Production breakdown', 'role', 'logistics-cmte');

  /**
   * Performance slots: 12 minutes each with a 5-minute transition, and the
   * 15-minute intermission after team 4 — the workbook's own arithmetic.
   */
  teams.forEach((t, i) => {
    const perform = T(17, 30) + i * 17 + (i >= 4 ? 15 : 0);
    block('Sat', perform - 120, perform - 75, L[['greenA', 'greenB', 'greenC'][i % 3]],
      'Hair, makeup & costume', 'team', t.id);
    block('Sat', perform - 75, perform - 45, L.backstage, 'Team warm-up', 'team', t.id);
    block('Sat', perform - 20, perform, L.backstage, 'Backstage hold — stage right', 'team', t.id,
      'Silent from this point. Phones away.');
    block('Sat', perform, perform + 12, L.stage, 'PERFORMANCE', 'team', t.id,
      'Hard cut at 12 minutes.');
    block('Sat', perform + 15, perform + 35, L.audLobby, 'Team photos', 'team', t.id);
  });

  // Individual assignments — the person-targeting mode.
  judges.forEach((j, i) => {
    block('Sat', T(17), T(20, 30), L.stage, `Scoring — seat ${i + 1}`, 'person', j.id,
      "Judges' table, house centre. Tablet is at your seat.");
    block('Sat', T(20, 30), T(21, 10), L.meetingRoom, 'Deliberation & tabulation', 'person', j.id);
  });
  videographers.forEach((v, i) => {
    const posts = ['House left', 'House right', 'Centre pit', 'Balcony'];
    block('Sat', T(16, 30), T(21, 16), L.stage, `Camera ${i + 1} — ${posts[i]}`,
      'person', v.id, 'Card swap at intermission.');
  });
  liaisons.forEach((l) => {
    block('Sat', T(16), T(21, 16), L.backstage, `Backstage liaison — ${l.team.short}`,
      'person', l.id, 'You are the only person your team should be asking.');
  });
  boardByCommittee.get('directors').forEach((p) => {
    block('Sat', T(21, 16), T(22, 30), L.audLobby, 'RAS debrief & handoff', 'person', p.id);
  });

  /* ---- Sunday: departures ---- */
  block('Sun', T(6), T(16), L.airport, 'Airport dropoff window — liaisons on shift',
    'role', 'liaison', 'Confirm every team is checked in before you leave.');
  block('Sun', T(11), T(13), L.meetingRoom, 'Board wrap-up & inventory', 'role', 'exec');
  teams.forEach((t, i) => {
    const out = T(7) + i * 60;
    block('Sun', out, out + 30, L.hotelLobby, 'Hotel checkout',
      'team', t.id, 'Rooms cleared. Lost and found is at the front desk.');
    block('Sun', out + 30, out + 105, L.airport, `Departure transport — ${t.short}`,
      'team', t.id);
  });

  logEdit({
    editedBy: 'admin',
    source: 'demo',
    changeType: 'sync',
    summary:
      `Demo data: ${teams.length} teams, ` +
      `${dancers.length + liaisons.length + board.length + judges.length + videographers.length + rasReps.length + sponsors.length} people, ` +
      `${blocks} schedule blocks`,
  });

  backfillTargetVersions(db);
  touchRosterVersion();
  touchScheduleVersion();

  return {
    teams: teams.length,
    dancers: dancers.length,
    captains: captains.length,
    liaisons: liaisons.length,
    board: board.length,
    others: judges.length + videographers.length + rasReps.length + sponsors.length,
    blocks,
  };
});

const stats = build();
const codes = backfillAccessCodes({}, { editedBy: 'admin', source: 'demo' });

const people = stats.dancers + stats.liaisons + stats.board + stats.others;
console.log(`Raas Royalty XVII demo data — ${EVENT_DAYS[0].date} to ${EVENT_DAYS[3].date}`);
console.log(
  `  ${stats.teams} teams · ${people} people ` +
    `(${stats.dancers} dancers incl. ${stats.captains} captains, ${stats.liaisons} liaisons, ` +
    `${stats.board} board, ${stats.others} judges/media/RAS/sponsors)`
);
console.log(`  ${stats.blocks} schedule blocks across four days`);
console.log(`  ${codes.created} access codes issued across ${codes.total} subjects`);
console.log('\n  npm run codes -- --list       every code and its subject');
console.log('  npm run days -- --friday YYYY-MM-DD   move the weekend\n');

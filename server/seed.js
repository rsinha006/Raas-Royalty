/**
 * Placeholder roster + schedule so the app can be built and tested before real
 * data exists. Everything here is fake and safe to wipe: `npm run seed:reset`.
 *
 * Deliberately generated rather than hand-written so it hits realistic scale
 * (160 people, 8 teams, ~250 schedule blocks) and exercises all three targeting
 * modes: team, person, and role.
 */
import { db, newId, nowIso, touchScheduleVersion, setMeta } from './db.js';
import { logEdit } from './lib/mutations.js';
import { backfillAccessCodes } from './lib/access-codes.js';

const RESET = process.argv.includes('--reset');

/* -------------------- deterministic pseudo-random -------------------- */
let _seed = 20260807;
const rand = () => ((_seed = (_seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pickOne = (arr) => arr[Math.floor(rand() * arr.length)];

/* -------------------- name pools -------------------- */
const FIRST = [
  'Amara','Priya','Jordan','Maya','Devin','Sofia','Kai','Naomi','Elias','Zara','Marcus','Lena',
  'Theo','Imani','Rafael','Yuki','Owen','Camila','Nico','Aaliyah','Sam','Hana','Julian','Reese',
  'Ariana','Malik','Freya','Dante','Simone','Arjun','Nadia','Emeka','Talia','Rowan','Ines','Cyrus',
  'Wren','Mateo','Anika','Josiah','Sable','Kiran','Noor','Bodhi','Celia','Ronan','Vivi','Oscar',
  'Leila','Tomas','Sana','Beau','Indira','Ezra','Mina','Kofi','Paloma','Dax','Alina','Quinn',
];
const LAST = [
  'Okafor','Nguyen','Alvarez','Chen','Patel','Rivera','Hassan','Kowalski','Bennett','Osei','Sato',
  'Moreau','Silva','Kimura','Adeyemi','Novak','Reyes','Ferrari','Haddad','Lindqvist','Brooks',
  'Iyer','Duarte','Petrov','Cardoso','Mbeki','Halloran','Sandoval','Yamada','Ferreira','Ashworth',
  'Vance','Delacroix','Rahman','Castellanos','Whitfield','Anand','Boateng','Marchetti','Solberg',
];

const usedNames = new Set();
function uniqueName() {
  for (let i = 0; i < 500; i++) {
    const n = `${pickOne(FIRST)} ${pickOne(LAST)}`;
    if (!usedNames.has(n)) {
      usedNames.add(n);
      return n;
    }
  }
  return `Participant ${usedNames.size + 1}`;
}

const phone = (n) => `+1-555-${String(100 + n).padStart(4, '0')}`;
const email = (name) =>
  `${name.toLowerCase().replace(/[^a-z]+/g, '.')}@royaltydance.example`;

/* -------------------- time helpers -------------------- */
const hhmm = (mins) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const T = (h, m = 0) => h * 60 + m;

/* -------------------- reset -------------------- */
if (RESET) {
  db.exec(`
    DELETE FROM edit_log;
    DELETE FROM schedule_blocks;
    DELETE FROM people;
    DELETE FROM teams;
    DELETE FROM contact_cards;
    DELETE FROM locations;
    DELETE FROM event_days;
    DELETE FROM roles;
    DELETE FROM meta;
    DELETE FROM access_codes;
  `);
  console.log('Cleared existing data.');
}

const existing = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
if (existing > 0 && !RESET) {
  // Not a no-op any more: this is the migration path. An existing database
  // predates access codes, so backfill it rather than bailing out. Idempotent,
  // so it never rotates a code that has already been distributed.
  const codes = backfillAccessCodes({}, { editedBy: 'seed', source: 'seed' });
  console.log(`Database already has ${existing} people. Use --reset to rebuild.`);
  console.log(
    `Access codes: ${codes.created} issued, ${codes.kept} already present (${codes.total} subjects).`
  );
  process.exit(0);
}

const seed = db.transaction(() => {
  /* -------------------- meta + days -------------------- */
  setMeta('event_name', 'Royalty 2026');

  const days = [
    { key: 'Fri', label: 'Friday', date: '2026-08-07', sort: 1 },
    { key: 'Sat', label: 'Saturday', date: '2026-08-08', sort: 2 },
  ];
  const insDay = db.prepare(
    'INSERT INTO event_days (key, label, date, sort_order) VALUES (?, ?, ?, ?)'
  );
  days.forEach((d) => insDay.run(d.key, d.label, d.date, d.sort));

  /* -------------------- roles -------------------- */
  const roles = [
    { id: 'dancer', label: 'Dancer', selector: 'team', blurb: 'Find your team', sort: 1 },
    { id: 'exec', label: 'Exec Board', selector: 'person', blurb: 'Find your name', sort: 2 },
    { id: 'judge', label: 'Judge', selector: 'person', blurb: 'Find your name', sort: 3 },
    { id: 'videographer', label: 'Videographer', selector: 'person', blurb: 'Find your name', sort: 4 },
    { id: 'sponsor', label: 'Sponsor', selector: 'person', blurb: 'Find your name', sort: 5 },
    { id: 'logistics', label: 'Logistics & Admin', selector: 'person', blurb: 'Find your name', sort: 6 },
    /**
     * An ordinary role row, held *in addition to* Dancer. Sorted last so it
     * never becomes anyone's display role — a captain reads as a Dancer, which
     * is what they are; Captain is an overlay carrying three extra blocks.
     *
     * `selector: 'person'` means "reached individually", which keeps captains
     * out of the personal-code list: that query excludes anyone holding a
     * team-selector role, and a captain still holds Dancer.
     */
    { id: 'captain', label: 'Captain', selector: 'person', blurb: 'Team captains', sort: 9 },
  ];
  const insRole = db.prepare(
    'INSERT INTO roles (id, label, selector, blurb, sort_order, active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  roles.forEach((r) => insRole.run(r.id, r.label, r.selector, r.blurb, r.sort));

  /* -------------------- locations -------------------- */
  const locs = [
    ['Main Venue', 'Main Stage'],
    ['Main Venue', 'Green Room A'],
    ['Main Venue', 'Green Room B'],
    ['Main Venue', 'Green Room C'],
    ['Main Venue', 'Warm-up Studio'],
    ['Main Venue', 'Lobby / Check-in'],
    ['Main Venue', "Judges' Lounge"],
    ['Main Venue', 'Loading Dock'],
    ['Main Venue', 'Media Booth'],
    ['Hotel Marquette', 'Grand Ballroom'],
    ['Hotel Marquette', 'Terrace'],
  ];
  const insLoc = db.prepare(
    'INSERT INTO locations (id, venue_name, sub_location) VALUES (?, ?, ?)'
  );
  const L = {};
  locs.forEach(([v, s]) => {
    const id = newId('loc');
    insLoc.run(id, v, s);
    L[s] = id;
  });

  /* -------------------- contact cards -------------------- */
  const insContact = db.prepare(
    'INSERT INTO contact_cards (id, name, title, phone, email, note) VALUES (?, ?, ?, ?, ?, ?)'
  );
  let contactCounter = 0;
  const makeContact = (name, title, note = null) => {
    const id = newId('con');
    insContact.run(id, name, title, phone(contactCounter++), email(name), note);
    return id;
  };

  const eventLead = makeContact('Priya Raghavan', 'Event Director', 'Escalations only');
  const logisticsLead = makeContact('Marcus Bell', 'Logistics Lead', 'Runs the call sheet');
  const judgeWrangler = makeContact('Nadia Haddad', 'Judges Coordinator');
  const mediaLead = makeContact('Rowan Vance', 'Media Lead');
  const sponsorLead = makeContact('Camila Duarte', 'Sponsorship Lead');
  setMeta('default_contact_id', logisticsLead);

  /* -------------------- teams + liaisons -------------------- */
  const teamNames = [
    'Kinetic Motion',
    'Rhythm Nation',
    'Verve Dance Co.',
    'Pulse Collective',
    'Elevate Crew',
    'Momentum',
    'Cadence',
    'Aftershock',
  ];
  const insTeam = db.prepare(
    'INSERT INTO teams (id, name, liaison_contact_id, show_order) VALUES (?, ?, ?, ?)'
  );
  const teams = teamNames.map((name, i) => {
    const liaisonName = uniqueName();
    const liaison = makeContact(liaisonName, `Team Liaison — ${name}`, 'Your first point of contact');
    const id = newId('team');
    // The draw is late in reality; seeded here so the column is exercised.
    insTeam.run(id, name, liaison, i + 1);
    return { id, name, liaison };
  });

  /* -------------------- people -------------------- */
  const insPerson = db.prepare(
    'INSERT INTO people (id, name, team_id, contact_id) VALUES (?, ?, ?, ?)'
  );
  const insPersonRole = db.prepare(
    'INSERT INTO person_roles (person_id, role_id) VALUES (?, ?)'
  );
  const addPerson = (id, name, roleIds, teamId, contactId) => {
    insPerson.run(id, name, teamId, contactId);
    for (const roleId of roleIds) insPersonRole.run(id, roleId);
  };
  const people = { dancer: [], exec: [], judge: [], videographer: [], sponsor: [], logistics: [] };
  const captains = [];

  teams.forEach((t) => {
    const size = 15 + Math.floor(rand() * 4); // 15–18 dancers per team
    for (let i = 0; i < size; i++) {
      const id = newId('per');
      const name = uniqueName();
      // Three captains per team, holding Dancer + Captain.
      const isCaptain = i < 3;
      addPerson(id, name, isCaptain ? ['dancer', 'captain'] : ['dancer'], t.id, t.liaison);
      people.dancer.push({ id, name, teamId: t.id });
      if (isCaptain) captains.push({ id, name, teamId: t.id });
    }
  });

  const addStaff = (roleId, count, contactId, titleFn) => {
    for (let i = 0; i < count; i++) {
      const name = uniqueName();
      const own = makeContact(name, titleFn(i));
      const id = newId('per');
      addPerson(id, name, [roleId], null, contactId);
      people[roleId].push({ id, name, ownContact: own });
    }
  };

  addStaff('exec', 12, eventLead, (i) => `Exec Board Member ${i + 1}`);
  addStaff('judge', 6, judgeWrangler, (i) => `Judge — Panel ${i < 3 ? 'A' : 'B'}`);
  addStaff('videographer', 5, mediaLead, (i) => `Camera ${i + 1}`);
  addStaff('sponsor', 6, sponsorLead, (i) => `Sponsor Representative ${i + 1}`);
  addStaff('logistics', 8, logisticsLead, (i) => `Logistics Crew ${i + 1}`);

  /* -------------------- schedule -------------------- */
  const insBlock = db.prepare(
    `INSERT INTO schedule_blocks
       (id, day, start_time, end_time, location_id, activity_label,
        applies_to_type, applies_to_id, notes, source, source_key,
        created_at, updated_at, last_change)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', NULL, ?, ?, NULL)`
  );
  const ts = nowIso();
  let blockCount = 0;
  const block = (day, start, end, locId, activity, type, targetId, notes = null) => {
    insBlock.run(
      newId('blk'),
      day,
      hhmm(start),
      hhmm(end),
      locId,
      activity,
      type,
      targetId,
      notes,
      ts,
      ts
    );
    blockCount++;
  };

  /* ---- Friday: load-in and tech ---- */
  block('Fri', T(11), T(14), L['Loading Dock'], 'Venue load-in & staging', 'role', 'logistics',
    'Truck arrives 11:00 sharp — dock code 4417');
  block('Fri', T(12), T(14), L['Main Stage'], 'Stage build & spacing marks', 'role', 'exec');
  block('Fri', T(13), T(15), L['Media Booth'], 'Camera rig & audio setup', 'role', 'videographer');
  block('Fri', T(14), T(14, 30), L['Lobby / Check-in'], 'Registration opens', 'role', 'dancer',
    'Bring photo ID. One captain checks in for the whole team.');
  block('Fri', T(18), T(19), L["Judges' Lounge"], 'Judges orientation & rubric walkthrough', 'role', 'judge');
  /**
   * The three captain-only blocks. One row each, targeted at the Captain role —
   * which is the entire reason captains hold a second role rather than a
   * boolean. As person-targeted blocks these would be 24 rows to bulk-shift
   * when the day runs late, and 24 to re-create by hand if a fourth captain
   * meeting appears mid-event.
   */
  block('Fri', T(17), T(17, 45), L['Grand Ballroom'], "Captains' meeting", 'role', 'captain',
    'One captain per team minimum. Running order draw happens here.');
  block('Fri', T(20, 30), T(21), L['Main Stage'], 'Lighting cues check — captains', 'role', 'captain',
    'Bring your cue sheet.');
  block('Fri', T(19), T(20, 30), L['Grand Ballroom'], 'Sponsor welcome dinner', 'role', 'sponsor',
    'Business casual. Table assignments at the door.');

  // Staggered per-team Friday rotation.
  teams.forEach((t, i) => {
    const base = T(15) + i * 45;
    block('Fri', base, base + 30, L['Lobby / Check-in'], 'Team check-in & wristbands', 'team', t.id,
      'All members must be present.');
    block('Fri', base + 30, base + 75, L['Main Stage'], 'Tech rehearsal (spacing + lighting)', 'team', t.id,
      'You get one run. Music cued from the booth.');
    block('Fri', base + 75, base + 120, L[`Green Room ${['A', 'B', 'C'][i % 3]}`],
      'Green room hold & notes', 'team', t.id);
  });

  /* ---- Saturday: competition day ---- */
  block('Sat', T(8), T(9), L['Loading Dock'], 'Morning reset & floor sweep', 'role', 'logistics');
  block('Sat', T(9), T(9, 30), L['Main Stage'], 'All-dancer call time & safety brief', 'role', 'dancer',
    'Mandatory. Roll is taken by team.');
  block('Sat', T(9, 30), T(10), L["Judges' Lounge"], 'Judges check-in & scoring tablets', 'role', 'judge');
  block('Sat', T(10), T(10, 30), L["Judges' Lounge"], "Captains & judges' briefing", 'role', 'captain',
    'Scoring questions answered here, not backstage.');
  block('Sat', T(10), T(10, 30), L['Media Booth'], 'Media sync & shot list review', 'role', 'videographer');
  block('Sat', T(11), T(12), L['Grand Ballroom'], 'Exec board sync — run of show', 'role', 'exec');
  block('Sat', T(16), T(17), L['Terrace'], 'Sponsor reception & activation walkthrough', 'role', 'sponsor');
  block('Sat', T(20), T(21), L['Main Stage'], 'Awards ceremony', 'role', 'dancer',
    'Full team on stage in performance costume.');
  block('Sat', T(20), T(21), L['Main Stage'], 'Awards ceremony — presenters', 'role', 'exec');
  block('Sat', T(21), T(23), L['Loading Dock'], 'Strike & load-out', 'role', 'logistics');

  // Per-team competition rotation: warm-up → backstage → perform → photos.
  teams.forEach((t, i) => {
    const perform = T(13) + i * 25;
    block('Sat', perform - 90, perform - 60, L['Warm-up Studio'], 'Team warm-up', 'team', t.id);
    block('Sat', perform - 20, perform, L[`Green Room ${['A', 'B', 'C'][i % 3]}`],
      'Backstage hold — stage right', 'team', t.id, 'Silent from this point. Phones away.');
    block('Sat', perform, perform + 12, L['Main Stage'], 'PERFORMANCE', 'team', t.id,
      'Hard cut at 12 minutes.');
    block('Sat', perform + 15, perform + 35, L['Lobby / Check-in'], 'Team photos', 'team', t.id);
  });

  // Individual assignments — the person-level targeting mode.
  people.judge.forEach((j, i) => {
    const panel = i < 3 ? 'A' : 'B';
    block('Sat', T(12, 30), T(17), L['Main Stage'], `Scoring — Panel ${panel}`, 'person', j.id,
      `Seat ${i + 1} at the judges' table.`);
    block('Sat', T(17, 30), T(19), L["Judges' Lounge"], 'Deliberation & tabulation', 'person', j.id);
  });

  people.videographer.forEach((v, i) => {
    const posts = ['House left', 'House right', 'Center pit', 'Balcony', 'Roaming / backstage'];
    block('Sat', T(12), T(19), L['Main Stage'], `Camera ${i + 1} — ${posts[i % posts.length]}`,
      'person', v.id, 'Card swap between team 4 and 5.');
    block('Fri', T(15), T(19), L['Main Stage'], 'Tech rehearsal B-roll', 'person', v.id);
  });

  people.logistics.forEach((p, i) => {
    const shift = i % 2 === 0 ? [T(8), T(15)] : [T(14), T(22)];
    block('Sat', shift[0], shift[1], L['Lobby / Check-in'], `Floor shift ${i % 2 === 0 ? 'AM' : 'PM'}`,
      'person', p.id, 'Radio channel 3.');
  });

  people.exec.slice(0, 6).forEach((p, i) => {
    block('Fri', T(16) + i * 30, T(17) + i * 30, L['Main Stage'], 'Tech rehearsal supervision',
      'person', p.id, `Covering teams ${i * 2 + 1}–${i * 2 + 2}.`);
  });

  logEdit({
    editedBy: 'admin',
    source: 'seed',
    changeType: 'sync',
    summary: `Seeded placeholder data: ${teams.length} teams, ${Object.values(people).flat().length} people, ${blockCount} schedule blocks`,
  });

  touchScheduleVersion();

  return {
    teams: teams.length,
    people: Object.values(people).flat().length,
    blocks: blockCount,
  };
});

const stats = seed();
const codes = backfillAccessCodes({}, { editedBy: 'seed', source: 'seed' });

console.log(
  `Seeded ${stats.people} people across ${stats.teams} teams, ${stats.blocks} schedule blocks.`
);
// Read back rather than hardcoded — the literal list here went stale the first
// time a role was added.
console.log(
  `Roles: ${db
    .prepare('SELECT label FROM roles ORDER BY sort_order, label')
    .all()
    .map((r) => r.label)
    .join(', ')}`
);
console.log(
  `Access codes: ${codes.created} issued across ${codes.total} subjects ` +
    '(one per team, one per staff member; dancers use their team code).'
);

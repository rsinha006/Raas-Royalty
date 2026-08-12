/**
 * Printed fallback call sheets — item 28.
 *
 * If the app is down at 1pm Saturday, the answer is paper, not a rollback. This
 * builds that paper: one sheet per team, one per staff role, and one desk index
 * for the person answering "I lost my link".
 *
 * Three properties make it worth generating rather than typing:
 *
 * ⚠️ **The blocks come from `getPersonalizedSchedule`** — the viewer's own
 * function, called with the viewer's own argument shape. Paper that was
 * assembled by a second query would disagree with the phones on exactly the
 * blocks nobody thought about, and it would be reached for at the moment there
 * is no way left to check. Same rule as `view-as.js`, for the same reason.
 *
 * ⚠️ **A team sheet is the team *plus its members*, because paper has no
 * identity step.** A team session deliberately holds no person-targeted and no
 * Captain blocks — before someone taps their name there is no way to know whose
 * phone it is (see `resolveSession`). Printing that view alone would produce a
 * team sheet with every airport pickup missing and no error anywhere. So each
 * member gets a section of what their own phone holds and the shared part does
 * not: `own.blocks \ shared.blocks`, a set difference on block ids, never a
 * re-derivation of who-sees-what.
 *
 * ⚠️ **Access codes appear on the desk index and nowhere else.** A code is a
 * bearer token; a team sheet is handed to 25 dancers and taped to a wall, and
 * a photograph of it would be a live credential. The desk index stays behind
 * the desk with somebody who already has the panel password. There is a test
 * asserting no code string reaches a team or role sheet.
 *
 * Coverage is reported rather than assumed: a person on no sheet, and a block
 * on no sheet, are the two ways paper silently loses somebody. `npm run
 * callsheets -- --check` exits non-zero on either.
 */
import { getMeta } from '../db.js';
import { codeForSubject } from './access-codes.js';
import { eventTimeState } from './event-time.js';
import {
  describeTarget,
  getPersonalizedSchedule,
  listAllBlocks,
  listDays,
  listPeople,
  listRoles,
  listTeams,
} from './queries.js';
import { accessFor, ROUTES } from './view-as.js';

/** `HH:MM` → "1:05 PM". Mirrors `client/src/time.ts` so paper reads like the phone. */
export function formatTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return String(hhmm);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

export const formatRange = (start, end) => `${formatTime(start)} – ${formatTime(end)}`;

/**
 * Who to page when the app is the problem.
 *
 * Environment rather than roster, because the on-call person is a property of
 * the *deploy* — the same reason `ALERT_WEBHOOK_URL` is. Unset prints a ruled
 * blank line saying so; a sheet that quietly omits the section reads as
 * finished. `deploy-config.js` warns when it is missing.
 */
export function onCall(env = process.env) {
  const name = (env.ON_CALL_NAME || '').trim();
  const phone = (env.ON_CALL_PHONE || '').trim();
  return { name: name || null, phone: phone || null, set: Boolean(name && phone) };
}

/** Blocks grouped into the event's days, in day order, empty days dropped. */
function byDay(blocks, days) {
  const order = new Map(days.map((d, i) => [d.key, i]));
  const groups = new Map();
  for (const b of blocks) {
    if (!groups.has(b.day)) groups.set(b.day, []);
    groups.get(b.day).push(b);
  }
  return [...groups.entries()]
    .sort((a, c) => (order.get(a[0]) ?? 99) - (order.get(c[0]) ?? 99))
    .map(([key, list]) => {
      const day = days.find((d) => d.key === key);
      return {
        key,
        label: day?.label ?? key,
        date: day?.date ?? null,
        blocks: list.sort((x, y) => x.startTime.localeCompare(y.startTime)),
      };
    });
}

/** The group half of a sheet: exactly what that team's or role's own code shows. */
function groupPayload(type, id) {
  const payload = getPersonalizedSchedule({ type, id });
  return { blocks: payload?.blocks ?? [], contact: payload?.contact ?? null };
}

/**
 * One person's section: what their phone holds and the shared part does not.
 *
 * The subtraction is by block id against the group's own payload, so nothing
 * here decides who sees what — `getPersonalizedSchedule` already did, twice.
 */
function personSection(person, sharedIds, days) {
  const payload = getPersonalizedSchedule({ type: 'person', id: person.id });
  const own = payload?.blocks ?? [];
  const extra = own.filter((b) => !sharedIds.has(b.id));
  return {
    id: person.id,
    name: person.name,
    roleLabels: person.roles.map((r) => r.label),
    teamName: person.teamName,
    contact: payload?.contact ?? null,
    blockIds: own.map((b) => b.id),
    days: byDay(extra, days),
    count: extra.length,
  };
}

/**
 * Which sheet a person's own blocks are printed on. One sheet each — a person
 * printed twice is a person handed two answers.
 *
 * On a team if they are on one; otherwise on the sheet for their display role,
 * which is the role that reads next to their name everywhere else. That covers
 * the state item 14 creates when a team is deleted: its dancers are unassigned,
 * not removed, and they keep a schedule they can no longer sign in to see. On
 * paper they land on the Dancer sheet rather than nowhere.
 */
export function sheetKeyFor(person) {
  if (person.teamId) return `team:${person.teamId}`;
  if (person.roleId) return `role:${person.roleId}`;
  return null;
}

/**
 * Everything the printed pack contains.
 *
 * @param {object} opts
 * @param {Date}   opts.at       the moment the pack is generated — it is stamped on every page
 * @param {string} opts.baseUrl  where magic links point, for the desk index
 * @param {object} opts.env      for the on-call block
 */
export function buildCallSheets({ at = new Date(), baseUrl = '', env = process.env } = {}) {
  const time = eventTimeState(at);
  const days = listDays();
  const people = listPeople();
  const teams = listTeams();
  const roles = listRoles({ includeInactive: true });
  const roleById = new Map(roles.map((r) => [r.id, r]));

  const membersBySheet = new Map();
  const unplaced = [];
  for (const p of people) {
    const key = sheetKeyFor(p);
    if (!key) {
      unplaced.push({ id: p.id, name: p.name, why: 'On no team and holding no role.' });
      continue;
    }
    if (!membersBySheet.has(key)) membersBySheet.set(key, []);
    membersBySheet.get(key).push(p);
  }

  const sheets = [];

  for (const team of teams) {
    const { blocks, contact } = groupPayload('team', team.id);
    const sharedIds = new Set(blocks.map((b) => b.id));
    const members = membersBySheet.get(`team:${team.id}`) ?? [];
    sheets.push({
      kind: 'team',
      id: team.id,
      key: `team:${team.id}`,
      title: team.name,
      subtitle: team.showOrder ? `Running order ${team.showOrder}` : 'Team',
      contact,
      shared: byDay(blocks, days),
      sharedCount: blocks.length,
      people: members.map((p) => personSection(p, sharedIds, days)),
    });
  }

  /**
   * A role sheet for every role that anybody lands on. Dancers on a team are
   * already on their team's sheet, so in practice this is the ~80 staff — but
   * the rule is "whoever is left", not a list of role ids, because roles are
   * data and a new one must not silently print nothing.
   */
  const roleKeys = [...membersBySheet.keys()].filter((k) => k.startsWith('role:'));
  const orderedRoleKeys = roleKeys.sort((a, b) => {
    const ra = roleById.get(a.slice(5));
    const rb = roleById.get(b.slice(5));
    return (ra?.sortOrder ?? 99) - (rb?.sortOrder ?? 99) || (ra?.label ?? '').localeCompare(rb?.label ?? '');
  });

  for (const key of orderedRoleKeys) {
    const roleId = key.slice(5);
    const role = roleById.get(roleId);
    const { blocks, contact } = groupPayload('role', roleId);
    const sharedIds = new Set(blocks.map((b) => b.id));
    sheets.push({
      kind: 'role',
      id: roleId,
      key,
      title: role ? `All ${role.label}` : describeTarget('role', roleId),
      subtitle: 'Everyone holding this role, and their own blocks',
      contact,
      shared: byDay(blocks, days),
      sharedCount: blocks.length,
      people: (membersBySheet.get(key) ?? []).map((p) => personSection(p, sharedIds, days)),
    });
  }

  /**
   * The desk index. Every person, how they sign in, and the code that does it —
   * so "I lost my link" is a lookup rather than a search through the panel with
   * a queue waiting.
   */
  const link = (code) => (baseUrl ? `${baseUrl.replace(/\/+$/, '')}/s/${code}` : `/s/${code}`);
  const desk = [...people]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const access = accessFor('person', p.id);
      const record = access.code ? codeForSubject(access.code.subjectType, access.code.subjectId) : null;
      return {
        name: p.name,
        roleLabels: p.roles.map((r) => r.label),
        teamName: p.teamName,
        route: access.route,
        // What to say at the desk, decided once here rather than improvised per
        // person: a dancer is given their team's link and picks their own name.
        how:
          access.route === ROUTES.TEAM_THEN_NAME
            ? `Team link (${p.teamName}), then tap their name`
            : access.route === ROUTES.OWN
              ? 'Their own link'
              : access.note || 'No way in — see the panel',
        code: record?.code ?? null,
        link: record ? link(record.code) : null,
        // A person with a schedule and no live code cannot open the app at all.
        // On paper that is a row to fix, not an empty cell.
        blocked: record ? null : access.note || 'No live access code.',
      };
    });

  /**
   * Blocks that reach no sheet. Almost always a role nobody holds, or a
   * person-targeted block for somebody who has left the roster — the paper
   * equivalent of `npm run codes -- --check`.
   */
  const printed = new Set();
  for (const sheet of sheets) {
    for (const day of sheet.shared) for (const b of day.blocks) printed.add(b.id);
    for (const person of sheet.people) for (const id of person.blockIds) printed.add(id);
  }
  const unprinted = listAllBlocks()
    .filter((b) => !printed.has(b.id))
    .map((b) => ({
      id: b.id,
      day: b.day,
      time: formatRange(b.startTime, b.endTime),
      activity: b.activity,
      target: describeTarget(b.appliesTo.type, b.appliesTo.id),
    }));

  return {
    eventName: getMeta('event_name', 'Royalty Dance Competition'),
    generatedAt: at.toISOString(),
    time,
    days,
    onCall: onCall(env),
    sheets,
    desk,
    coverage: {
      sheets: sheets.length,
      people: people.length,
      placed: people.length - unplaced.length,
      unplaced,
      unprinted,
      withoutCode: desk.filter((d) => !d.code).length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 *
 * One self-contained HTML file with its own print stylesheet: it has to open
 * and print from any laptop at the venue, including one that cannot reach the
 * server, so it links to nothing. Black on white, 11pt, because it is read
 * under stage lighting and photocopied.
 * ------------------------------------------------------------------ */

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #000;
         font: 11pt/1.35 -apple-system, "Helvetica Neue", Arial, sans-serif; }
  .sheet { padding: 14mm 12mm; max-width: 210mm; margin: 0 auto;
           border-bottom: 1px dashed #999; }
  .sheet:last-child { border-bottom: 0; }
  h1 { font-size: 19pt; margin: 0 0 2pt; }
  h2 { font-size: 12pt; margin: 14pt 0 4pt; border-bottom: 1.5pt solid #000; padding-bottom: 2pt; }
  h3 { font-size: 11pt; margin: 10pt 0 2pt; }
  .sub { font-size: 10pt; margin: 0 0 8pt; }
  .stamp { border: 1.5pt solid #000; padding: 5pt 7pt; margin: 8pt 0 10pt; font-size: 9.5pt; }
  .stamp strong { font-size: 10.5pt; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6pt; }
  th, td { text-align: left; vertical-align: top; padding: 3pt 4pt;
           border-bottom: 0.5pt solid #bbb; }
  th { font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em;
       border-bottom: 1pt solid #000; }
  td.time { white-space: nowrap; font-weight: 700; width: 30mm; }
  td.where { width: 45mm; }
  .note { font-size: 9.5pt; }
  .muted { color: #444; }
  .person { margin-top: 8pt; page-break-inside: avoid; }
  .person .who { font-weight: 700; }
  .empty { font-size: 10pt; padding: 4pt 0; }
  .contact { margin-top: 12pt; border-top: 1.5pt solid #000; padding-top: 5pt; font-size: 10pt; }
  .blank { display: inline-block; min-width: 55mm; border-bottom: 1pt solid #000; }
  ul.plain { margin: 4pt 0; padding-left: 16pt; }
  @media print {
    .sheet { page-break-after: always; border-bottom: 0; padding: 0; max-width: none; }
    .sheet:last-child { page-break-after: auto; }
    @page { margin: 14mm 12mm; }
  }
`;

function stampHtml(doc) {
  const w = doc.time.wallClock.replace('T', ' ');
  return `<div class="stamp">
    <strong>Printed ${esc(w)} ${esc(doc.time.abbreviation)}.</strong>
    Paper does not update. If this sheet and somebody's phone disagree,
    <strong>the phone is right</strong> — and if nobody's phone is working, this is the
    schedule as it stood at the time above.
  </div>`;
}

function tableHtml(dayGroups, emptyText) {
  if (!dayGroups.length) return `<p class="empty muted">${esc(emptyText)}</p>`;
  return dayGroups
    .map(
      (d) => `<h3>${esc(d.label)}${d.date ? ` <span class="muted">${esc(d.date)}</span>` : ''}</h3>
      <table>
        <thead><tr><th>Time</th><th>What</th><th>Where</th><th>Notes</th></tr></thead>
        <tbody>${d.blocks
          .map(
            (b) => `<tr>
              <td class="time">${esc(formatRange(b.startTime, b.endTime))}</td>
              <td>${esc(b.activity)}</td>
              <td class="where">${esc(b.location?.display ?? '')}</td>
              <td class="note">${esc(b.notes ?? '')}</td>
            </tr>`
          )
          .join('')}</tbody>
      </table>`
    )
    .join('');
}

function contactHtml(contact) {
  if (!contact) return '';
  const bits = [contact.title, contact.phone, contact.email].filter(Boolean).map(esc).join(' · ');
  return `<div class="contact"><strong>Who to call:</strong> ${esc(contact.name)}${
    bits ? ` — ${bits}` : ''
  }</div>`;
}

function sheetHtml(doc, sheet) {
  /**
   * Only the people who have something of their own get a table. On a 25-dancer
   * team that is usually the two captains and whoever is on an airport run, and
   * printing "nothing further" 23 times would push the part that matters onto a
   * second page. The rest are still named — a sheet is also the team's roll —
   * just on one line.
   */
  const withExtras = sheet.people.filter((p) => p.count);
  const rest = sheet.people.filter((p) => !p.count);

  const sections = withExtras
    .map(
      (p) => `<div class="person">
        <div class="who">${esc(p.name)}${
          p.roleLabels.length ? ` <span class="muted">— ${esc(p.roleLabels.join(', '))}</span>` : ''
        }</div>
        ${tableHtml(p.days, '')}
      </div>`
    )
    .join('');

  const restHtml = rest.length
    ? `<p class="note"><strong>Nothing else individually (${rest.length}):</strong>
        ${rest.map((p) => esc(p.name)).join(', ')}.</p>`
    : '';

  return `<section class="sheet">
    <h1>${esc(sheet.title)}</h1>
    <p class="sub">${esc(doc.eventName)} · ${esc(sheet.subtitle)} · ${sheet.people.length} ${
      sheet.people.length === 1 ? 'person' : 'people'
    }</p>
    ${stampHtml(doc)}
    <h2>Everyone on this sheet</h2>
    ${tableHtml(sheet.shared, 'No shared blocks.')}
    <h2>Individually (${withExtras.length} of ${sheet.people.length})</h2>
    ${sections || '<p class="empty muted">Nobody here has a block of their own.</p>'}
    ${restHtml}
    ${contactHtml(sheet.contact)}
  </section>`;
}

/**
 * The desk index — the one page that carries codes, and the one page that does
 * not get handed out. It also carries the two answers item 28 asks to have
 * decided in advance, printed rather than remembered.
 */
function deskHtml(doc) {
  const rows = doc.desk
    .map(
      (d) => `<tr>
        <td>${esc(d.name)}</td>
        <td class="note">${esc([d.teamName, d.roleLabels.join(', ')].filter(Boolean).join(' · '))}</td>
        <td class="note">${esc(d.how)}</td>
        <td class="time">${esc(d.code ?? '—')}</td>
        <td class="note">${esc(d.blocked ?? '')}</td>
      </tr>`
    )
    .join('');

  const oc = doc.onCall.set
    ? `<strong>${esc(doc.onCall.name)}</strong> — ${esc(doc.onCall.phone)}`
    : 'NOT SET — write the name and number here before the doors open: <span class="blank"></span>';

  return `<section class="sheet">
    <h1>Check-in desk</h1>
    <p class="sub">${esc(doc.eventName)} · keep this one behind the desk</p>
    ${stampHtml(doc)}
    <div class="stamp">
      <strong>This page lists live access codes.</strong> A code is a password in a link:
      anyone holding it sees that person's or that team's schedule. Do not hand this page out,
      leave it on a table, or photograph it.
    </div>

    <h2>On call for the app</h2>
    <p>${oc}</p>

    <h2>"I lost my link"</h2>
    <ul class="plain">
      <li><strong>A dancer:</strong> find their team below and give them the team link. They tap
        their own name when it opens. Nothing is invalidated and nobody else is affected.</li>
      <li><strong>Staff:</strong> give them their own link from the row below.</li>
      <li><strong>Do not regenerate</strong> to solve a lost link — the old link still works, and
        rotating it breaks whoever else is holding it. Regenerate only for a lost or stolen
        phone, and then send the new link to that person.</li>
      <li><strong>No code at all</strong> (last column): issue one in
        <em>Admin → Access codes</em>, then read the new link off this page's replacement.</li>
    </ul>

    <h2>Everyone, A–Z (${doc.desk.length})</h2>
    <table>
      <thead><tr><th>Name</th><th>Team / role</th><th>How they get in</th><th>Code</th><th>Problem</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">Nobody on the roster.</td></tr>'}</tbody>
    </table>
  </section>`;
}

/**
 * @param {object} doc from `buildCallSheets`
 * @param {{desk?: boolean, sheets?: boolean}} what — the desk page carries codes,
 *   so it is printed separately from the pack that gets handed out.
 */
export function renderCallSheets(doc, { desk = true, sheets = true } = {}) {
  const body = [
    sheets ? doc.sheets.map((s) => sheetHtml(doc, s)).join('\n') : '',
    desk ? deskHtml(doc) : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.eventName)} — call sheets ${esc(doc.time.wallClock.slice(0, 10))}</title>
<style>${STYLE}</style>
</head>
<body>
${body || '<section class="sheet"><h1>Nothing to print</h1></section>'}
</body>
</html>
`;
}

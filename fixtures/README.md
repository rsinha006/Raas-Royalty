# Fixtures

Anonymized copies of the real past-year spreadsheets in `samples/`. Every person
and phone number is fake; everything else — structure, formulas, merge geometry,
and the mess — is byte-for-byte what logistics actually produced.

These are committed. `samples/` is gitignored and must stay that way: it carries
names and contact details for ~250 real people, and this repository is public.

## Regenerating

```bash
python3 scripts/anonymize_samples.py && python3 scripts/verify_fixtures.py
```

Needs `openpyxl` and a copy of `samples/`. The mapping is derived at runtime from
a fixed seed and never written to disk, so the output is stable across runs but
cannot be reversed into the originals. Anyone without `samples/` can still use
the fixtures; they just can't rebuild them.

`verify_fixtures.py` is the gate. It fails if any real name, phone number, or
piece of document metadata survived, and if the structure drifted. Run it before
committing a regenerated fixture.

## What's in here

| File | Shape |
| --- | --- |
| `Team Contact Information [FULL ROSTER].xlsx` | 10 sheets — 8 team rosters + 2 aggregate tabs, 186 dancers |
| `24-25 OFFICIAL RRXVI WEEKEND TASK SHEET.xlsx` | 16 sheets — 4 merged day grids + 9 logistics tabs + 3 empty, 1,679 merged ranges |
| `RAS Rep Schedule .xlsx` | 8 sheets — the previous year (RRXIV), a different eight teams |
| `Raas Royalty Auditorium Schedule-1_27_24.xlsx` | 6 sheets — RRXIV auditorium/tech schedule |

The last two are from a **different year** than the first two, with a completely
different team set (UCSD, VT, UCLA, Chicago, Purdue, GW). That makes them the
year-over-year drift sample [the analysis](../docs/sample-data-analysis.md)
said we didn't have — worth using when testing that the importer doesn't assume
this year's teams.

## Edge cases these exist to preserve

Every one of these is checked by `verify_fixtures.py`. If you change the
anonymizer, the check is what tells you whether you broke a fixture's reason for
existing.

**Roster**

- Name split across two columns; **no team column** — team is the sheet name.
- Trailing-space names (24 of them), pervasive on one team's whole sheet.
- The `*` / `**` suffix on 27 names. It marks **food restrictions**, not
  captains — see [docs/decisions.md](../docs/decisions.md). Strip it from names.
- Two dancers on one team sharing a name, with different phone numbers. Real
  people, not duplicates: name matching needs a tiebreak.
- Five phone formats — bare 10-digit stored as a *number*, hyphenated,
  space-padded, `(812) 335-8000`, and `(925)-430-8287`. Plus five numbers
  wrapped in invisible Unicode direction marks, which break `tel:` links and
  string comparison.
- One dancer with no phone number at all.
- Side tables in columns G–K holding unrelated tallies. An importer that reads
  "all columns until empty" eats them.
- Free-form dietary text with inconsistent casing and prose.

**Day grids**

- A merged Gantt wall chart, not a table. Merge width is duration.
- Column granularity differs per day: 30-minute, 15-minute, 5-minute.
- Meridiem written on the **end time only** in many cells, and absent entirely
  in others. Parsing the start time independently is a silent 12-hour error.
- Text and grid disagree in ~8.6% of cells. Trust the text, surface the conflict.
- Past-midnight blocks, routinely. Saturday's call time is 03:45.
- Group labels rename between days; person names are misspelled inconsistently,
  four pairs of them. The fake names preserve this — the two spellings of one
  person are still one edit apart, so fuzzy-match tests keep their teeth.
- Row order changes between days: row position is not an identity key.
- Sheet names carry trailing spaces (`Saturday Schedule `, `Changes `).
- An orphan cell below the grid (`Saturday!Q67`) — a real assignment for a
  person with no row. Reading only the people block silently drops it.
- `Conflict` appears as literal cell text where two commitments collided and
  nobody resolved it. This is a working document, not a finished one.

## What was deliberately *not* anonymized

Team names, venue names, and street addresses. They are public facts about
organizations and buildings, and the location-alias problem — roughly a dozen
real venues behind thirty spellings — is untestable without them.

One surname survives on purpose: the bussing vendor's company name, which is
also a family name. The individuals at that company are anonymized; the company
is not.

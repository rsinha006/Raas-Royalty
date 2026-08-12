# Distributing access links

Item 25. Everyone at the event reaches their schedule through a link, and this
is how the links get to them. It is a short job once the roster is loaded, and
the whole point of doing it early is that **"I lost my link" is a conversation
you want in the week before, not at a check-in desk on the Friday.**

Prerequisites: the roster is loaded ([loading-data.md](loading-data.md)), and
`PUBLIC_BASE_URL` is set to the address attendees actually use — behind a proxy
the request's own host header is whatever the proxy passed along, and 280 links
to the wrong hostname is a mistake the recipients discover rather than you.

---

## Who gets what

| Code | Goes to | Why |
| --- | --- | --- |
| **Team** | that team's **captains** | The code is shared within the team by design, and the captains are who pass it on. A captain forwarding it to their own group chat is the distribution mechanism. |
| **Person** (staff) | that person | Board, liaisons, judges, videographers, RAS reps — one link each, ~80 of them. |
| **Role** | nobody automatically | A role code shows every holder's schedule to whoever has it. Who receives one is an explicit decision, the same reason none is ever issued automatically. |
| **Dancers** | no personal link at all | They use their team's code and then pick their name. ~200 individual credentials nobody distributes and nobody revokes is the thing the access-code decision exists to avoid. |

⚠️ **A link is a bearer token in a URL.** Anyone holding it sees that subject's
schedule. That is the accepted trade — see [decisions.md](decisions.md) — but it
means a link belongs in a direct message, not in a shared document, a group
calendar invite, or anything indexed.

---

## The steps

### 1. Check everyone can be reached

```bash
npm run codes -- --check
```

Exits non-zero on either of the two failures, which are different and have
different fixes:

- **Missing a code** — that subject cannot reach their schedule at all. Issue
  from the panel's **Access codes** tab, or `npm run codes` to backfill.
- **No recipient** — they have a link and nowhere to send it. Nearly always a
  blank `Email` on the People tab, or a team with no `Captain?` marked. Fix the
  spreadsheet and re-import; the message names which.

The **Ready to send** card in the panel is the same information on a screen, and
lists the blocked ones with the reason on each.

### 2. Download the file

**Admin → Access codes → Download links CSV**, or scoped to `Teams only` /
`Staff only` if they go out in separate mailings.

One row per recipient — a team link addressed to three captains is three rows,
so a merge needs no splitting step.

| Column | |
| --- | --- |
| `Subject Type`, `Subject`, `Team`, `Role` | who the link is *for* |
| `Code`, `Link` | the link itself |
| `Send To`, `Send To Name`, `Send To Phone` | who it goes *to* |
| `Why` | `their own link`, or `captain — distributes to the team` |
| `Blocked` | why this row cannot be sent, if it cannot |
| `Last Used` | whether anyone has opened it yet |

⚠️ **`Send To` is that person's own address, never a contact card.** The two are
different things and the difference is silent: `people.contact_id` is the
coordinator someone should *call*, and it is shared — every dancer on a team
points at that team's liaison. A send list built from it mails a dozen private
links to one inbox and looks entirely correct on the way past. There is a test
that mails nothing to a shared card; don't relax it.

Rows that cannot be sent are **still in the file**, with `Send To` empty and
`Blocked` saying why. Dropping them would make the file look finished.

### 3. Send

The file is a mail merge. Nothing in this app sends email — deliberately: an
event has a mailing tool already, and a half-built sender is one more thing to
be on call for.

Suggested wording, because the two questions every recipient asks are "is this
real" and "what do I do with it":

> Your Royalty schedule is at **{{Link}}**. It is personal to you — it opens
> straight to your own times and updates live, so check it rather than a
> screenshot. Captains: forward your team's link to your dancers; they'll pick
> their own name when they open it.

Send **at least a week out**. The whole value of early is that the lost-link
requests arrive while somebody is at a desk.

### 4. Watch it land

The panel's **Never used** count is how many links nobody has opened. Track it
down over the days after the send — a link that is never opened is a link that
never arrived, and finding that out on the Friday is too late.

---

## During the event

The desk-facing version of everything below is printed on the **desk index**
(item 28): every name, how they sign in, and their live code, on one page behind
the desk. `npm run callsheets`, or Ops → Printed fallback. See
[admin-guide.md](admin-guide.md).

**"I lost my link."** Find them in **Access codes**, copy their link, send it
again. The code has not changed and nothing is invalidated. A *dancer* is given
their **team's** link — they pick their own name when it opens — and never a
personal one, because they do not have one.

**"My phone was stolen."** Revoke, then regenerate, then send the new link. The
old one stops working immediately — the session is re-checked against the code
on every request, so someone already signed in is locked out too, which is the
point.

**A whole team's link has leaked somewhere public.** Regenerate just that team's
code and re-send to its captains. Bulk rotate is for a compromise of everything
at once; its blast radius is every person at the event locked out simultaneously,
which is why it is gated on typing `REGENERATE`.

⚠️ **Regenerating invalidates the link already in someone's hand.** Anyone still
holding the old one gets a sign-in screen with no explanation of why. That is
correct behaviour and it is also a support conversation, so do it deliberately.

The printed fallback call sheets are item 28, and they are not optional: if the
app is down at 1pm Saturday you need paper, not a rollback. They are built —
`npm run callsheets` — and the pack that gets handed out deliberately carries
no codes. Only the desk index does.

import type { Contact } from '../types';
import { ContactActions } from './ContactCard';

/**
 * Sexual assault support — the board members someone can reach about it,
 * directly under their liaison.
 *
 * Under the liaison on purpose, and not behind a tab or a link: the bottom of
 * the schedule is where this app has already taught people to look for "who do
 * I talk to", and a support contact that has to be hunted for at 1am is a
 * support contact nobody uses. It is in the cached payload like everything
 * else, so it survives the venue's wifi.
 *
 * The same list for every viewer, not a personalized one — see the payload
 * comment in `queries.js`. Nothing here is a promise the app can't keep: the
 * names, titles and any note come from the contact cards the board fills in,
 * so a claim about confidentiality is theirs to make and theirs to word.
 */
export default function SupportContacts({ contacts }: { contacts: Contact[] }) {
  // Empty when nobody has been designated yet — and, briefly, when an offline
  // cache written by a build that predates this field is what is on screen.
  // Rendering a heading over nothing would read as "there is nobody", which is
  // a worse answer than the section not being there at all.
  if (!contacts.length) return null;

  return (
    <section className="contact support" aria-labelledby="support-heading">
      <h2 className="contact-name" id="support-heading">
        Sexual assault support
      </h2>
      <div className="muted small" style={{ marginTop: 4 }}>
        {contacts.length === 1
          ? 'This board member is available for the whole weekend.'
          : 'Either of these board members is available for the whole weekend.'}
      </div>

      <ul className="stack plainlist support-list">
        {contacts.map((c) => (
          <li key={c.id} className="support-person">
            <div className="support-name">{c.name}</div>
            {c.title && <div className="muted small">{c.title}</div>}
            {c.note && (
              <div className="muted small" style={{ marginTop: 6 }}>
                {c.note}
              </div>
            )}
            <ContactActions contact={c} />
          </li>
        ))}
      </ul>
    </section>
  );
}

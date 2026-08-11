import type { Contact } from '../types';

/** Tap-to-call / text / email. Falls back gracefully when a method is missing. */
export default function ContactCard({ contact }: { contact: Contact | null }) {
  if (!contact) {
    return (
      <div className="contact">
        <h2 className="contact-name">Need help?</h2>
        <div className="muted small" style={{ marginTop: 4 }}>
          No contact has been assigned to you yet. Find anyone in a Logistics shirt at check-in.
        </div>
      </div>
    );
  }

  const telHref = contact.phone ? `tel:${contact.phone.replace(/[^\d+]/g, '')}` : null;
  const smsHref = contact.phone ? `sms:${contact.phone.replace(/[^\d+]/g, '')}` : null;

  return (
    <div className="contact">
      <div className="spread">
        <div>
          <h2 className="contact-name">{contact.name}</h2>
          {contact.title && <div className="muted small">{contact.title}</div>}
        </div>
        <span className="badge soft">Your contact</span>
      </div>

      {contact.note && (
        <div className="muted small" style={{ marginTop: 8 }}>
          {contact.note}
        </div>
      )}

      {/* Three links whose visible labels are one word each. Out of context —
          in a screen reader's list of links, which is how these get found —
          "Call" alone does not say whom, and the emoji is read out as
          "telephone receiver" ahead of it. The name goes in the accessible
          name; the glyph is decoration and says so. */}
      <div className="contact-actions">
        {telHref && (
          <a className="contact-btn" href={telHref} aria-label={`Call ${contact.name}`}>
            <span aria-hidden="true">📞</span> Call
          </a>
        )}
        {smsHref && (
          <a className="contact-btn" href={smsHref} aria-label={`Text ${contact.name}`}>
            <span aria-hidden="true">💬</span> Text
          </a>
        )}
        {contact.email && (
          <a
            className={`contact-btn${telHref ? ' full' : ''}`}
            href={`mailto:${contact.email}`}
            aria-label={`Email ${contact.name}`}
          >
            <span aria-hidden="true">✉️</span> Email
          </a>
        )}
        {!telHref && !contact.email && (
          <div className="muted small full" style={{ gridColumn: '1 / -1' }}>
            No contact method on file.
          </div>
        )}
      </div>
    </div>
  );
}

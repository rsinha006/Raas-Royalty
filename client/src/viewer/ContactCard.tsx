import type { Contact } from '../types';

/** Tap-to-call / text / email. Falls back gracefully when a method is missing. */
export default function ContactCard({ contact }: { contact: Contact | null }) {
  if (!contact) {
    return (
      <div className="contact">
        <div className="contact-name">Need help?</div>
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
          <div className="contact-name">{contact.name}</div>
          {contact.title && <div className="muted small">{contact.title}</div>}
        </div>
        <span className="badge soft">Your contact</span>
      </div>

      {contact.note && (
        <div className="muted small" style={{ marginTop: 8 }}>
          {contact.note}
        </div>
      )}

      <div className="contact-actions">
        {telHref && (
          <a className="contact-btn" href={telHref}>
            📞 Call
          </a>
        )}
        {smsHref && (
          <a className="contact-btn" href={smsHref}>
            💬 Text
          </a>
        )}
        {contact.email && (
          <a
            className={`contact-btn${telHref ? ' full' : ''}`}
            href={`mailto:${contact.email}`}
          >
            ✉️ Email
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

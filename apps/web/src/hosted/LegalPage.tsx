import { useEffect, useRef } from 'react';
import type { Capabilities, LegalDocument, LegalNotices } from '@atlas/schema';
import { LEGAL_TITLES, contactLabel, dataHandlingFacts, paragraphs, safeContact, takedownFacts } from './legal';
import { LegalLinks } from './LegalLinks';
import { navigate } from './route';

/**
 * Privacy, terms and takedown pages (M4.6, ADR-077). The legal wording is the operator's
 * plain text, rendered as text and never as markup; ATLAS adds only the facts of what its
 * code does. Without the operator's text the page says so plainly: a production service
 * does not start in that state.
 */
export function LegalPage({ document, notices, capabilities }: { document: LegalDocument; notices: LegalNotices; capabilities: Capabilities }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [document]);
  const text = notices.documents[document];
  const contact = safeContact(notices.contact);
  const facts = document === 'privacy' ? dataHandlingFacts(capabilities.limits) : document === 'takedown' ? takedownFacts(capabilities.limits) : null;
  return (
    <main className="gate">
      <article className="gate-card hosted-card legal-page">
        <p className="gate-brand">
          <span className="brand-mark" aria-hidden="true">◆</span> ATLAS
        </p>
        <h1 ref={heading} tabIndex={-1}>
          {LEGAL_TITLES[document]}
        </h1>
        {text ? (
          <div className="legal-text">
            {paragraphs(text).map((p, i) => <p key={i}>{p}</p>)}
          </div>
        ) : (
          <p className="notice legal-placeholder" role="note">
            <strong>Placeholder.</strong> The operator of this service has not supplied this text, so this is not a public service. A production
            service refuses to start without it.
          </p>
        )}
        {facts && (
          <section className="legal-facts" aria-labelledby="legal-facts-title">
            <h2 id="legal-facts-title">{document === 'privacy' ? 'How this service handles data' : 'What a takedown can do'}</h2>
            <p className="gate-small">From the service&apos;s implementation, not legal wording.</p>
            <ul>
              {facts.map((fact) => <li key={fact}>{fact}</li>)}
            </ul>
          </section>
        )}
        <p>
          {contact ? (
            <>
              Contact: <a href={contact} rel="noreferrer">{contactLabel(contact)}</a>
            </>
          ) : (
            'Contact: not configured on this service.'
          )}
        </p>
        <a className="button" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
          Back to the start page
        </a>
        <LegalLinks contact={contact} current={document} />
      </article>
    </main>
  );
}

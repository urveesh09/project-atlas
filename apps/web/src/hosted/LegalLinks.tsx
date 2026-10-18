import { LEGAL_DOCUMENTS, type LegalDocument } from '@atlas/schema';
import { LEGAL_TITLES } from './legal';
import { navigate } from './route';

/** Footer links to the public-service pages and the operator's contact (M4.6). */
export function LegalLinks({ contact, current }: { contact: string | null; current?: LegalDocument }) {
  return (
    <nav className="legal-links" aria-label="Service information">
      <ul>
        {LEGAL_DOCUMENTS.map((name) => (
          <li key={name}>
            <a href={`/${name}`} aria-current={name === current ? 'page' : undefined} onClick={(e) => { e.preventDefault(); navigate(`/${name}`); }}>
              {LEGAL_TITLES[name]}
            </a>
          </li>
        ))}
        {contact && (
          <li>
            <a href={contact} rel="noreferrer">Contact</a>
          </li>
        )}
      </ul>
    </nav>
  );
}

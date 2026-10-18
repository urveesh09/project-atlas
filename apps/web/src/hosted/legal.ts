import type { LegalDocument } from '@atlas/schema';

export const LEGAL_TITLES: Readonly<Record<LegalDocument, string>> = {
  privacy: 'Privacy',
  terms: 'Terms of use',
  takedown: 'Takedown requests',
};

/**
 * What the service's code does with data (M4.6, ADR-077), shown beside the operator's
 * privacy text. These are implementation facts, not legal wording; each is checked
 * against the code and tested. Day counts come from the service's own limits.
 */
export function dataHandlingFacts(limits: Readonly<Record<string, number>>): string[] {
  const days = limits['publicationTtlDays'];
  return [
    'Source text is never stored. A published analysis holds file paths, package and declaration names, metrics, dependencies and commit IDs.',
    `A publication is public to anyone with its link for ${days} days, unless its owner deletes it sooner. It is withdrawn if its repository stops being public. Copies already downloaded cannot be recalled.`,
    'IP addresses are not stored or written to logs. Quotas use a keyed daily hash of the address, kept with the browser session for 24 hours and removed from job records after 24 hours.',
    'Service logs record job IDs, stages and error codes. A repository appears in them only as a short tag derived from its numeric GitHub ID, never by name.',
    `The database keeps each job's submitted repository URL, and the repository's GitHub name and numeric ID so that its visibility can be rechecked. These records are deleted ${limits['jobRecordRetentionDays']} days after the job ends; database backups may hold them for 7 days more. A repository that was taken down keeps its name and ID so that the takedown keeps applying.`,
    'One cookie lasts 24 hours and lets this browser follow and cancel its own analyses. Pages load nothing from other sites, and there are no analytics.',
    "Repositories are read only from GitHub's public API and Git service. On a production service, analysis runs offline in an isolated container.",
  ];
}

/** What the service can do about a publication, shown beside the operator's takedown text. */
export function takedownFacts(limits: Readonly<Record<string, number>>): string[] {
  return [
    "The operator can withdraw a single publication, or every publication of a repository, and delete their stored data.",
    'A publication is withdrawn when its repository stops being public: each view needs a visibility check at most 5 minutes old, and every publication is rechecked daily.',
    `Every publication expires after ${limits['publicationTtlDays']} days on its own.`,
    'Withdrawing a publication cannot recall copies that were already downloaded.',
  ];
}

/** Paragraphs of the operator's plain text: blank lines separate them; nothing is markup. */
export const paragraphs = (text: string): string[] => text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

/** Only `mailto:` and `https:` contacts become links; the service validates them too. */
export const safeContact = (contact: string | null): string | null =>
  contact && /^(?:mailto:|https:\/\/)/.test(contact) ? contact : null;

/** The status page must be `https:`; the service validates it too. */
export const safeStatus = (status: string | null): string | null => (status && status.startsWith('https://') ? status : null);

/** A `mailto:` contact shows its address; an https page shows its host and path. */
export function contactLabel(contact: string): string {
  if (contact.startsWith('mailto:')) return contact.slice('mailto:'.length);
  try {
    const url = new URL(contact);
    return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return contact;
  }
}

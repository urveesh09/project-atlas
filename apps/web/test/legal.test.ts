import { describe, expect, it } from 'vitest';
import { LIMITS } from '@atlas/schema';
import { contactLabel, dataHandlingFacts, paragraphs, safeContact, takedownFacts } from '../src/hosted/legal';
import { parseRoute } from '../src/hosted/route';

describe('public-service pages', () => {
  it('routes the three pages and nothing near them', () => {
    expect(parseRoute('/privacy')).toEqual({ kind: 'legal', document: 'privacy' });
    expect(parseRoute('/terms')).toEqual({ kind: 'legal', document: 'terms' });
    expect(parseRoute('/takedown')).toEqual({ kind: 'legal', document: 'takedown' });
    for (const near of ['/privacy/', '/Privacy', '/privacy.html', '/legal']) expect(parseRoute(near).kind, near).toBe('unknown');
  });

  it("states the service's own publication lifetime, not a copied number", () => {
    const limits = { ...LIMITS, publicationTtlDays: 3 } as Record<string, number>;
    expect(dataHandlingFacts(limits).join(' ')).toContain('for 3 days');
    expect(takedownFacts(limits).join(' ')).toContain('after 3 days');
    expect(dataHandlingFacts(LIMITS as unknown as Record<string, number>).join(' ')).toContain(`for ${LIMITS.publicationTtlDays} days`);
  });

  it('splits the operator text into paragraphs only at blank lines', () => {
    expect(paragraphs('One\nstill one\n\n\nTwo\n')).toEqual(['One\nstill one', 'Two']);
  });

  it('links only mailto: and https: contacts', () => {
    expect(safeContact('mailto:operator@example.org')).toBe('mailto:operator@example.org');
    expect(safeContact('https://example.org/contact')).toBe('https://example.org/contact');
    for (const unsafe of ['javascript:alert(1)', 'http://example.org', 'data:text/html,x', null]) expect(safeContact(unsafe)).toBeNull();
    expect(contactLabel('mailto:operator@example.org')).toBe('operator@example.org');
    expect(contactLabel('https://example.org/contact')).toBe('example.org/contact');
    expect(contactLabel('https://example.org/')).toBe('example.org');
  });
});

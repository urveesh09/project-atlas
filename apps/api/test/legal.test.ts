import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGAL_PLACEHOLDER_MARKER, LEGAL_TEXT_LIMIT, legalNoticesFromEnv, startApi, type AdmissionStore } from '@atlas/api';
import { LegalNoticesSchema } from '@atlas/schema';

const dir = mkdtempSync(path.join(tmpdir(), 'atlas-legal-'));
const file = (name: string, contents: string | Buffer) => {
  const full = path.join(dir, name);
  writeFileSync(full, contents);
  return full;
};
const owner = {
  ATLAS_PRIVACY_FILE: file('privacy.txt', '﻿Owner privacy text.\r\n\r\nSecond paragraph.\r\n'),
  ATLAS_TERMS_FILE: file('terms.txt', 'Owner terms text.'),
  ATLAS_TAKEDOWN_FILE: file('takedown.txt', 'Owner takedown text.'),
  ATLAS_CONTACT: 'mailto:operator@example.org',
  ATLAS_STATUS_URL: 'https://github.com/example/service/issues?q=label%3Aincident',
};
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('legal notices from the environment', () => {
  it("serves the owner's texts, normalized, and the contact", () => {
    expect(legalNoticesFromEnv(owner, false)).toEqual({
      configured: true,
      contact: 'mailto:operator@example.org',
      status: 'https://github.com/example/service/issues?q=label%3Aincident',
      documents: { privacy: 'Owner privacy text.\n\nSecond paragraph.', terms: 'Owner terms text.', takedown: 'Owner takedown text.' },
    });
    expect(legalNoticesFromEnv({ ...owner, ATLAS_CONTACT: 'https://example.org/contact' }, false).contact).toBe('https://example.org/contact');
  });

  it('refuses to start a production service without every text and the contact', () => {
    for (const missing of Object.keys(owner)) {
      const env: Record<string, string> = { ...owner };
      delete env[missing];
      expect(() => legalNoticesFromEnv(env, false), missing).toThrow(`${missing} is required outside development`);
    }
  });

  it('refuses the shipped placeholders, empty, oversized, non-UTF-8 and control-character texts, and relative paths', () => {
    const cases: [Record<string, string>, string][] = [
      [{ ATLAS_TERMS_FILE: file('placeholder.txt', `${LEGAL_PLACEHOLDER_MARKER}: replace this text.`) }, 'still holds the shipped placeholder'],
      [{ ATLAS_TERMS_FILE: file('empty.txt', ' \n\n ') }, 'is empty'],
      [{ ATLAS_TERMS_FILE: file('large.txt', 'x'.repeat(LEGAL_TEXT_LIMIT + 1)) }, 'exceeds'],
      [{ ATLAS_TERMS_FILE: file('latin1.txt', Buffer.from([0x54, 0xe9, 0x74, 0xe9])) }, 'is not UTF-8 text'],
      [{ ATLAS_TERMS_FILE: file('control.txt', 'Terms\u0007') }, 'control characters'],
      [{ ATLAS_TERMS_FILE: 'terms.txt' }, 'must be an absolute path'],
      [{ ATLAS_TERMS_FILE: path.join(dir, 'missing.txt') }, 'could not be read'],
    ];
    for (const [change, message] of cases) expect(() => legalNoticesFromEnv({ ...owner, ...change }, false), message).toThrow(message);
  });

  it('accepts only a mailto: address or a plain https: URL as the contact', () => {
    for (const contact of ['operator@example.org', 'http://example.org', 'javascript:alert(1)', 'https://user:pw@example.org/', 'mailto:a@b', 'mailto:a@example.org?subject=x', 'https://example.org/a b']) {
      expect(() => legalNoticesFromEnv({ ...owner, ATLAS_CONTACT: contact }, false), contact).toThrow('ATLAS_CONTACT must be');
    }
  });

  it('accepts only a plain https: URL as the status page', () => {
    for (const status of ['http://status.example.org', 'mailto:ops@example.org', 'https://user:pw@status.example.org/', 'status.example.org']) {
      expect(() => legalNoticesFromEnv({ ...owner, ATLAS_STATUS_URL: status }, false), status).toThrow('ATLAS_STATUS_URL must be an https: URL');
    }
  });

  it('shows placeholders on a development service, and never invents text', () => {
    expect(legalNoticesFromEnv({}, true)).toEqual({ configured: false, contact: null, status: null, documents: { privacy: null, terms: null, takedown: null } });
    // The shipped examples may be used in development; they are still not a configured service.
    const partial = legalNoticesFromEnv({ ATLAS_PRIVACY_FILE: file('dev.txt', `${LEGAL_PLACEHOLDER_MARKER} example`) }, true);
    expect(partial.configured).toBe(false);
    expect(partial.documents.privacy).toContain(LEGAL_PLACEHOLDER_MARKER);
  });
});

describe('legal routes', () => {
  const webRoot = path.join(dir, 'web');
  let api: Awaited<ReturnType<typeof startApi>>;
  beforeAll(async () => {
    mkdirSync(webRoot);
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>viewer</title>');
    api = await startApi({ store: { session: async () => null } as unknown as AdmissionStore, quotaSecret: 'q'.repeat(32), developmentLoopback: true, webRoot, legal: legalNoticesFromEnv(owner, false) });
  });
  afterAll(() => api.close());
  const get = (target: string) => new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
    request(`${api.origin}${target}`, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
    }).on('error', reject).end();
  });

  it('serves the notices as the public contract and each page as the viewer', async () => {
    const notices = await get('/api/v1/legal');
    expect(notices.status).toBe(200);
    expect(LegalNoticesSchema.parse(JSON.parse(notices.body))).toMatchObject({ configured: true, contact: 'mailto:operator@example.org' });
    for (const page of ['/privacy', '/terms', '/takedown']) {
      const shell = await get(page);
      expect(shell.status, page).toBe(200);
      expect(shell.body).toContain('<title>viewer</title>');
    }
    expect((await get('/privacy/extra')).status).toBe(404);
  });
});

import { describe, expect, it } from 'vitest';
// @ts-expect-error Operator tooling is plain ESM and deliberately outside runtime packages.
import { downloadMetadata, githubRanges, parseCidr, refreshBatch } from '../../../deploy/production/refresh-github-ranges.mjs';

const meta = { api: ['140.82.112.0/20', '2606:50c0::/32'], git: ['140.82.112.0/20', '140.82.112.1/32', '2a0a:a440::/29'] };
describe('production GitHub firewall metadata', () => {
  it('deduplicates nested intervals and uses only git/API ranges', () => {
    expect(githubRanges({ ...meta, actions: ['0.0.0.0/0'] })).toEqual({ ipv4: ['140.82.112.0/20'], ipv6: ['2606:50c0::/32', '2a0a:a440::/29'] });
    const batch = refreshBatch(meta);
    expect(batch).toContain('flush set inet atlas_egress github4\nflush set inet atlas_egress github6');
    expect(batch).not.toContain('flush ruleset');
    expect(batch).not.toContain('140.82.112.1');
  });
  it.each(['0.0.0.0/0', '10.0.0.0/8', '127.0.0.1/32', '169.254.169.254/32', '172.16.0.0/12',
    '192.168.0.0/16', '198.18.0.0/15', '203.0.113.0/24', '224.0.0.0/4', '140.82.112.1/20',
    '140.82.112.0/020', '140.82.112.0/20; flush ruleset', '::/0', '::1/128', 'fc00::/7', 'fe80::/10',
    '::ffff:127.0.0.1/128', '2001:db8::/32', '2001::/16', '2001::/32', '2002::/16', '3fff::/20', '2606:50c0::1/32'])('rejects unsafe or noncanonical CIDR %s', (cidr) => {
    expect(() => parseCidr(cidr)).toThrow();
  });
  it.each([{}, { api: [], git: [] }, { api: meta.api }, { ...meta, git: Array(513).fill(meta.git[0]) }, { api: ['140.82.112.0/20'], git: ['140.82.112.0/20'] }])('rejects incomplete metadata rather than dropping protections', (value) => {
    expect(() => refreshBatch(value)).toThrow();
  });
  it('downloads only the fixed HTTPS URL without redirects or credentials', async () => {
    const calls: { url: string; options: RequestInit }[] = [];
    const downloaded = await downloadMetadata(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(meta));
    });
    expect(downloaded).toEqual(meta);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://api.github.com/meta', options: { redirect: 'error' } });
    expect(calls[0]?.options.headers).not.toHaveProperty('Authorization');
    expect(calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([new Response('unavailable', { status: 503 }), new Response('not json'), new Response('x'.repeat(1024 * 1024 + 1)), new Response(new Uint8Array([255]))])('rejects unavailable, malformed and excessive responses', async (response) => {
    await expect(downloadMetadata(async () => response)).rejects.toThrow();
  });
});

#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const ipv4 = (s) => s.split('.').reduce((n, part) => (n << 8n) | BigInt(part), 0n);
const ipv6 = (s) => {
  const halves = s.split('::').map((h) => h ? h.split(':') : []);
  const words = halves.length === 1 ? halves[0] : [...halves[0], ...Array(8 - halves[0].length - halves[1].length).fill('0'), ...halves[1]];
  return words.reduce((n, word) => (n << 16n) | BigInt(`0x${word}`), 0n);
};
const forbidden4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
].map(([address, prefix]) => [ipv4(address), ipv4(address) + (1n << BigInt(32 - prefix)) - 1n]);
const forbidden6 = [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]
  .map(([address, prefix]) => [ipv6(address), ipv6(address) + (1n << BigInt(128 - prefix)) - 1n]);

/** Accept only canonical, globally routable CIDRs; never interpolate raw HTTP text into nft. */
export function parseCidr(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[0-9a-fA-F.:]+\/[0-9]{1,3}$/.test(value)) throw new Error('Invalid GitHub CIDR');
  const [address, rawPrefix] = value.split('/');
  const family = isIP(address);
  if (!family || (family === 6 && address.includes('.'))) throw new Error('Invalid GitHub address');
  const bits = family === 4 ? 32 : 128;
  const prefix = Number(rawPrefix);
  if (String(prefix) !== rawPrefix || prefix < (family === 4 ? 8 : 16) || prefix > bits) throw new Error('Invalid GitHub prefix');
  const start = family === 4 ? ipv4(address) : ipv6(address);
  const size = 1n << BigInt(bits - prefix);
  const end = start + size - 1n;
  if (start % size !== 0n) throw new Error('GitHub CIDR has host bits');
  if (family === 4 ? forbidden4.some(([lo, hi]) => start <= hi && end >= lo) :
    start < ipv6('2000::') || end >= ipv6('4000::') || forbidden6.some(([lo, hi]) => start <= hi && end >= lo)) {
    throw new Error('GitHub CIDR is not globally routable');
  }
  return { cidr: `${address.toLowerCase()}/${prefix}`, family, start, end };
}

export function githubRanges(meta) {
  if (!meta || typeof meta !== 'object' || !Array.isArray(meta.git) || !Array.isArray(meta.api) ||
    !meta.git.length || !meta.api.length || meta.git.length + meta.api.length > 512) throw new Error('Incomplete or excessive GitHub metadata');
  const ranges = [...meta.git, ...meta.api].map(parseCidr);
  const out = { ipv4: [], ipv6: [] };
  for (const family of [4, 6]) {
    // /meta repeats API ranges in git. nft interval sets must not contain overlaps.
    const sorted = ranges.filter((r) => r.family === family).sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.end > b.end ? -1 : a.end < b.end ? 1 : 0);
    let previousEnd = -1n;
    for (const range of sorted) {
      if (range.end <= previousEnd) continue;
      if (range.start <= previousEnd) throw new Error('Unexpected overlapping GitHub ranges');
      out[family === 4 ? 'ipv4' : 'ipv6'].push(range.cidr);
      previousEnd = range.end;
    }
  }
  if (!out.ipv4.length || !out.ipv6.length) throw new Error('GitHub metadata must cover both address families');
  return out;
}

/** One nft transaction: a failed check/application never leaves a partially updated set. */
export function refreshBatch(meta) {
  const { ipv4: v4, ipv6: v6 } = githubRanges(meta);
  return `flush set inet atlas_egress github4\nflush set inet atlas_egress github6\nadd element inet atlas_egress github4 { ${v4.join(', ')} }\nadd element inet atlas_egress github6 { ${v6.join(', ')} }\n`;
}

export async function downloadMetadata(fetcher = fetch) {
  const response = await fetcher('https://api.github.com/meta', {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'atlas-egress-refresh' },
  });
  if (!response.ok || !response.body) throw new Error('GitHub metadata is unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) throw new Error('GitHub metadata exceeds 1 MiB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  githubRanges(meta);
  return meta;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || !['--apply', '--print'].includes(process.argv[2])) throw new Error('Usage: refresh-github-ranges.mjs --apply|--print');
    const meta = await downloadMetadata();
    const batch = refreshBatch(meta);
    if (process.argv[2] === '--print') process.stdout.write(batch);
    else {
      // stdin only: no temporary files, shell interpolation, tokens or metadata logs.
      execFileSync('/usr/sbin/nft', ['--check', '--file', '-'], { input: batch, stdio: ['pipe', 'ignore', 'pipe'], timeout: 5000 });
      execFileSync('/usr/sbin/nft', ['--file', '-'], { input: batch, stdio: ['pipe', 'ignore', 'pipe'], timeout: 5000 });
      console.log('atlas.egress.refreshed');
    }
  } catch {
    // Retain old ranges until their kernel timeouts expire; never broaden on failure.
    console.error('atlas.egress.refresh-failed');
    process.exitCode = 1;
  }
}

import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { BlockList, connect as netConnect, isIP, type AddressInfo, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { IngestError } from './errors.js';
import type { FetchLike } from './github.js';

/**
 * Egress policy for hosted acquisition (plan §8.2, §8.6). Only the two GitHub hosts on
 * port 443 are reachable. Names are resolved here, every resolved address must be a
 * public unicast address, and the connection is pinned to the validated address so a
 * second resolution cannot redirect it. TLS still runs end to end against the original
 * host name: pinning never weakens certificate or hostname verification. Bytes in both
 * directions are counted against one budget; exceeding it closes every connection.
 */
export const GITHUB_EGRESS_HOSTS: readonly string[] = Object.freeze(['github.com', 'api.github.com']);

// Separate lists: a BlockList also matches IPv4 addresses against IPv4-mapped IPv6 rules.
const deniedV4 = new BlockList();
const deniedV6 = new BlockList();
// IPv4 special-purpose ranges (RFC 6890 and successors): nothing here is GitHub.
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) deniedV4.addSubnet(network, prefix, 'ipv4');
// IPv6: anything outside global unicast, plus translation, tunnelling, documentation and
// ULA ranges. IPv4-mapped/compatible forms are refused outright rather than unwrapped.
for (const [network, prefix] of [
  ['::', 3], ['4000::', 2], ['8000::', 1], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) deniedV6.addSubnet(network, prefix, 'ipv6');

/** True only for a literal public unicast address (plan §8.2). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return family === 4 ? !deniedV4.check(address, 'ipv4') : !deniedV6.check(address, 'ipv6');
}

export type Lookup = (host: string) => Promise<readonly { address: string; family: number }[]>;
export type Dial = (address: string, port: number) => Socket;

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });
const defaultDial: Dial = (address, port) => netConnect({ host: address, port });

function allowedHost(host: string, allowed: readonly string[]): string | null {
  const normalized = host.toLowerCase();
  return allowed.includes(normalized) ? normalized : null;
}

/**
 * Resolve an allowlisted name and return one pinned address. Any non-public address in
 * the answer refuses the whole name: a GitHub name resolving to a private or metadata
 * address indicates DNS tampering and fails closed.
 */
export async function resolvePinned(host: string, lookup: Lookup = defaultLookup): Promise<string> {
  let answers: readonly { address: string; family: number }[];
  try {
    answers = await lookup(host);
  } catch {
    throw new IngestError('UPSTREAM_UNAVAILABLE', 'Could not resolve the GitHub endpoint');
  }
  if (answers.length === 0 || answers.length > 64) throw new IngestError('UPSTREAM_UNAVAILABLE', 'Could not resolve the GitHub endpoint');
  if (answers.some((a) => !isPublicAddress(a.address))) {
    throw new IngestError('UPSTREAM_UNAVAILABLE', 'The GitHub endpoint resolved to a non-public address', { reason: 'EGRESS_ADDRESS_DENIED' });
  }
  return (answers.find((a) => isIP(a.address) === 4) ?? answers[0]!).address;
}

/** One byte budget shared by every connection of an acquisition stage. */
export class ByteMeter {
  private used = 0;
  private tripped = false;
  private readonly listeners = new Set<() => void>();
  constructor(readonly limitBytes: number) {
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('Invalid byte budget');
  }
  get bytes(): number {
    return this.used;
  }
  get exceeded(): boolean {
    return this.tripped;
  }
  /** Count bytes; false once the budget is exceeded (and from then on). */
  add(bytes: number): boolean {
    this.used += bytes;
    if (!this.tripped && this.used > this.limitBytes) {
      this.tripped = true;
      for (const listener of this.listeners) listener();
    }
    return !this.tripped;
  }
  onExceeded(listener: () => void): () => void {
    if (this.tripped) listener();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function meter(socket: Socket, budget: ByteMeter, onExceeded: () => void) {
  socket.on('data', (chunk: Buffer) => {
    if (!budget.add(chunk.length)) onExceeded();
  });
}

export interface EgressBrokerOptions {
  budget: ByteMeter;
  allowedHosts?: readonly string[];
  lookup?: Lookup;
  dial?: Dial;
  /** Concurrent tunnels; Git uses one or two. */
  maxTunnels?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface EgressStats {
  bytes: number;
  limitBytes: number;
  exceeded: boolean;
  tunnels: number;
  refused: number;
  refusals: Record<string, number>;
}

export interface EgressBroker {
  port: number;
  stats(): EgressStats;
  close(): Promise<void>;
}

/**
 * HTTP CONNECT broker for Git (plan §8.3). It never proxies plain HTTP, never follows a
 * redirect (a tunnel carries opaque TLS), never accepts an IP literal or another port,
 * and dials only the address it validated itself.
 */
export async function startEgressBroker(options: EgressBrokerOptions & { host?: string; port?: number }): Promise<EgressBroker> {
  const allowed = options.allowedHosts ?? GITHUB_EGRESS_HOSTS;
  const lookup = options.lookup ?? defaultLookup;
  const dial = options.dial ?? defaultDial;
  const maxTunnels = options.maxTunnels ?? 4;
  const sockets = new Set<Socket>();
  const refusals: Record<string, number> = {};
  let tunnels = 0;
  let active = 0;
  const closeAll = () => {
    for (const socket of sockets) socket.destroy();
  };
  options.budget.onExceeded(closeAll);
  const refuse = (socket: Socket, status: 403 | 429 | 502, reason: string) => {
    refusals[reason] = (refusals[reason] ?? 0) + 1;
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : status === 429 ? 'Too Many Requests' : 'Bad Gateway'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const server: Server = createHttpServer({ maxHeaderSize: 4096, requestTimeout: 10_000, headersTimeout: 10_000 }, (_req, res) => {
    refusals['NOT_CONNECT'] = (refusals['NOT_CONNECT'] ?? 0) + 1;
    res.writeHead(405, { Connection: 'close', 'Content-Length': '0' });
    res.end();
  });
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    void (async () => {
      sockets.add(client);
      client.on('close', () => sockets.delete(client));
      client.on('error', () => client.destroy());
      const target = /^([a-z0-9.-]{1,253}):(\d{1,5})$/i.exec(req.url ?? '');
      const host = target ? allowedHost(target[1]!, allowed) : null;
      if (!target || !host) return refuse(client, 403, 'HOST_DENIED');
      if (target[2] !== '443') return refuse(client, 403, 'PORT_DENIED');
      if (options.budget.exceeded) return refuse(client, 403, 'BUDGET_EXCEEDED');
      if (active >= maxTunnels) return refuse(client, 429, 'TOO_MANY_TUNNELS');
      active++;
      client.once('close', () => active--);
      let address: string;
      try {
        address = await resolvePinned(host, lookup);
      } catch (error) {
        return refuse(client, error instanceof IngestError && error.details['reason'] === 'EGRESS_ADDRESS_DENIED' ? 403 : 502, error instanceof IngestError && error.details['reason'] === 'EGRESS_ADDRESS_DENIED' ? 'ADDRESS_DENIED' : 'RESOLVE_FAILED');
      }
      if (client.destroyed) return;
      const upstream = dial(address, 443);
      sockets.add(upstream);
      let connected = false;
      upstream.on('close', () => {
        sockets.delete(upstream);
        if (connected) client.destroy();
        else if (!client.destroyed) refuse(client, 502, 'CONNECT_FAILED');
      });
      client.on('close', () => upstream.destroy());
      upstream.setTimeout(options.connectTimeoutMs ?? 10_000, () => upstream.destroy());
      upstream.on('error', () => upstream.destroy());
      upstream.once('connect', () => {
        connected = true;
        tunnels++;
        upstream.setTimeout(options.idleTimeoutMs ?? 60_000, () => upstream.destroy());
        client.setTimeout(options.idleTimeoutMs ?? 60_000, () => client.destroy());
        meter(upstream, options.budget, closeAll);
        meter(client, options.budget, closeAll);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          if (!options.budget.add(head.length)) return closeAll();
          upstream.write(head);
        }
        upstream.pipe(client);
        client.pipe(upstream);
      });
    })();
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    stats: () => ({
      bytes: options.budget.bytes,
      limitBytes: options.budget.limitBytes,
      exceeded: options.budget.exceeded,
      tunnels,
      refused: Object.values(refusals).reduce((a, b) => a + b, 0),
      refusals: { ...refusals },
    }),
    close: async () => {
      closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface PinnedFetchOptions {
  budget: ByteMeter;
  allowedHosts?: readonly string[];
  lookup?: Lookup;
  dial?: Dial;
  timeoutMs?: number;
  /** Response bodies are JSON metadata; 1 MiB is ample. */
  maxResponseBytes?: number;
  /** Extra trust roots for tests only; production uses the platform roots. */
  ca?: string;
}

/**
 * A `fetch` replacement for GitHub metadata that applies the same egress policy as the
 * broker: allowlisted HTTPS host, validated pinned address, TLS verified against the
 * original name, byte budget, deadline and capped body. Redirects are returned, never
 * followed, so the caller's REPOSITORY_MOVED classification still applies.
 */
export function pinnedFetch(options: PinnedFetchOptions): FetchLike {
  const allowed = options.allowedHosts ?? GITHUB_EGRESS_HOSTS;
  const lookup = options.lookup ?? defaultLookup;
  const dial = options.dial ?? defaultDial;
  const maxBytes = options.maxResponseBytes ?? 1024 * 1024;
  return async (raw, init) => {
    const url = new URL(raw);
    const host = allowedHost(url.hostname, allowed);
    if (url.protocol !== 'https:' || !host || url.port !== '' || url.username || url.password) {
      throw new IngestError('UPSTREAM_UNAVAILABLE', 'Egress to this destination is not permitted', { reason: 'EGRESS_DESTINATION_DENIED' });
    }
    if (options.budget.exceeded) throw new IngestError('REPOSITORY_TOO_LARGE', 'Acquisition exceeded the transfer limit');
    const address = await resolvePinned(host, lookup);
    return await new Promise((resolve, reject) => {
      const raw = dial(address, 443);
      const socket = tlsConnect({ socket: raw, servername: host, ...(options.ca ? { ca: options.ca } : {}) });
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => fail(new IngestError('CANCELLED', 'Operation cancelled'));
      const fail = (error: IngestError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        init.signal?.removeEventListener('abort', onAbort);
        socket.destroy();
        raw.destroy();
        reject(error);
      };
      raw.on('error', () => fail(new IngestError('UPSTREAM_UNAVAILABLE', 'Could not reach GitHub')));
      socket.on('error', () => fail(new IngestError('UPSTREAM_UNAVAILABLE', 'Could not reach GitHub')));
      // A socket wrapped by TLS emits no 'data' events of its own; its wire counters are
      // exact, so account by their growth (encrypted bytes in both directions).
      let counted = 0;
      const account = () => {
        const total = raw.bytesRead + raw.bytesWritten;
        const ok = options.budget.add(total - counted);
        counted = total;
        if (!ok) fail(new IngestError('REPOSITORY_TOO_LARGE', 'Acquisition exceeded the transfer limit'));
        return ok;
      };
      raw.on('close', account);
      timer = setTimeout(() => fail(new IngestError('UPSTREAM_UNAVAILABLE', 'GitHub did not respond in time')), options.timeoutMs ?? 15_000);
      init.signal?.addEventListener('abort', onAbort, { once: true });
      const req = httpsRequest(
        {
          host,
          servername: host,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { ...init.headers, Host: host, 'Accept-Encoding': 'identity', Connection: 'close' },
          // No `agent`: with any agent (even `agent: false`) Node ignores createConnection
          // and dials the name itself, bypassing the pinned, validated address.
          createConnection: () => socket,
        },
        (res) => {
          const parts: Buffer[] = [];
          let length = 0;
          res.on('data', (chunk: Buffer) => {
            if (!account()) return;
            length += chunk.length;
            if (length > maxBytes) return fail(new IngestError('UPSTREAM_UNAVAILABLE', 'GitHub response exceeded its size limit', { reason: 'RESPONSE_TOO_LARGE' }));
            parts.push(chunk);
          });
          res.on('error', () => fail(new IngestError('UPSTREAM_UNAVAILABLE', 'Could not reach GitHub')));
          res.on('end', () => {
            if (!account() || settled) return;
            settled = true;
            clearTimeout(timer);
            init.signal?.removeEventListener('abort', onAbort);
            const body = Buffer.concat(parts);
            const headers = res.headers;
            resolve({
              status: res.statusCode ?? 0,
              headers: { get: (name: string) => { const value = headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(', ') : (value ?? null); } },
              json: async () => {
                try {
                  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
                } catch {
                  throw new IngestError('UPSTREAM_UNAVAILABLE', 'Unexpected GitHub response');
                }
              },
            });
          });
        },
      );
      req.on('error', () => fail(new IngestError('UPSTREAM_UNAVAILABLE', 'Could not reach GitHub')));
      req.end();
    });
  };
}

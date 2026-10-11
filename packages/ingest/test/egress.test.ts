import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ByteMeter, isPublicAddress, pinnedFetch, resolvePinned, startEgressBroker, type EgressBroker, type Lookup } from '@atlas/ingest';

describe('egress address policy (plan §8.2)', () => {
  it.each(['140.82.112.3', '140.82.121.6', '185.199.108.133', '2606:50c0:8000::153', '2a0a:a440::1'])('allows public unicast %s', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
  it.each([
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1', '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:140.82.112.3', '64:ff9b::8c52:7003', '2002:8c52:7003::1', '2001::1', '2001:db8::1',
    'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '3fff::1', 'github.com', '', '1.2.3', '01.2.3.4',
  ])('denies %j', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('refuses a name whose answer contains any non-public address and prefers IPv4', async () => {
    const lookup = (answers: string[]): Lookup => async () => answers.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    await expect(resolvePinned('github.com', lookup(['140.82.112.3', '10.0.0.5']))).rejects.toMatchObject({ details: { reason: 'EGRESS_ADDRESS_DENIED' } });
    await expect(resolvePinned('github.com', lookup(['169.254.169.254']))).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    await expect(resolvePinned('github.com', lookup([]))).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(await resolvePinned('github.com', lookup(['2606:50c0:8000::153', '140.82.112.3']))).toBe('140.82.112.3');
    await expect(resolvePinned('github.com', async () => { throw new Error('ENOTFOUND'); })).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

/** A local "upstream" that echoes bytes, standing in for the dialed GitHub address. */
async function echoServer(): Promise<{ server: Server; port: number; connections: Socket[] }> {
  const connections: Socket[] = [];
  const server = createServer((socket) => {
    connections.push(socket);
    socket.on('error', () => socket.destroy());
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port, connections };
}

function tunnel(port: number, request: string): Promise<{ socket: Socket; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    socket.once('error', reject);
    socket.on('data', function onData(chunk: Buffer) {
      text += chunk.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end !== -1) {
        socket.off('data', onData);
        resolve({ socket, head: text.slice(0, end) });
      }
    });
    socket.once('end', () => resolve({ socket, head: text }));
    socket.write(request);
  });
}

const roundTrip = (socket: Socket, payload: Buffer) =>
  new Promise<Buffer>((resolve) => {
    const parts: Buffer[] = [];
    let length = 0;
    socket.on('data', (chunk: Buffer) => {
      parts.push(chunk);
      length += chunk.length;
      if (length >= payload.length) resolve(Buffer.concat(parts));
    });
    socket.write(payload);
  });

describe('egress CONNECT broker', () => {
  const closers: (() => unknown)[] = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });
  const start = async (limitBytes = 1024 * 1024, answers = ['140.82.112.3']) => {
    const upstream = await echoServer();
    closers.push(() => new Promise<void>((resolve) => upstream.server.close(() => resolve())));
    const dialed: string[] = [];
    const budget = new ByteMeter(limitBytes);
    const broker: EgressBroker = await startEgressBroker({
      budget,
      lookup: async () => answers.map((address) => ({ address, family: 4 })),
      // The broker validates and pins the address; the test maps that one public
      // address onto the local echo server so no real network is used.
      dial: (address, port) => {
        dialed.push(`${address}:${port}`);
        return connect(upstream.port, '127.0.0.1');
      },
    });
    closers.push(() => broker.close());
    return { broker, budget, dialed, upstream };
  };

  it('tunnels only to an allowlisted host on 443 through the pinned address, counting both directions', async () => {
    const { broker, dialed } = await start();
    const { socket, head } = await tunnel(broker.port, 'CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n');
    closers.push(() => socket.destroy());
    expect(head).toMatch(/^HTTP\/1\.1 200/);
    const payload = Buffer.alloc(4096, 7);
    expect((await roundTrip(socket, payload)).equals(payload)).toBe(true);
    expect(dialed).toEqual(['140.82.112.3:443']);
    expect(broker.stats()).toMatchObject({ tunnels: 1, refused: 0, exceeded: false });
    expect(broker.stats().bytes).toBe(payload.length * 2);
  });

  it.each([
    ['CONNECT evil.example:443 HTTP/1.1\r\n\r\n', 'HOST_DENIED'],
    ['CONNECT github.com.evil.example:443 HTTP/1.1\r\n\r\n', 'HOST_DENIED'],
    ['CONNECT 140.82.112.3:443 HTTP/1.1\r\n\r\n', 'HOST_DENIED'],
    ['CONNECT [::1]:443 HTTP/1.1\r\n\r\n', 'HOST_DENIED'],
    ['CONNECT github.com:22 HTTP/1.1\r\n\r\n', 'PORT_DENIED'],
    ['CONNECT github.com:80 HTTP/1.1\r\n\r\n', 'PORT_DENIED'],
    ['CONNECT github.com HTTP/1.1\r\n\r\n', 'HOST_DENIED'],
  ])('refuses %j', async (request, reason) => {
    const { broker, dialed } = await start();
    const { socket, head } = await tunnel(broker.port, request);
    closers.push(() => socket.destroy());
    expect(head).toMatch(/^HTTP\/1\.1 403/);
    expect(dialed).toEqual([]);
    expect(broker.stats().refusals).toEqual({ [reason]: 1 });
  });

  it('never proxies plain HTTP requests', async () => {
    const { broker, dialed } = await start();
    const { socket, head } = await tunnel(broker.port, 'GET http://github.com/ HTTP/1.1\r\nHost: github.com\r\n\r\n');
    closers.push(() => socket.destroy());
    expect(head).toMatch(/^HTTP\/1\.1 405/);
    expect(dialed).toEqual([]);
  });

  it('fails closed when the allowlisted name resolves to a private or metadata address', async () => {
    const { broker, dialed } = await start(1024, ['169.254.169.254']);
    const { socket, head } = await tunnel(broker.port, 'CONNECT api.github.com:443 HTTP/1.1\r\n\r\n');
    closers.push(() => socket.destroy());
    expect(head).toMatch(/^HTTP\/1\.1 403/);
    expect(dialed).toEqual([]);
    expect(broker.stats().refusals).toEqual({ ADDRESS_DENIED: 1 });
  });

  it('closes every tunnel once the shared byte budget is exceeded and refuses new ones', async () => {
    const { broker, budget } = await start(10_000);
    const first = await tunnel(broker.port, 'CONNECT github.com:443 HTTP/1.1\r\n\r\n');
    const closed = new Promise<void>((resolve) => first.socket.once('close', () => resolve()));
    first.socket.on('data', () => {});
    first.socket.on('error', () => {});
    first.socket.write(Buffer.alloc(20_000, 1));
    await closed;
    expect(budget.exceeded).toBe(true);
    expect(broker.stats().exceeded).toBe(true);
    const second = await tunnel(broker.port, 'CONNECT github.com:443 HTTP/1.1\r\n\r\n');
    closers.push(() => second.socket.destroy());
    expect(second.head).toMatch(/^HTTP\/1\.1 403/);
  });

  it('bounds concurrent tunnels', async () => {
    const upstream = await echoServer();
    closers.push(() => new Promise<void>((resolve) => upstream.server.close(() => resolve())));
    const broker = await startEgressBroker({
      budget: new ByteMeter(1024 * 1024),
      maxTunnels: 1,
      lookup: async () => [{ address: '140.82.112.3', family: 4 }],
      dial: () => connect(upstream.port, '127.0.0.1'),
    });
    closers.push(() => broker.close());
    const a = await tunnel(broker.port, 'CONNECT github.com:443 HTTP/1.1\r\n\r\n');
    closers.push(() => a.socket.destroy());
    const b = await tunnel(broker.port, 'CONNECT github.com:443 HTTP/1.1\r\n\r\n');
    closers.push(() => b.socket.destroy());
    expect(a.head).toMatch(/^HTTP\/1\.1 200/);
    expect(b.head).toMatch(/^HTTP\/1\.1 429/);
  });
});

describe('pinned metadata fetch', () => {
  it('refuses destinations outside the allowlist before resolving', async () => {
    let resolved = 0;
    const fetch = pinnedFetch({ budget: new ByteMeter(1024), lookup: async () => { resolved++; return [{ address: '140.82.112.3', family: 4 }]; } });
    for (const url of ['https://example.com/x', 'http://api.github.com/x', 'https://api.github.com:8443/x', 'https://user@api.github.com/x', 'https://169.254.169.254/latest']) {
      await expect(fetch(url, { method: 'GET', headers: {}, redirect: 'manual' })).rejects.toMatchObject({ details: { reason: 'EGRESS_DESTINATION_DENIED' } });
    }
    expect(resolved).toBe(0);
  });

  it('dials only the validated address and never a re-resolution', async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dialed: string[] = [];
    const fetch = pinnedFetch({
      budget: new ByteMeter(1024 * 1024),
      timeoutMs: 2000,
      lookup: async () => [{ address: '140.82.113.6', family: 4 }],
      dial: (address, port) => {
        dialed.push(`${address}:${port}`);
        return connect((server.address() as AddressInfo).port, '127.0.0.1');
      },
    });
    // The fake upstream is not GitHub, so TLS cannot complete: the request fails closed.
    await expect(fetch('https://api.github.com/repos/o/r', { method: 'GET', headers: {}, redirect: 'manual' })).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    expect(dialed).toEqual(['140.82.113.6:443']);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails closed on private answers', async () => {
    const fetch = pinnedFetch({ budget: new ByteMeter(1024), lookup: async () => [{ address: '10.0.0.8', family: 4 }] });
    await expect(fetch('https://api.github.com/repos/o/r', { method: 'GET', headers: {}, redirect: 'manual' })).rejects.toMatchObject({ details: { reason: 'EGRESS_ADDRESS_DENIED' } });
  });
});

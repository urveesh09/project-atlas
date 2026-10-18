#!/usr/bin/env node
/** Black-box packet checks. nft runs ONLY in the router container's net namespace.
 * Never uses host networking, host PIDs, privileged mode or the host firewall.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const image = process.argv[process.argv.indexOf('--validation-image') + 1];
if (!/^sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('Immutable validation image ID required');
const prefix = `atlas-firewall-${randomBytes(5).toString('hex')}`;
const containers = [], networks = [];
const run = (args, options = {}) => execFileSync('docker', args, { encoding: 'utf8', timeout: 20_000, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
const createNetwork = (suffix) => { const name = `${prefix}-${suffix}`; networks.push(name); run(['network', 'create', '--label', `atlas.production.probe=${prefix}`, name]); return name; };
const create = (suffix, network, program, extra = []) => {
  const name = `${prefix}-${suffix}`;
  containers.push(name);
  run(['run', '-d', '--name', name, '--label', `atlas.production.probe=${prefix}`, '--network', network, '--cap-drop=ALL', '--cap-add=NET_ADMIN', ...extra, image, 'node', '-e', program]);
  return name;
};
const exec = (name, args, options) => run(['exec', '-i', name, ...args], options);
const inspectNetwork = (name) => JSON.parse(run(['network', 'inspect', name]))[0];
const address = (network, name) => Object.values(inspectNetwork(network).Containers).find((c) => c.Name === name).IPv4Address.split('/')[0];
const listening = "const net=require('node:net');for(const p of [53,80,443,5432])net.createServer(s=>{s.on('error',()=>{});s.end('ok')}).listen(p,'0.0.0.0');";
const connect = (name, ip, port, uid) => {
  const program = `const net=require('node:net');const s=net.connect(${port},${JSON.stringify(ip)});let done=false;function end(ok){if(done)return;done=true;s.destroy();console.log(ok?'connected':'blocked');}s.on('connect',()=>end(true));s.on('error',()=>end(false));s.setTimeout(350,()=>end(false));`;
  return run(['exec', ...(uid ? ['--user', uid] : []), name, 'node', '-e', program]);
};
try {
  const sourceNet = createNetwork('source'), targetNet = createNetwork('target');
  const router = create('router', sourceNet, listening, ['--sysctl', 'net.ipv4.ip_forward=1']);
  run(['network', 'connect', targetNet, router]);
  const source = create('broker', sourceNet, listening);
  const target = create('target', targetNet, listening);
  const sourceIP = address(sourceNet, source), targetIP = address(targetNet, target);
  const sourceSubnet = inspectNetwork(sourceNet).IPAM.Config[0].Subnet;
  const targetSubnet = inspectNetwork(targetNet).IPAM.Config[0].Subnet;
  exec(source, ['ip', 'route', 'add', targetSubnet, 'via', address(sourceNet, router)]);
  exec(target, ['ip', 'route', 'add', sourceSubnet, 'via', address(targetNet, router)]);
  // Positive control: the exact same routed TCP paths work before installing the filter.
  assert.equal(connect(source, targetIP, 443), 'connected');
  assert.equal(connect(source, targetIP, 80), 'connected');
  assert.equal(connect(source, address(sourceNet, router), 443), 'connected');
  let rules = readFileSync(fileURLToPath(new URL('../deploy/production/worker-egress.nft', import.meta.url)), 'utf8')
    .replace('192.0.2.53', targetIP).replace('192.0.2.10', targetIP).replace('192.0.2.20', targetIP)
    .replace('172.28.0.0/24', sourceSubnet).replaceAll('"docker0"', '"eth0"');
  // Fixture IPs enter sets only inside this isolated router. Production metadata rejects
  // private/documentation ranges; its separate tests prove that boundary.
  rules += `\nflush set inet atlas_egress github4\nadd element inet atlas_egress github4 { ${targetIP} timeout 30s }\n`;
  exec(router, ['nft', '-c', '-f', '-'], { input: rules });
  exec(router, ['nft', '-f', '-'], { input: rules });
  assert.equal(connect(source, targetIP, 443), 'connected', 'broker HTTPS allow');
  assert.equal(connect(source, address(sourceNet, router), 443), 'blocked', 'broker cannot relay through a host service');
  assert.equal(connect(source, targetIP, 80), 'blocked', 'broker HTTP deny');
  assert.equal(connect(source, targetIP, 5432), 'blocked', 'broker database deny');
  assert.equal(connect(source, targetIP, 53), 'connected', 'broker fixed DNS allow');
  assert.equal(connect(target, sourceIP, 443), 'blocked', 'nonbroker forwarding deny');
  assert.equal(connect(router, targetIP, 443, '10001:10001'), 'connected', 'coordinator GitHub/storage allow');
  assert.equal(connect(router, targetIP, 5432, '10001:10001'), 'connected', 'coordinator database allow');
  assert.equal(connect(router, targetIP, 80, '10001:10001'), 'blocked', 'coordinator other ports deny');
  assert.equal(connect(router, targetIP, 5432, '10002:10002'), 'blocked', 'unrelated host UID deny');
  // An invalid atomic transaction cannot flush a previously working allowlist.
  assert.throws(() => exec(router, ['nft', '-f', '-'], { input: 'flush set inet atlas_egress github4\nadd element inet atlas_egress github4 { not-an-address }\n' }));
  assert.equal(connect(source, targetIP, 443), 'connected', 'failed update preserves old set');
  // Keep the other explicit storage allow out of this expiry check: broker has none.
  exec(router, ['nft', '-f', '-'], { input: `flush set inet atlas_egress github4\nadd element inet atlas_egress github4 { ${targetIP} timeout 1s }\n` });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(connect(source, targetIP, 443), 'blocked', 'expired allowlist fails closed');
  const counters = JSON.parse(exec(router, ['nft', '-j', 'list', 'table', 'inet', 'atlas_egress']));
  const drops = counters.nftables.flatMap((n) => n.rule?.expr ?? []).filter((e) => e.counter).reduce((n, e) => n + e.counter.packets, 0);
  assert(drops >= 5, 'deny counter witnesses packets reaching the actual firewall');
  console.log('PASS routed broker/coordinator packet policy, atomic failure, stale-set expiry');
} catch (error) {
  // Retain only fixture network diagnostics; no host rules or service credentials.
  for (const name of containers) {
    try {
      console.error(`${name}: ${exec(name, ['ip', '-brief', 'address'])}`);
      if (name.endsWith('-router')) console.error(exec(name, ['nft', 'list', 'table', 'inet', 'atlas_egress']));
    } catch { console.error(`${name}: diagnostic unavailable`); }
  }
  throw error;
} finally {
  const failures = [];
  for (const name of containers.reverse()) {
    try {
      const info = JSON.parse(run(['inspect', name]))[0];
      assert.equal(info.Config.Labels['atlas.production.probe'], prefix);
      run(['rm', '-f', info.Id]);
    } catch (error) { if (!String(error.stderr).includes('No such object')) failures.push(error); }
  }
  for (const name of networks.reverse()) {
    try {
      const info = inspectNetwork(name);
      assert.equal(info.Labels['atlas.production.probe'], prefix);
      run(['network', 'rm', info.Id]);
    } catch (error) { if (!String(error.stderr).includes('not found')) failures.push(error); }
  }
  assert.equal(run(['ps', '-aq', '--filter', `label=atlas.production.probe=${prefix}`]), '');
  assert.equal(run(['network', 'ls', '-q', '--filter', `label=atlas.production.probe=${prefix}`]), '');
  if (failures.length) throw new AggregateError(failures, 'Owned firewall probe cleanup failed');
}

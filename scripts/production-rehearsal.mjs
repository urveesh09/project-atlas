#!/usr/bin/env node
/** M4.1: real production API profile, trusted loopback TLS, isolated validators.
 * Never applies a firewall on the host. Only this random Compose project's resources
 * are removed. Service credentials/CA live in ignored scratch, never in the report.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import tls from 'node:tls';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertProductionProfile } from '../deploy/production/check-profile.mjs';
import { downloadMetadata, githubRanges, refreshBatch } from '../deploy/production/refresh-github-ranges.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const apiImage = opt('--api-image');
const validationImage = opt('--validation-image');
const caddyImage = opt('--proxy-image');
if (![apiImage, validationImage, caddyImage].every((v) => /^sha256:[a-f0-9]{64}$/.test(v ?? ''))) throw new Error('Supply immutable --api-image, --proxy-image and --validation-image IDs');
const postgresImage = 'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const storageImage = 'versity/versitygw@sha256:605de57c0cdc297fc5bc905ece592965d542d8df70d6eedf755734c80f2eb797';
const project = `atlas-m41-${randomBytes(5).toString('hex')}`;
const work = path.join(root, '.atlas-tmp', project);
mkdirSync(work, { recursive: true, mode: 0o700 });
const reportPath = path.resolve(opt('--out') ?? path.join(work, 'report.json'));
const secretDir = path.join(work, 'secrets');
mkdirSync(secretDir, { mode: 0o700 });
const token = () => randomBytes(32).toString('hex');
const pgPassword = token(), apiPassword = token(), workerPassword = token(), storageKey = token();
const secret = (name, value) => {
  writeFileSync(path.join(secretDir, name), value, { mode: 0o644 });
  // Ephemeral test values only. Production provisioning uses root:10001 / 0440.
  chmodSync(path.join(secretDir, name), 0o644);
};
secret('postgres_password', pgPassword);
secret('migration_url', `postgres://postgres:${pgPassword}@postgres:5432/atlas`);
secret('api_database_url', `postgres://atlas_api:${apiPassword}@postgres:5432/atlas`);
secret('api_role_password', apiPassword);
secret('worker_role_password', workerPassword);
secret('quota_secret', token());
secret('api_storage_access_key', 'atlas-rehearsal');
secret('api_storage_secret', storageKey);
secret('store.env', `ROOT_ACCESS_KEY=atlas-rehearsal\nROOT_SECRET_KEY=${storageKey}\n`);
const docker = (params, options = {}) => execFileSync('docker', params, { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024, ...options }).trim();
const mounted = work.replaceAll('\\', '/');
const production = path.join(root, 'deploy/production');
const prodMount = production.replaceAll('\\', '/');
const report = { task: 'M4.1', started: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
  images: { api: apiImage, validation: validationImage, proxy: caddyImage, postgres: postgresImage, storage: storageImage }, steps: [] };
report.configurationSha256 = Object.fromEntries([...readdirSync(production).filter((f) => /\.(mjs|ya?ml|nft|service|timer|Dockerfile|json)$/.test(f)).map((f) => `deploy/production/${f}`),
  'deploy/production/docker.service.d/atlas-egress.conf', 'scripts/hosted-rehearsal.mjs', 'scripts/production-rehearsal.mjs', 'scripts/production-firewall-probe.mjs'].sort().map((f) => [f, createHash('sha256').update(readFileSync(path.join(root, f))).digest('hex')]));
let prometheusImage;
const step = async (name, run) => {
  const start = performance.now();
  try {
    const detail = await run();
    report.steps.push({ name, passed: true, ms: Math.round(performance.now() - start), ...(detail ? { detail } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.steps.push({ name, passed: false, ms: Math.round(performance.now() - start), error: error.code ?? error.name });
    throw error;
  }
};
const overlay = path.join(work, 'compose.json');
const composeEnv = { ...process.env, ATLAS_API_IMAGE: apiImage, ATLAS_PROXY_IMAGE: caddyImage, ATLAS_DOMAIN: 'localhost', ATLAS_PUBLIC_ORIGIN: 'https://localhost',
  ATLAS_SECRET_DIR: secretDir, ATLAS_S3_ENDPOINT: 'https://storage:8443', ATLAS_S3_BUCKET: 'atlas-rehearsal', ATLAS_HTTPS_PORT: '0', ATLAS_BIND_ADDRESS: '127.0.0.1' };
const compose = (params, options) => docker(['compose', '-p', project, '-f', path.join(production, 'compose.yaml'), '-f', overlay, '--profile', 'api-host', '--profile', 'monitoring', ...params], { env: composeEnv, ...options });
// The throwaway CA only verifies the loopback server; it is a trust anchor, never request
// data. It exists after the first step, so the agent is created on first use. Keep-alive
// matches Node's global agent, which these requests used before.
let trusted;
const request = (port, urlPath, { method = 'GET', body, headers = {}, stream = false } = {}) => new Promise((resolve, reject) => {
  trusted ??= new https.Agent({ ca: readFileSync(path.join(secretDir, 'ca.crt')), keepAlive: true });
  const req = https.request({ hostname: '127.0.0.1', servername: 'localhost', port, path: urlPath, method, agent: trusted,
    headers: { Host: `localhost:${port}`, ...headers, ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, timeout: 10_000 }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      text += chunk;
      if (stream && text.includes('\n\n')) { resolve({ status: res.statusCode, headers: res.headers, text }); req.destroy(); }
    });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    res.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new Error('HTTPS rehearsal timeout')));
  req.on('error', reject);
  req.end(body);
});

try {
  await step('throwaway CA and hostname-verified server certificate', () => {
    docker(['run', '--rm', '--network=none', '--mount', `type=bind,source=${mounted},target=/work`, validationImage, 'sh', '-ec',
      'cd /work/secrets; openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout ca.key -out ca.crt -subj /CN=ATLAS-rehearsal-CA -addext basicConstraints=critical,CA:TRUE; openssl req -newkey rsa:2048 -nodes -keyout tls_key -out server.csr -subj /CN=localhost; printf "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:storage\\nbasicConstraints=CA:FALSE\\nextendedKeyUsage=serverAuth\\n" > server.ext; openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out tls_certificate -days 1 -extfile server.ext; chmod 644 tls_key tls_certificate ca.crt'], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
  writeFileSync(path.join(work, 'storage.Caddyfile'), '{\n admin off\n auto_https disable_redirects\n}\nhttps://storage:8443 {\n tls /run/secrets/tls_certificate /run/secrets/tls_key\n reverse_proxy store:7070\n}\n');
  writeFileSync(overlay, JSON.stringify({ services: {
    postgres: { image: postgresImage, environment: { POSTGRES_PASSWORD_FILE: '/run/secrets/postgres_password', POSTGRES_DB: 'atlas' }, secrets: ['postgres_password'], networks: ['api'], tmpfs: ['/var/lib/postgresql/data'], healthcheck: { test: ['CMD', 'pg_isready', '-U', 'postgres', '-d', 'atlas'], interval: '1s', retries: 30 } },
    store: { image: storageImage, command: ['--quiet', 'posix', '/data'], env_file: [path.join(secretDir, 'store.env')], tmpfs: ['/data'], networks: ['api'] },
    storage: { image: caddyImage, volumes: [`${mounted}/storage.Caddyfile:/etc/caddy/Caddyfile:ro`], secrets: ['tls_certificate', 'tls_key'], networks: ['api'] },
    api: { environment: { NODE_EXTRA_CA_CERTS: '/run/secrets/rehearsal_ca' }, secrets: ['rehearsal_ca'] },
    migrate: { depends_on: { postgres: { condition: 'service_healthy' } } },
  }, secrets: { postgres_password: { file: path.join(secretDir, 'postgres_password') }, rehearsal_ca: { file: path.join(secretDir, 'ca.crt') } } }, null, 2));

  await step('production profile preserves immutable images, secret mounts and isolation', () => {
    const config = JSON.parse(compose(['config', '--format', 'json']));
    assertProductionProfile(config);
    for (const name of ['api', 'migrate', 'proxy']) {
      const service = config.services[name];
      assert.equal(service.read_only, true);
      assert.equal(service.user, '10001:10001');
      assert.deepEqual(service.cap_drop, ['ALL']);
      assert(service.security_opt.includes('no-new-privileges:true'));
      assert.equal(service.environment.ATLAS_DEVELOPMENT, undefined);
      assert(!service.volumes?.some((v) => v.target?.includes('docker.sock')));
      assert(!JSON.stringify(service.environment).includes(pgPassword));
    }
    assert.equal(config.services.api.ports, undefined);
    assert.equal(config.services.api.environment.ATLAS_TRUSTED_PROXIES, '172.30.10.2');
    assert.match(config.services.proxy.image, /^sha256:[a-f0-9]{64}$/);
    assert.equal(config.services.prometheus.network_mode, 'service:api');
    prometheusImage = config.services.prometheus.image;
  });
  await step('Caddy validates the actual production configuration and certificate', () => {
    compose(['run', '--rm', '--no-deps', 'proxy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  });
  await step('nft validates current GitHub ranges in its own network namespace; host rules are untouched', async () => {
    const meta = await downloadMetadata();
    const ranges = githubRanges(meta);
    const rules = readFileSync(path.join(production, 'worker-egress.nft'), 'utf8') + '\n' + refreshBatch(meta);
    docker(['run', '--rm', '--network=none', '--cap-add=NET_ADMIN', validationImage, 'nft', '--check', '--file', '-'], { input: rules });
    return { githubIpv4Ranges: ranges.ipv4.length, githubIpv6Ranges: ranges.ipv6.length };
  });
  await step('systemd validates the shipped worker and firewall units', () => {
    docker(['run', '--rm', '--network=none', '--mount', `type=bind,source=${prodMount},target=/production,readonly`, validationImage, 'sh', '-ec',
      'mkdir -p /opt/atlas/node/bin /opt/atlas/current /etc/atlas /var/lib/atlas/jobs /run/atlas-egress /tmp/units /etc/systemd/system/docker.service.d; ln -s /usr/local/bin/node /opt/atlas/node/bin/node; touch /etc/atlas/worker.env; printf "#!/bin/sh\\nexit 0\\n" > /usr/bin/docker; chmod +x /usr/bin/docker; printf "[Service]\\nExecStart=/usr/bin/true\\n" > /etc/systemd/system/docker.service; cp /production/docker.service.d/atlas-egress.conf /etc/systemd/system/docker.service.d/; cp /production/*.service /production/*.timer /tmp/units/; chmod 644 /tmp/units/* /etc/systemd/system/docker.service.d/*; systemd-analyze verify /tmp/units/*.service /tmp/units/*.timer']);
  });
  await step('promtool validates the Prometheus configuration, alert rules and their unit tests', () => {
    docker(['run', '--rm', '--network=none', '--mount', `type=bind,source=${prodMount},target=/etc/prometheus,readonly`, '--workdir', '/etc/prometheus', '--entrypoint', 'sh', prometheusImage, '-ec',
      'promtool check config prometheus.yml; promtool check rules alerts.yml slo.yml; promtool test rules alerts.test.yml slo.test.yml']);
  });
  await step('firewall enforces broker and coordinator destinations in isolated container networks', () => {
    execFileSync(process.execPath, [path.join(root, 'scripts/production-firewall-probe.mjs'), '--validation-image', validationImage], { cwd: root, stdio: 'inherit', timeout: 120_000 });
  });
  await step('start disposable dependencies and create a private HTTPS bucket', () => {
    compose(['up', '-d', '--wait', 'postgres', 'store', 'storage']);
    compose(['run', '--rm', '--no-deps', '--entrypoint', 'node', 'api', '--input-type=module', '-e',
      "import {storageFromEnv} from '/atlas/node_modules/@atlas/control/dist/index.js'; await storageFromEnv(process.env).createBucketForDevelopment();"]);
  });
  await step('real migration provisions roles; production API becomes healthy', () => {
    compose(['up', '-d', '--wait', 'api', 'proxy']);
    const info = JSON.parse(docker(['inspect', compose(['ps', '-q', 'api'])]))[0];
    assert.equal(info.Config.User, '10001:10001');
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
    assert.equal(info.Config.Env.some((v) => v.startsWith('ATLAS_DEVELOPMENT=')), false);
  });
  // Docker selects a free loopback port. Restart API with its exact public origin;
  // certificates remain checked against localhost (no TLS verification bypass).
  let port = Number(compose(['port', 'proxy', '8443']).split(':').at(-1));
  composeEnv.ATLAS_PUBLIC_ORIGIN = `https://localhost:${port}`;
  composeEnv.ATLAS_HTTPS_PORT = String(port);
  compose(['up', '-d', '--wait', 'api', 'proxy']);
  const origin = composeEnv.ATLAS_PUBLIC_ORIGIN;
  let cookie, jobId;
  await step('TLS, HSTS, no-store and secure same-origin session', async () => {
    await assert.rejects(() => new Promise((resolve, reject) => {
      const socket = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', rejectUnauthorized: true }, () => { socket.end(); resolve(); });
      socket.once('error', reject);
      socket.setTimeout(3000, () => socket.destroy(new Error('TLS trust probe timeout')));
    }), (error) => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code));
    const home = await request(port, '/');
    assert.equal(home.status, 200);
    assert.equal(home.headers['strict-transport-security'], 'max-age=31536000');
    assert.equal((await request(port, '/api/v1/health/ready')).status, 200);
    const apiId = compose(['ps', '-q', 'api']);
    const health = JSON.parse(docker(['inspect', apiId]))[0].Config.Healthcheck.Test;
    assert.equal(health[0], 'CMD');
    docker(['exec', apiId, ...health.slice(1)]);
    // A DB-only operator endpoint always returns 200, even for stale migrations,
    // and misses a storage outage. Exercise the actual full readiness command.
    compose(['stop', 'storage']);
    assert.equal((await request(port, '/api/v1/health/ready')).status, 503);
    assert.throws(() => docker(['exec', apiId, ...health.slice(1)]), (error) => error.status === 1);
    compose(['up', '-d', '--wait', 'storage']);
    const storageDeadline = Date.now() + 5000;
    while ((await request(port, '/api/v1/health/ready')).status !== 200) {
      if (Date.now() > storageDeadline) throw new Error('Storage did not recover');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    docker(['exec', apiId, ...health.slice(1)]);
    const session = await request(port, '/api/v1/session', { method: 'POST', headers: { Origin: origin } });
    assert.equal(session.status, 201);
    assert.match(session.headers['cache-control'], /no-store/);
    assert.match(session.headers['set-cookie'][0], /; Secure/);
    cookie = session.headers['set-cookie'][0].split(';')[0];
  });
  await step('proxy rejects unsupported methods and oversized bodies', async () => {
    assert.equal((await request(port, '/api/v1/session', { method: 'PUT' })).status, 405);
    const atLimit = JSON.stringify({ padding: 'x'.repeat(16370) });
    assert.equal(Buffer.byteLength(atLimit), 16384);
    // Exactly 16 KiB reaches API schema validation (400); it is not a proxy size error.
    assert.equal((await request(port, '/api/v1/analyses', { method: 'POST', body: atLimit, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() } })).status, 400);
    assert.equal((await request(port, '/api/v1/analyses', { method: 'POST', body: 'x'.repeat(16385), headers: { Origin: origin, Cookie: cookie, 'Idempotency-Key': crypto.randomUUID() } })).status, 413);
  });
  await step('forged Host/Origin are rejected through the real proxy', async () => {
    assert.equal((await request(port, '/api/v1/session', { method: 'POST', headers: { Origin: 'https://forged.example.org' } })).status, 403);
    assert.equal((await request(port, '/api/v1/session', { method: 'POST', headers: { Host: 'forged.example.org', Origin: origin } })).status, 421);
  });
  await step('admit, stream first event before completion, cancel through HTTPS', async () => {
    const submission = await request(port, '/api/v1/analyses', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ repositoryUrl: 'https://github.com/atlas-demo/harbor', commitSha: null, profile: 'v0.1-default', history: { enabled: false }, publication: 'public-expiring' }) });
    assert.equal(submission.status, 202);
    jobId = JSON.parse(submission.text).jobId;
    const events = await request(port, `/api/v1/jobs/${jobId}/events`, { headers: { Cookie: cookie }, stream: true });
    assert.equal(events.status, 200);
    assert.match(events.headers['content-type'], /text\/event-stream/);
    assert.match(events.text, /QUEUED/);
    const cancelled = await request(port, `/api/v1/jobs/${jobId}/cancel`, { method: 'POST', headers: { Origin: origin, Cookie: cookie } });
    assert.equal(cancelled.status, 200);
    assert.equal(JSON.parse(cancelled.text).state, 'CANCELLED');
    const terminal = await request(port, `/api/v1/jobs/${jobId}/events`, { headers: { Cookie: cookie } });
    assert.match(terminal.text, /CANCELLED/);
  });
  await step('spoofed forwarding headers cannot bypass client session quotas', async () => {
    // The first session plus 29 more exhaust the existing per-client limit of 30.
    for (let n = 1; n < 30; n++) assert.equal((await request(port, '/api/v1/session', { method: 'POST', headers: { Origin: origin, 'X-Forwarded-For': `198.51.100.${n}` } })).status, 201);
    assert.equal((await request(port, '/api/v1/session', { method: 'POST', headers: { Origin: origin, 'X-Forwarded-For': '203.0.113.1' } })).status, 429);
  });
  await step('Prometheus scrapes the loopback-only operator listener from the API namespace and loads every alert and service-level rule', async () => {
    const apiId = compose(['ps', '-q', 'api']);
    // An unknown publication is an ended read (ADR-076); it must reach the API's counter through the proxy.
    assert.equal((await request(port, `/api/v1/analyses/analysis_${'0'.repeat(64)}`)).status, 404);
    // Same network, different namespace: the proxy is refused, so only a scraper in the API's namespace can read it.
    assert.throws(() => compose(['exec', '-T', 'proxy', 'wget', '-q', '-O', '-', '-T', '3', 'http://api:9090/metrics'], { stdio: ['ignore', 'pipe', 'pipe'] }),
      (error) => /refused/i.test(String(error.stderr)));
    const text = docker(['exec', apiId, 'node', '-e',
      "fetch('http://127.0.0.1:9090/metrics',{headers:{accept:'text/plain;version=0.0.4'}}).then(async(r)=>{if(r.headers.get('content-type')!=='text/plain; version=0.0.4; charset=utf-8')process.exit(2);process.stdout.write(await r.text());})"]);
    const lint = execFileSync('docker', ['run', '--rm', '-i', '--network=none', '--entrypoint', 'promtool', prometheusImage, 'check', 'metrics'],
      { input: `${text}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
    assert.equal(lint.trim(), '');
    assert.match(text, /^atlas_publication_reads_total\{result="ended"\} 1$/m);
    compose(['up', '-d', '--no-deps', 'prometheus']);
    const query = (target) => JSON.parse(docker(['exec', apiId, 'node', '-e', `fetch('http://127.0.0.1:9091${target}').then((r)=>r.text()).then((t)=>process.stdout.write(t))`]));
    const deadline = Date.now() + 90_000;
    for (;;) {
      let up = [], rules = [];
      try {
        up = query('/api/v1/query?query=up').data.result;
        rules = query('/api/v1/rules').data.groups.flatMap((group) => group.rules);
      } catch { /* Prometheus is still starting. */ }
      if (up.some((s) => s.metric.job === 'atlas-operator' && s.value[1] === '1') && rules.length === 16 && rules.every((rule) => rule.health === 'ok')) break;
      if (Date.now() > deadline) throw new Error(`Prometheus did not scrape and evaluate in time: up ${JSON.stringify(up)}, rules ${JSON.stringify(rules.map((rule) => [rule.name, rule.health]))}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    // The job cancelled above is in the scraped data.
    const cancelled = query('/api/v1/query?query=atlas_outcomes_24h').data.result.find((s) => s.metric.state === 'CANCELLED');
    assert(Number(cancelled?.value[1]) >= 1);
    const ended = query('/api/v1/query?query=atlas_publication_reads_total').data.result.find((s) => s.metric.result === 'ended');
    assert(Number(ended?.value[1]) >= 1);
    return { metricFamilies: text.match(/^# TYPE /gm).length, rules: 16 };
  });
  await step('runtime database role cannot alter the schema', () => {
    const result = compose(['exec', '-T', 'api', 'node', '--input-type=module', '-e',
      "import {databasePool} from '/atlas/node_modules/@atlas/control/dist/index.js'; const pool=databasePool(process.env); try { await pool.query('CREATE TABLE forbidden_probe(id int)'); process.exitCode=1; } catch(e) { if(e.code!=='42501') throw e; } finally { await pool.end(); }"]);
    assert.equal(result, '');
  });
} catch (error) {
  writeFileSync(path.join(work, 'failure-error.txt'), error.stack ?? error.name);
  try { writeFileSync(path.join(work, 'failure-logs.txt'), compose(['logs', '--no-color', '--tail', '80'])); } catch { /* Preserve the original failure. */ }
  console.error(`M4.1 rehearsal failed (${error.name}). Retain this report; local failure logs saved in scratch.`);
  process.exitCode = 1;
} finally {
  trusted?.destroy();
  try {
    compose(['down', '--volumes', '--remove-orphans']);
    const remaining = docker(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]);
    assert.equal(remaining, '');
    report.cleaned = true;
  } catch { report.cleaned = false; process.exitCode = 1; }
  report.finished = new Date().toISOString();
  report.passed = report.steps.length === 16 && report.steps.every((s) => s.passed) && report.cleaned;
  if (!report.passed) process.exitCode = 1;
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Report: ${path.relative(root, reportPath)}`);
}

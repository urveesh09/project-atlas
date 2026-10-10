import { expect, it, describe } from 'vitest';
import { runBounded } from '@atlas/ingest';
import { analysisContainerArgs, runOfflineProbe, type SandboxRuntime } from '../src/sandbox.js';

const name = `atlas-analysis-${'a'.repeat(32)}`;
const image = `sha256:${'b'.repeat(64)}`;
describe('offline sandbox policy', () => {
  it('pins immutable operator image, network, user, filesystem, CPU, PID, RAM, swap and bounded scratch', () => {
    const args = analysisContainerArgs(name, image);
    for (const value of ['--network=none', '--read-only', '--user=10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pull=never', '--log-driver=none']) expect(args).toContain(value);
    expect(args[args.indexOf('--memory') + 1]).toBe('2147483648');
    expect(args[args.indexOf('--memory-swap') + 1]).toBe('2147483648');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('64');
    expect(args.filter((s) => s.startsWith('/scratch:') || s.startsWith('/tmp:')).map((s) => Number(/size=(\d+)/.exec(s)![1])).reduce((a, b) => a + b, 0)).toBe(1073741824);
    expect(args.some((s) => s.includes('docker.sock') || s === '--privileged')).toBe(false);
  });
  it('rejects mutable images, injected names and raised limits', () => {
    expect(() => analysisContainerArgs(name, 'node:latest')).toThrow('immutable');
    expect(() => analysisContainerArgs('--privileged', image)).toThrow();
    expect(() => analysisContainerArgs(name, image, { memoryBytes: 3 * 1024 ** 3, scratchBytes: 1024 ** 3, cpus: 4, pids: 64 })).toThrow('lowered');
  });
});

const enabled = process.env['ATLAS_CONTAINER_TESTS'] === '1';
const actualImage = process.env['ATLAS_TEST_SANDBOX_IMAGE'];
if (enabled && !actualImage) throw new Error('Container tests require the immutable ATLAS_TEST_SANDBOX_IMAGE');
describe.runIf(enabled)('actual Linux container isolation spike (partial P5.3)', () => {
  const runtime: SandboxRuntime = {
    docker: process.env['ATLAS_DOCKER_EXECUTABLE'] ?? 'docker', image: actualImage!, cwd: process.cwd(),
    // Operator environment used only by Docker CLI; none enters the container.
    env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
  };
  it('proves non-root, read-only runtime, no metadata/public egress, no host socket and real cgroup caps', async () => {
    const result = await runOfflineProbe(runtime, `
      const fs=require('node:fs'),net=require('node:net');
      const blocked=async(host)=>new Promise(resolve=>{const s=net.connect(80,host);s.setTimeout(500);s.on('connect',()=>{s.destroy();resolve(false)});s.on('error',()=>resolve(true));s.on('timeout',()=>{s.destroy();resolve(true)});});
      (async()=>{let readonly=false;try{fs.writeFileSync('/forbidden','x')}catch{readonly=true}
      const probes=await Promise.all(['169.254.169.254','1.1.1.1','10.0.0.1'].map(blocked));
      fs.writeFileSync('/scratch/allowed','x');
      console.log(JSON.stringify({uid:process.getuid(),readonly,probes,socket:fs.existsSync('/var/run/docker.sock'),
        memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),pids:fs.readFileSync('/sys/fs/cgroup/pids.max','utf8').trim(),cpu:fs.readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim()}));})();
    `);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ uid: 10001, readonly: true, probes: [true,true,true], socket: false, memory: '2147483648', pids: '64', cpu: '400000 100000' });
    expect(result.config).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, Memory: 2147483648, MemorySwap: 2147483648, PidsLimit: 64, NanoCpus: 4000000000 });
    const containers = await runBounded(runtime.docker, ['ps','--all','--filter',`name=${result.name}`,'--format','{{.Names}}'], { cwd: runtime.cwd, env: runtime.env, timeoutMs: 5000, maxStdoutBytes: 4096 });
    expect(containers.stdout.toString('utf8').trim()).toBe('');
  });
  it('enforces scratch capacity in the kernel instead of an event-loop watchdog', async () => {
    const result = await runOfflineProbe(runtime, `const fs=require('node:fs');let capped=false;try{fs.writeFileSync('/scratch/too-big',Buffer.alloc(9*1024*1024))}catch(e){capped=e.code==='ENOSPC'};console.log(JSON.stringify({capped}));`, { limits: { memoryBytes: 128 * 1024 * 1024, scratchBytes: 8 * 1024 * 1024, cpus: 1, pids: 16 } });
    expect(JSON.parse(result.stdout).capped).toBe(true);
  });
  it('contains actual memory exhaustion under a lowered hard memory cap', async () => {
    const result = await runOfflineProbe(runtime, `const blocks=[];for(let i=0;i<1000;i++)blocks.push(Buffer.alloc(1024*1024,1));console.log('unexpected completion');`, { limits: { memoryBytes: 64 * 1024 * 1024, scratchBytes: 8 * 1024 * 1024, cpus: 1, pids: 16 } });
    expect(result.exitCode).toBe(137); expect(result.oomKilled).toBe(true);
  });
  it('prevents process exhaustion at the kernel PID boundary', async () => {
    const result = await runOfflineProbe(runtime, `const {spawn}=require('node:child_process');let failed=0,done=0;const children=[];for(let i=0;i<30;i++){const c=spawn('sleep',['60']);children.push(c);const finish=()=>{if(++done===30){for(const child of children)child.kill();console.log(JSON.stringify({failed}));}};c.once('error',()=>{failed++;finish()});c.once('spawn',finish)}`, { limits: { memoryBytes: 128 * 1024 * 1024, scratchBytes: 8 * 1024 * 1024, cpus: 1, pids: 16 } });
    expect(result.exitCode).toBe(0); expect(JSON.parse(result.stdout).failed).toBeGreaterThan(0);
  });
  it('kills the container and descendants when the coordinator deadline expires', async () => {
    await expect(runOfflineProbe(runtime, `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)']);setInterval(()=>{},1000);`, { deadlineMs: 700 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const containers = await runBounded(runtime.docker, ['ps','--all','--filter','label=atlas.sandbox=analysis','--format','{{.Names}}'], { cwd: runtime.cwd, env: runtime.env, timeoutMs: 5000, maxStdoutBytes: 4096 });
    expect(containers.stdout.toString('utf8').trim()).toBe('');
  });
});

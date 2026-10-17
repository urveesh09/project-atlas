import { readFileSync } from 'node:fs';

/** Benchmark-only observation of our direct parser children; never enters artifacts. */
export function observeParserMemory(ParserPool) {
  if (process.platform !== 'linux') return { finish: () => ({ available: false, method: 'Linux /proc VmHWM required', children: [] }) };
  const peaks = new Map();
  let error = null;
  const sample = () => {
    try {
      const children = readFileSync(`/proc/self/task/${process.pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
      for (const pid of children) {
        try {
          const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (!/(?:^|\/)parse-worker\.js\x00/.test(command)) continue;
          const status = readFileSync(`/proc/${pid}/status`, 'utf8');
          const value = /^VmHWM:\s+(\d+) kB$/m.exec(status);
          if (!value) throw new Error('Parser child has no kernel high-water RSS');
          peaks.set(Number(pid), Math.max(peaks.get(Number(pid)) ?? 0, Number(value[1]) * 1024));
        } catch (cause) {
          if (!['ENOENT', 'ESRCH'].includes(cause.code)) throw cause;
        }
      }
    } catch (cause) { error = cause; }
  };
  // Flush while successful workers are still alive, before production closes them.
  // The kernel high-water counter includes transient peaks between the 50 ms samples.
  const originalClose = ParserPool.prototype.close;
  ParserPool.prototype.close = async function (...args) { sample(); return originalClose.apply(this, args); };
  const timer = setInterval(sample, 50);
  timer.unref();
  return { finish() {
    sample();
    clearInterval(timer);
    ParserPool.prototype.close = originalClose;
    if (error) throw error;
    return { available: true, method: 'Linux /proc VmHWM every 50 ms and immediately before pool close; own direct parse-worker children only',
      children: [...peaks].map(([pid, peakRSSBytes]) => ({ pid, peakRSSBytes })) };
  } };
}

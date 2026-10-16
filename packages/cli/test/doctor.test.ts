import { expect, it } from 'vitest';
import { EXIT, run } from '@atlas/cli';

// M1.1: an old patch on the supported major warns without making diagnosis fail.
// Exercise both output modes through the command, including the real offline Git probe.
it.each([
  ['24.0.0', 'warn', EXIT.ok],
  ['24.15.0', 'warn', EXIT.ok],
  ['24.21.9', 'warn', EXIT.ok],
  ['24.22.0', 'ok', EXIT.ok],
  ['24.22.1', 'ok', EXIT.ok],
  ['24.23.0', 'ok', EXIT.ok],
  ['23.11.0', 'fail', EXIT.failure],
  ['25.0.0', 'fail', EXIT.failure],
] as const)('doctor on Node %s reports %s', async (version, status, code) => {
  const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node');
  if (!descriptor) throw new Error('Node version descriptor is missing');
  Object.defineProperty(process.versions, 'node', { ...descriptor, value: version });
  try {
    for (const json of [true, false]) {
      let stdout = '';
      let stderr = '';
      const result = await run(['doctor', ...(json ? ['--json'] : [])], {
        stdout: { write: (text: string) => { stdout += text; }, isTTY: false },
        stderr: { write: (text: string) => { stderr += text; }, isTTY: false },
        cwd: process.cwd(),
        env: { NO_COLOR: '1', ATLAS_ASCII: '1' },
        signal: new AbortController().signal,
      });
      expect(result, stderr).toBe(code);
      if (json) {
        const report = JSON.parse(stdout);
        expect(report.ok).toBe(code === EXIT.ok);
        expect(report.checks.find((check: { id: string }) => check.id === 'node')).toMatchObject({ status });
        expect(report.checks.find((check: { id: string }) => check.id === 'isolation')).toMatchObject({ status: 'ok' });
      } else if (status === 'warn') {
        expect(stdout).toContain('! Node.js');
        expect(stdout).toContain('Ready with 1 warning.');
      } else {
        expect(stdout).toContain(status === 'ok' ? 'Ready.' : '1 check failed.');
        expect(stdout).not.toContain('Ready with');
      }
      if (status === 'warn') expect(stdout).toContain('upgrade to 24.22.0 or newer 24.x for security fixes');
      if (status === 'fail') expect(stdout).toContain('requires 24.x; minimum 24.22.0');
    }
  } finally {
    Object.defineProperty(process.versions, 'node', descriptor);
  }
});

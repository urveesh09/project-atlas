import { describe, expect, it } from 'vitest';
import { parseGitConfigData } from '../src/local-repository.js';

/** The key/value expressions the scanner replaced (ADR-046), kept as the reference semantics. */
function reference(text: string): Map<string, string> {
  const values = new Map<string, string>();
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\]/.exec(line);
    if (header) {
      section = header[2] === undefined ? header[1]!.toLowerCase() : `${header[1]!.toLowerCase()}.${header[2]}`;
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (kv && section) values.set(`${section}.${kv[1]!.toLowerCase()}`, (kv[2] ?? 'true').replace(/\s*[#;].*$/, '').replace(/^"(.*)"$/, '$1'));
  }
  return values;
}

describe('git config reader', () => {
  it('reads exactly what the replaced expressions read', () => {
    let s = 7;
    const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const tokens = ['[core]', '[remote "origin"]', 'url', 'bare', ' ', '\t', '=', '"', '#', ';', 'x', 'A-1', '\r', '\u2028', '!', 'v a l', '\uFEFF'];
    for (let n = 0; n < 20_000; n++) {
      const lines = Array.from({ length: 1 + Math.floor(next() * 5) }, () =>
        Array.from({ length: Math.floor(next() * 6) }, () => tokens[Math.floor(next() * tokens.length)]).join(''),
      );
      const text = ['[core]', ...lines].join('\n');
      expect([...parseGitConfigData(text)], JSON.stringify(text)).toEqual([...reference(text)]);
    }
  });

  it('stays linear on lines built to make backtracking explode', () => {
    const started = performance.now();
    parseGitConfigData(`[core]\nkey = ${' '.repeat(200_000)}x\nother${' '.repeat(200_000)}!`);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

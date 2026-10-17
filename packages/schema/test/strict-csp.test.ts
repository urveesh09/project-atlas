import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GraphSnapshotSchema } from '@atlas/schema';

/** Browsers validate without compiled code; Node keeps compiled validators (ADR-069). */
describe('zod code generation by runtime', () => {
  it('keeps compiled validators in Node, where no content security policy applies', () => {
    expect(GraphSnapshotSchema).toBeDefined(); // the schema index, and so its CSP module, has loaded
    expect(z.config().jitless).not.toBe(true);
  });
});

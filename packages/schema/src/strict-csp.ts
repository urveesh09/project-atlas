import { z } from 'zod';

/**
 * Browsers validate without compiled code (ADR-069). The viewer runs under
 * `script-src 'self'`, which forbids eval. Zod probes for eval with `Function('')` while
 * each object schema is defined, so the probe ran during module evaluation. The policy
 * blocked it, and browsers already fell back to validation without compiled code, but
 * Firefox reported the blocked attempt as a page error. Setting `jitless` before any
 * schema is defined skips the probe; validation results are identical. Node keeps
 * compiled validators. The index imports this module first so the setting precedes every
 * schema.
 */
const inNode = typeof (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions?.node === 'string';
if (!inNode) z.config({ jitless: true });

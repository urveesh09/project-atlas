import { PublicationStore, databasePool, forgetEndedJobs, operatorCancel, operatorMetrics, resolverFromEnv, storageFromEnv, type Env } from '@atlas/control';
import { JobQueue } from './queue.js';

/**
 * Operator commands (P5.6 runbooks). They act through the same database transitions and
 * storage rules as the services, print JSON only, and never print secrets or repository
 * names. Use the worker's least-privilege role (cancel/purge/sweep need no more).
 */
export const OPS_USAGE = `atlas-ops <command>
  metrics                         queue, leases, outcomes, stage p95s, storage, upstream budget
  cancel <job_id>                 cancel a queued or running job (sandboxes stop first)
  purge-analysis <analysis_id>    revoke one publication and purge storage it alone holds
  revoke-repository <numeric_id>  revoke every publication of a repository and purge
  reap                            fence expired leases now (normally every 5 s)
  sweep                           purge expired/deleted/revoked content and stale uploads
  revalidate                      re-check visibility of repositories with live publications
  reconcile-storage               delete stored upload prefixes with no database owner
  forget                          delete ended jobs past the 30-day record retention (normally hourly)`;

export async function runOps(env: Env, args: readonly string[], out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const [command, target] = args;
  if (!command || command === 'help') {
    out(OPS_USAGE);
    return command ? 0 : 2;
  }
  const pool = databasePool({ ...env, ATLAS_PROCESS_NAME: 'atlas-ops' }, 2);
  try {
    const publications = () => new PublicationStore(pool, storageFromEnv(env), resolverFromEnv(env, pool));
    const print = (value: unknown) => out(JSON.stringify(value));
    switch (command) {
      case 'metrics':
        print(await operatorMetrics(pool));
        return 0;
      case 'cancel': {
        const state = await operatorCancel(pool, target ?? '');
        print({ job: target ?? null, state });
        return state ? 0 : 1;
      }
      case 'purge-analysis': {
        const found = await publications().operatorPurge(target ?? '');
        print({ analysis: target ?? null, purged: found });
        return found ? 0 : 1;
      }
      case 'revoke-repository': {
        if (!/^[1-9]\d{0,19}$/.test(target ?? '')) {
          out('A numeric repository ID is required');
          return 2;
        }
        const store = publications();
        await store.revokeRepository(target!);
        print({ revoked: true, purged: await store.purge() });
        return 0;
      }
      case 'reap':
        print({ reaped: await new JobQueue(pool).reap() });
        return 0;
      case 'sweep':
        print(await publications().purge());
        return 0;
      case 'revalidate':
        print(await publications().revalidate());
        return 0;
      case 'reconcile-storage':
        print(await publications().reconcileStorage());
        return 0;
      case 'forget':
        print(await forgetEndedJobs(pool));
        return 0;
      default:
        out(OPS_USAGE);
        return 2;
    }
  } finally {
    await pool.end();
  }
}

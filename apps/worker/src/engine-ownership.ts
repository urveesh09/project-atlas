import type { Pool } from 'pg';
import { ConfigError } from '@atlas/control';

/** Hold one database session for the lifetime of the coordinator on this engine. */
export async function acquireEngineOwnership(pool: Pool, engineId: string, onLost: () => void): Promise<() => Promise<void>> {
  if (!engineId || engineId.length > 256 || /[\r\n\0]/.test(engineId)) throw new ConfigError('Docker engine identity is unavailable');
  const client = await pool.connect();
  const key = `atlas.engine/1:${engineId}`;
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [key],
    );
    if (!rows[0]?.acquired) throw new ConfigError('A coordinator already owns this Docker engine; stop it before restarting');
  } catch (error) {
    client.release();
    throw error;
  }
  let released = false;
  const lost = () => { if (!released) onLost(); };
  client.on('error', lost);
  return async () => {
    if (released) return;
    released = true;
    client.removeListener('error', lost);
    try { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]); }
    finally { client.release(true); }
  };
}

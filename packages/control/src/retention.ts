import type { Pool } from 'pg';

export interface ForgottenRecords { jobs: number; publications: number; objects: number; uploads: number; repositories: number }

/**
 * Delete ended jobs older than `LIMITS.jobRecordRetentionDays`, with their events,
 * admissions, checkpoints, purged publications, artifact and upload rows, and repositories
 * no longer referenced, unless taken down (ADR-078). Runs the schema-owned function that
 * enforces the conditions; the caller cannot widen them. Bounded per call.
 */
export async function forgetEndedJobs(pool: Pool, batch = 100): Promise<ForgottenRecords> {
  const row = (await pool.query<Record<string, number>>('SELECT * FROM atlas_forget_ended_jobs($1)', [batch])).rows[0]!;
  return {
    jobs: row['forgotten_jobs']!,
    publications: row['forgotten_publications']!,
    objects: row['forgotten_objects']!,
    uploads: row['forgotten_uploads']!,
    repositories: row['forgotten_repositories']!,
  };
}

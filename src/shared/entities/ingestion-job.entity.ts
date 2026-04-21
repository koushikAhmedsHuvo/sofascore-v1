import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

/** Lifecycle for a single ingestion run row. `RUNNING` should always end in SUCCESS or FAILED. */
export enum IngestionJobStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  SUCCESS = 'success',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

/**
 * Audit log for every cron/backfill ingestion run.
 * Essential for monitoring lag, error rate, and data freshness SLAs.
 */
@Entity({ name: 'ingestion_jobs' })
@Index(['jobType', 'status'])
@Index(['scheduledAt'])
export class IngestionJob extends BaseEntity {
  /** e.g. "scheduled-events", "team-events", "h2h", "metadata-team" */
  @Column({ name: 'job_type', type: 'varchar', length: 128 })
  jobType: string;

  /** Context params serialized as JSON (tournamentId, date, teamId, etc.) */
  @Column({ name: 'params', type: 'jsonb', nullable: true })
  params: Record<string, unknown> | null;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 32,
    default: IngestionJobStatus.PENDING,
  })
  status: IngestionJobStatus;

  @Column({ name: 'scheduled_at', type: 'timestamptz' })
  scheduledAt: Date;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  /** Milliseconds elapsed for this job run. */
  @Column({ name: 'duration_ms', type: 'integer', nullable: true })
  durationMs: number | null;

  /** Number of paths fetched in this run. */
  @Column({ name: 'paths_fetched', type: 'integer', default: 0 })
  pathsFetched: number;

  /** Number of snapshots upserted / written. */
  @Column({ name: 'rows_upserted', type: 'integer', default: 0 })
  rowsUpserted: number;

  /** Provider call error counts. */
  @Column({ name: 'error_count', type: 'integer', default: 0 })
  errorCount: number;

  /** Serialized error details for debugging. */
  @Column({ name: 'error_details', type: 'jsonb', nullable: true })
  errorDetails: Record<string, unknown>[] | null;
}

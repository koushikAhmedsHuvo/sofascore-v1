import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  IngestionJob,
  IngestionJobStatus,
} from '../../shared/entities/ingestion-job.entity';

/**
 * Tracks and persists audit records for all ingestion runs (`ingestion_jobs`).
 * Used for ops dashboards, alerting, and post-mortems — does not expose data
 * to end users; keep DB access restricted in production.
 */
@Injectable()
export class IngestionJobTrackerService implements OnApplicationBootstrap {
  private readonly logger = new Logger(IngestionJobTrackerService.name);

  constructor(
    @InjectRepository(IngestionJob)
    private readonly jobRepo: Repository<IngestionJob>,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const shouldMarkStale =
      this.configService.get<boolean>(
        'ingestion.markRunningJobsStaleOnStartup',
      ) ?? true;

    if (!shouldMarkStale) return;

    const markedCount = await this.markRunningJobsStale(
      'Marked stale on startup because the previous process stopped while this job was RUNNING.',
    );
    if (markedCount > 0) {
      this.logger.warn(
        `Marked ${markedCount} stale RUNNING ingestion job(s) as FAILED on startup`,
      );
    }
  }

  async markRunningJobsStale(reason: string): Promise<number> {
    const staleJobs = await this.jobRepo.find({
      where: { status: IngestionJobStatus.RUNNING },
    });
    if (!staleJobs.length) return 0;

    const now = new Date();
    for (const job of staleJobs) {
      job.status = IngestionJobStatus.FAILED;
      job.finishedAt = now;
      job.durationMs =
        now.getTime() - (job.startedAt?.getTime() ?? job.scheduledAt.getTime());
      job.errorCount = Math.max(job.errorCount, 1);
      job.errorDetails = [
        ...(job.errorDetails ?? []),
        {
          message: reason,
          stale: true,
          markedAt: now.toISOString(),
        },
      ];
    }

    await this.jobRepo.save(staleJobs);
    return staleJobs.length;
  }

  /** Creates a RUNNING row; caller must `finishJob` or `failJob`. */
  async startJob(
    jobType: string,
    params: Record<string, unknown>,
  ): Promise<IngestionJob> {
    const job = this.jobRepo.create({
      jobType,
      params,
      status: IngestionJobStatus.RUNNING,
      scheduledAt: new Date(),
      startedAt: new Date(),
    });
    return this.jobRepo.save(job);
  }

  /**
   * Marks SUCCESS unless every path failed (`pathsFetched === 0` and `errorCount > 0`),
   * in which case FAILED — partial success still counts as SUCCESS.
   */
  async finishJob(
    job: IngestionJob,
    results: {
      pathsFetched: number;
      rowsUpserted: number;
      errorCount: number;
      errorDetails?: Record<string, unknown>[];
    },
  ): Promise<void> {
    const now = new Date();
    job.finishedAt = now;
    job.durationMs = now.getTime() - (job.startedAt?.getTime() ?? now.getTime());
    job.status =
      results.errorCount > 0 && results.pathsFetched === 0
        ? IngestionJobStatus.FAILED
        : IngestionJobStatus.SUCCESS;
    job.pathsFetched = results.pathsFetched;
    job.rowsUpserted = results.rowsUpserted;
    job.errorCount = results.errorCount;
    job.errorDetails = results.errorDetails ?? null;
    await this.jobRepo.save(job);

    this.logger.log(
      `Job [${job.jobType}] ${job.status}: fetched=${results.pathsFetched}, upserted=${results.rowsUpserted}, errors=${results.errorCount}, duration=${job.durationMs}ms`,
    );
  }

  /** Terminal FAILED state with a single aggregated error payload. */
  async failJob(job: IngestionJob, error: Error): Promise<void> {
    const now = new Date();
    job.finishedAt = now;
    job.durationMs = now.getTime() - (job.startedAt?.getTime() ?? now.getTime());
    job.status = IngestionJobStatus.FAILED;
    job.errorCount = 1;
    job.errorDetails = [{ message: error.message, stack: error.stack }];
    await this.jobRepo.save(job);

    this.logger.error(`Job [${job.jobType}] FAILED: ${error.message}`, error.stack);
  }

  /**
   * Newest-first audit rows for `/internal/ingestion/jobs`. `scheduledAt` is the
   * job enqueue time (same as start for our usage — we set both in `startJob`).
   */
  async getRecentJobs(limit = 50, jobType?: string): Promise<IngestionJob[]> {
    return this.jobRepo.find({
      where: jobType ? { jobType } : undefined,
      order: { scheduledAt: 'DESC' },
      take: limit,
    });
  }

  /** Persists counters for a RUNNING job so ops APIs show live progress. */
  async updateJobProgress(
    job: IngestionJob,
    results: {
      pathsFetched: number;
      rowsUpserted: number;
      errorCount: number;
      errorDetails?: Record<string, unknown>[];
    },
  ): Promise<void> {
    const now = new Date();
    job.durationMs = now.getTime() - (job.startedAt?.getTime() ?? now.getTime());
    job.pathsFetched = results.pathsFetched;
    job.rowsUpserted = results.rowsUpserted;
    job.errorCount = results.errorCount;
    job.errorDetails = results.errorDetails?.length
      ? results.errorDetails
      : null;
    await this.jobRepo.save(job);

    this.logger.log(
      `Job [${job.jobType}] progress: fetched=${results.pathsFetched}, upserted=${results.rowsUpserted}, errors=${results.errorCount}, duration=${job.durationMs}ms`,
    );
  }

  /**
   * Aggregate counts for dashboards. `last24h` uses `scheduled_at >= now-24h`
   * (rolling window, not calendar day).
   */
  async getJobStats(): Promise<{
    total: number;
    success: number;
    failed: number;
    running: number;
    last24h: number;
  }> {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [total, success, failed, running, last24h] = await Promise.all([
      this.jobRepo.count(),
      this.jobRepo.count({ where: { status: IngestionJobStatus.SUCCESS } }),
      this.jobRepo.count({ where: { status: IngestionJobStatus.FAILED } }),
      this.jobRepo.count({ where: { status: IngestionJobStatus.RUNNING } }),
      this.jobRepo
        .createQueryBuilder('j')
        .where('j.scheduled_at >= :since', { since: oneDayAgo })
        .getCount(),
    ]);

    return { total, success, failed, running, last24h };
  }
}

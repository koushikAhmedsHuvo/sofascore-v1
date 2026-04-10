import { Injectable, Logger } from '@nestjs/common';
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
export class IngestionJobTrackerService {
  private readonly logger = new Logger(IngestionJobTrackerService.name);

  constructor(
    @InjectRepository(IngestionJob)
    private readonly jobRepo: Repository<IngestionJob>,
  ) {}

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
  async getRecentJobs(limit = 50): Promise<IngestionJob[]> {
    return this.jobRepo.find({
      order: { scheduledAt: 'DESC' },
      take: limit,
    });
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

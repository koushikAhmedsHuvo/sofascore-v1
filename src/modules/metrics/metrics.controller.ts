import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SnapshotService } from '../snapshot/snapshot.service';
import { IngestionJobTrackerService } from '../ingestion/ingestion-job-tracker.service';
import { OperationalMetricsResponseDto } from '../../common/dto';

/**
 * Operational metrics for dashboards and alerting:
 * - Snapshot row counts and staleness
 * - Ingestion job success / failure rates
 */
@ApiTags('Health & Observability')
@Controller('internal/metrics')
export class MetricsController {
  constructor(
    private readonly snapshotService: SnapshotService,
    private readonly jobTracker: IngestionJobTrackerService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Operational metrics snapshot',
    description:
      'Aggregated counts from `raw_snapshots` and `ingestion_jobs`. ' +
      'Intended for Grafana / internal ops dashboards — protect at nginx.',
  })
  @ApiOkResponse({ type: OperationalMetricsResponseDto })
  async getMetrics(): Promise<OperationalMetricsResponseDto> {
    const [totalSnapshots, countByType, expiredByType, jobStats] =
      await Promise.all([
        this.snapshotService.getTotalCount(),
        this.snapshotService.getCountByType(),
        this.snapshotService.getExpiredCount(),
        this.jobTracker.getJobStats(),
      ]);

    return {
      timestamp: new Date().toISOString(),
      snapshots: {
        total: totalSnapshots,
        byType: countByType,
        expired: expiredByType,
      },
      ingestionJobs: jobStats,
    };
  }
}

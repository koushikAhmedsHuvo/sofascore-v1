import { ApiProperty } from '@nestjs/swagger';
import { IngestionJobDto } from './ingestion-job.dto';

/** POST .../event/:eventId/bundle */
export class EventBundleTriggerResponseDto {
  @ApiProperty({ example: 'Match bundle triggered for event 13981730' })
  message: string;

  @ApiProperty({
    description: 'Relative API paths fetched for this bundle (SofaScore-compatible suffixes).',
    example: ['event/13981730', 'event/13981730/incidents', 'event/13981730/statistics'],
    type: [String],
  })
  paths: string[];
}

/** Wrapper for GET /internal/ingestion/jobs */
export class IngestionJobsListResponseDto {
  @ApiProperty({ type: [IngestionJobDto], description: 'Recent jobs (newest first).' })
  jobs: IngestionJobDto[];
}

/** GET /internal/ingestion/jobs/stats */
export class IngestionJobStatsResponseDto {
  @ApiProperty({ example: 1240 })
  total: number;

  @ApiProperty({ example: 1180 })
  success: number;

  @ApiProperty({ example: 12 })
  failed: number;

  @ApiProperty({ example: 2 })
  running: number;

  @ApiProperty({
    example: 48,
    description: 'Jobs scheduled in the last 24 hours.',
  })
  last24h: number;
}

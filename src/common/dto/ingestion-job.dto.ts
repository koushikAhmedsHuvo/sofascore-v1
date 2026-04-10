import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One row from the ingestion_jobs audit table.
 * Returned inside GET /internal/ingestion/jobs.
 */
export class IngestionJobDto {
  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  id: string;

  @ApiProperty({ example: 'scheduled-events' })
  jobType: string;

  @ApiPropertyOptional({
    example: { tournamentId: 23, date: '2026-04-04' },
    description: 'Job context (tournament id, date range, etc.).',
  })
  params: Record<string, unknown> | null;

  @ApiProperty({ enum: ['pending', 'running', 'success', 'failed', 'skipped'] })
  status: string;

  @ApiProperty({ example: '2026-04-04T12:00:00.000Z' })
  scheduledAt: Date;

  @ApiPropertyOptional({ example: '2026-04-04T12:00:01.000Z' })
  startedAt: Date | null;

  @ApiPropertyOptional({ example: '2026-04-04T12:05:00.000Z' })
  finishedAt: Date | null;

  @ApiPropertyOptional({ example: 299000 })
  durationMs: number | null;

  @ApiProperty({ example: 420 })
  pathsFetched: number;

  @ApiProperty({ example: 418 })
  rowsUpserted: number;

  @ApiProperty({ example: 0 })
  errorCount: number;

  @ApiPropertyOptional({
    description: 'Per-path error payloads when errorCount > 0.',
  })
  errorDetails: Record<string, unknown>[] | null;
}

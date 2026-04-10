import { ApiProperty } from '@nestjs/swagger';

class SnapshotMetricsBlockDto {
  @ApiProperty({ example: 1_250_000 })
  total: number;

  @ApiProperty({
    example: { LIVE: 1200, METADATA: 800000 },
    description: 'Counts keyed by endpoint volatility bucket.',
  })
  byType: Record<string, number>;

  @ApiProperty({
    example: { LIVE: 5 },
    description: 'Expired-but-not-yet-purged rows per type.',
  })
  expired: Record<string, number>;
}

class IngestionJobStatsBlockDto {
  @ApiProperty({ example: 5000 })
  total: number;

  @ApiProperty({ example: 4800 })
  success: number;

  @ApiProperty({ example: 50 })
  failed: number;

  @ApiProperty({ example: 2 })
  running: number;

  @ApiProperty({ example: 120 })
  last24h: number;
}

/** GET /internal/metrics */
export class OperationalMetricsResponseDto {
  @ApiProperty({ example: '2026-04-04T12:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ type: SnapshotMetricsBlockDto })
  snapshots: SnapshotMetricsBlockDto;

  @ApiProperty({ type: IngestionJobStatsBlockDto })
  ingestionJobs: IngestionJobStatsBlockDto;
}

/**
 * Internal metrics aggregation for ops dashboards. Pulls snapshot stats and job
 * stats; protect `/internal/metrics` at the edge in production.
 */
import { Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { SnapshotModule } from '../snapshot/snapshot.module';
import { IngestionModule } from '../ingestion/ingestion.module';

@Module({
  imports: [SnapshotModule, IngestionModule],
  controllers: [MetricsController],
})
export class MetricsModule {}

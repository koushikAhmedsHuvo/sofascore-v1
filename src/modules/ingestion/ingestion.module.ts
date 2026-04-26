/**
 * Scheduled and on-demand ingestion: crons, ops controller, job audit persistence.
 * `CountryRegistryModule` / `TournamentRegistryModule` are global — injected into
 * `IngestionService` without a direct import here.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IngestionService } from './ingestion.service';
import { IngestionCron } from './ingestion.cron';
import { IngestionController } from './ingestion.controller';
import { IngestionJobTrackerService } from './ingestion-job-tracker.service';
import { IngestionJob } from '../../shared/entities/ingestion-job.entity';
import { SofaEvent } from '../../shared/entities/sofa-event.entity';
import { SofaTournamentEntity } from '../../shared/entities/sofa-tournament.entity';
import { SnapshotModule } from '../snapshot/snapshot.module';
import { NormalizeModule } from '../normalize/normalize.module';
// TournamentRegistryModule is @Global — no explicit import needed here,
// but kept for clarity if IngestionModule is ever used standalone.

@Module({
  imports: [
    TypeOrmModule.forFeature([IngestionJob, SofaEvent, SofaTournamentEntity]),
    SnapshotModule,
    NormalizeModule,
  ],
  providers: [
    IngestionService,
    IngestionCron,
    IngestionJobTrackerService,
  ],
  controllers: [IngestionController],
  exports: [IngestionService, IngestionJobTrackerService],
})
export class IngestionModule {}

/**
 * Maps raw SofaScore JSON into normalized `sofa_*` tables. Used by ingestion
 * pipelines only — not by the public proxy path.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NormalizeService } from './normalize.service';
import { SofaEvent } from '../../shared/entities/sofa-event.entity';
import { SofaTeamEntity } from '../../shared/entities/sofa-team.entity';
import { SofaTournamentEntity } from '../../shared/entities/sofa-tournament.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SofaEvent, SofaTeamEntity, SofaTournamentEntity]),
  ],
  providers: [NormalizeService],
  exports: [NormalizeService],
})
export class NormalizeModule {}

/** Global module: dynamic country-code registry + admin HTTP API. */
import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SofaCountryEntity } from '../../shared/entities/sofa-country.entity';
import { CountryRegistryService } from './country-registry.service';
import { CountryRegistryController } from './country-registry.controller';
import { SnapshotModule } from '../snapshot/snapshot.module';

/**
 * @Global — inject CountryRegistryService anywhere without re-importing.
 *
 * Boot order: CountryRegistryModule must be imported BEFORE
 * TournamentRegistryModule (which uses country codes for priority assignment).
 * In app.module.ts, list this module first.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([SofaCountryEntity]),
    SnapshotModule,
  ],
  providers: [CountryRegistryService],
  controllers: [CountryRegistryController],
  exports: [CountryRegistryService],
})
export class CountryRegistryModule {}

/** Global module: dynamic tournament-id registry + admin HTTP API. */
import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { SofaTournamentEntity } from "../../shared/entities/sofa-tournament.entity";
import { SofaSportEntity } from "../../shared/entities/sofa-sport.entity";
import { TournamentRegistryService } from "./tournament-registry.service";
import { TournamentRegistryController } from "./tournament-registry.controller";
import { SnapshotModule } from "../snapshot/snapshot.module";
import { CountryRegistryModule } from "./country-registry.module";

/**
 * @Global — inject TournamentRegistryService anywhere without re-importing.
 *
 * Depends on:
 *   - SnapshotModule: ProviderClientService (HTTP to provider)
 *   - CountryRegistryModule: CountryRegistryService (dynamic country codes)
 *
 * Boot order: CountryRegistryModule must already be initialized before
 * TournamentRegistryModule so that country codes are available when
 * `applyPriorityFromDefaults` runs. Both are OnApplicationBootstrap, and
 * Nest guarantees imports are initialized before the importing module.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([SofaTournamentEntity, SofaSportEntity]),
    SnapshotModule,
    CountryRegistryModule,
  ],
  providers: [TournamentRegistryService],
  controllers: [TournamentRegistryController],
  exports: [TournamentRegistryService],
})
export class TournamentRegistryModule {}

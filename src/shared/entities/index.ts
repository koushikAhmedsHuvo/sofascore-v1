/**
 * Barrel export for TypeORM entities and shared enums used in `DatabaseModule`,
 * `forFeature()` imports, and the migration CLI (`data-source.ts`).
 * When adding a new table, register the entity here and in `database.module.ts`.
 */
export { BaseEntity } from "./base.entity";
export { RawSnapshot } from "./raw-snapshot.entity";
export { SofaTournamentEntity } from "./sofa-tournament.entity";
export { SofaTeamEntity } from "./sofa-team.entity";
export { SofaEvent } from "./sofa-event.entity";
export { IngestionJob, IngestionJobStatus } from "./ingestion-job.entity";
export { SofaCountryEntity } from "./sofa-country.entity";
export { SofaSportEntity } from "./sofa-sport.entity";

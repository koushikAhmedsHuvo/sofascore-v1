import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `sofa_sports` table — one row per sport slug (football,
 * basketball, cricket, tennis, …) actively tracked by the ingestion engine.
 *
 * Populated by TournamentRegistryService.discoverAndRefresh() whenever it
 * iterates over SOFA_ACTIVE_SPORTS and successfully discovers tournaments
 * from the provider's `sport/{slug}/categories/all` endpoint.
 */
export class SofaSportsTable1776752204651 implements MigrationInterface {
  name = 'SofaSportsTable1776752204651';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sofa_sports" (
        "id"                  uuid          NOT NULL DEFAULT gen_random_uuid(),
        "slug"                varchar(64)   NOT NULL,
        "is_active"           boolean       NOT NULL DEFAULT true,
        "tournament_count"    integer       NOT NULL DEFAULT 0,
        "last_discovered_at"  timestamptz,
        "created_at"          timestamptz   NOT NULL DEFAULT now(),
        "updated_at"          timestamptz   NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sofa_sports" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_sofa_sports_slug"
        ON "sofa_sports" ("slug");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_sofa_sports_slug";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sofa_sports";`);
  }
}

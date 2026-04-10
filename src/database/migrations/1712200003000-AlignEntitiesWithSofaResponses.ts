import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Aligns normalized tables with SofaScore `event` / `team` / `tournament` JSON
 * shapes captured in `Sofascore api documentation/` (cricket, NFL, etc.).
 *
 * Adds queryable columns that appear in API responses; full objects remain in
 * `raw_payload` / `raw_meta`.
 */
export class AlignEntitiesWithSofaResponses1712200003000 implements MigrationInterface {
  name = 'AlignEntitiesWithSofaResponses1712200003000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sofa_events"
        ADD COLUMN IF NOT EXISTS "custom_id" VARCHAR(64),
        ADD COLUMN IF NOT EXISTS "status_description" VARCHAR(256),
        ADD COLUMN IF NOT EXISTS "round_name" VARCHAR(256),
        ADD COLUMN IF NOT EXISTS "season_year" VARCHAR(16),
        ADD COLUMN IF NOT EXISTS "end_timestamp" BIGINT,
        ADD COLUMN IF NOT EXISTS "venue" JSONB,
        ADD COLUMN IF NOT EXISTS "competition_sofa_id" INTEGER;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sofa_events_competition_sofa_id"
        ON "sofa_events" ("competition_sofa_id")
        WHERE "competition_sofa_id" IS NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE "sofa_teams"
        ADD COLUMN IF NOT EXISTS "full_name" VARCHAR(512),
        ADD COLUMN IF NOT EXISTS "user_count" INTEGER,
        ADD COLUMN IF NOT EXISTS "team_type" SMALLINT,
        ADD COLUMN IF NOT EXISTS "team_class" SMALLINT,
        ADD COLUMN IF NOT EXISTS "text_color" VARCHAR(16);
    `);

    await queryRunner.query(`
      ALTER TABLE "sofa_tournaments"
        ADD COLUMN IF NOT EXISTS "category_slug" VARCHAR(256),
        ADD COLUMN IF NOT EXISTS "user_count" INTEGER;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_sofa_events_competition_sofa_id";
    `);

    await queryRunner.query(`
      ALTER TABLE "sofa_events"
        DROP COLUMN IF EXISTS "custom_id",
        DROP COLUMN IF EXISTS "status_description",
        DROP COLUMN IF EXISTS "round_name",
        DROP COLUMN IF EXISTS "season_year",
        DROP COLUMN IF EXISTS "end_timestamp",
        DROP COLUMN IF EXISTS "venue",
        DROP COLUMN IF EXISTS "competition_sofa_id";
    `);

    await queryRunner.query(`
      ALTER TABLE "sofa_teams"
        DROP COLUMN IF EXISTS "full_name",
        DROP COLUMN IF EXISTS "user_count",
        DROP COLUMN IF EXISTS "team_type",
        DROP COLUMN IF EXISTS "team_class",
        DROP COLUMN IF EXISTS "text_color";
    `);

    await queryRunner.query(`
      ALTER TABLE "sofa_tournaments"
        DROP COLUMN IF EXISTS "category_slug",
        DROP COLUMN IF EXISTS "user_count";
    `);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds discovery-driven columns to sofa_tournaments so tournament IDs are
 * managed dynamically from the SofaScore categories API, never hardcoded.
 */
export class TournamentRegistry1712200001000 implements MigrationInterface {
  name = 'TournamentRegistry1712200001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sofa_tournaments"
        ADD COLUMN IF NOT EXISTS "is_active"         BOOLEAN     NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "priority"           INTEGER     NOT NULL DEFAULT 999,
        ADD COLUMN IF NOT EXISTS "last_refreshed_at" TIMESTAMPTZ;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sofa_tournaments_active_priority"
        ON "sofa_tournaments" ("is_active", "priority")
        WHERE "is_active" = true;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sofa_tournaments"
        DROP COLUMN IF EXISTS "is_active",
        DROP COLUMN IF EXISTS "priority",
        DROP COLUMN IF EXISTS "last_refreshed_at";
    `);
  }
}

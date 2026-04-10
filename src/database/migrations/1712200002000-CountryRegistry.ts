import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates `sofa_countries` for CountryRegistryService: dynamic ISO2 list with
 * priority — no hardcoded country codes in application code.
 */
export class CountryRegistry1712200002000 implements MigrationInterface {
  name = 'CountryRegistry1712200002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sofa_countries" (
        "alpha2"            VARCHAR(2)   NOT NULL,
        "priority"          INTEGER      NOT NULL DEFAULT 999,
        "is_active"         BOOLEAN      NOT NULL DEFAULT true,
        "last_refreshed_at" TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sofa_countries" PRIMARY KEY ("alpha2")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sofa_countries_active_priority"
        ON "sofa_countries" ("is_active", "priority")
        WHERE "is_active" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sofa_countries"`);
  }
}

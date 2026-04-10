import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema migration for the sofascore-nest-api.
 *
 * Creates:
 *   - raw_snapshots      — verbatim JSON store (two-layer cache)
 *   - sofa_tournaments   — normalized tournament metadata
 *   - sofa_teams         — normalized team metadata
 *   - sofa_events        — normalized match events
 *   - ingestion_jobs     — cron/backfill audit log
 */
export class InitialSchema1712200000000 implements MigrationInterface {
  name = 'InitialSchema1712200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── raw_snapshots ──────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "raw_snapshots" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "path_key"        VARCHAR(512) NOT NULL,
        "params_hash"     VARCHAR(64)  NOT NULL DEFAULT '',
        "payload"         JSONB        NOT NULL,
        "sport"           VARCHAR(64)  NOT NULL DEFAULT 'football',
        "endpoint_type"   VARCHAR(32)  NOT NULL DEFAULT 'historical',
        "fetched_at"      TIMESTAMPTZ  NOT NULL,
        "expires_at"      TIMESTAMPTZ,
        "provider_status" SMALLINT,
        "hit_count"       INTEGER      NOT NULL DEFAULT 0,
        "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_raw_snapshots_path_params" UNIQUE ("path_key", "params_hash")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_raw_snapshots_endpoint_expires"
        ON "raw_snapshots" ("endpoint_type", "expires_at");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_raw_snapshots_sport_type"
        ON "raw_snapshots" ("sport", "endpoint_type");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_raw_snapshots_expires_at"
        ON "raw_snapshots" ("expires_at")
        WHERE "expires_at" IS NOT NULL;
    `);

    // ─── sofa_tournaments ───────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sofa_tournaments" (
        "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "sofa_id"             INTEGER      NOT NULL,
        "name"                VARCHAR(256) NOT NULL,
        "slug"                VARCHAR(256),
        "sport"               VARCHAR(64)  NOT NULL DEFAULT 'football',
        "category_name"       VARCHAR(256),
        "category_id"         INTEGER,
        "country_alpha2"      VARCHAR(4),
        "primary_color_hex"   VARCHAR(16),
        "secondary_color_hex" VARCHAR(16),
        "raw_meta"            JSONB,
        "created_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_sofa_tournaments_sofa_id" UNIQUE ("sofa_id")
      );
    `);

    // ─── sofa_teams ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sofa_teams" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "sofa_id"         INTEGER      NOT NULL,
        "name"            VARCHAR(256) NOT NULL,
        "slug"            VARCHAR(256),
        "short_name"      VARCHAR(64),
        "name_code"       VARCHAR(8),
        "sport"           VARCHAR(64)  NOT NULL DEFAULT 'football',
        "country_alpha2"  VARCHAR(4),
        "gender"          VARCHAR(16),
        "primary_color"   VARCHAR(16),
        "secondary_color" VARCHAR(16),
        "raw_meta"        JSONB,
        "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_sofa_teams_sofa_id" UNIQUE ("sofa_id")
      );
    `);

    // ─── sofa_events ────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sofa_events" (
        "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "sofa_id"            INTEGER      NOT NULL,
        "slug"               VARCHAR(256),
        "sport"              VARCHAR(64)  NOT NULL DEFAULT 'football',
        "home_team_sofa_id"  INTEGER      NOT NULL,
        "away_team_sofa_id"  INTEGER      NOT NULL,
        "tournament_sofa_id" INTEGER,
        "season_id"          INTEGER,
        "season_name"        VARCHAR(128),
        "round"              SMALLINT,
        "start_timestamp"    BIGINT       NOT NULL,
        "status_type"        VARCHAR(32)  NOT NULL DEFAULT 'notstarted',
        "status_code"        SMALLINT,
        "winner_code"        SMALLINT,
        "home_score"         JSONB,
        "away_score"         JSONB,
        "raw_payload"        JSONB        NOT NULL,
        "tournament_id"      UUID REFERENCES "sofa_tournaments"("id") ON DELETE SET NULL,
        "home_team_id"       UUID REFERENCES "sofa_teams"("id") ON DELETE SET NULL,
        "away_team_id"       UUID REFERENCES "sofa_teams"("id") ON DELETE SET NULL,
        "created_at"         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_sofa_events_sofa_id" UNIQUE ("sofa_id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sofa_events_teams_time"
        ON "sofa_events" ("home_team_sofa_id", "away_team_sofa_id", "start_timestamp");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sofa_events_tournament_time"
        ON "sofa_events" ("tournament_sofa_id", "start_timestamp");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sofa_events_status_time"
        ON "sofa_events" ("status_type", "start_timestamp");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sofa_events_start_timestamp"
        ON "sofa_events" ("start_timestamp");
    `);

    // ─── ingestion_jobs ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ingestion_jobs" (
        "id"            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "job_type"      VARCHAR(128) NOT NULL,
        "params"        JSONB,
        "status"        VARCHAR(32)  NOT NULL DEFAULT 'pending',
        "scheduled_at"  TIMESTAMPTZ  NOT NULL,
        "started_at"    TIMESTAMPTZ,
        "finished_at"   TIMESTAMPTZ,
        "duration_ms"   INTEGER,
        "paths_fetched" INTEGER      NOT NULL DEFAULT 0,
        "rows_upserted" INTEGER      NOT NULL DEFAULT 0,
        "error_count"   INTEGER      NOT NULL DEFAULT 0,
        "error_details" JSONB,
        "created_at"    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        "updated_at"    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ingestion_jobs_type_status"
        ON "ingestion_jobs" ("job_type", "status");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_ingestion_jobs_scheduled_at"
        ON "ingestion_jobs" ("scheduled_at");
    `);

    // ─── Trigger: auto-update updated_at ────────────────────────────────────
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ language 'plpgsql';
    `);

    for (const table of [
      'raw_snapshots',
      'sofa_tournaments',
      'sofa_teams',
      'sofa_events',
      'ingestion_jobs',
    ]) {
      await queryRunner.query(`
        CREATE TRIGGER update_${table}_updated_at
          BEFORE UPDATE ON "${table}"
          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'ingestion_jobs',
      'sofa_events',
      'sofa_teams',
      'sofa_tournaments',
      'raw_snapshots',
    ]) {
      await queryRunner.query(
        `DROP TABLE IF EXISTS "${table}" CASCADE;`,
      );
    }
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS update_updated_at_column CASCADE;`,
    );
  }
}

import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds indexes that become critical once the system ingests multiple sports.
 *
 * Changes:
 *
 * 1. `sofa_events (sport, status_type, start_timestamp)` — as the table grows to
 *    cover football, basketball, cricket, and tennis events, queries for live
 *    events by sport (or future sport-scoped admin endpoints) would otherwise
 *    perform a full-sport sequential scan.  The existing `(status_type,
 *    start_timestamp)` index is still kept for cross-sport queries.
 *
 * 2. `sofa_tournaments (sport, priority) WHERE is_active = true` — complements
 *    the existing `(is_active, priority) WHERE is_active = true` partial index
 *    with a sport-leading column.  When the registry adds sport-scoped DB
 *    queries (e.g. `WHERE sport = ? AND is_active = true ORDER BY priority`),
 *    this index serves them without a full active-tournament scan.
 *
 * No existing indexes are dropped; both new indexes are additive.
 */
export class MultiSportIndexes1776616178690 implements MigrationInterface {
  name = "MultiSportIndexes1776616178690";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Composite index for per-sport live/status queries on the events table.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sofa_events_sport_status_time"
        ON "sofa_events" ("sport", "status_type", "start_timestamp");
    `);

    // Sport-aware partial index for the tournament registry.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_sofa_tournaments_sport_priority_active"
        ON "sofa_tournaments" ("sport", "priority")
        WHERE "is_active" = true;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_sofa_events_sport_status_time";
    `);

    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_sofa_tournaments_sport_priority_active";
    `);
  }
}

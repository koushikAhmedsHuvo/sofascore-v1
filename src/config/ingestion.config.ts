import { registerAs } from '@nestjs/config';

/**
 * Ingestion runtime tunables.
 *
 * **No tournament IDs here.**
 * Active tournament IDs are discovered dynamically from the SofaScore
 * categories API by TournamentRegistryService on every startup and nightly
 * refresh. There is nothing to seed in env files.
 */
export const ingestionConfig = registerAs('ingestion', () => ({
  /** Milliseconds to wait between consecutive provider HTTP calls. */
  requestDelayMs: parseInt(process.env.INGESTION_REQUEST_DELAY_MS ?? '500', 10),

  /** Max concurrent provider calls (reserved — serial execution used today). */
  concurrency: parseInt(process.env.INGESTION_CONCURRENCY ?? '3', 10),

  /** How many calendar days back the historical backfill job should reach. */
  backfillDaysBack: parseInt(process.env.BACKFILL_DAYS_BACK ?? '365', 10),

  /**
   * TTL per endpoint volatility class (seconds). **`0` = `expires_at` NULL**
   * (row never ages out; see SnapshotService / deleteExpired).
   *
   * **Historical archive:** `historical`, `metadata`, `immutable` default to **0**
   * (`expires_at` never set — treat as stable). **`recent`** defaults to **3600**
   * so `event/{id}/…` and odds paths can re-fetch while the match is upcoming /
   * live-adjacent. Expired rows are **not** bulk-deleted: cleanup only removes
   * **`live`** snapshots (see `SnapshotService.deleteExpired`).
   *
   * **Cache tuning:** shorten `scheduled` / `recent` for fresher provider traffic;
   * lengthen or set to `0` to reduce refetches (at the cost of staler JSON until
   * the next upsert from another code path).
   */
  ttl: {
    live: parseInt(process.env.TTL_LIVE_S ?? '30', 10),
    scheduled: parseInt(process.env.TTL_SCHEDULED_S ?? '300', 10),
    recent: parseInt(process.env.TTL_RECENT_S ?? '3600', 10),
    historical: parseInt(process.env.TTL_HISTORICAL_S ?? '0', 10),
    metadata: parseInt(process.env.TTL_METADATA_S ?? '0', 10),
    immutable: parseInt(process.env.TTL_IMMUTABLE_S ?? '0', 10),
  },
}));

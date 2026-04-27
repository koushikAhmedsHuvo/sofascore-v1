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
  /** Enable the broader tiered football ingestion plan. */
  enableFullFootballPlan:
    process.env.INGESTION_ENABLE_FULL_FOOTBALL_PLAN === 'true',

  /** Enable high-frequency live / near-live cron jobs. */
  enableLiveCron: process.env.INGESTION_ENABLE_LIVE_CRON === 'true',

  /** Enable any scheduled cron trigger. Default is startup-only ingestion. */
  enableScheduledCron: process.env.INGESTION_ENABLE_SCHEDULED_CRON === 'true',

  /** Run the focused ingestion flow automatically on application startup. */
  runFocusedFlowOnStartup:
    process.env.INGESTION_RUN_FOCUSED_FLOW_ON_STARTUP !== 'false',

  /** Keep legacy focused cron jobs active alongside the full-football plan. */
  enableFocusedCompatibilityJobs:
    process.env.INGESTION_ENABLE_FOCUSED_COMPATIBILITY_JOBS === 'true',

  /** Run the focused bootstrap sequence once on module startup. */
  runBootstrapOnStartup:
    process.env.INGESTION_RUN_BOOTSTRAP_ON_STARTUP === 'true',

  /**
   * Allow country/tournament registry services to auto-refresh from provider
   * during bootstrap. Default false for the current focused startup-only flow.
   */
  enableRegistryBootstrapRefresh:
    process.env.INGESTION_ENABLE_REGISTRY_BOOTSTRAP_REFRESH === 'true',

  /** Milliseconds to wait between consecutive provider HTTP calls. */
  requestDelayMs: parseInt(process.env.INGESTION_REQUEST_DELAY_MS ?? '500', 10),

  /** Max concurrent provider calls (reserved — serial execution used today). */
  concurrency: parseInt(process.env.INGESTION_CONCURRENCY ?? '3', 10),

  /**
   * After the sport-level scheduled-events feed is fetched, only this many
   * priority tournaments are used as tournament-level fallback per sport/date.
   */
  scheduledEventsFallbackLimit: parseInt(
    process.env.INGESTION_SCHEDULED_EVENTS_FALLBACK_LIMIT ?? '250',
    10,
  ),

  /** Persist RUNNING job counters after every N provider path attempts. */
  progressFlushEvery: parseInt(
    process.env.INGESTION_PROGRESS_FLUSH_EVERY ?? '50',
    10,
  ),

  /**
   * On application startup, mark leftover RUNNING jobs as failed. These rows
   * usually mean the previous process was stopped before it could finish/fail.
   */
  markRunningJobsStaleOnStartup:
    process.env.INGESTION_MARK_RUNNING_STALE_ON_STARTUP !== 'false',

  /**
   * Focused category-country discovery list for the season-graph cron.
   * Default keeps the initial football rollout scoped to the user's target markets.
   */
  focusedCategoryCountries: (process.env.INGESTION_FOCUSED_CATEGORY_COUNTRIES ??
    'spain,germany,italy,france,england')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),

  /** Only these tournaments are kept during the current focused rollout. */
  focusedTournamentNames: (process.env.INGESTION_FOCUSED_TOURNAMENTS ??
    'laliga,bundesliga,epl,seriea,ligue1,ucl,europaleague')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),

  /** Exact tournament IDs for the current focused rollout. */
  focusedTournamentIds: (process.env.INGESTION_FOCUSED_TOURNAMENT_IDS ??
    '8,35,17,23,34,7,679')
    .split(',')
    .map((value) => parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0),

  /** How many calendar days back the historical backfill job should reach. */
  backfillDaysBack: parseInt(process.env.BACKFILL_DAYS_BACK ?? '365', 10),

  /**
   * Lightweight nightly backfill window for the tiered all-football plan.
   * Keeps recent history warm without replaying the full archive every day.
   */
  nightlyBackfillDays: parseInt(
    process.env.INGESTION_NIGHTLY_BACKFILL_DAYS ?? '3',
    10,
  ),

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

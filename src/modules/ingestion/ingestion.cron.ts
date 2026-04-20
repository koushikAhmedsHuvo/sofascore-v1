import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { IngestionService } from "./ingestion.service";
import { SnapshotService } from "../snapshot/snapshot.service";

/**
 * Full SofaScore cron scheduler.
 *
 * Schedule map by frequency:
 *
 *  Every 30s   → live match incidents + statistics (for in-progress events)
 *  Every 1min  → live tournament list + live event list
 *  Every 5min  → today's scheduled events per tournament
 *  Every 10min → sport-level scheduled-tournaments (home page view)
 *  Every 30min → tomorrow's scheduled events
 *  Daily 01:30 → newly-added-events + global config refresh
 *  Daily 02:00 → cleanup expired snapshots
 *  Daily 03:00 → historical scheduled-events backfill
 *  Daily 03:30 → backfill match-detail bundle for recent finished events
 *  Daily 04:00 → tournament metadata (standings, seasons, cup trees)
 *
 * All methods guard internally — cron failures never crash the process.
 */
@Injectable()
export class IngestionCron {
  private readonly logger = new Logger(IngestionCron.name);

  constructor(
    private readonly ingestionService: IngestionService,
    private readonly snapshotService: SnapshotService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Live (high-frequency) ────────────────────────────────────────────────

  /**
   * Every 30 seconds — re-fetch incidents + statistics for in-progress events.
   * Uses the sofa_events table to identify currently live match IDs.
   */
  @Cron("*/30 * * * * *")
  async cronLiveMatchDetails(): Promise<void> {
    try {
      await this.ingestionService.refreshLiveMatchDetails();
    } catch (err) {
      this.logger.error(
        "[CRON] live-match-details failed",
        (err as Error).stack,
      );
    }
  }

  /**
   * Every 1 minute — refresh live tournament list and live event list.
   * sport/{sport}/live-tournaments  +  sport/{sport}/events/live
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async cronLiveTournaments(): Promise<void> {
    try {
      await this.ingestionService.refreshLiveTournaments();
    } catch (err) {
      this.logger.error("[CRON] live-tournaments failed", (err as Error).stack);
    }
  }

  // ─── Scheduled / Upcoming ────────────────────────────────────────────────

  /**
   * Every 5 minutes — today's scheduled events for all priority tournaments.
   * unique-tournament/{id}/scheduled-events/{today}
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async cronScheduledEventsToday(): Promise<void> {
    this.logger.log("[CRON] scheduled-events-today");
    try {
      await this.ingestionService.ingestScheduledEventsForDate(new Date());
    } catch (err) {
      this.logger.error(
        "[CRON] scheduled-events-today failed",
        (err as Error).stack,
      );
    }
  }

  /**
   * Every 10 minutes — sport-level scheduled-tournaments for today.
   * sport/{sport}/scheduled-tournaments/{date}
   * Powers the home page date-picker / tournament listing.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async cronSportScheduledTournaments(): Promise<void> {
    try {
      await this.ingestionService.ingestSportScheduledTournaments(new Date());
    } catch (err) {
      this.logger.error(
        "[CRON] sport-scheduled-tournaments failed",
        (err as Error).stack,
      );
    }
  }

  /**
   * Every 30 minutes — tomorrow's scheduled events.
   * Keeps upcoming match data warm before match day starts.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async cronScheduledEventsTomorrow(): Promise<void> {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    try {
      await this.ingestionService.ingestScheduledEventsForDate(tomorrow);
    } catch (err) {
      this.logger.error(
        "[CRON] scheduled-events-tomorrow failed",
        (err as Error).stack,
      );
    }
  }

  // ─── Daily jobs ──────────────────────────────────────────────────────────

  /**
   * Daily 01:30 UTC — newly-added-events + global config/reference data.
   * country/alpha2, config/default-unique-tournaments, odds/providers, etc.
   */
  @Cron("0 30 1 * * *")
  async cronGlobalConfig(): Promise<void> {
    this.logger.log("[CRON] global-config");
    try {
      await this.ingestionService.ingestGlobalConfig();
    } catch (err) {
      this.logger.error("[CRON] global-config failed", (err as Error).stack);
    }
  }

  /**
   * Daily 02:00 UTC — delete expired snapshots.
   * Immutable historical events (expires_at IS NULL) are never deleted.
   */
  @Cron("0 0 2 * * *")
  async cronCleanup(): Promise<void> {
    this.logger.log("[CRON] cleanup-expired-snapshots");
    try {
      const deleted = await this.snapshotService.deleteExpired();
      this.logger.log(`[CRON] cleanup deleted ${deleted} expired snapshots`);
    } catch (err) {
      this.logger.error("[CRON] cleanup failed", (err as Error).stack);
    }
  }

  /**
   * Daily 03:00 UTC — historical backfill for scheduled events.
   * Fills gaps for N days back (default 365) for all priority tournaments.
   */
  @Cron("0 0 3 * * *")
  async cronHistoricalBackfill(): Promise<void> {
    this.logger.log("[CRON] historical-backfill");
    try {
      await this.ingestionService.backfillHistoricalEvents();
    } catch (err) {
      this.logger.error(
        "[CRON] historical-backfill failed",
        (err as Error).stack,
      );
    }
  }

  /**
   * Daily 03:30 UTC — backfill match-detail bundle for recently finished events.
   * Fetches incidents, statistics, h2h, highlights for matches we have
   * in sofa_events but haven't yet ingested sub-endpoint data for.
   */
  @Cron("0 30 3 * * *")
  async cronBackfillMatchDetails(): Promise<void> {
    this.logger.log("[CRON] backfill-match-details");
    try {
      await this.ingestionService.backfillMatchDetailsForFinishedEvents(100);
    } catch (err) {
      this.logger.error(
        "[CRON] backfill-match-details failed",
        (err as Error).stack,
      );
    }
  }

  /**
   * Daily 04:00 UTC — tournament metadata bundle.
   * unique-tournament/{id}, /seasons, /standings/total, /cuptrees,
   * top-players, sport categories.
   */
  @Cron("0 0 4 * * *")
  async cronMetadata(): Promise<void> {
    this.logger.log("[CRON] metadata-tournaments");
    try {
      await this.ingestionService.ingestTournamentMetadata();
    } catch (err) {
      this.logger.error(
        "[CRON] metadata-tournaments failed",
        (err as Error).stack,
      );
    }
  }

  /**
   * Daily 10:20 UTC — pre-warm player statistics.
   *
   * Discovers player IDs from cached team roster snapshots (team/{id}/players),
   * then fetches:
   *   player/{id}/statistics          — career aggregate stats
   *   player/{id}/statistics/seasons  — list of seasons with data
   *
   * After this cron runs, `player/{playerId}/statistics` requests will be
   * served from the local DB (source: "local-db") instead of hitting the
   * external provider on every request.
   *
   * Runs AFTER metadata cron (04:00) so team roster snapshots are fresh.
   */
  @Cron("0 20 10 * * *")
  async cronPlayerStatistics(): Promise<void> {
    this.logger.log("[CRON] player-statistics");
    try {
      await this.ingestionService.ingestPlayerStatistics();
    } catch (err) {
      this.logger.error(
        "[CRON] player-statistics failed",
        (err as Error).stack,
      );
    }
  }
}

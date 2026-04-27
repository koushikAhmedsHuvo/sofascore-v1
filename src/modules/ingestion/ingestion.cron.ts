import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { IngestionService } from "./ingestion.service";

const LOCAL_CRON_TIMEZONE = "Asia/Dhaka";

@Injectable()
export class IngestionCron implements OnApplicationBootstrap {
  private readonly logger = new Logger(IngestionCron.name);
  private bootstrapStarted = false;

  constructor(
    private readonly ingestionService: IngestionService,
    private readonly configService: ConfigService,
  ) {}

  private get liveCronEnabled(): boolean {
    return this.configService.get<boolean>("ingestion.enableLiveCron") ?? false;
  }

  private get fullFootballPlanEnabled(): boolean {
    return (
      this.configService.get<boolean>("ingestion.enableFullFootballPlan") ??
      false
    );
  }

  private get focusedCompatibilityJobsEnabled(): boolean {
    return (
      this.configService.get<boolean>(
        "ingestion.enableFocusedCompatibilityJobs",
      ) ?? false
    );
  }

  private get scheduledCronEnabled(): boolean {
    return (
      this.configService.get<boolean>("ingestion.enableScheduledCron") ?? false
    );
  }

  private get nightlyBackfillDays(): number {
    return (
      this.configService.get<number>("ingestion.nightlyBackfillDays") ?? 3
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    const shouldBootstrap =
      this.configService.get<boolean>("ingestion.runBootstrapOnStartup") ??
      false;

    if (!shouldBootstrap) return;
    if (this.bootstrapStarted) return;
    this.bootstrapStarted = true;

    // Let HTTP startup finish first so the app becomes reachable immediately.
    setTimeout(() => {
      void this.runBootstrapSequence();
    }, 0);
  }

  private async runBootstrapSequence(): Promise<void> {
    if (this.fullFootballPlanEnabled) {
      this.logger.log(
        "Bootstrap mode detected - starting full-football cold start sequence",
      );

      try {
        await this.ingestionService.runFullFootballBootstrap();
        this.logger.log("Full-football bootstrap complete - normal schedule active");
      } catch (err) {
        this.logger.error("Full-football bootstrap failed", (err as Error).stack);
      }
      return;
    }

    this.logger.log("Bootstrap mode detected - starting cold start sequence");

    try {
      this.logger.log("Bootstrap step 1/3: weekly teams");
      await this.ingestionService.ingestFocusedWeeklyTeams();

      this.logger.log("Bootstrap step 2/3: matchday players");
      await this.ingestionService.ingestFocusedMatchdayPlayers();

      this.logger.log("Bootstrap step 3/3: bootstrap events (+/-7 days)");
      await this.ingestionService.ingestFocusedBootstrapEvents();

      this.logger.log("Bootstrap complete - normal schedule active");
    } catch (err) {
      this.logger.error("Bootstrap failed", (err as Error).stack);
    }
  }

  @Cron("0 * * * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async cronLiveIndexes(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.liveCronEnabled) return;
    try {
      await this.ingestionService.refreshLiveTournaments();
    } catch (err) {
      this.logger.error("[CRON] live-indexes failed", (err as Error).stack);
    }
  }

  @Cron("*/30 * * * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async cronImportantLiveMatchDetails(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.liveCronEnabled) return;
    try {
      await this.ingestionService.refreshImportantLiveMatchDetails();
    } catch (err) {
      this.logger.error("[CRON] live-important failed", (err as Error).stack);
    }
  }

  @Cron("0 */2 * * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async cronNormalLiveMatchDetails(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.liveCronEnabled) return;
    try {
      await this.ingestionService.refreshNormalLiveMatchDetails();
    } catch (err) {
      this.logger.error("[CRON] live-normal failed", (err as Error).stack);
    }
  }

  @Cron("0 */5 * * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async cronMatchStartDetector(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.liveCronEnabled) return;
    try {
      await this.ingestionService.detectStartedMatches();
    } catch (err) {
      this.logger.error(
        "[CRON] match-start-detector failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 */10 * * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async cronUpcomingLineups(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.liveCronEnabled) return;
    try {
      await this.ingestionService.refreshUpcomingLineups();
    } catch (err) {
      this.logger.error("[CRON] lineups-upcoming failed", (err as Error).stack);
    }
  }

  @Cron("30 */10 * * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async cronRecentlyFinishedCorrections(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.liveCronEnabled) return;
    try {
      await this.ingestionService.refreshRecentlyFinishedMatches();
    } catch (err) {
      this.logger.error(
        "[CRON] finished-correction failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 */15 * * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async cronRecentlyFinishedStandings(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.liveCronEnabled) return;
    try {
      await this.ingestionService.refreshRecentlyFinishedStandings();
    } catch (err) {
      this.logger.error(
        "[CRON] standings-recent-finished failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 0 20 * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async runFocusedDailyEvents(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (this.fullFootballPlanEnabled && !this.focusedCompatibilityJobsEnabled) {
      return;
    }
    try {
      await this.ingestionService.ingestFocusedDailyEvents();
    } catch (err) {
      this.logger.error(
        "[CRON] focused-daily-events failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 0 20 * * 1", { timeZone: LOCAL_CRON_TIMEZONE })
  async runFocusedWeeklyTeams(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (this.fullFootballPlanEnabled && !this.focusedCompatibilityJobsEnabled) {
      return;
    }
    try {
      await this.ingestionService.ingestFocusedWeeklyTeams();
    } catch (err) {
      this.logger.error(
        "[CRON] focused-weekly-teams failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 0 23 * * 1", { timeZone: LOCAL_CRON_TIMEZONE })
  async runFocusedMondayPlayers(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (this.fullFootballPlanEnabled && !this.focusedCompatibilityJobsEnabled) {
      return;
    }
    try {
      await this.ingestionService.ingestFocusedMatchdayPlayers();
    } catch (err) {
      this.logger.error(
        "[CRON] focused-monday-players failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 0 20 * * 3,5", { timeZone: LOCAL_CRON_TIMEZONE })
  async runFocusedMatchdayPlayers(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (this.fullFootballPlanEnabled && !this.focusedCompatibilityJobsEnabled) {
      return;
    }
    try {
      await this.ingestionService.ingestFocusedMatchdayPlayers();
    } catch (err) {
      this.logger.error(
        "[CRON] focused-matchday-players failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 */30 * * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async runTier1ScheduledToday(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.fullFootballPlanEnabled) return;
    try {
      await this.ingestionService.ingestScheduledEventsForDate(new Date());
    } catch (err) {
      this.logger.error(
        "[CRON] tier1-scheduled-today failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 0 */2 * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async runTier1ScheduledTomorrow(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.fullFootballPlanEnabled) return;
    try {
      await this.ingestionService.ingestScheduledEventsForDate(
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      );
    } catch (err) {
      this.logger.error(
        "[CRON] tier1-scheduled-tomorrow failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 0 1 * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async runTier1RegistryRefresh(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.fullFootballPlanEnabled) return;
    try {
      await this.ingestionService.refreshRegistries();
    } catch (err) {
      this.logger.error(
        "[CRON] tier1-registry-refresh failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 0 2 * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async runTier1Metadata(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.fullFootballPlanEnabled) return;
    try {
      await this.ingestionService.ingestTournamentMetadata();
      await this.ingestionService.ingestGlobalConfig();
    } catch (err) {
      this.logger.error("[CRON] tier1-metadata failed", (err as Error).stack);
    }
  }

  @Cron("0 0 * * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async runTier3UpcomingBundles(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.fullFootballPlanEnabled) return;
    try {
      await this.ingestionService.ingestRecentAndUpcomingEventBundles();
    } catch (err) {
      this.logger.error(
        "[CRON] tier3-event-bundles failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 0 3 * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async runTier2TeamProfiles(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.fullFootballPlanEnabled) return;
    try {
      await this.ingestionService.ingestTeamProfiles();
    } catch (err) {
      this.logger.error(
        "[CRON] tier2-team-profiles failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 0 4 * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async runTier2PlayerProfiles(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.fullFootballPlanEnabled) return;
    try {
      await this.ingestionService.ingestPlayerProfiles();
    } catch (err) {
      this.logger.error(
        "[CRON] tier2-player-profiles failed",
        (err as Error).stack,
      );
    }
  }

  @Cron("0 0 5 * * *", { timeZone: LOCAL_CRON_TIMEZONE })
  async runTier3NightlyBackfill(): Promise<void> {
    if (!this.scheduledCronEnabled) return;
    if (!this.fullFootballPlanEnabled) return;
    try {
      await this.ingestionService.backfillHistoricalEvents(
        this.nightlyBackfillDays,
      );
    } catch (err) {
      this.logger.error(
        "[CRON] tier3-nightly-backfill failed",
        (err as Error).stack,
      );
    }
  }

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

  async cronTeamProfiles(): Promise<void> {
    this.logger.log("[CRON] team-profiles");
    try {
      await this.ingestionService.ingestTeamProfiles();
    } catch (err) {
      this.logger.error("[CRON] team-profiles failed", (err as Error).stack);
    }
  }

  async cronPlayerStatistics(): Promise<void> {
    this.logger.log("[CRON] player-statistics");
    try {
      await this.ingestionService.ingestPlayerProfiles();
    } catch (err) {
      this.logger.error(
        "[CRON] player-statistics failed",
        (err as Error).stack,
      );
    }
  }

  async cronCatalogCoverage(): Promise<void> {
    this.logger.log("[CRON] catalog-coverage");
    try {
      await this.ingestionService.ingestCatalogCoverage();
    } catch (err) {
      this.logger.error("[CRON] catalog-coverage failed", (err as Error).stack);
    }
  }
}

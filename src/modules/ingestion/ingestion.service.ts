import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, In } from "typeorm";
import { SnapshotService } from "../snapshot/snapshot.service";
import { NormalizeService } from "../normalize/normalize.service";
import { IngestionJobTrackerService } from "./ingestion-job-tracker.service";
import { SofaContractService } from "../contract/sofa-contract.service";
import { TournamentRegistryService } from "../registry/tournament-registry.service";
import { CountryRegistryService } from "../registry/country-registry.service";
import { SofaEvent } from "../../shared/entities/sofa-event.entity";
import { SofaTournamentEntity } from "../../shared/entities/sofa-tournament.entity";
import { IngestionJob } from "../../shared/entities/ingestion-job.entity";
import { EventStatus } from "../../shared/enums/event-status.enum";
import { formatDateForPath, dateRange } from "../../shared/utils/path.utils";

interface IngestionResult {
  pathsFetched: number;
  rowsUpserted: number;
  errorCount: number;
  errorDetails: Record<string, unknown>[];
  job?: IngestionJob;
  progressFlushEvery: number;
  attemptsSinceProgressFlush: number;
}

interface TournamentSeasonContext {
  tournamentId: number;
  competitionIds: Set<number>;
  seasonIds: Set<number>;
  roundsBySeason: Map<number, Set<number>>;
  teamIdsBySeason: Map<number, Set<number>>;
}

interface FocusedCategory {
  id: number;
  name: string | null;
  slug: string | null;
  alpha2: string | null;
  countryName: string | null;
  countrySlug: string | null;
  countryAlpha2: string | null;
}

interface FocusedTournament {
  id: number;
  name: string;
  slug: string | null;
  primaryColorHex: string | null;
  secondaryColorHex: string | null;
  userCount: number | null;
  rawMeta: Record<string, unknown>;
}

/**
 * Ingestion orchestrator.
 *
 * **Tournament IDs are never hardcoded.**
 * They are always read from {@link TournamentRegistryService} which
 * self-populates from the SofaScore categories API on startup and nightly.
 *
 * **Canonical API paths** come from {@link SofaContractService}.
 * Path templates captured in `Sofascore api documentation/` are listed in
 * `sofa-documented-paths.catalog.ts` and verified by `npm run verify:doc-paths`.
 *
 * **Storage / historical data (non-redundant model):**
 * - Every `fetchOne` / `getOrFetch` persists the **full response** in
 *   `raw_snapshots` (key = path + params). That is the **authoritative** copy
 *   for replay and time-travel per URL.
 * - `NormalizeService` projects list payloads into `sofa_events` / `sofa_teams` /
 *   `sofa_tournaments` for **querying** (by id, date, status). Embedded
 *   `raw_payload` / `raw_meta` on those rows is a **convenience slice** of the
 *   object used at insert time — not a second copy of every API in the catalog.
 * - Endpoints not passed through normalize (most `/event/{id}/…` sub-resources)
 *   exist **only** in `raw_snapshots` when cron/backfill runs them — no extra
 *   normalized table unless you add one later.
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly requestDelayMs: number;

  constructor(
    private readonly snapshotService: SnapshotService,
    private readonly normalizeService: NormalizeService,
    private readonly jobTracker: IngestionJobTrackerService,
    private readonly configService: ConfigService,
    private readonly contract: SofaContractService,
    private readonly registry: TournamentRegistryService,
    private readonly countryRegistry: CountryRegistryService,
    @InjectRepository(SofaEvent)
    private readonly eventRepo: Repository<SofaEvent>,
    @InjectRepository(SofaTournamentEntity)
    private readonly tournamentRepo: Repository<SofaTournamentEntity>,
  ) {
    this.requestDelayMs =
      this.configService.get<number>("ingestion.requestDelayMs") ?? 500;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private get sport(): string {
    return this.contract.getDefaultSport();
  }

  /** Active sports are controlled by SOFA_ACTIVE_SPORTS. */
  private get activeSports(): string[] {
    return this.contract.getActiveSports();
  }

  /** Live list — always reflects the latest DB state via the registry (default sport). */
  private get tournamentIds(): number[] {
    return this.registry.getActiveTournamentIds(this.sport);
  }

  // ─── Scheduled events ─────────────────────────────────────────────────────

  /**
   * For each active sport × active tournament id: fetch `scheduled-events/{date}`,
   * snapshot + normalize. Loops over all `SOFA_ACTIVE_SPORTS`.
   */
  async ingestScheduledEventsForDate(date: Date = new Date()): Promise<void> {
    const dateStr = formatDateForPath(date);
    const fallbackLimit = Math.max(
      0,
      this.configService.get<number>(
        "ingestion.scheduledEventsFallbackLimit",
      ) ?? 250,
    );

    for (const sport of this.activeSports) {
      const ids = this.registry.getActiveTournamentIds(sport);
      if (!ids.length) continue;

      const job = await this.jobTracker.startJob("scheduled-events", {
        date: dateStr,
        sport,
        tournamentCount: ids.length,
        strategy: "sport-level-primary-with-priority-tournament-fallback",
        fallbackLimit,
      });
      const result = this.emptyResult(job);

      try {
        const coveredTournamentIds = new Set<number>();
        const normalizeScheduledEvents = async (
          payload: Record<string, unknown>,
        ) => {
          for (const tournamentId of this.collectUniqueTournamentIds(payload)) {
            coveredTournamentIds.add(tournamentId);
          }
          const counts =
            await this.normalizeService.normalizeScheduledEventsPayload(
              payload,
              sport,
            );
          result.rowsUpserted +=
            counts.events + counts.teams + counts.tournaments;
        };

        const sportLevelPaths = [
          this.contract.sportScheduledEvents(dateStr, sport),
          this.contract.sportScheduledEventsPaged(dateStr, 0, sport),
        ];

        for (const path of sportLevelPaths) {
          await this.fetchOne(path, result, normalizeScheduledEvents, sport);
          await this.delay();
        }

        const fallbackIds = ids
          .filter((tournamentId) => !coveredTournamentIds.has(tournamentId))
          .slice(0, fallbackLimit);
        const failedFallbackPaths: string[] = [];

        for (const tournamentId of fallbackIds) {
          const path = this.contract.scheduledEvents(tournamentId, dateStr);
          const fetchResult = await this.fetchOne(
            path,
            result,
            normalizeScheduledEvents,
            sport,
          );
          if (!fetchResult.ok) failedFallbackPaths.push(path);
          await this.delay();
        }

        if (failedFallbackPaths.length) {
          this.logger.warn(
            `[scheduled-events] [${sport}] retrying ${failedFallbackPaths.length} failed fallback paths`,
          );
          await this.delay(5000);
        }

        for (const path of failedFallbackPaths) {
          const beforeErrors = result.errorCount;
          const retryResult = await this.fetchOne(
            path,
            result,
            normalizeScheduledEvents,
            sport,
          );
          if (retryResult.ok) {
            result.errorCount = Math.max(0, beforeErrors - 1);
            result.errorDetails = result.errorDetails.filter(
              (detail) =>
                !(
                  typeof detail.path === "string" && detail.path === path
                ),
            );
          }
          await this.delay();
        }

        await this.jobTracker.finishJob(job, result);
      } catch (err) {
        await this.jobTracker.failJob(job, err as Error);
      }
    }
  }

  // ─── Live ─────────────────────────────────────────────────────────────────

  /** Refreshes sport-level live tournament and live event list snapshots for all active sports. */
  async refreshLiveTournaments(): Promise<void> {
    for (const sport of this.activeSports) {
      const paths = [
        this.contract.sportLiveTournaments(sport),
        this.contract.sportEventsLive(sport),
      ];
      for (const path of paths) {
        try {
          const { payload } = await this.snapshotService.getOrFetch(
            path,
            {},
            sport,
          );
          if (path === this.contract.sportEventsLive(sport)) {
            await this.normalizeScheduledPayloadForSport(payload, sport);
          }
        } catch (err) {
          this.logger.warn(
            `Live refresh [${sport}] failed for ${path}: ${(err as Error).message}`,
          );
        }
        await this.delay(200);
      }
    }
  }

  /**
   * Polls volatile paths for rows in `sofa_events` that are in-play. Requires
   * normalized events to be up to date — if empty, nothing is fetched.
   */
  async refreshLiveMatchDetails(): Promise<void> {
    const liveEvents = await this.eventRepo.find({
      where: {
        sport: this.sport,
        statusType: In([
          EventStatus.IN_PROGRESS,
          EventStatus.HALFTIME,
          EventStatus.PAUSE,
        ]),
      },
      select: ["sofaId"],
    });

    if (!liveEvents.length) return;

    this.logger.log(`Refreshing live details for ${liveEvents.length} events`);

    for (const event of liveEvents) {
      for (const path of this.contract.liveVolatilePathsForEvent(
        event.sofaId,
      )) {
        try {
          await this.snapshotService.getOrFetch(path, {}, this.sport);
        } catch (err) {
          this.logger.warn(
            `Live detail refresh failed ${path}: ${(err as Error).message}`,
          );
        }
        await this.delay(100);
      }
    }
  }

  // ─── Match / team detail bundles ──────────────────────────────────────────

  /** Fetches every path in `matchDetailPaths` (full post-lineup bundle). */
  async ingestMatchDetailBundle(eventId: number): Promise<void> {
    const job = await this.jobTracker.startJob("match-detail-bundle", {
      eventId,
    });
    const result = this.emptyResult(job);

    try {
      for (const path of this.contract.matchDetailPaths(eventId)) {
        await this.fetchOne(path, result);
        await this.delay();
      }
      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  /** Fetches `teamBundlePaths` — roster, fixtures, stats references. */
  async ingestTeamBundle(teamId: number): Promise<void> {
    const job = await this.jobTracker.startJob("team-bundle", { teamId });
    const result = this.emptyResult(job);

    try {
      for (const path of this.contract.teamBundlePaths(teamId)) {
        await this.fetchOne(path, result);
        await this.delay();
      }
      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  // ─── Metadata ─────────────────────────────────────────────────────────────

  /**
   * Refreshes tournament metadata.
   * First triggers a registry re-discovery (updates `sofa_tournaments` from
   * categories API), then fetches detailed season info for every active
   * tournament the registry now knows about.
   */
  async ingestTournamentMetadata(): Promise<void> {
    // Re-discover tournaments — this is the single place we update the registry.
    await this.registry.discoverAndRefresh(this.activeSports);

    const lookback = this.contract.getTournamentSeasonsLookback();

    for (const sport of this.activeSports) {
      const ids = this.registry.getActiveTournamentIds(sport);

      const job = await this.jobTracker.startJob("metadata-tournaments", {
        sport,
        tournamentCount: ids.length,
      });
      const result = this.emptyResult(job);

      try {
        await this.fetchOne(this.contract.sportCategoriesAll(sport), result);
        await this.delay();

        for (const tid of ids) {
          const tournamentPaths = [
            this.contract.uniqueTournament(tid),
            this.contract.uniqueTournamentSeasons(tid),
          ];

          for (const path of tournamentPaths) {
            await this.fetchOne(path, result);
            await this.delay();
          }

          const seasonsSnapshot = await this.snapshotService
            .findByPath(this.contract.uniqueTournamentSeasons(tid))
            .catch(() => null);

          if (seasonsSnapshot) {
            const seasons =
              (
                seasonsSnapshot.payload as {
                  seasons?: Array<{ id: number }>;
                }
              ).seasons ?? [];

            for (const season of seasons.slice(0, lookback)) {
              for (const path of this.contract.seasonPathsForTournament(
                tid,
                season.id,
              )) {
                await this.fetchOne(path, result);
                await this.delay();
              }
            }
          }
        }

        await this.jobTracker.finishJob(job, result);
      } catch (err) {
        await this.jobTracker.failJob(job, err as Error);
      }
    }
  }

  /**
   * Config + odds + news paths for all {@link CountryRegistryService} codes
   * (and global `00` market) — see `SofaContractService.globalConfigPaths`.
   */
  async ingestGlobalConfig(): Promise<void> {
    const job = await this.jobTracker.startJob("global-config", {
      sports: this.activeSports,
    });
    const result = this.emptyResult(job);

    try {
      const countryCodes = this.countryRegistry.getActiveCountryCodes();
      for (const sport of this.activeSports) {
        for (const path of this.contract.globalConfigPaths(
          countryCodes,
          sport,
        )) {
          await this.fetchOne(path, result);
          await this.delay();
        }
      }
      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  // ─── Backfill ─────────────────────────────────────────────────────────────

  /**
   * Cartesian product: each calendar day in `[start, yesterday]` × each active
   * tournament id. Expensive for large `daysBack` × many tournaments — tune
   * cron or split by league if provider rate limits bite.
   */
  async backfillHistoricalEvents(daysBack?: number): Promise<void> {
    const days =
      daysBack ??
      this.configService.get<number>("ingestion.backfillDaysBack") ??
      365;

    // Inclusive range [start, endDate] where endDate is **yesterday** (avoid partial “today” data).
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const dates = dateRange(startDate, endDate);

    for (const sport of this.activeSports) {
      const ids = this.registry.getActiveTournamentIds(sport);
      if (!ids.length) continue;

      this.logger.log(
        `Historical backfill [${sport}]: ${dates.length} days × ${ids.length} tournaments`,
      );

      const job = await this.jobTracker.startJob("historical-backfill", {
        sport,
        daysBack: days,
        dateRange: [formatDateForPath(startDate), formatDateForPath(endDate)],
        tournamentCount: ids.length,
      });
      const result = this.emptyResult(job);

      try {
        for (const dateStr of dates) {
          for (const tournamentId of ids) {
            await this.fetchOne(
              this.contract.scheduledEvents(tournamentId, dateStr),
              result,
              async (payload) => {
                const counts =
                  await this.normalizeService.normalizeScheduledEventsPayload(
                    payload,
                    sport,
                  );
                result.rowsUpserted +=
                  counts.events + counts.teams + counts.tournaments;
              },
            );
            await this.delay();
          }
        }
        await this.jobTracker.finishJob(job, result);
      } catch (err) {
        await this.jobTracker.failJob(job, err as Error);
      }
    }
  }

  /**
   * Latest N finished rows in `sofa_events` (by `startTimestamp`), then for each
   * event every path in `finishedEventBackfillPaths`. Does not guarantee full
   * history — only a sliding window of recent finishes.
   */
  async backfillMatchDetailsForFinishedEvents(limit = 50): Promise<void> {
    const finishedEvents = await this.eventRepo.find({
      where: { sport: this.sport, statusType: EventStatus.FINISHED },
      order: { startTimestamp: "DESC" },
      take: limit,
      select: ["sofaId"],
    });

    if (!finishedEvents.length) {
      this.logger.log("No finished events found for detail backfill");
      return;
    }

    const job = await this.jobTracker.startJob("backfill-match-details", {
      eventCount: finishedEvents.length,
    });
    const result = this.emptyResult(job);

    try {
      for (const event of finishedEvents) {
        for (const path of this.contract.finishedEventBackfillPaths(
          event.sofaId,
        )) {
          await this.fetchOne(path, result);
          await this.delay();
        }
      }
      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  /**
   * Single path: `sport/.../scheduled-tournaments/{date}` (home-page style listing).
   * Does not walk per-tournament ids — use `ingestScheduledEventsForDate` for that.
   */
  async ingestSportScheduledTournaments(
    date: Date = new Date(),
  ): Promise<void> {
    const dateStr = formatDateForPath(date);
    for (const sport of this.activeSports) {
      const path = this.contract.sportScheduledTournaments(dateStr, sport);
      await this.snapshotService
        .getOrFetch(path, {}, sport)
        .catch((err) =>
          this.logger.warn(
            `sport scheduled-tournaments [${sport}] failed for ${dateStr}: ${(err as Error).message}`,
          ),
        );
      await this.delay(200);
    }
  }

  /** Realtime layer: hot paths for high-priority live matches. */
  async refreshImportantLiveMatchDetails(limitPerSport = 20): Promise<void> {
    await this.refreshLiveMatchDetailsByPriority({
      importantOnly: true,
      limitPerSport,
      label: "live-important",
    });
  }

  /** Realtime layer: hot paths for all other live matches at lower frequency. */
  async refreshNormalLiveMatchDetails(limitPerSport = 80): Promise<void> {
    await this.refreshLiveMatchDetailsByPriority({
      importantOnly: false,
      limitPerSport,
      label: "live-normal",
    });
  }

  /** Near-realtime layer: catch matches that should have moved from notstarted to live. */
  async detectStartedMatches(lookbackHours = 3, limitPerSport = 100): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromTimestamp = nowSec - lookbackHours * 3600;

    for (const sport of this.activeSports) {
      const events = await this.eventRepo
        .createQueryBuilder("event")
        .where("event.sport = :sport", { sport })
        .andWhere("event.statusType = :status", {
          status: EventStatus.NOT_STARTED,
        })
        .andWhere("event.startTimestamp BETWEEN :from AND :now", {
          from: fromTimestamp,
          now: nowSec,
        })
        .orderBy("event.startTimestamp", "ASC")
        .limit(limitPerSport)
        .getMany();

      await this.fetchEventDetailBatch(events, sport, "match-start-detector");
    }
  }

  /** Near-realtime layer: lineups are often published shortly before kickoff. */
  async refreshUpcomingLineups(aheadHours = 2, limitPerSport = 150): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const toTimestamp = nowSec + aheadHours * 3600;

    for (const sport of this.activeSports) {
      const events = await this.eventRepo
        .createQueryBuilder("event")
        .where("event.sport = :sport", { sport })
        .andWhere("event.statusType = :status", {
          status: EventStatus.NOT_STARTED,
        })
        .andWhere("event.startTimestamp BETWEEN :now AND :to", {
          now: nowSec,
          to: toTimestamp,
        })
        .orderBy("event.startTimestamp", "ASC")
        .limit(limitPerSport)
        .getMany();

      for (const event of events) {
        await this.fetchRealtimePath(
          this.contract.eventLineups(event.sofaId),
          sport,
          "lineups-upcoming",
        );
        await this.delay(100);
      }
    }
  }

  /** Near-realtime layer: final stats can arrive minutes after full time. */
  async refreshRecentlyFinishedMatches(
    lookbackHours = 6,
    limitPerSport = 150,
  ): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromTimestamp = nowSec - lookbackHours * 3600;

    for (const sport of this.activeSports) {
      const events = await this.eventRepo
        .createQueryBuilder("event")
        .where("event.sport = :sport", { sport })
        .andWhere("event.statusType IN (:...statuses)", {
          statuses: [EventStatus.FINISHED, EventStatus.AWARDED],
        })
        .andWhere("event.startTimestamp >= :from", { from: fromTimestamp })
        .orderBy("event.startTimestamp", "DESC")
        .limit(limitPerSport)
        .getMany();

      for (const event of events) {
        const paths = [
          this.contract.eventDetail(event.sofaId),
          this.contract.eventIncidents(event.sofaId),
          this.contract.eventStatistics(event.sofaId),
          this.contract.eventLineups(event.sofaId),
          this.contract.eventGraph(event.sofaId),
        ];

        for (const path of paths) {
          await this.fetchRealtimePath(path, sport, "finished-correction", event);
          await this.delay(100);
        }
      }
    }
  }

  /** Near-realtime layer: update standings for tournaments with recent finishes. */
  async refreshRecentlyFinishedStandings(
    lookbackHours = 6,
    limitPerSport = 100,
  ): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromTimestamp = nowSec - lookbackHours * 3600;

    for (const sport of this.activeSports) {
      const events = await this.eventRepo
        .createQueryBuilder("event")
        .where("event.sport = :sport", { sport })
        .andWhere("event.statusType IN (:...statuses)", {
          statuses: [EventStatus.FINISHED, EventStatus.AWARDED],
        })
        .andWhere("event.startTimestamp >= :from", { from: fromTimestamp })
        .andWhere("event.tournamentSofaId IS NOT NULL")
        .andWhere("event.seasonId IS NOT NULL")
        .orderBy("event.startTimestamp", "DESC")
        .limit(limitPerSport)
        .getMany();

      const targets = new Set<string>();
      for (const event of events) {
        if (!event.tournamentSofaId || !event.seasonId) continue;
        targets.add(`${event.tournamentSofaId}:${event.seasonId}`);
      }

      for (const target of targets) {
        const [tournamentId, seasonId] = target.split(":").map(Number);
        for (const path of [
          this.contract.standingsTotal(tournamentId, seasonId),
          this.contract.standingsHome(tournamentId, seasonId),
          this.contract.standingsAway(tournamentId, seasonId),
        ]) {
          await this.fetchRealtimePath(path, sport, "standings-recent-finished");
          await this.delay(100);
        }
      }
    }
  }

  /** Dependency-aware batch layer. Heavy jobs run in order from one cron. */
  async runDailyBatchPipeline(): Promise<void> {
    this.logger.log("[batch-pipeline] starting daily ingestion pipeline");
    await this.ingestFocusedSeasonGraph();
    await this.snapshotService.deleteExpired();
    this.logger.log("[batch-pipeline] finished daily ingestion pipeline");
  }

  /**
   * Focused discovery-first batch:
   * 1. `sport/{sport}/categories`
   * 2. keep only the configured countries
   * 3. `category/{id}/unique-tournaments`
   * 4. `unique-tournament/{id}/seasons`
   * 5. `unique-tournament/{tid}/season/{sid}/team-events/total`
   * 6. sport scheduled-events for today/tomorrow
   * 7. team profiles for discovered teams
   * 8. player profiles for discovered rosters
   */
  async ingestFocusedSeasonGraph(sports = this.activeSports): Promise<void> {
    const job = await this.jobTracker.startJob("focused-season-graph", {
      sports,
      tournamentIds: this.getFocusedTournamentIds(),
      liveCronEnabled:
        this.configService.get<boolean>("ingestion.enableLiveCron") ?? false,
    });
    const result = this.emptyResult(job);

    try {
      const today = formatDateForPath(new Date());
      const tomorrow = formatDateForPath(
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      );

      for (const sport of sports) {
        const teamIds = new Set<number>();
        const eventIds = new Set<number>();
        await this.ingestFocusedSportSeasonGraph(
          sport,
          teamIds,
          eventIds,
          [today, tomorrow],
          result,
        );
        await this.ingestEventManagersForIds(sport, [...eventIds], result);
        await this.ingestTeamProfilesForIds(sport, [...teamIds], result);
        await this.ingestPlayerProfilesForTeamIds(sport, [...teamIds], result);
      }

      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  async ingestFocusedDailyEvents(sports = this.activeSports): Promise<void> {
    const job = await this.jobTracker.startJob("focused-daily-events", {
      sports,
      tournamentIds: this.getFocusedTournamentIds(),
    });
    const result = this.emptyResult(job);

    try {
      const eventIds = new Set<number>();
      const dates = [this.today(), this.tomorrow()];

      for (const sport of sports) {
        for (const tournamentId of this.getFocusedTournamentIds()) {
          for (const date of dates) {
            await this.fetchOne(
              this.contract.scheduledEvents(tournamentId, date),
              result,
              async (payload) => {
                const counts =
                  await this.normalizeService.normalizeScheduledEventsPayload(
                    payload,
                    sport,
                  );
                result.rowsUpserted +=
                  counts.events + counts.teams + counts.tournaments;
                for (const eventId of this.collectEventIdsFromPayload(payload)) {
                  eventIds.add(eventId);
                }
              },
              sport,
            );
            await this.delay();
          }
        }

        await this.ingestEventManagersForIds(sport, [...eventIds], result);
      }

      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  async ingestFocusedBootstrapEvents(
    sports = this.activeSports,
  ): Promise<void> {
    const job = await this.jobTracker.startJob("focused-bootstrap-events", {
      sports,
      tournamentIds: this.getFocusedTournamentIds(),
      range: [-7, 7],
    });
    const result = this.emptyResult(job);

    try {
      const eventIds = new Set<number>();
      const dates = this.getDateRange(-7, 7);

      for (const sport of sports) {
        for (const tournamentId of this.getFocusedTournamentIds()) {
          for (const date of dates) {
            await this.fetchOne(
              this.contract.scheduledEvents(tournamentId, date),
              result,
              async (payload) => {
                const counts =
                  await this.normalizeService.normalizeScheduledEventsPayload(
                    payload,
                    sport,
                  );
                result.rowsUpserted +=
                  counts.events + counts.teams + counts.tournaments;
                for (const eventId of this.collectEventIdsFromPayload(payload)) {
                  eventIds.add(eventId);
                }
              },
              sport,
            );
            await this.delay();
          }
        }

        await this.ingestEventManagersForIds(sport, [...eventIds], result);
      }

      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  async ingestFocusedMatchdayPlayers(
    sports = this.activeSports,
  ): Promise<void> {
    const job = await this.jobTracker.startJob("focused-matchday-players", {
      sports,
    });
    const result = this.emptyResult(job);

    try {
      for (const sport of sports) {
        const playerIds = await this.discoverPlayerIdsFromSnapshots(sport);
        for (const playerId of playerIds) {
          for (const path of this.contract.playerProfileBundlePaths(playerId)) {
            await this.fetchOne(path, result, undefined, sport);
            await this.delay();
          }
        }

        this.logger.log(
          `[focused-matchday-players] [${sport}] players=${playerIds.length}`,
        );
      }

      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  async ingestFocusedWeeklyTeams(sports = this.activeSports): Promise<void> {
    const job = await this.jobTracker.startJob("focused-weekly-teams", {
      sports,
      tournamentIds: this.getFocusedTournamentIds(),
    });
    const result = this.emptyResult(job);

    try {
      for (const sport of sports) {
        const teamIds = new Set<number>();

        for (const tournamentId of this.getFocusedTournamentIds()) {
          await this.fetchOne(
            this.contract.uniqueTournament(tournamentId),
            result,
            undefined,
            sport,
          );
          await this.delay();

          const seasons = await this.fetchAndGetLatestSeasons(
            tournamentId,
            sport,
            result,
          );

          for (const seasonId of seasons) {
            await this.fetchOne(
              this.contract.tournamentSeasonTeamEvents(tournamentId, seasonId),
              result,
              async (payload) => {
                await this.normalizeSeasonEventsPayload(
                  payload,
                  sport,
                  teamIds,
                  new Set<number>(),
                  result,
                );
              },
              sport,
            );
            await this.delay();
          }
        }

        await this.ingestTeamProfilesForIds(sport, [...teamIds], result);
      }

      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  /**
   * Pre-warms match-detail bundles for events close to "now".
   * This keeps upcoming lineups / odds / h2h data and recently finished
   * summaries ready in PostgreSQL before public proxy traffic arrives.
   */
  async ingestRecentAndUpcomingEventBundles(
    lookbackHours = 6,
    aheadHours = 48,
    limitPerSport = 150,
  ): Promise<void> {
    const job = await this.jobTracker.startJob("event-bundles-upcoming", {
      sports: this.activeSports,
      lookbackHours,
      aheadHours,
      limitPerSport,
    });
    const result = this.emptyResult(job);

    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const fromTimestamp = nowSec - lookbackHours * 3600;
      const toTimestamp = nowSec + aheadHours * 3600;

      for (const sport of this.activeSports) {
        const events = await this.eventRepo
          .createQueryBuilder("event")
          .where("event.sport = :sport", { sport })
          .andWhere("event.startTimestamp BETWEEN :from AND :to", {
            from: fromTimestamp,
            to: toTimestamp,
          })
          .orderBy("event.startTimestamp", "ASC")
          .limit(limitPerSport)
          .select(["event.sofaId"])
          .getMany();

        for (const event of events) {
          for (const path of this.contract.upcomingEventBundlePaths(
            event.sofaId,
          )) {
            await this.fetchOne(path, result, undefined, sport);
            await this.delay();
          }
        }

        this.logger.log(
          `[event-bundles-upcoming] [${sport}] processed ${events.length} events`,
        );
      }

      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  /**
   * Pre-warms expanded team profile bundles for teams found in normalized events.
   * This turns `sofa_events` into the discovery graph for downstream team data.
   */
  async ingestTeamProfiles(): Promise<void> {
    const job = await this.jobTracker.startJob("team-profiles", {
      sports: this.activeSports,
    });
    const result = this.emptyResult(job);

    try {
      for (const sport of this.activeSports) {
        const teamIds = await this.collectDistinctTeamIdsForSport(sport);
        for (const teamId of teamIds) {
          for (const path of this.contract.teamProfileBundlePaths(teamId)) {
            await this.fetchOne(path, result, undefined, sport);
            await this.delay();
          }
        }

        this.logger.log(
          `[team-profiles] [${sport}] processed ${teamIds.length} teams`,
        );
      }

      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  // ─── Player statistics ────────────────────────────────────────────────────

  /**
   * Pre-warms `player/{id}/statistics` and `player/{id}/statistics/seasons`
   * for every distinct player found in cached `team/{id}/players` roster
   * snapshots. Player IDs are discovered lazily from the most recent events
   * already in `sofa_events` — no hardcoded IDs anywhere.
   *
   * Strategy:
   *  1. Collect distinct team IDs from the N most recent events in `sofa_events`.
   *  2. For each team, load the cached `team/{id}/players` snapshot (DB only —
   *     no provider call; if the roster was never fetched it is skipped).
   *  3. Extract `players[].player.id` from the payload.
   *  4. For each unique player (up to `limit`), call `fetchOne` for every path
   *     in `contract.playerStatisticsBundlePaths` — which goes through the
   *     standard DB-first cache so already-fresh rows are not re-fetched.
   *
   * No cap on player count — all distinct players found across all team rosters
   * for each active sport are processed.
   */
  async ingestPlayerProfiles(sports = this.activeSports): Promise<void> {
    const job = await this.jobTracker.startJob("player-profiles", {
      sports,
    });
    const result = this.emptyResult(job);

    try {
      for (const sport of sports) {
        const playerIds = await this.collectDistinctPlayerIdsForSport(sport);
        for (const playerId of playerIds) {
          for (const path of this.contract.playerProfileBundlePaths(playerId)) {
            await this.fetchOne(path, result, undefined, sport);
            await this.delay();
          }
        }

        this.logger.log(
          `[player-profiles] [${sport}] processed ${playerIds.length} players`,
        );
      }

      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  private async ingestFocusedSportSeasonGraph(
    sport: string,
    teamIds: Set<number>,
    eventIds: Set<number>,
    scheduledDates: string[],
    result: IngestionResult,
  ): Promise<void> {
    const focusedTournamentIds = this.getFocusedTournamentIds();
    this.logger.log(
      `[focused-season-graph] [${sport}] tournaments=${focusedTournamentIds.length}`,
    );

    for (const tournamentId of focusedTournamentIds) {
      await this.fetchOne(
        this.contract.uniqueTournament(tournamentId),
        result,
        undefined,
        sport,
      );
      await this.delay();

      const seasonsResult = await this.fetchOne(
        this.contract.uniqueTournamentSeasons(tournamentId),
        result,
        undefined,
        sport,
      );
      await this.delay();

      for (const seasonId of this.extractSeasonIdsFromPayload(
        seasonsResult.payload,
      )) {
        await this.fetchOne(
          this.contract.tournamentSeasonTeamEvents(tournamentId, seasonId),
          result,
          async (payload) => {
              await this.normalizeSeasonEventsPayload(
                payload,
                sport,
                teamIds,
                eventIds,
                result,
              );
            },
            sport,
        );
        await this.delay();
      }

      for (const date of scheduledDates) {
        await this.fetchOne(
          this.contract.scheduledEvents(tournamentId, date),
          result,
          async (payload) => {
            const counts = await this.normalizeService.normalizeScheduledEventsPayload(
              payload,
              sport,
            );
            result.rowsUpserted +=
              counts.events + counts.teams + counts.tournaments;
            for (const eventId of this.collectEventIdsFromPayload(payload)) {
              eventIds.add(eventId);
            }
          },
          sport,
        );
        await this.delay();
      }
    }
  }

  private async ingestEventManagersForIds(
    sport: string,
    eventIds: number[],
    result: IngestionResult,
  ): Promise<void> {
    for (const eventId of [...new Set(eventIds)]) {
      await this.fetchOne(
        this.contract.eventManagers(eventId),
        result,
        undefined,
        sport,
      );
      await this.delay();
    }

    this.logger.log(
      `[focused-season-graph] [${sport}] event-managers=${eventIds.length}`,
    );
  }

  private async fetchAndGetLatestSeasons(
    tournamentId: number,
    sport: string,
    result: IngestionResult,
  ): Promise<number[]> {
    const fetchResult = await this.fetchOne(
      this.contract.uniqueTournamentSeasons(tournamentId),
      result,
      undefined,
      sport,
    );
    await this.delay();

    return this.extractSeasonIdsFromPayload(fetchResult.payload);
  }

  private async ingestTeamProfilesForIds(
    sport: string,
    teamIds: number[],
    result: IngestionResult,
  ): Promise<void> {
    for (const teamId of [...new Set(teamIds)]) {
      for (const path of this.contract.teamProfileBundlePaths(teamId)) {
        await this.fetchOne(path, result, undefined, sport);
        await this.delay();
      }
    }

    this.logger.log(
      `[focused-season-graph] [${sport}] team-profiles=${teamIds.length}`,
    );
  }

  private async ingestPlayerProfilesForTeamIds(
    sport: string,
    teamIds: number[],
    result: IngestionResult,
  ): Promise<void> {
    const playerIds = new Set<number>();

    for (const teamId of [...new Set(teamIds)]) {
      const rosterSnapshot = await this.snapshotService
        .findByPath(this.contract.teamPlayers(teamId))
        .catch(() => null);

      if (!rosterSnapshot) continue;

      const players =
        (
          rosterSnapshot.payload as {
            players?: Array<{ player?: { id?: number } }>;
          }
        ).players ?? [];

      for (const entry of players) {
        const playerId = entry?.player?.id;
        if (playerId) playerIds.add(playerId);
      }
    }

    for (const playerId of playerIds) {
      for (const path of this.contract.playerProfileBundlePaths(playerId)) {
        await this.fetchOne(path, result, undefined, sport);
        await this.delay();
      }
    }

    this.logger.log(
      `[focused-season-graph] [${sport}] player-profiles=${playerIds.size}`,
    );
  }

  private async discoverPlayerIdsFromSnapshots(
    sport: string,
  ): Promise<number[]> {
    const teamIds = await this.discoverFocusedTeamIdsFromSnapshots(sport);
    if (!teamIds.length) return [];

    const playerIds = new Set<number>();

    for (const teamId of teamIds) {
      const rosterSnapshot = await this.snapshotService
        .findByPath(this.contract.teamPlayers(teamId))
        .catch(() => null);

      if (!rosterSnapshot) continue;

      const players =
        (
          rosterSnapshot.payload as {
            players?: Array<{ player?: { id?: number } }>;
          }
        ).players ?? [];

      for (const entry of players) {
        const playerId = entry?.player?.id;
        if (playerId) playerIds.add(playerId);
      }
    }

    return [...playerIds];
  }

  async ingestPlayerStatistics(): Promise<void> {
    const job = await this.jobTracker.startJob("player-statistics", {
      sports: this.activeSports,
    });
    const result = this.emptyResult(job);

    try {
      // Process each active sport independently so snapshots are tagged correctly.
      for (const sport of this.activeSports) {
        const seenPlayerIds = new Set<number>();

        // 1. Distinct team IDs from ALL events for this sport.
        const recentEvents = await this.eventRepo.find({
          where: { sport },
          order: { startTimestamp: "DESC" },
          select: ["homeTeamSofaId", "awayTeamSofaId"],
        });

        if (!recentEvents.length) {
          this.logger.debug(
            `[player-statistics] no recent events for sport=${sport}, skipping`,
          );
          continue;
        }

        const teamIds = [
          ...new Set(
            recentEvents.flatMap((e) => [e.homeTeamSofaId, e.awayTeamSofaId]),
          ),
        ];

        for (const teamId of teamIds) {
          // 2. Roster snapshot — DB only, no provider fallback.
          const rosterSnapshot = await this.snapshotService
            .findByPath(this.contract.teamPlayers(teamId))
            .catch(() => null);

          if (!rosterSnapshot) continue;

          const players =
            (
              rosterSnapshot.payload as {
                players?: Array<{ player?: { id?: number } }>;
              }
            ).players ?? [];

          // 3. Extract player IDs.
          for (const entry of players) {
            const playerId = entry?.player?.id;
            if (!playerId || seenPlayerIds.has(playerId)) continue;
            seenPlayerIds.add(playerId);

            // 4. Fetch statistics bundle — pass sport so snapshot is tagged correctly.
            for (const path of this.contract.playerStatisticsBundlePaths(
              playerId,
            )) {
              await this.fetchOne(path, result, undefined, sport);
              await this.delay();
            }
          }
        }

        this.logger.log(
          `[player-statistics] [${sport}] processed ${seenPlayerIds.size} players from ${teamIds.length} teams`,
        );
      }

      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  /**
   * Comprehensive best-effort coverage pass for the documented finite API surface.
   *
   * This job intentionally focuses on endpoints whose parameter space can be
   * discovered from local registries / snapshots (sport, tournament, season,
   * event, team, player, country, manager, channel). Query-driven endpoints
   * such as `search/*?q=...` remain lazy-cache by design because their keyspace
   * is effectively unbounded.
   */
  async ingestCatalogCoverage(): Promise<void> {
    const job = await this.jobTracker.startJob("catalog-coverage", {
      sports: this.activeSports,
    });
    const result = this.emptyResult(job);

    try {
      const today = formatDateForPath(new Date());
      const tomorrow = formatDateForPath(
        new Date(Date.now() + 24 * 60 * 60 * 1000),
      );
      const countryCodes = this.countryRegistry.getActiveCountryCodes();
      const oddsProviderId = this.contract.getOddsProviderId();

      await this.fetchOne(this.contract.oddsTopTeamStreaks(), result);
      for (const rankingTypeId of [1, 2]) {
        await this.fetchOne(this.contract.rankingsType(rankingTypeId), result);
      }

      for (const sport of this.activeSports) {
        await this.ingestFiniteSportCoverage(
          sport,
          today,
          tomorrow,
          countryCodes,
          oddsProviderId,
          result,
        );
      }

      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  private async ingestFiniteSportCoverage(
    sport: string,
    today: string,
    tomorrow: string,
    countryCodes: string[],
    oddsProviderId: number,
    result: IngestionResult,
  ): Promise<void> {
    const sportPaths = [
      this.contract.sportCategories(sport),
      this.contract.sportCategoriesAll(sport),
      this.contract.sportLiveTournaments(sport),
      this.contract.sportEventsLive(sport),
      this.contract.sportScheduledEvents(today, sport),
      this.contract.sportScheduledEventsPaged(today, 0, sport),
      this.contract.sportScheduledEvents(tomorrow, sport),
      this.contract.sportTrendingTopPlayers(sport),
      this.contract.sportLiveCategories(sport),
      this.contract.sportEventCount(sport),
      this.contract.oddsFeaturedEvents(oddsProviderId, sport),
      this.contract.oddsFeaturedEventsByPopularity(oddsProviderId, sport),
    ];

    for (const path of sportPaths) {
      const shouldNormalize =
        path === this.contract.sportScheduledEvents(today, sport) ||
        path === this.contract.sportScheduledEvents(tomorrow, sport);

      await this.fetchOne(
        path,
        result,
        shouldNormalize
          ? async (payload) => {
              const counts =
                await this.normalizeService.normalizeScheduledEventsPayload(
                  payload,
                  sport,
                );
              result.rowsUpserted +=
                counts.events + counts.teams + counts.tournaments;
            }
          : undefined,
        sport,
      );
      await this.delay();
    }

    await this.ingestTournamentCatalogCoverage(sport, result, countryCodes);
    await this.ingestEventCatalogCoverage(sport, result, countryCodes);
    await this.ingestTeamCatalogCoverage(sport, result, countryCodes);
    await this.ingestPlayerCatalogCoverage(sport, result);
  }

  private async ingestTournamentCatalogCoverage(
    sport: string,
    result: IngestionResult,
    countryCodes: string[],
  ): Promise<void> {
    const tournaments = await this.tournamentRepo.find({
      where: { sport, isActive: true },
      select: ["sofaId", "categoryId"],
      order: { priority: "ASC", sofaId: "ASC" },
    });
    const contexts = await this.collectTournamentSeasonContexts(sport);

    for (const tournament of tournaments) {
      if (tournament.categoryId) {
        await this.fetchOne(
          this.contract.categoryUniqueTournaments(tournament.categoryId),
          result,
          undefined,
          sport,
        );
        await this.delay();
      }

      for (const path of [
        this.contract.uniqueTournament(tournament.sofaId),
        this.contract.uniqueTournamentWinners(tournament.sofaId),
        this.contract.uniqueTournamentSeasons(tournament.sofaId),
        this.contract.uniqueTournamentFeaturedEvents(tournament.sofaId),
        this.contract.tournamentMedia(tournament.sofaId),
      ]) {
        await this.fetchOne(path, result, undefined, sport);
        await this.delay();
      }

      const seasonIds = new Set<number>(
        await this.extractNumberIdsFromSnapshot(
          this.contract.uniqueTournamentSeasons(tournament.sofaId),
          ["id"],
          "seasons",
        ),
      );
      const context = contexts.get(tournament.sofaId);
      for (const seasonId of context?.seasonIds ?? []) seasonIds.add(seasonId);

      for (const seasonId of seasonIds) {
        const seasonPaths = [
          this.contract.tournamentSeasonInfo(tournament.sofaId, seasonId),
          this.contract.tournamentSeasonRounds(tournament.sofaId, seasonId),
          this.contract.standingsTotal(tournament.sofaId, seasonId),
          this.contract.standingsHome(tournament.sofaId, seasonId),
          this.contract.standingsAway(tournament.sofaId, seasonId),
          this.contract.cupTrees(tournament.sofaId, seasonId),
          this.contract.tournamentSeasonTeamEvents(tournament.sofaId, seasonId),
          this.contract.tournamentSeasonEventsNext(tournament.sofaId, seasonId),
          this.contract.tournamentSeasonEditors(tournament.sofaId, seasonId),
          this.contract.tournamentTopPlayersOverall(tournament.sofaId, seasonId),
          this.contract.topPlayersRating(tournament.sofaId, seasonId),
          this.contract.topPlayersGoals(tournament.sofaId, seasonId),
          this.contract.tournamentTopPlayersPerGame(tournament.sofaId, seasonId),
          this.contract.tournamentTopRatings(tournament.sofaId, seasonId),
          this.contract.tournamentTopTeamsOverall(tournament.sofaId, seasonId),
          this.contract.tournamentSeasonPlayerStatisticsTypes(
            tournament.sofaId,
            seasonId,
          ),
          this.contract.tournamentSeasonPowerRankingsRounds(
            tournament.sofaId,
            seasonId,
          ),
          this.contract.tournamentSeasonGroups(tournament.sofaId, seasonId),
          this.contract.tournamentSeasonVenues(tournament.sofaId, seasonId),
          this.contract.tournamentTeamOfWeekRounds(tournament.sofaId, seasonId),
          this.contract.tournamentTeamOfWeekPeriods(
            tournament.sofaId,
            seasonId,
          ),
          this.contract.tournamentPlayerOfSeason(tournament.sofaId, seasonId),
        ];

        for (const path of seasonPaths) {
          await this.fetchOne(path, result, undefined, sport);
          await this.delay();
        }

        for (const competitionId of context?.competitionIds ?? []) {
          for (const path of [
            this.contract.tournamentStandings(competitionId, seasonId),
            this.contract.competitionTournamentStandingsHome(
              competitionId,
              seasonId,
            ),
            this.contract.competitionTournamentStandingsAway(
              competitionId,
              seasonId,
            ),
          ]) {
            await this.fetchOne(path, result, undefined, sport);
            await this.delay();
          }
        }

        const roundIds = new Set<number>(
          context?.roundsBySeason.get(seasonId) ?? [],
        );
        for (const roundId of await this.extractNumberIdsFromSnapshot(
          this.contract.tournamentSeasonRounds(tournament.sofaId, seasonId),
          ["round", "id"],
          undefined,
        )) {
          roundIds.add(roundId);
        }
        for (const roundId of await this.extractNumberIdsFromSnapshot(
          this.contract.tournamentTeamOfWeekRounds(tournament.sofaId, seasonId),
          ["round", "id"],
          undefined,
        )) {
          roundIds.add(roundId);
        }
        for (const roundId of await this.extractNumberIdsFromSnapshot(
          this.contract.tournamentTeamOfWeekPeriods(tournament.sofaId, seasonId),
          ["round", "id"],
          undefined,
        )) {
          roundIds.add(roundId);
        }

        for (const roundId of roundIds) {
          await this.fetchOne(
            this.contract.tournamentSeasonRoundEvents(
              tournament.sofaId,
              seasonId,
              roundId,
            ),
            result,
            undefined,
            sport,
          );
          await this.delay();
          await this.fetchOne(
            this.contract.tournamentTeamOfWeek(
              tournament.sofaId,
              seasonId,
              roundId,
            ),
            result,
            undefined,
            sport,
          );
          await this.delay();
        }

        const teamIds = new Set<number>(context?.teamIdsBySeason.get(seasonId) ?? []);
        const playerStatKinds = await this.extractStringIdsFromSnapshot(
          this.contract.tournamentSeasonPlayerStatisticsTypes(
            tournament.sofaId,
            seasonId,
          ),
          ["slug", "name", "type"],
        );

        for (const teamId of teamIds) {
          const teamSeasonPaths = [
            this.contract.teamSeasonStatistics(
              teamId,
              tournament.sofaId,
              seasonId,
              "overall",
            ),
            this.contract.teamSeasonStatistics(
              teamId,
              tournament.sofaId,
              seasonId,
              "home",
            ),
            this.contract.teamSeasonStatistics(
              teamId,
              tournament.sofaId,
              seasonId,
              "away",
            ),
            this.contract.teamTopPlayersInTournament(
              teamId,
              tournament.sofaId,
              seasonId,
              "overall",
            ),
            this.contract.teamTopPlayersInTournament(
              teamId,
              tournament.sofaId,
              seasonId,
              "home",
            ),
            this.contract.teamTopPlayersInTournament(
              teamId,
              tournament.sofaId,
              seasonId,
              "away",
            ),
            this.contract.teamUniqueTournamentSeasonGoalDistributions(
              teamId,
              tournament.sofaId,
              seasonId,
            ),
            this.contract.teamPerformanceGraph(
              tournament.sofaId,
              seasonId,
              teamId,
            ),
          ];

          for (const path of teamSeasonPaths) {
            await this.fetchOne(path, result, undefined, sport);
            await this.delay();
          }

          for (const kind of playerStatKinds) {
            await this.fetchOne(
              this.contract.teamUniqueTournamentSeasonPlayerStatistics(
                teamId,
                tournament.sofaId,
                seasonId,
                kind,
              ),
              result,
              undefined,
              sport,
            );
            await this.delay();
            await this.fetchOne(
              this.contract.teamTopPlayersInTournamentSlug(
                teamId,
                tournament.sofaId,
                seasonId,
                kind,
              ),
              result,
              undefined,
              sport,
            );
            await this.delay();
          }
        }

        for (const slug of playerStatKinds) {
          await this.fetchOne(
            this.contract.tournamentSeasonTopPlayersSlug(
              tournament.sofaId,
              seasonId,
              slug,
            ),
            result,
            undefined,
            sport,
          );
          await this.delay();
        }
      }
    }
  }

  private async ingestEventCatalogCoverage(
    sport: string,
    result: IngestionResult,
    countryCodes: string[],
  ): Promise<void> {
    const events = await this.collectRecentEventTargetsForSport(sport);

    for (const event of events) {
      const eventPaths = [
        ...this.contract.matchDetailPaths(event.sofaId),
        this.contract.eventBestPlayers(event.sofaId),
        this.contract.eventComments(event.sofaId),
        this.contract.eventTeamStreaksBettingOdds(event.sofaId),
        this.contract.eventShotmap(event.sofaId, event.homeTeamSofaId),
        this.contract.eventShotmap(event.sofaId, event.awayTeamSofaId),
        this.contract.eventHeatmap(event.sofaId, event.homeTeamSofaId),
        this.contract.eventHeatmap(event.sofaId, event.awayTeamSofaId),
        ...countryCodes.map((cc) =>
          this.contract.eventMediaSummary(event.sofaId, cc),
        ),
      ];

      for (const path of eventPaths) {
        await this.fetchOne(path, result, undefined, sport);
        await this.delay();
      }

      for (const channelId of await this.discoverChannelIdsForEvent(
        event.sofaId,
      )) {
        await this.fetchOne(
          this.contract.tvChannelSchedule(channelId),
          result,
          undefined,
          sport,
        );
        await this.delay();
      }

      for (const managerId of await this.discoverManagerIdsForEvent(
        event.sofaId,
      )) {
        await this.fetchOne(
          this.contract.managerDetail(managerId),
          result,
          undefined,
          sport,
        );
        await this.delay();
        await this.fetchOne(
          this.contract.managerCareerHistory(managerId),
          result,
          undefined,
          sport,
        );
        await this.delay();
      }
    }
  }

  private async ingestTeamCatalogCoverage(
    sport: string,
    result: IngestionResult,
    countryCodes: string[],
  ): Promise<void> {
    const teamIds = await this.collectDistinctTeamIdsForSport(sport);

    for (const teamId of teamIds) {
      const paths = [
        ...this.contract.teamProfileBundlePaths(teamId),
        this.contract.teamUniqueTournaments(teamId),
        this.contract.teamGrandSlamBestResults(teamId),
        ...countryCodes.map((cc) =>
          this.contract.teamMediaSummaryCountry(teamId, cc),
        ),
      ];

      for (const path of paths) {
        await this.fetchOne(path, result, undefined, sport);
        await this.delay();
      }
    }
  }

  private async ingestPlayerCatalogCoverage(
    sport: string,
    result: IngestionResult,
  ): Promise<void> {
    const playerIds = await this.collectDistinctPlayerIdsForSport(sport);
    const playerContexts = await this.collectPlayerTournamentSeasonContextsForSport(
      sport,
    );

    for (const playerId of playerIds) {
      for (const path of [
        ...this.contract.playerProfileBundlePaths(playerId),
        this.contract.playerMediaVideos(playerId),
        this.contract.fantasyPlayerCompetitions(playerId),
      ]) {
        await this.fetchOne(path, result, undefined, sport);
        await this.delay();
      }

      for (const context of playerContexts.get(playerId) ?? []) {
        await this.fetchOne(
          this.contract.playerTournamentSeasonStats(
            playerId,
            context.tournamentId,
            context.seasonId,
          ),
          result,
          undefined,
          sport,
        );
        await this.delay();
        await this.fetchOne(
          this.contract.playerSeasonStatisticalRankings(
            playerId,
            context.seasonId,
            "regularSeason",
          ),
          result,
          undefined,
          sport,
        );
        await this.delay();
      }
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async collectDistinctTeamIdsForSport(sport: string): Promise<number[]> {
    const recentEvents = await this.eventRepo.find({
      where: { sport },
      order: { startTimestamp: "DESC" },
      select: ["homeTeamSofaId", "awayTeamSofaId"],
    });

    if (!recentEvents.length) {
      this.logger.debug(`[ingestion] no recent events for sport=${sport}`);
      return [];
    }

    return [
      ...new Set(
        recentEvents.flatMap((event) => [
          event.homeTeamSofaId,
          event.awayTeamSofaId,
        ]),
      ),
    ];
  }

  private async refreshLiveMatchDetailsByPriority(options: {
    importantOnly: boolean;
    limitPerSport: number;
    label: string;
  }): Promise<void> {
    const liveStatuses = [
      EventStatus.IN_PROGRESS,
      EventStatus.HALFTIME,
      EventStatus.PAUSE,
      EventStatus.INTERRUPTED,
    ];

    for (const sport of this.activeSports) {
      const priorityTournamentIds = new Set(
        this.registry.getActiveTournamentIds(sport).slice(0, 100),
      );

      const query = this.eventRepo
        .createQueryBuilder("event")
        .where("event.sport = :sport", { sport })
        .andWhere("event.statusType IN (:...statuses)", {
          statuses: liveStatuses,
        })
        .orderBy("event.startTimestamp", "DESC")
        .limit(options.limitPerSport);

      if (options.importantOnly && priorityTournamentIds.size > 0) {
        query.andWhere("event.tournamentSofaId IN (:...tournamentIds)", {
          tournamentIds: [...priorityTournamentIds],
        });
      } else if (!options.importantOnly && priorityTournamentIds.size > 0) {
        query.andWhere(
          "(event.tournamentSofaId IS NULL OR event.tournamentSofaId NOT IN (:...tournamentIds))",
          { tournamentIds: [...priorityTournamentIds] },
        );
      }

      const events = await query.getMany();
      for (const event of events) {
        for (const path of this.liveMatchPaths(event.sofaId)) {
          await this.fetchRealtimePath(path, sport, options.label, event);
          await this.delay(100);
        }
      }
    }
  }

  private liveMatchPaths(eventId: number): string[] {
    return [
      this.contract.eventDetail(eventId),
      this.contract.eventIncidents(eventId),
      this.contract.eventStatistics(eventId),
      this.contract.eventLineups(eventId),
      this.contract.eventGraph(eventId),
    ];
  }

  private async fetchEventDetailBatch(
    events: SofaEvent[],
    sport: string,
    label: string,
  ): Promise<void> {
    for (const event of events) {
      await this.fetchRealtimePath(
        this.contract.eventDetail(event.sofaId),
        sport,
        label,
        event,
      );
      await this.delay(100);
    }
  }

  private async fetchRealtimePath(
    path: string,
    sport: string,
    label: string,
    event?: SofaEvent,
  ): Promise<void> {
    try {
      const { payload, source } = await this.snapshotService.getOrFetch(
        path,
        {},
        sport,
      );
      if (path === this.contract.eventDetail(event?.sofaId ?? -1)) {
        await this.normalizeEventDetailPayload(payload, sport);
      }
      this.logger.debug(`[${label}] ${source}: ${path}`);
    } catch (err) {
      this.logger.warn(`[${label}] failed ${path}: ${(err as Error).message}`);
    }
  }

  private async normalizeScheduledPayloadForSport(
    payload: Record<string, unknown>,
    sport: string,
  ): Promise<void> {
    const counts = await this.normalizeService.normalizeScheduledEventsPayload(
      payload,
      sport,
    );
    if (counts.events > 0) {
      this.logger.log(
        `[normalize-live-index] [${sport}] events=${counts.events}, teams=${counts.teams}, tournaments=${counts.tournaments}`,
      );
    }
  }

  private async normalizeEventDetailPayload(
    payload: Record<string, unknown>,
    sport: string,
  ): Promise<void> {
    const eventPayload =
      payload.event && typeof payload.event === "object"
        ? (payload.event as Record<string, unknown>)
        : payload;

    await this.normalizeService.normalizeScheduledEventsPayload(
      { events: [eventPayload] },
      sport,
    );
  }

  private async normalizeSeasonEventsPayload(
    payload: Record<string, unknown>,
    sport: string,
    teamIds: Set<number>,
    eventIds: Set<number>,
    result: IngestionResult,
  ): Promise<void> {
    const counts = await this.normalizeService.normalizeScheduledEventsPayload(
      payload,
      sport,
    );
    result.rowsUpserted += counts.events + counts.teams + counts.tournaments;

    for (const teamId of this.collectTeamIdsFromPayload(payload)) {
      teamIds.add(teamId);
    }
    for (const eventId of this.collectEventIdsFromPayload(payload)) {
      eventIds.add(eventId);
    }
  }

  private async collectDistinctPlayerIdsForSport(
    sport: string,
  ): Promise<number[]> {
    const teamIds = await this.collectDistinctTeamIdsForSport(sport);
    if (!teamIds.length) return [];

    const playerIds = new Set<number>();

    for (const teamId of teamIds) {
      const rosterSnapshot = await this.snapshotService
        .findByPath(this.contract.teamPlayers(teamId))
        .catch(() => null);

      if (!rosterSnapshot) continue;

      const players =
        (
          rosterSnapshot.payload as {
            players?: Array<{ player?: { id?: number } }>;
          }
        ).players ?? [];

      for (const entry of players) {
        const playerId = entry?.player?.id;
        if (playerId) playerIds.add(playerId);
      }
    }

    return [...playerIds];
  }

  private async discoverFocusedTeamIdsFromSnapshots(
    sport: string,
  ): Promise<number[]> {
    const teamIds = new Set<number>();
    const dates = [this.today(), this.tomorrow()];

    for (const tournamentId of this.getFocusedTournamentIds()) {
      const seasonsSnapshot = await this.snapshotService
        .findByPath(this.contract.uniqueTournamentSeasons(tournamentId))
        .catch(() => null);

      const seasonIds = this.extractSeasonIdsFromPayload(
        seasonsSnapshot?.payload as Record<string, unknown> | undefined,
      );

      for (const seasonId of seasonIds) {
        const fixtureSnapshot = await this.snapshotService
          .findByPath(
            this.contract.tournamentSeasonTeamEvents(tournamentId, seasonId),
          )
          .catch(() => null);

        if (fixtureSnapshot) {
          for (const teamId of this.collectTeamIdsFromPayload(
            fixtureSnapshot.payload,
          )) {
            teamIds.add(teamId);
          }
        }
      }

      for (const date of dates) {
        const scheduledSnapshot = await this.snapshotService
          .findByPath(this.contract.scheduledEvents(tournamentId, date))
          .catch(() => null);

        if (scheduledSnapshot) {
          for (const teamId of this.collectTeamIdsFromPayload(
            scheduledSnapshot.payload,
          )) {
            teamIds.add(teamId);
          }
        }
      }
    }

    return [...teamIds];
  }

  private extractFocusedCategories(
    payload?: Record<string, unknown>,
  ): FocusedCategory[] {
    const rawCategories = Array.isArray(payload?.categories)
      ? payload.categories
      : [];

    return rawCategories
      .map((rawCategory) => this.mapFocusedCategory(rawCategory))
      .filter(
        (category): category is FocusedCategory =>
          category !== null && this.isFocusedCategory(category),
      );
  }

  private mapFocusedCategory(rawCategory: unknown): FocusedCategory | null {
    if (!rawCategory || typeof rawCategory !== "object") return null;

    const category = rawCategory as Record<string, unknown>;
    const country =
      category.country && typeof category.country === "object"
        ? (category.country as Record<string, unknown>)
        : null;
    const id = this.asNumber(category.id);

    if (!id) return null;

    return {
      id,
      name: this.asString(category.name),
      slug: this.asString(category.slug),
      alpha2: this.asString(category.alpha2)?.toUpperCase() ?? null,
      countryName: this.asString(country?.name),
      countrySlug: this.asString(country?.slug),
      countryAlpha2: this.asString(country?.alpha2)?.toUpperCase() ?? null,
    };
  }

  private isFocusedCategory(category: FocusedCategory): boolean {
    const wanted = new Set(this.getFocusedCategoryCountries());
    const candidates = [
      category.name,
      category.slug,
      category.alpha2,
      category.countryName,
      category.countrySlug,
      category.countryAlpha2,
    ]
      .filter((value): value is string => typeof value === "string")
      .map((value) => this.normalizeCountryKey(value));

    return candidates.some((candidate) => wanted.has(candidate));
  }

  private getFocusedCategoryCountries(): string[] {
    const configured =
      this.configService.get<string[]>("ingestion.focusedCategoryCountries") ??
      ["spain", "germany", "italy", "france", "england"];

    const aliases = new Set<string>();
    for (const value of configured) {
      const normalized = this.normalizeCountryKey(value);
      aliases.add(normalized);

      switch (normalized) {
        case "spain":
          aliases.add("es");
          break;
        case "germany":
          aliases.add("de");
          break;
        case "italy":
          aliases.add("it");
          break;
        case "france":
          aliases.add("fr");
          break;
        case "england":
          aliases.add("en");
          aliases.add("gb");
          aliases.add("uk");
          aliases.add("greatbritain");
          break;
      }
    }

    return [...aliases];
  }

  private extractUniqueTournamentsFromCategoryPayload(
    payload?: Record<string, unknown>,
  ): FocusedTournament[] {
    const tournaments = new Map<number, FocusedTournament>();
    const pushTournament = (rawTournament: unknown) => {
      const mapped = this.mapFocusedTournament(rawTournament);
      if (mapped) tournaments.set(mapped.id, mapped);
    };

    if (Array.isArray(payload?.uniqueTournaments)) {
      for (const rawTournament of payload.uniqueTournaments) {
        pushTournament(rawTournament);
      }
    }

    if (Array.isArray(payload?.groups)) {
      for (const rawGroup of payload.groups) {
        if (!rawGroup || typeof rawGroup !== "object") continue;
        const group = rawGroup as Record<string, unknown>;
        const groupTournaments = Array.isArray(group.uniqueTournaments)
          ? group.uniqueTournaments
          : [];
        for (const rawTournament of groupTournaments) {
          pushTournament(rawTournament);
        }
      }
    }

    return [...tournaments.values()].filter((tournament) =>
      this.isFocusedTournament(tournament),
    );
  }

  private mapFocusedTournament(rawTournament: unknown): FocusedTournament | null {
    if (!rawTournament || typeof rawTournament !== "object") return null;

    const tournament = rawTournament as Record<string, unknown>;
    const id = this.asNumber(tournament.id);
    const name = this.asString(tournament.name);

    if (!id || !name) return null;

    return {
      id,
      name,
      slug: this.asString(tournament.slug),
      primaryColorHex: this.asString(tournament.primaryColorHex),
      secondaryColorHex: this.asString(tournament.secondaryColorHex),
      userCount: this.asNumber(tournament.userCount),
      rawMeta: tournament,
    };
  }

  private isFocusedTournament(tournament: FocusedTournament): boolean {
    const wanted = new Set(this.getFocusedTournamentNames());
    const candidates = [tournament.name, tournament.slug]
      .filter((value): value is string => typeof value === "string")
      .map((value) => this.normalizeTournamentKey(value));

    return candidates.some((candidate) => wanted.has(candidate));
  }

  private getFocusedTournamentNames(): string[] {
    const configured =
      this.configService.get<string[]>("ingestion.focusedTournamentNames") ?? [
        "laliga",
        "bundesliga",
        "epl",
        "seriea",
        "ligue1",
        "ucl",
        "europaleague",
      ];

    const aliases = new Set<string>();
    for (const value of configured) {
      const normalized = this.normalizeTournamentKey(value);
      aliases.add(normalized);

      switch (normalized) {
        case "laliga":
          aliases.add("laligaa");
          aliases.add("laligaea");
          aliases.add("primera");
          aliases.add("primeradivision");
          break;
        case "bundesliga":
          aliases.add("bundesliga1");
          break;
        case "epl":
          aliases.add("premierleague");
          aliases.add("englishpremierleague");
          break;
        case "seriea":
        case "seria":
          aliases.add("seriea");
          aliases.add("italianseriea");
          break;
        case "ligue1":
        case "leagueone":
          aliases.add("ligue1");
          aliases.add("leagueone");
          aliases.add("frenchligue1");
          break;
        case "ucl":
          aliases.add("uefachampionsleague");
          aliases.add("championsleague");
          break;
        case "europaleague":
          aliases.add("uefaeuropaleague");
          aliases.add("europaleague");
          break;
      }
    }

    return [...aliases];
  }

  private getFocusedTournamentIds(): number[] {
    const configured =
      this.configService.get<number[]>("ingestion.focusedTournamentIds") ?? [
        8, 35, 17, 23, 34, 7, 679,
      ];

    return [...new Set(configured.filter((value) => Number.isFinite(value)))];
  }

  private extractSeasonIdsFromPayload(
    payload?: Record<string, unknown>,
  ): number[] {
    const seasons = Array.isArray(payload?.seasons) ? payload.seasons : [];
    const orderedSeasons: Array<{ id: number; score: number }> = [];

    for (const rawSeason of seasons) {
      if (!rawSeason || typeof rawSeason !== "object") continue;
      const season = rawSeason as Record<string, unknown>;
      const id = this.asNumber(season.id);
      if (!id) continue;

      const year =
        this.asNumber(season.year) ??
        this.asNumber(
          typeof season.name === "string"
            ? season.name.match(/\d{4}/)?.[0]
              ? Number(season.name.match(/\d{4}/)?.[0])
              : null
            : null,
        ) ??
        0;

      orderedSeasons.push({ id, score: year > 0 ? year : id });
    }

    orderedSeasons.sort((a, b) => b.score - a.score || b.id - a.id);
    return [...new Set(orderedSeasons.slice(0, 5).map((season) => season.id))];
  }

  private collectTeamIdsFromPayload(payload: Record<string, unknown>): number[] {
    const ids = new Set<number>();

    const visit = (input: unknown): void => {
      if (Array.isArray(input)) {
        for (const item of input) visit(item);
        return;
      }

      if (!input || typeof input !== "object") return;

      const record = input as Record<string, unknown>;
      const homeTeam =
        record.homeTeam && typeof record.homeTeam === "object"
          ? (record.homeTeam as Record<string, unknown>)
          : null;
      const awayTeam =
        record.awayTeam && typeof record.awayTeam === "object"
          ? (record.awayTeam as Record<string, unknown>)
          : null;
      const team =
        record.team && typeof record.team === "object"
          ? (record.team as Record<string, unknown>)
          : null;

      const homeId = this.asNumber(homeTeam?.id);
      const awayId = this.asNumber(awayTeam?.id);
      const teamId = this.asNumber(team?.id);

      if (homeId) ids.add(homeId);
      if (awayId) ids.add(awayId);
      if (teamId) ids.add(teamId);

      for (const value of Object.values(record)) {
        visit(value);
      }
    };

    visit(payload);

    return [...ids];
  }

  private collectEventIdsFromPayload(payload: Record<string, unknown>): number[] {
    const ids = new Set<number>();

    const visit = (input: unknown): void => {
      if (Array.isArray(input)) {
        for (const item of input) visit(item);
        return;
      }

      if (!input || typeof input !== "object") return;

      const record = input as Record<string, unknown>;
      const eventId = this.asNumber(record.id);
      const homeTeam =
        record.homeTeam && typeof record.homeTeam === "object"
          ? (record.homeTeam as Record<string, unknown>)
          : null;
      const awayTeam =
        record.awayTeam && typeof record.awayTeam === "object"
          ? (record.awayTeam as Record<string, unknown>)
          : null;

      if (eventId && (homeTeam || awayTeam)) ids.add(eventId);

      for (const value of Object.values(record)) {
        visit(value);
      }
    };

    visit(payload);
    return [...ids];
  }

  private async upsertFocusedTournament(
    sport: string,
    category: FocusedCategory,
    tournament: FocusedTournament,
  ): Promise<void> {
    await this.tournamentRepo
      .createQueryBuilder()
      .insert()
      .into(SofaTournamentEntity)
      .values({
        sofaId: tournament.id,
        name: tournament.name,
        slug: tournament.slug,
        sport,
        categoryName: category.name,
        categoryId: category.id,
        categorySlug: category.slug,
        countryAlpha2: category.countryAlpha2 ?? category.alpha2,
        primaryColorHex: tournament.primaryColorHex,
        secondaryColorHex: tournament.secondaryColorHex,
        userCount: tournament.userCount,
        isActive: true,
        lastRefreshedAt: new Date(),
        rawMeta: tournament.rawMeta,
      } as object)
      .orUpdate(
        [
          "name",
          "slug",
          "sport",
          "category_name",
          "category_id",
          "category_slug",
          "country_alpha2",
          "primary_color_hex",
          "secondary_color_hex",
          "user_count",
          "is_active",
          "last_refreshed_at",
          "raw_meta",
          "updated_at",
        ],
        ["sofa_id"],
      )
      .execute();
  }

  private async collectRecentEventTargetsForSport(
    sport: string,
    lookbackDays = 7,
    aheadDays = 7,
    limit = 250,
  ): Promise<
    Array<{
      sofaId: number;
      homeTeamSofaId: number;
      awayTeamSofaId: number;
    }>
  > {
    const nowSec = Math.floor(Date.now() / 1000);
    const fromTimestamp = nowSec - lookbackDays * 24 * 3600;
    const toTimestamp = nowSec + aheadDays * 24 * 3600;

    return this.eventRepo
      .createQueryBuilder("event")
      .where("event.sport = :sport", { sport })
      .andWhere("event.startTimestamp BETWEEN :from AND :to", {
        from: fromTimestamp,
        to: toTimestamp,
      })
      .orderBy("event.startTimestamp", "DESC")
      .limit(limit)
      .select([
        "event.sofaId",
        "event.homeTeamSofaId",
        "event.awayTeamSofaId",
      ])
      .getMany();
  }

  private async collectTournamentSeasonContexts(
    sport: string,
  ): Promise<Map<number, TournamentSeasonContext>> {
    const events = await this.eventRepo.find({
      where: { sport },
      select: [
        "tournamentSofaId",
        "competitionSofaId",
        "seasonId",
        "round",
        "homeTeamSofaId",
        "awayTeamSofaId",
      ],
      order: { startTimestamp: "DESC" },
      take: 5000,
    });

    const contexts = new Map<number, TournamentSeasonContext>();

    for (const event of events) {
      if (!event.tournamentSofaId || !event.seasonId) continue;

      const existing =
        contexts.get(event.tournamentSofaId) ??
        {
          tournamentId: event.tournamentSofaId,
          competitionIds: new Set<number>(),
          seasonIds: new Set<number>(),
          roundsBySeason: new Map<number, Set<number>>(),
          teamIdsBySeason: new Map<number, Set<number>>(),
        };

      existing.seasonIds.add(event.seasonId);
      if (event.competitionSofaId) {
        existing.competitionIds.add(event.competitionSofaId);
      }

      const roundSet =
        existing.roundsBySeason.get(event.seasonId) ?? new Set<number>();
      if (event.round) roundSet.add(event.round);
      existing.roundsBySeason.set(event.seasonId, roundSet);

      const teamSet =
        existing.teamIdsBySeason.get(event.seasonId) ?? new Set<number>();
      teamSet.add(event.homeTeamSofaId);
      teamSet.add(event.awayTeamSofaId);
      existing.teamIdsBySeason.set(event.seasonId, teamSet);

      contexts.set(event.tournamentSofaId, existing);
    }

    return contexts;
  }

  private async collectPlayerTournamentSeasonContextsForSport(
    sport: string,
  ): Promise<Map<number, Array<{ tournamentId: number; seasonId: number }>>> {
    const events = await this.eventRepo.find({
      where: { sport },
      select: [
        "tournamentSofaId",
        "seasonId",
        "homeTeamSofaId",
        "awayTeamSofaId",
      ],
      order: { startTimestamp: "DESC" },
      take: 2000,
    });

    const teamPlayerIds = new Map<number, number[]>();
    const teamIds = await this.collectDistinctTeamIdsForSport(sport);
    for (const teamId of teamIds) {
      const rosterSnapshot = await this.snapshotService
        .findByPath(this.contract.teamPlayers(teamId))
        .catch(() => null);
      if (!rosterSnapshot) continue;

      const players =
        (
          rosterSnapshot.payload as {
            players?: Array<{ player?: { id?: number } }>;
          }
        ).players ?? [];

      teamPlayerIds.set(
        teamId,
        players
          .map((entry) => entry?.player?.id)
          .filter((id): id is number => typeof id === "number"),
      );
    }

    const contexts = new Map<number, Set<string>>();
    for (const event of events) {
      if (!event.tournamentSofaId || !event.seasonId) continue;

      for (const teamId of [event.homeTeamSofaId, event.awayTeamSofaId]) {
        for (const playerId of teamPlayerIds.get(teamId) ?? []) {
          const set = contexts.get(playerId) ?? new Set<string>();
          set.add(`${event.tournamentSofaId}:${event.seasonId}`);
          contexts.set(playerId, set);
        }
      }
    }

    return new Map(
      [...contexts.entries()].map(([playerId, items]) => [
        playerId,
        [...items].map((item) => {
          const [tournamentId, seasonId] = item.split(":").map(Number);
          return { tournamentId, seasonId };
        }),
      ]),
    );
  }

  private async discoverChannelIdsForEvent(eventId: number): Promise<number[]> {
    return this.extractNumberIdsFromSnapshot(
      this.contract.tvEventCountryChannels(eventId),
      ["id", "channelId"],
      undefined,
    );
  }

  private async discoverManagerIdsForEvent(eventId: number): Promise<number[]> {
    return this.extractNumberIdsFromSnapshot(
      this.contract.eventManagers(eventId),
      ["id", "managerId"],
      undefined,
    );
  }

  private async extractNumberIdsFromSnapshot(
    path: string,
    keys: string[],
    arrayProperty?: string,
  ): Promise<number[]> {
    const snapshot = await this.snapshotService.findByPath(path).catch(() => null);
    if (!snapshot) return [];

    const source = arrayProperty
      ? (snapshot.payload as Record<string, unknown>)[arrayProperty]
      : snapshot.payload;

    const values = this.collectNestedValues(source, keys);
    return [...new Set(values.filter((value): value is number => Number.isFinite(value)))];
  }

  private async extractStringIdsFromSnapshot(
    path: string,
    keys: string[],
  ): Promise<string[]> {
    const snapshot = await this.snapshotService.findByPath(path).catch(() => null);
    if (!snapshot) return [];

    const values = this.collectNestedValues(snapshot.payload, keys);
    return [
      ...new Set(
        values.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        ),
      ),
    ];
  }

  private collectNestedValues(
    input: unknown,
    keys: string[],
    acc: Array<number | string> = [],
  ): Array<number | string> {
    if (Array.isArray(input)) {
      for (const item of input) this.collectNestedValues(item, keys, acc);
      return acc;
    }

    if (!input || typeof input !== "object") return acc;

    const record = input as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (keys.includes(key)) {
        if (typeof value === "number" || typeof value === "string") acc.push(value);
      }
      this.collectNestedValues(value, keys, acc);
    }

    return acc;
  }

  private asString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  }

  private asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private normalizeCountryKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z]/g, "");
  }

  private normalizeTournamentKey(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, "");
  }

  private today(): string {
    return formatDateForPath(new Date());
  }

  private tomorrow(): string {
    return formatDateForPath(new Date(Date.now() + 24 * 60 * 60 * 1000));
  }

  private getDateRange(startOffset: number, endOffset: number): string[] {
    const dates: string[] = [];
    for (let offset = startOffset; offset <= endOffset; offset++) {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      dates.push(formatDateForPath(date));
    }
    return dates;
  }

  async refreshRegistries(): Promise<void> {
    await this.countryRegistry.discoverAndRefresh();
    await this.registry.discoverAndRefresh(this.activeSports);
  }

  async runFullFootballBootstrap(): Promise<void> {
    await this.refreshRegistries();
    await this.ingestTournamentMetadata();
    await this.ingestGlobalConfig();
    await this.ingestScheduledEventsForDate(new Date());
    await this.ingestScheduledEventsForDate(
      new Date(Date.now() + 24 * 60 * 60 * 1000),
    );
    await this.refreshLiveTournaments();
    await this.refreshRecentlyFinishedMatches();
    await this.refreshRecentlyFinishedStandings();
    await this.ingestTeamProfiles();
    await this.ingestPlayerProfiles();
    await this.ingestRecentAndUpcomingEventBundles();
  }

  private collectUniqueTournamentIds(payload: Record<string, unknown>): number[] {
    const rawEvents = Array.isArray(payload.events) ? payload.events : [];
    const ids = new Set<number>();

    for (const rawEvent of rawEvents) {
      const event = rawEvent as {
        tournament?: { uniqueTournament?: { id?: unknown } };
      };
      const id = event.tournament?.uniqueTournament?.id;
      if (typeof id === "number" && Number.isFinite(id)) ids.add(id);
    }

    return [...ids];
  }

  private emptyResult(job?: IngestionJob): IngestionResult {
    return {
      pathsFetched: 0,
      rowsUpserted: 0,
      errorCount: 0,
      errorDetails: [],
      job,
      progressFlushEvery: Math.max(
        1,
        this.configService.get<number>("ingestion.progressFlushEvery") ?? 50,
      ),
      attemptsSinceProgressFlush: 0,
    };
  }

  /**
   * One provider path through {@link SnapshotService.getOrFetch}. Increments
   * `rowsUpserted` by **1 per successful path** (approximate snapshot row count);
   * when `afterFetch` normalizes scheduled events, additional rows are added there.
   * Errors are counted but do not abort the whole job unless `afterFetch` throws.
   *
   * @param sport Optional sport slug override; defaults to `this.sport` (football).
   */
  private async fetchOne(
    path: string,
    result: IngestionResult,
    afterFetch?: (payload: Record<string, unknown>) => Promise<void>,
    sport?: string,
  ): Promise<{ ok: boolean; payload?: Record<string, unknown> }> {
    try {
      const { payload } = await this.snapshotService.getOrFetch(
        path,
        {},
        sport ?? this.sport,
      );
      result.pathsFetched++;
      result.rowsUpserted++;
      if (afterFetch) await afterFetch(payload);
      await this.flushProgressIfNeeded(result, path);
      return { ok: true, payload };
    } catch (err) {
      result.errorCount++;
      result.errorDetails.push({ path, error: (err as Error).message });
      this.logger.warn(`Failed to ingest ${path}: ${(err as Error).message}`);
      await this.flushProgressIfNeeded(result, path);
      return { ok: false };
    }
  }

  private async flushProgressIfNeeded(
    result: IngestionResult,
    path: string,
  ): Promise<void> {
    if (!result.job) return;

    result.attemptsSinceProgressFlush++;
    if (result.attemptsSinceProgressFlush < result.progressFlushEvery) return;

    result.attemptsSinceProgressFlush = 0;
    await this.jobTracker.updateJobProgress(result.job, result);
    this.logger.log(
      `[${result.job.jobType}] progress flush after ${result.progressFlushEvery} attempts; lastPath=${path}`,
    );
  }

  /** Rate-limits provider calls so parallel crons + proxy are less likely to trip upstream limits. */
  private delay(ms?: number): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(resolve, ms ?? this.requestDelayMs),
    );
  }
}

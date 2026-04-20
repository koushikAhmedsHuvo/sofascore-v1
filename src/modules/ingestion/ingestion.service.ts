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
import { EventStatus } from "../../shared/enums/event-status.enum";
import { formatDateForPath, dateRange } from "../../shared/utils/path.utils";

interface IngestionResult {
  pathsFetched: number;
  rowsUpserted: number;
  errorCount: number;
  errorDetails: Record<string, unknown>[];
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
  ) {
    this.requestDelayMs =
      this.configService.get<number>("ingestion.requestDelayMs") ?? 500;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private get sport(): string {
    return this.contract.getDefaultSport();
  }

  /** All sports enabled for active ingestion — driven by `SOFA_ACTIVE_SPORTS` env var. */
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

    for (const sport of this.activeSports) {
      const ids = this.registry.getActiveTournamentIds(sport);
      if (!ids.length) continue;

      const job = await this.jobTracker.startJob("scheduled-events", {
        date: dateStr,
        sport,
        tournamentCount: ids.length,
      });
      const result = this.emptyResult();

      try {
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
          await this.snapshotService.getOrFetch(path, {}, sport);
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
    const result = this.emptyResult();

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
    const result = this.emptyResult();

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
    await this.registry.discoverAndRefresh();

    const lookback = this.contract.getTournamentSeasonsLookback();

    for (const sport of this.activeSports) {
      const ids = this.registry.getActiveTournamentIds(sport);

      const job = await this.jobTracker.startJob("metadata-tournaments", {
        sport,
        tournamentCount: ids.length,
      });
      const result = this.emptyResult();

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
    const result = this.emptyResult();

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
      const result = this.emptyResult();

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
      where: { statusType: EventStatus.FINISHED },
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
    const result = this.emptyResult();

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
   * @param limit   Max number of distinct player IDs to process per run
   *                (default 200 — tune via cron or manual trigger).
   * @param eventSampleSize  How many recent events to scan for team IDs.
   */
  async ingestPlayerStatistics(
    limit = 200,
    eventSampleSize = 100,
  ): Promise<void> {
    // 1. Distinct team IDs from recent events (no new injection needed)
    const recentEvents = await this.eventRepo.find({
      order: { startTimestamp: "DESC" },
      take: eventSampleSize,
      select: ["homeTeamSofaId", "awayTeamSofaId"],
    });

    const teamIds = [
      ...new Set(
        recentEvents.flatMap((e) => [e.homeTeamSofaId, e.awayTeamSofaId]),
      ),
    ];

    const job = await this.jobTracker.startJob("player-statistics", {
      teamCount: teamIds.length,
      playerLimit: limit,
    });
    const result = this.emptyResult();
    const seenPlayerIds = new Set<number>();

    try {
      outer: for (const teamId of teamIds) {
        // 2. Roster snapshot — DB only, no provider fallback
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

        // 3. Extract player IDs
        for (const entry of players) {
          const playerId = entry?.player?.id;
          if (!playerId || seenPlayerIds.has(playerId)) continue;
          seenPlayerIds.add(playerId);

          // 4. Fetch statistics bundle through the normal DB-first cache
          for (const path of this.contract.playerStatisticsBundlePaths(
            playerId,
          )) {
            await this.fetchOne(path, result);
            await this.delay();
          }

          if (seenPlayerIds.size >= limit) break outer;
        }
      }

      this.logger.log(
        `[player-statistics] processed ${seenPlayerIds.size} players from ${teamIds.length} teams`,
      );
      await this.jobTracker.finishJob(job, result);
    } catch (err) {
      await this.jobTracker.failJob(job, err as Error);
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private emptyResult(): IngestionResult {
    return {
      pathsFetched: 0,
      rowsUpserted: 0,
      errorCount: 0,
      errorDetails: [],
    };
  }

  /**
   * One provider path through {@link SnapshotService.getOrFetch}. Increments
   * `rowsUpserted` by **1 per successful path** (approximate snapshot row count);
   * when `afterFetch` normalizes scheduled events, additional rows are added there.
   * Errors are counted but do not abort the whole job unless `afterFetch` throws.
   */
  private async fetchOne(
    path: string,
    result: IngestionResult,
    afterFetch?: (payload: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    try {
      const { payload } = await this.snapshotService.getOrFetch(
        path,
        {},
        this.sport,
      );
      result.pathsFetched++;
      result.rowsUpserted++;
      if (afterFetch) await afterFetch(payload);
    } catch (err) {
      result.errorCount++;
      result.errorDetails.push({ path, error: (err as Error).message });
      this.logger.warn(`Failed to ingest ${path}: ${(err as Error).message}`);
    }
  }

  /** Rate-limits provider calls so parallel crons + proxy are less likely to trip upstream limits. */
  private delay(ms?: number): Promise<void> {
    return new Promise((resolve) =>
      setTimeout(resolve, ms ?? this.requestDelayMs),
    );
  }
}

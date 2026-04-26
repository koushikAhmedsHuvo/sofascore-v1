import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { IngestionService } from "./ingestion.service";
import { IngestionJobTrackerService } from "./ingestion-job-tracker.service";
import { SofaContractService } from "../contract/sofa-contract.service";
import { CountryRegistryService } from "../registry/country-registry.service";
import { TournamentRegistryService } from "../registry/tournament-registry.service";
import {
  ApiCoverageResponseDto,
  BackfillMatchDetailsBodyDto,
  BackfillScheduledEventsBodyDto,
  EventBundleTriggerResponseDto,
  IngestionJobsQueryDto,
  IngestionJobStatsResponseDto,
  IngestionJobsListResponseDto,
  MessageResponseDto,
  ScheduledEventsIngestBodyDto,
} from "../../common/dto";

/**
 * Internal ops triggers for ingestion crons and backfills.
 *
 * **Security:** expose only on private networks — nginx should allow-list
 * `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, or VPN IPs.
 */
@ApiTags("Ingestion (Internal / Ops)")
@Controller("internal/ingestion")
export class IngestionController {
  constructor(
    private readonly ingestionService: IngestionService,
    private readonly jobTracker: IngestionJobTrackerService,
    private readonly countryRegistry: CountryRegistryService,
    private readonly tournamentRegistry: TournamentRegistryService,
    private readonly contract: SofaContractService,
  ) {}

  // ─── Backfill ─────────────────────────────────────────────────────────────

  @Post("backfill/scheduled-events")
  @ApiOperation({
    summary: "Historical scheduled-events backfill",
    description:
      "Fetches `unique-tournament/{id}/scheduled-events/{date}` for every active tournament " +
      "across the configured lookback window. Idempotent (upserts into `raw_snapshots`).",
  })
  @ApiBody({ type: BackfillScheduledEventsBodyDto, required: false })
  @ApiOkResponse({
    type: MessageResponseDto,
    description: "Job accepted — processing continues asynchronously.",
  })
  async triggerBackfill(
    @Body() body: BackfillScheduledEventsBodyDto,
  ): Promise<MessageResponseDto> {
    void this.ingestionService.backfillHistoricalEvents(body?.daysBack);
    return {
      message:
        "Scheduled-events backfill started. Monitor via GET /internal/ingestion/jobs.",
    };
  }

  @Post("backfill/match-details")
  @ApiOperation({
    summary: "Backfill match-detail bundles for finished events",
    description:
      "Walks recent rows in `sofa_events` with FINISHED status and pulls the full " +
      "match-detail path bundle (incidents, stats, h2h, …).",
  })
  @ApiBody({ type: BackfillMatchDetailsBodyDto, required: false })
  @ApiOkResponse({ type: MessageResponseDto })
  async triggerMatchDetailBackfill(
    @Body() body: BackfillMatchDetailsBodyDto,
  ): Promise<MessageResponseDto> {
    void this.ingestionService.backfillMatchDetailsForFinishedEvents(
      body?.limit ?? 100,
    );
    return { message: "Match-detail backfill started." };
  }

  // ─── On-demand ingestion ──────────────────────────────────────────────────

  @Post("scheduled-events")
  @ApiOperation({
    summary: "Ingest scheduled events for a specific date",
    description:
      "Fetches scheduled-events for all priority tournaments for a single calendar day.",
  })
  @ApiBody({ type: ScheduledEventsIngestBodyDto, required: false })
  @ApiOkResponse({ type: MessageResponseDto })
  async triggerScheduledEvents(
    @Body() body: ScheduledEventsIngestBodyDto,
  ): Promise<MessageResponseDto> {
    const date = body?.date ? new Date(body.date) : new Date();
    void this.ingestionService.ingestScheduledEventsForDate(date);
    return {
      message: `Ingestion triggered for ${date.toISOString().split("T")[0]}`,
    };
  }

  @Post("event/:eventId/bundle")
  @ApiOperation({
    summary: "Ingest full match-detail bundle for a single event",
    description:
      "Fetches every path in `SofaContractService.matchDetailPaths` for the given event id.",
  })
  @ApiParam({
    name: "eventId",
    type: "number",
    description: "SofaScore event / match id",
    example: 13981730,
  })
  @ApiOkResponse({ type: EventBundleTriggerResponseDto })
  async triggerEventBundle(
    @Param("eventId", ParseIntPipe) eventId: number,
  ): Promise<EventBundleTriggerResponseDto> {
    const paths = this.contract.matchDetailPaths(eventId);
    void this.ingestionService.ingestMatchDetailBundle(eventId);
    return { message: `Match bundle triggered for event ${eventId}`, paths };
  }

  @Post("team/:teamId/bundle")
  @ApiOperation({
    summary: "Ingest full team profile bundle",
    description:
      "Runs `teamBundlePaths(teamId)` — roster, stats, fixtures, etc.",
  })
  @ApiParam({
    name: "teamId",
    type: "number",
    description: "SofaScore team id",
  })
  @ApiOkResponse({ type: MessageResponseDto })
  async triggerTeamBundle(
    @Param("teamId", ParseIntPipe) teamId: number,
  ): Promise<MessageResponseDto> {
    void this.ingestionService.ingestTeamBundle(teamId);
    return { message: `Team bundle triggered for team ${teamId}` };
  }

  @Post("tournament/:tournamentId/metadata")
  @ApiOperation({
    summary: "Ingest tournament metadata",
    description:
      "Note: the current service implementation refreshes metadata for **all** " +
      "tracked tournaments via `ingestTournamentMetadata()` — the path param is accepted for routing symmetry.",
  })
  @ApiParam({
    name: "tournamentId",
    type: "number",
    description: "SofaScore unique tournament id (informational)",
    example: 17,
  })
  @ApiOkResponse({ type: MessageResponseDto })
  async triggerTournamentMetadata(
    @Param("tournamentId", ParseIntPipe) tournamentId: number,
  ): Promise<MessageResponseDto> {
    void this.ingestionService.ingestTournamentMetadata();
    return {
      message: `Tournament ${tournamentId} metadata ingestion triggered`,
    };
  }

  @Post("global-config")
  @ApiOperation({
    summary: "Refresh global config and reference data",
    description:
      "Uses `CountryRegistryService` country codes + `SofaContractService.globalConfigPaths`.",
  })
  @ApiOkResponse({ type: MessageResponseDto })
  async triggerGlobalConfig(): Promise<MessageResponseDto> {
    void this.ingestionService.ingestGlobalConfig();
    return { message: "Global config ingestion triggered" };
  }

  @Post("metadata")
  @ApiOperation({
    summary: "Refresh all tournament metadata",
    description:
      "Runs the full tournament metadata job for every active tournament id.",
  })
  @ApiOkResponse({ type: MessageResponseDto })
  async triggerMetadata(): Promise<MessageResponseDto> {
    void this.ingestionService.ingestTournamentMetadata();
    return { message: "Metadata ingestion triggered" };
  }

  // ─── Monitoring ───────────────────────────────────────────────────────────

  @Get("jobs")
  @ApiOperation({
    summary: "Recent ingestion job audit log",
    description: "Newest jobs first — backed by `ingestion_jobs` table.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "number",
    example: 50,
    description: "Max rows (default 50)",
  })
  @ApiQuery({
    name: "jobType",
    required: false,
    type: "string",
    example: "scheduled-events",
    description: "Filter jobs by exact job type",
  })
  @ApiOkResponse({ type: IngestionJobsListResponseDto })
  async getJobs(
    @Query() query: IngestionJobsQueryDto,
  ): Promise<IngestionJobsListResponseDto> {
    const jobs = await this.jobTracker.getRecentJobs(
      query.limit ?? 50,
      query.jobType?.trim() || undefined,
    );
    return { jobs };
  }

  @Get("jobs/stats")
  @ApiOperation({
    summary: "Ingestion job aggregate statistics",
  })
  @ApiOkResponse({ type: IngestionJobStatsResponseDto })
  async getJobStats(): Promise<IngestionJobStatsResponseDto> {
    return this.jobTracker.getJobStats();
  }

  @Post("jobs/mark-running-stale")
  @ApiOperation({
    summary: "Mark currently RUNNING ingestion jobs as failed/stale",
    description:
      "Ops helper for a fresh analysis run after a server restart or interrupted cron. " +
      "It does not stop in-process work; use it only when those RUNNING rows are known stale.",
  })
  @ApiOkResponse({ type: MessageResponseDto })
  async markRunningJobsStale(): Promise<MessageResponseDto> {
    const count = await this.jobTracker.markRunningJobsStale(
      "Manually marked stale via POST /internal/ingestion/jobs/mark-running-stale.",
    );
    return { message: `Marked ${count} RUNNING job(s) as stale.` };
  }

  @Get("api-coverage")
  @ApiOperation({
    summary: "SofaScore API coverage map",
    description:
      "Machine-readable catalog of path templates implemented in `SofaContractService`, " +
      "plus live registry state for documentation and client onboarding.",
  })
  @ApiOkResponse({ type: ApiCoverageResponseDto })
  getCoverage(): ApiCoverageResponseDto {
    const activeCountries = this.countryRegistry.getActiveCountryCodes();
    const activeTournaments = this.tournamentRegistry.getActiveTournamentIds();

    return {
      providerBaseUrl: this.contract.getProviderBaseUrl(),
      defaultSport: this.contract.getDefaultSport(),
      oddsProviderId: this.contract.getOddsProviderId(),
      teamEventsPageIndex: this.contract.getTeamEventsPageIndex(),
      tournamentSeasonsLookback: this.contract.getTournamentSeasonsLookback(),
      healthProbeUrl: this.contract.getProviderHealthCheckUrl(),
      registryState: {
        activeCountryCodes: activeCountries,
        activeTournamentCount: activeTournaments.length,
        activeTournamentIdsSample: activeTournaments.slice(0, 10),
        trackedSports: this.tournamentRegistry.getTrackedSports(),
      },
      note:
        "Path templates from SofaContractService; country/tournament lists from CountryRegistryService + TournamentRegistryService. " +
        "`documentedPathTemplates` is the full catalog from `Sofascore api documentation/` captures.",
      documentedPathTemplates: [...this.contract.documentedPathTemplates()],
      resolvedPathExamples: {
        globalConfigPaths: this.contract
          .globalConfigPaths(activeCountries.slice(0, 2))
          .slice(0, 10),
        firstTournamentScheduledEvents: activeTournaments
          .slice(0, 3)
          .map((id) =>
            this.contract.scheduledEvents(
              id,
              new Date().toISOString().split("T")[0],
            ),
          ),
      },
      coverage: {
        note: "Paths verified against: sofascore.com (Antigravity), developer_finding.txt, matchstat_nextjs, football-nest-api proxy, sofascore-wrapper.",
        "sport-level": [
          "sport/{sport}/categories",
          "sport/{sport}/categories/all",
          "sport/{sport}/live-tournaments",
          "sport/{sport}/events/live",
          "sport/{sport}/scheduled-tournaments/{date}",
          "sport/{sport}/scheduled-tournaments/{date}/page/{page}",
          "sport/{sport}/scheduled-events/{date}",
          "sport/{sport}/trending-top-players",
          "sport/{numericId}/event-count",
        ],
        "tournament-scheduled-events": [
          "unique-tournament/{id}/scheduled-events/{date}",
        ],
        "match-detail-bundle (proactively ingested)": [
          "event/{id}",
          "event/{id}/incidents",
          "event/{id}/statistics",
          "event/{id}/lineups",
          "event/{id}/shotmap",
          "event/{id}/shotmap/{teamId}",
          "event/{id}/heatmap/{teamId}",
          "event/{id}/graph/win-probability",
          "event/{id}/graph",
          "event/{id}/point-by-point",
          "event/{id}/points/overview",
          "event/{id}/innings",
          "event/{id}/pregame-form",
          "event/{id}/h2h",
          "event/{id}/h2h/events",
          "event/{id}/team-streaks",
          "event/{id}/best-players",
          "event/{id}/best-players/summary",
          "event/{id}/managers",
          "event/{id}/highlights",
          "event/{id}/votes",
          "event/{id}/official-tweets",
          "event/{id}/comments",
          "event/{id}/ai-insights/{lang}",
          "event/{id}/meta",
          "event/{id}/media/summary/country/{cc}",
          "tv/event/{id}/country-channels",
          "tv/channel/{channelId}/schedule",
          "event/{id}/odds/{providerId}/featured",
          "event/{id}/odds/{providerId}/all",
          "event/{id}/provider/{providerId}/winning-odds",
          "event/newly-added-events",
        ],
        "live-volatile (polled every 30s during match)": [
          "event/{id}/incidents",
          "event/{id}/statistics",
          "event/{id}/lineups",
          "event/{id}/graph/win-probability",
          "event/{id}/graph",
          "event/{id}/team-streaks",
          "event/{id}/points/overview",
        ],
        "team-bundle": [
          "team/{id}",
          "team/{id}/rankings",
          "team/{id}/team-statistics/seasons",
          "team/{id}/recent-unique-tournaments",
          "team/{id}/performance",
          "team/{id}/featured-event",
          "team/{id}/featured-players",
          "team/{id}/players",
          "team/{id}/near-events",
          "team/{id}/events/next/{page}",
          "team/{id}/events/last/{page}",
          "team/{id}/transfers",
          "team/{id}/media",
          "team/{id}/unique-tournaments/all",
          "team/{id}/achievements",
          "team/{id}/grand-slam/best-results",
          "team/{id}/standings/seasons",
          "team/{id}/unique-tournament/{tid}/season/{sid}/statistics/overall|home|away",
          "team/{id}/unique-tournament/{tid}/season/{sid}/player-statistics/{kind}",
          "team/{id}/unique-tournament/{tid}/season/{sid}/top-players/overall|home|away",
          "unique-tournament/{tid}/season/{sid}/team/{id}/team-performance-graph-data",
        ],
        player: [
          "player/{id}",
          "player/{id}/performance",
          "player/{id}/statistics",
          "player/{id}/statistics/seasons",
          "player/{id}/last-year-summary",
          "player/{id}/unique-tournaments",
          "player/{id}/unique-tournament/{tid}/season/{sid}/statistics/overall|home|away",
          "player/{id}/transfer-history",
          "player/{id}/national-team-statistics",
          "player/{id}/attribute-overviews",
          "player/{id}/events/last/{page}",
          "player/{id}/media",
          "player/{id}/media/videos",
          "fantasy/player/{id}/competitions",
        ],
        manager: ["manager/{id}", "manager/{id}/career-history"],
        "tournament-metadata (nightly cron)": [
          "unique-tournament/{id}",
          "unique-tournament/{id}/seasons",
          "unique-tournament/{id}/season/{sid}/info",
          "unique-tournament/{id}/season/{sid}/rounds",
          "unique-tournament/{id}/season/{sid}/events/round/{round}",
          "unique-tournament/{id}/season/{sid}/standings/total|home|away",
          "unique-tournament/{id}/season/{sid}/cuptrees",
          "unique-tournament/{id}/season/{sid}/top-players/overall|rating|goals",
          "unique-tournament/{id}/season/{sid}/top-players/{slug}",
          "unique-tournament/{id}/season/{sid}/player-statistics/types",
          "unique-tournament/{id}/season/{sid}/events/next/{page}",
          "unique-tournament/{id}/season/{sid}/top-players-per-game/all/overall",
          "unique-tournament/{id}/season/{sid}/top-ratings/overall",
          "unique-tournament/{id}/season/{sid}/top-teams/overall",
          "unique-tournament/{id}/season/{sid}/team-events/total",
          "unique-tournament/{id}/season/{sid}/team-of-the-week/rounds",
          "unique-tournament/{id}/season/{sid}/team-of-the-week/{round}",
          "unique-tournament/{id}/season/{sid}/player-of-the-season",
          "unique-tournament/{id}/media",
          "tournament/{id}/season/{sid}/standings/total",
          "category/{id}/unique-tournaments",
        ],
        "global-config (nightly cron)": [
          "country/alpha2",
          "config/country-sport-priorities/country",
          "config/country-sport-priorities/country/{cc}",
          "config/default-unique-tournaments/{cc}/{sport}",
          "config/top-unique-tournaments/{cc}/{sport}",
          "config/top-unique-tournaments/00/{sport}",
          "odds/providers/{cc}/web",
          "odds/providers/{cc}/web-odds",
          "odds/providers/{cc}/web-featured",
          "branding/providers/{cc}/web",
          "odds/top-team-streaks/wins/all",
          "odds/{provider}/featured-events/{sport}",
          "odds/{provider}/featured-events-by-popularity/{sport}",
          "sofascore-news/{lang}/posts",
          "event/newly-added-events",
        ],
        "tennis-rankings": ["rankings/type/1  (ATP)", "rankings/type/2  (WTA)"],
        "search (on-demand via proxy, not pre-ingested)": [
          "search/all/?q={query}&page={page}",
          "search/events/?q={query}&page={page}",
          "search/player-team-persons/?q={query}&page={page}",
          "search/teams/?q={query}&page={page}",
          "search/unique-tournaments/?q={query}&page={page}",
          "search/suggestions/default",
        ],
        "image-cdn (img.sofascore.com — different host, no proxy)": [
          "https://img.sofascore.com/api/v1/player/{id}/image",
          "https://img.sofascore.com/api/v1/team/{id}/image",
          "https://img.sofascore.com/api/v1/unique-tournament/{id}/image",
          "https://img.sofascore.com/api/v1/category/{id}/image",
          "https://img.sofascore.com/api/v1/country/{cc}/flag",
        ],
        "wildcard-proxy (catch-all)": [
          "ANY SofaScore-compatible path → DB cache-aside → provider fallback",
          "Paths not proactively ingested are served on-demand and cached",
        ],
      },
    };
  }
}

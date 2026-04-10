import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { appendQueryString, SofascoreNewsPostsQueryParams } from './sofa-api-query-params';
import { SOFASCORE_DOCUMENTED_PATH_TEMPLATES } from './sofa-documented-paths.catalog';

/**
 * **Singleton** (Nest default scope): one instance per application process.
 *
 * Single source of truth for every SofaScore-compatible API path used across
 * the matchstat ecosystem. Verified against:
 *   - developer_finding.txt  (scraped from live SofaScore pages)
 *   - matchstat_nextjs src   (all API_SOFA_SPORTS_BASE_URL usages)
 *   - football-nest-api      (h2h wildcard proxy paths)
 *   - sofascore-client-requirements-and-implementation.txt
 *   - Sofascore api documentation/ (live captures: cricket, NFL, handball, etc.)
 *
 * When the provider changes a path or you add a new feature, edit ONLY here.
 * All other services inject this service rather than constructing strings.
 */
@Injectable()
export class SofaContractService {
  constructor(private readonly config: ConfigService) {}

  // ─── Provider / HTTP ───────────────────────────────────────────────────────

  getProviderBaseUrl(): string {
    return (
      this.config.get<string>('provider.baseUrl') ??
      'https://sportsdata365.com/football/api/v1/h2h/sports'
    );
  }

  /** Full URL for Terminus HTTP ping (provider liveness). */
  getProviderHealthCheckUrl(): string {
    const rel =
      this.config.get<string>('sofaContract.healthProbeRelativePath') ??
      'sport/football/categories/all';
    const base = this.getProviderBaseUrl().replace(/\/+$/, '');
    return `${base}/${rel.replace(/^\/+/, '')}`;
  }

  /**
   * Headers for every outbound provider request.
   *
   * Auth header is only added when PROVIDER_API_KEY is set — sportsdata365
   * does not require a per-request key (subscription is IP/domain-based).
   * If a future provider requires one, set PROVIDER_API_KEY in env.
   */
  buildProviderHeaders(): Record<string, string> {
    const apiKey    = this.config.get<string>('provider.apiKey') ?? '';
    const authHdr   = this.config.get<string>('provider.authHeaderName') ?? 'x-api-key';
    const referer   = this.config.get<string>('provider.referer')   ?? 'https://www.sofascore.com';
    const origin    = this.config.get<string>('provider.origin')    ?? 'https://www.sofascore.com';
    const userAgent = this.config.get<string>('provider.userAgent') ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    const headers: Record<string, string> = {
      'User-Agent':      userAgent,
      Referer:           referer,
      Origin:            origin,
      Accept:            'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control':   'no-cache',
    };

    if (apiKey) headers[authHdr] = apiKey;
    return headers;
  }

  // ─── Config tunables ───────────────────────────────────────────────────────

  getDefaultSport(): string {
    return this.config.get<string>('sofaContract.defaultSport') ?? 'football';
  }

  getOddsProviderId(): number {
    return this.config.get<number>('sofaContract.oddsProviderId') ?? 1;
  }

  getTeamEventsPageIndex(): number {
    return this.config.get<number>('sofaContract.teamEventsPageIndex') ?? 0;
  }

  getTournamentSeasonsLookback(): number {
    return this.config.get<number>('sofaContract.tournamentSeasonsLookback') ?? 2;
  }

  /**
   * Returns the seed country codes from env (`SOFA_CONFIG_COUNTRY_CODES`).
   * This is used ONLY as an emergency fallback by CountryRegistryService
   * when the DB table is empty (first startup before discovery runs).
   *
   * All production callers should use CountryRegistryService.getActiveCountryCodes()
   * instead of this method — it returns the dynamically discovered list.
   */
  getConfigCountryCodes(): string[] {
    return this.config.get<string[]>('sofaContract.configCountryCodes') ?? [];
  }

  // =========================================================================
  // PATH BUILDERS — verified against live matchstat client code
  // =========================================================================

  // ─── Sport-level ──────────────────────────────────────────────────────────

  /** `sport/football/categories/all`  — all competition categories */
  sportCategoriesAll(sport = this.getDefaultSport()): string {
    return `sport/${sport}/categories/all`;
  }

  /**
   * `sport/american-football/categories` (without `/all`)
   * Some clients load the lighter category index before `/categories/all`.
   * Captured in Sofascore api documentation (american football home page).
   */
  sportCategories(sport = this.getDefaultSport()): string {
    return `sport/${sport}/categories`;
  }

  /** `sport/football/live-tournaments` */
  sportLiveTournaments(sport = this.getDefaultSport()): string {
    return `sport/${sport}/live-tournaments`;
  }

  /**
   * `sport/volleyball/live-categories`
   * Volleyball home capture — live categories strip.
   */
  sportLiveCategories(sport = this.getDefaultSport()): string {
    return `sport/${sport}/live-categories`;
  }

  /**
   * `sport/volleyball/2026-04-09/21600/categories`
   * Date + inner sport id segment (captured on volleyball home).
   */
  sportCategoriesForDateSegment(
    dateYyyyMmDd: string,
    segmentId: string | number,
    sport = this.getDefaultSport(),
  ): string {
    return `sport/${sport}/${dateYyyyMmDd}/${segmentId}/categories`;
  }

  /** `sport/football/events/live` — live event feed */
  sportEventsLive(sport = this.getDefaultSport()): string {
    return `sport/${sport}/events/live`;
  }

  /** `sport/football/scheduled-tournaments/2026-04-04` (non-paginated) */
  sportScheduledTournaments(dateYyyyMmDd: string, sport = this.getDefaultSport()): string {
    return `sport/${sport}/scheduled-tournaments/${dateYyyyMmDd}`;
  }

  /**
   * `sport/football/scheduled-tournaments/2026-04-04/page/1`
   * Paginated — Antigravity live capture confirmed SofaScore adds `/page/{n}`
   * when there are many tournaments on a given date.
   */
  sportScheduledTournamentsPaged(
    dateYyyyMmDd: string,
    page: number,
    sport = this.getDefaultSport(),
  ): string {
    return `sport/${sport}/scheduled-tournaments/${dateYyyyMmDd}/page/${page}`;
  }

  /**
   * `sport/tennis/scheduled-events/2026-04-04`
   * Returns ALL individual matches (not just tournament lists) for a sport/date.
   * Distinct from `scheduled-tournaments`. Confirmed for tennis tab (Antigravity).
   */
  sportScheduledEvents(dateYyyyMmDd: string, sport = this.getDefaultSport()): string {
    return `sport/${sport}/scheduled-events/${dateYyyyMmDd}`;
  }

  /**
   * `sport/football/event-count` or `sport/21600/event-count`
   * Home page fires numeric ID (21600 = football). Slug works too.
   */
  sportEventCount(sportId: string | number): string {
    return `sport/${sportId}/event-count`;
  }

  /**
   * `sport/football/trending-top-players`
   * Home page trending players widget. Antigravity live capture.
   */
  sportTrendingTopPlayers(sport = this.getDefaultSport()): string {
    return `sport/${sport}/trending-top-players`;
  }

  // ─── Tournament / unique-tournament ───────────────────────────────────────

  /** `unique-tournament/7` */
  uniqueTournament(tournamentId: number): string {
    return `unique-tournament/${tournamentId}`;
  }

  /** `unique-tournament/7/seasons` */
  uniqueTournamentSeasons(tournamentId: number): string {
    return `unique-tournament/${tournamentId}/seasons`;
  }

  /**
   * `unique-tournament/11093/winners`
   * Past winners / roll of honour (volleyball league capture).
   */
  uniqueTournamentWinners(tournamentId: number): string {
    return `unique-tournament/${tournamentId}/winners`;
  }

  /** `unique-tournament/7/scheduled-events/2026-04-04` */
  scheduledEvents(tournamentId: number, dateYyyyMmDd: string): string {
    return `unique-tournament/${tournamentId}/scheduled-events/${dateYyyyMmDd}`;
  }

  // ─── Season-specific paths ─────────────────────────────────────────────────

  /** `unique-tournament/7/season/61627/standings/total` */
  standingsTotal(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/standings/total`;
  }

  /** `unique-tournament/7/season/61627/standings/home` */
  standingsHome(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/standings/home`;
  }

  /** `unique-tournament/7/season/61627/standings/away` */
  standingsAway(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/standings/away`;
  }

  /**
   * `tournament/7/season/61627/standings/total`
   * Some clients use `tournament` (non-unique) root — kept separate to avoid
   * confusion. Both are proxied identically.
   */
  tournamentStandings(tournamentId: number, seasonId: number): string {
    return `tournament/${tournamentId}/season/${seasonId}/standings/total`;
  }

  /**
   * `tournament/40604/season/91185/standings/home`
   * Non-unique `tournament/{id}` competition id (see event.tournament.id in captures).
   */
  competitionTournamentStandingsHome(tournamentId: number, seasonId: number): string {
    return `tournament/${tournamentId}/season/${seasonId}/standings/home`;
  }

  /**
   * `tournament/40604/season/91185/standings/away`
   * Non-unique competition id — away table.
   */
  competitionTournamentStandingsAway(tournamentId: number, seasonId: number): string {
    return `tournament/${tournamentId}/season/${seasonId}/standings/away`;
  }

  /** `unique-tournament/7/season/61627/cuptrees` — bracket structure */
  cupTrees(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/cuptrees`;
  }

  /** `unique-tournament/7/season/61627/top-players/rating` */
  topPlayersRating(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/top-players/rating`;
  }

  /** `unique-tournament/7/season/61627/top-players/goals` */
  topPlayersGoals(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/top-players/goals`;
  }

  /**
   * `unique-tournament/7/season/61627/team-events/total`
   * Used by the sofa-h2h tournament standings section to list all team fixtures
   * within a season (needed for standings context).
   */
  tournamentSeasonTeamEvents(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/team-events/total`;
  }

  /**
   * `unique-tournament/7/season/61627/info` — season info (start/end dates, round count)
   */
  tournamentSeasonInfo(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/info`;
  }

  /**
   * `unique-tournament/7/season/61627/rounds` — list of all rounds in season
   */
  tournamentSeasonRounds(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/rounds`;
  }

  /**
   * `unique-tournament/7/season/61627/events/round/1` — all matches in a round
   */
  tournamentSeasonRoundEvents(
    tournamentId: number,
    seasonId: number,
    round: number,
  ): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/events/round/${round}`;
  }

  /**
   * `unique-tournament/77/season/61027/events/round/29/slug/final`
   * Round feed with named slug segment (e.g. final).
   */
  tournamentSeasonRoundEventsSlug(
    tournamentId: number,
    seasonId: number,
    round: number,
    slug: string,
  ): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/events/round/${round}/slug/${slug}`;
  }

  /**
   * `unique-tournament/77/season/61027/editors` — editorial / picks metadata.
   */
  tournamentSeasonEditors(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/editors`;
  }

  /** `unique-tournament/7/season/61627/top-players/overall` — season top scorers etc. */
  tournamentTopPlayersOverall(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/top-players/overall`;
  }

  /**
   * `unique-tournament/9464/season/75522/top-players/regularSeason`
   * American football and other sports use a slug instead of `overall` / `goals`.
   */
  tournamentSeasonTopPlayersSlug(
    tournamentId: number,
    seasonId: number,
    slug: string,
  ): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/top-players/${slug}`;
  }

  /**
   * `unique-tournament/11165/season/91185/player-statistics/types`
   * Lists which player stat breakdowns exist for the season.
   */
  tournamentSeasonPlayerStatisticsTypes(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/player-statistics/types`;
  }

  /**
   * `unique-tournament/11165/season/91185/events/next/0`
   * Paginated “next” events within a league season.
   */
  tournamentSeasonEventsNext(
    tournamentId: number,
    seasonId: number,
    page = 0,
  ): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/events/next/${page}`;
  }

  /** `unique-tournament/7/season/61627/top-players-per-game/all/overall` */
  tournamentTopPlayersPerGame(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/top-players-per-game/all/overall`;
  }

  /**
   * `unique-tournament/23/season/76457/top-ratings/overall`
   * Returns **ratings**-based top player list (different from top-players/scorers).
   * Confirmed from Antigravity: home page fires this for each featured league.
   * `type` can be `overall` | `home` | `away`.
   */
  tournamentTopRatings(
    tournamentId: number,
    seasonId: number,
    type: 'overall' | 'home' | 'away' = 'overall',
  ): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/top-ratings/${type}`;
  }

  /** `unique-tournament/7/season/61627/top-teams/overall` — top teams by stats */
  tournamentTopTeamsOverall(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/top-teams/overall`;
  }

  /** `unique-tournament/7/season/61627/team-of-the-week/rounds` */
  tournamentTeamOfWeekRounds(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/team-of-the-week/rounds`;
  }

  /**
   * `unique-tournament/9464/season/75522/team-of-the-week/periods`
   * NFL and some leagues use `periods` instead of `rounds`.
   */
  tournamentTeamOfWeekPeriods(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/team-of-the-week/periods`;
  }

  /** `unique-tournament/7/season/61627/team-of-the-week/{round}` */
  tournamentTeamOfWeek(tournamentId: number, seasonId: number, round: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/team-of-the-week/${round}`;
  }

  /**
   * `unique-tournament/11165/season/91185/power-rankings/rounds`
   * Captured: cricket + NFL competition pages.
   */
  tournamentSeasonPowerRankingsRounds(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/power-rankings/rounds`;
  }

  /** `unique-tournament/{tid}/season/{sid}/groups` — group stage tables */
  tournamentSeasonGroups(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/groups`;
  }

  /** `unique-tournament/{tid}/season/{sid}/venues` — season venue list */
  tournamentSeasonVenues(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/venues`;
  }

  /**
   * `unique-tournament/11165/featured-events` — tournament-level featured matches (no season).
   */
  uniqueTournamentFeaturedEvents(tournamentId: number): string {
    return `unique-tournament/${tournamentId}/featured-events`;
  }

  /** `unique-tournament/7/season/61627/player-of-the-season` */
  tournamentPlayerOfSeason(tournamentId: number, seasonId: number): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/player-of-the-season`;
  }

  /** `unique-tournament/7/media` — tournament media/banner */
  tournamentMedia(tournamentId: number): string {
    return `unique-tournament/${tournamentId}/media`;
  }

  /** `category/1/unique-tournaments` — all tournaments in a sport category */
  categoryUniqueTournaments(categoryId: number): string {
    return `category/${categoryId}/unique-tournaments`;
  }

  /** All season sub-paths fetched during the nightly metadata cron. */
  seasonPathsForTournament(tournamentId: number, seasonId: number): string[] {
    return [
      this.tournamentSeasonInfo(tournamentId, seasonId),
      this.tournamentSeasonRounds(tournamentId, seasonId),
      this.standingsTotal(tournamentId, seasonId),
      this.standingsHome(tournamentId, seasonId),
      this.standingsAway(tournamentId, seasonId),
      this.cupTrees(tournamentId, seasonId),
      this.topPlayersRating(tournamentId, seasonId),
      this.topPlayersGoals(tournamentId, seasonId),
      this.tournamentTopPlayersOverall(tournamentId, seasonId),
      this.tournamentTopTeamsOverall(tournamentId, seasonId),
      this.tournamentSeasonTeamEvents(tournamentId, seasonId),
      this.tournamentSeasonPowerRankingsRounds(tournamentId, seasonId),
      this.tournamentSeasonGroups(tournamentId, seasonId),
      this.tournamentSeasonVenues(tournamentId, seasonId),
      this.tournamentTeamOfWeekRounds(tournamentId, seasonId),
      this.tournamentTeamOfWeekPeriods(tournamentId, seasonId),
    ];
  }

  // ─── Event (match) ────────────────────────────────────────────────────────
  // Confirmed from: developer_finding.txt, matchstat_nextjs, sofascore-wrapper

  /** `event/15624970` — core match detail */
  eventDetail(eventId: number): string {
    return `event/${eventId}`;
  }

  /** `event/15624970/incidents` — goals, cards, substitutions */
  eventIncidents(eventId: number): string {
    return `event/${eventId}/incidents`;
  }

  /** `event/15624970/statistics` — possession, shots, fouls, corners, etc. */
  eventStatistics(eventId: number): string {
    return `event/${eventId}/statistics`;
  }

  /** `event/15624970/lineups` — confirmed starting XI and bench */
  eventLineups(eventId: number): string {
    return `event/${eventId}/lineups`;
  }

  /** `event/15624970/graph/win-probability` */
  eventWinProbability(eventId: number): string {
    return `event/${eventId}/graph/win-probability`;
  }

  /** `event/15624970/point-by-point` — tennis/cricket point detail */
  eventPointByPoint(eventId: number): string {
    return `event/${eventId}/point-by-point`;
  }

  /**
   * `event/15624970/innings` — cricket innings scorecard.
   * Also reached via the generic `event/{id}/{type}` pattern.
   */
  eventInnings(eventId: number): string {
    return `event/${eventId}/innings`;
  }

  /** `event/15624970/pregame-form` — recent team form before match */
  eventPregameForm(eventId: number): string {
    return `event/${eventId}/pregame-form`;
  }

  /** `event/15624970/h2h` — head-to-head history (structured summary) */
  eventH2h(eventId: number): string {
    return `event/${eventId}/h2h`;
  }

  /**
   * `event/15624970/h2h/events` — raw H2H event list.
   * The Next.js sofa-h2h page calls this as an alternative to /h2h when
   * the event customId is available (cricket / multi-sport).
   */
  eventH2hEvents(eventId: number): string {
    return `event/${eventId}/h2h/events`;
  }

  /**
   * `event/15624970/team-streaks`
   * Used by the sofa-h2h streak section (sofa-h2h-streak-section.tsx).
   */
  eventTeamStreaks(eventId: number): string {
    return `event/${eventId}/team-streaks`;
  }

  /**
   * `event/15711539/team-streaks/betting-odds/1`
   * Cricket capture — streak data with odds provider segment.
   */
  eventTeamStreaksBettingOdds(eventId: number, providerId = this.getOddsProviderId()): string {
    return `event/${eventId}/team-streaks/betting-odds/${providerId}`;
  }

  /**
   * `event/15624970/shotmap` — shot map for the full match.
   * `event/15624970/shotmap/{teamId}` — per-team shot map.
   */
  eventShotmap(eventId: number, teamId?: number): string {
    return teamId
      ? `event/${eventId}/shotmap/${teamId}`
      : `event/${eventId}/shotmap`;
  }

  /**
   * `event/15624970/heatmap/{teamId}` — player/team heatmap.
   */
  eventHeatmap(eventId: number, teamId: number): string {
    return `event/${eventId}/heatmap/${teamId}`;
  }

  /**
   * `event/15624970/best-players/summary` — post-match best player ratings.
   * Available after match finishes.
   */
  eventBestPlayersSummary(eventId: number): string {
    return `event/${eventId}/best-players/summary`;
  }

  /**
   * `event/15318840/best-players` (no `/summary`)
   * Some sports use this path on match load instead of `best-players/summary`.
   */
  eventBestPlayers(eventId: number): string {
    return `event/${eventId}/best-players`;
  }

  /** `event/15624970/comments` — fan / press comments */
  eventComments(eventId: number): string {
    return `event/${eventId}/comments`;
  }

  /** `event/15624970/managers` — coaches / managers */
  eventManagers(eventId: number): string {
    return `event/${eventId}/managers`;
  }

  /** `event/15624970/highlights` — video highlights */
  eventHighlights(eventId: number): string {
    return `event/${eventId}/highlights`;
  }

  /** `event/15624970/votes` — man-of-the-match / public polls */
  eventVotes(eventId: number): string {
    return `event/${eventId}/votes`;
  }

  /**
   * `event/15624970/official-tweets`
   * Listed in developer_finding.txt for the match detail page.
   */
  eventOfficialTweets(eventId: number): string {
    return `event/${eventId}/official-tweets`;
  }

  /** `event/newly-added-events` — recently added matches */
  eventNewlyAdded(): string {
    return 'event/newly-added-events';
  }

  /**
   * `event/13981730/ai-insights/en`
   * AI-generated pre-match analysis text. Language param is typically `en`.
   * Confirmed from Antigravity live capture on football match page.
   */
  eventAiInsights(eventId: number, lang = 'en'): string {
    return `event/${eventId}/ai-insights/${lang}`;
  }

  /**
   * `event/13981730/meta`
   * SEO/meta information for the event page (title, description, canonical).
   * Confirmed from Antigravity live capture.
   */
  eventMeta(eventId: number): string {
    return `event/${eventId}/meta`;
  }

  /**
   * `event/13981730/media/summary/country/BD`
   * Country-specific media summary (TV coverage, streaming links).
   * Confirmed from Antigravity live capture on football match page.
   */
  eventMediaSummary(eventId: number, countryCode: string): string {
    return `event/${eventId}/media/summary/country/${countryCode}`;
  }

  /**
   * `event/{eventId}/points/overview`
   * Tennis-specific: point-by-point breakdown overview.
   * Confirmed from Antigravity tennis match page.
   */
  eventPointsOverview(eventId: number): string {
    return `event/${eventId}/points/overview`;
  }

  /**
   * `event/{eventId}/graph`
   * Match momentum / win-probability graph (used by tennis and other sports).
   * Antigravity confirmed this generic form (not to be confused with the
   * `graph/win-probability` sub-path used on football).
   */
  eventGraph(eventId: number): string {
    return `event/${eventId}/graph`;
  }

  // ─── Odds ──────────────────────────────────────────────────────────────────

  /** `event/15624970/odds/1/featured` */
  eventOddsFeatured(eventId: number, providerId = this.getOddsProviderId()): string {
    return `event/${eventId}/odds/${providerId}/featured`;
  }

  /** `event/15624970/odds/1/all` */
  eventOddsAll(eventId: number, providerId = this.getOddsProviderId()): string {
    return `event/${eventId}/odds/${providerId}/all`;
  }

  /** `event/15624970/provider/1/winning-odds` */
  eventWinningOdds(eventId: number, providerId = this.getOddsProviderId()): string {
    return `event/${eventId}/provider/${providerId}/winning-odds`;
  }

  // ─── Team ──────────────────────────────────────────────────────────────────

  /** `team/95935` — team profile */
  teamDetail(teamId: number): string {
    return `team/${teamId}`;
  }

  /** `team/95935/rankings` */
  teamRankings(teamId: number): string {
    return `team/${teamId}/rankings`;
  }

  /** `team/95935/team-statistics/seasons` */
  teamStatisticsSeasons(teamId: number): string {
    return `team/${teamId}/team-statistics/seasons`;
  }

  /** `team/95935/recent-unique-tournaments` */
  teamRecentUniqueTournaments(teamId: number): string {
    return `team/${teamId}/recent-unique-tournaments`;
  }

  /** `team/95935/performance` */
  teamPerformance(teamId: number): string {
    return `team/${teamId}/performance`;
  }

  /** `team/95935/featured-event` */
  teamFeaturedEvent(teamId: number): string {
    return `team/${teamId}/featured-event`;
  }

  /** `team/95935/events/next/0` */
  teamEventsNext(teamId: number, page = this.getTeamEventsPageIndex()): string {
    return `team/${teamId}/events/next/${page}`;
  }

  /** `team/95935/events/last/0` */
  teamEventsLast(teamId: number, page = this.getTeamEventsPageIndex()): string {
    return `team/${teamId}/events/last/${page}`;
  }

  /** `team/95935/near-events` — upcoming + recent matches around today */
  teamNearEvents(teamId: number): string {
    return `team/${teamId}/near-events`;
  }

  /**
   * `team/2793/featured-players`
   * Returns the key players highlighted on a match page for each team.
   * Both home and away teams fire this on match detail load (Antigravity).
   */
  teamFeaturedPlayers(teamId: number): string {
    return `team/${teamId}/featured-players`;
  }

  /** `team/95935/players` — current squad (roster) */
  teamPlayers(teamId: number): string {
    return `team/${teamId}/players`;
  }

  /** `team/95935/transfers` — transfer history */
  teamTransfers(teamId: number): string {
    return `team/${teamId}/transfers`;
  }

  /** `team/95935/media` — team media / photos */
  teamMedia(teamId: number): string {
    return `team/${teamId}/media`;
  }

  /**
   * `team/4424/media/summary/country/XX`
   * Country-specific media summary on team profile (captures use placeholder `XX`).
   */
  teamMediaSummaryCountry(teamId: number, countryCode: string): string {
    return `team/${teamId}/media/summary/country/${countryCode}`;
  }

  /**
   * `team/95935/unique-tournament/2487/season/80797/statistics/overall`
   * `type` can be: overall | home | away
   * Used heavily in the sofa-h2h performance stats section.
   */
  teamSeasonStatistics(
    teamId: number,
    tournamentId: number,
    seasonId: number,
    type: 'overall' | 'home' | 'away' = 'overall',
  ): string {
    return `team/${teamId}/unique-tournament/${tournamentId}/season/${seasonId}/statistics/${type}`;
  }

  /**
   * `team/4424/unique-tournament/9464/season/75522/player-statistics/regularSeason`
   * Sport-specific stat bucket slug (e.g. `regularSeason` for NFL).
   */
  teamUniqueTournamentSeasonPlayerStatistics(
    teamId: number,
    tournamentId: number,
    seasonId: number,
    kind: string,
  ): string {
    return `team/${teamId}/unique-tournament/${tournamentId}/season/${seasonId}/player-statistics/${kind}`;
  }

  /** `team/187843/unique-tournaments/all` — full historical tournament list */
  teamUniqueTournamentsAll(teamId: number): string {
    return `team/${teamId}/unique-tournaments/all`;
  }

  /** `team/4424/achievements` — trophies and titles */
  teamAchievements(teamId: number): string {
    return `team/${teamId}/achievements`;
  }

  /** `team/4424/grand-slam/best-results` — tennis Grand Slam bests */
  teamGrandSlamBestResults(teamId: number): string {
    return `team/${teamId}/grand-slam/best-results`;
  }

  /** `team/4424/standings/seasons` — league seasons this team appears in */
  teamStandingsSeasons(teamId: number): string {
    return `team/${teamId}/standings/seasons`;
  }

  /**
   * `team/95935/unique-tournament/2487/season/80797/top-players/overall`
   * Used by the sofa-h2h SSR helper and sofa-seasons-statistics component.
   */
  teamTopPlayersInTournament(
    teamId: number,
    tournamentId: number,
    seasonId: number,
    type: 'overall' | 'home' | 'away' = 'overall',
  ): string {
    return `team/${teamId}/unique-tournament/${tournamentId}/season/${seasonId}/top-players/${type}`;
  }

  /**
   * `team/4424/unique-tournament/9464/season/75522/top-players/regularSeason`
   * Slug form (same as `tournamentSeasonTopPlayersSlug` on unique-tournament).
   */
  teamTopPlayersInTournamentSlug(
    teamId: number,
    tournamentId: number,
    seasonId: number,
    slug: string,
  ): string {
    return `team/${teamId}/unique-tournament/${tournamentId}/season/${seasonId}/top-players/${slug}`;
  }

  /**
   * `team/6827/unique-tournament/11093/season/89896/goal-distributions`
   * Volleyball capture — scoring breakdown by period/zone.
   */
  teamUniqueTournamentSeasonGoalDistributions(
    teamId: number,
    tournamentId: number,
    seasonId: number,
  ): string {
    return `team/${teamId}/unique-tournament/${tournamentId}/season/${seasonId}/goal-distributions`;
  }

  /**
   * `unique-tournament/7/season/61627/team/42/team-performance-graph-data`
   * Performance graph data for a specific team within a season.
   */
  teamPerformanceGraph(
    tournamentId: number,
    seasonId: number,
    teamId: number,
  ): string {
    return `unique-tournament/${tournamentId}/season/${seasonId}/team/${teamId}/team-performance-graph-data`;
  }

  // ─── Player ────────────────────────────────────────────────────────────────
  // Confirmed from: sofascore-wrapper player.py, developer_finding.txt

  /** `player/934235` — player profile */
  playerDetail(playerId: number): string {
    return `player/${playerId}`;
  }

  /** `player/934235/performance` — career performance metrics */
  playerPerformance(playerId: number): string {
    return `player/${playerId}/performance`;
  }

  /** `player/934235/statistics/seasons` — all seasons the player has stats for */
  playerStatisticsSeasons(playerId: number): string {
    return `player/${playerId}/statistics/seasons`;
  }

  /** `player/934235/unique-tournaments` — tournaments the player participated in */
  playerUniqueTournaments(playerId: number): string {
    return `player/${playerId}/unique-tournaments`;
  }

  /**
   * `player/934235/unique-tournament/17/season/61627/statistics/overall`
   * Detailed per-tournament-season stats for a player.
   */
  playerTournamentSeasonStats(
    playerId: number,
    tournamentId: number,
    seasonId: number,
    type: 'overall' | 'home' | 'away' = 'overall',
  ): string {
    return `player/${playerId}/unique-tournament/${tournamentId}/season/${seasonId}/statistics/${type}`;
  }

  /** `player/934235/transfer-history` */
  playerTransferHistory(playerId: number): string {
    return `player/${playerId}/transfer-history`;
  }

  /** `player/934235/national-team-statistics` */
  playerNationalTeamStatistics(playerId: number): string {
    return `player/${playerId}/national-team-statistics`;
  }

  /** `player/934235/attribute-overviews` — radar chart attributes */
  playerAttributeOverviews(playerId: number): string {
    return `player/${playerId}/attribute-overviews`;
  }

  /** `player/934235/events/last/0` — player's recent matches */
  playerEventsLast(playerId: number, page = 0): string {
    return `player/${playerId}/events/last/${page}`;
  }

  /** `player/786521/last-year-summary` — year-over-year summary block */
  playerLastYearSummary(playerId: number): string {
    return `player/${playerId}/last-year-summary`;
  }

  /**
   * `player/1449234/statistics` — aggregate statistics (no `/seasons` suffix)
   * Distinct from `playerStatisticsSeasons`.
   */
  playerStatisticsOverview(playerId: number): string {
    return `player/${playerId}/statistics`;
  }

  /** `player/1449234/media` — photos / media hub */
  playerMedia(playerId: number): string {
    return `player/${playerId}/media`;
  }

  /** `player/1449234/media/videos` */
  playerMediaVideos(playerId: number): string {
    return `player/${playerId}/media/videos`;
  }

  /** `fantasy/player/786521/competitions` — fantasy competitions for this player */
  fantasyPlayerCompetitions(playerId: number): string {
    return `fantasy/player/${playerId}/competitions`;
  }

  /**
   * `player/961444/season/84695/statistical-rankings/regularSeason`
   * Baseball capture — season leaderboard slice for the player.
   */
  playerSeasonStatisticalRankings(
    playerId: number,
    seasonId: number,
    slug: string,
  ): string {
    return `player/${playerId}/season/${seasonId}/statistical-rankings/${slug}`;
  }

  // ─── Manager / coach ─────────────────────────────────────────────────────

  /** `manager/793399` — staff profile */
  managerDetail(managerId: number): string {
    return `manager/${managerId}`;
  }

  /** `manager/793399/career-history` */
  managerCareerHistory(managerId: number): string {
    return `manager/${managerId}/career-history`;
  }

  // ─── Config / reference data ──────────────────────────────────────────────

  /** `country/alpha2` — full country list with alpha2 codes */
  countryAlpha2(): string {
    return 'country/alpha2';
  }

  /** `config/country-sport-priorities/country` — global sport priority map */
  configCountrySportPriorities(): string {
    return 'config/country-sport-priorities/country';
  }

  /** `config/country-sport-priorities/country/BD` */
  configCountrySportPriorityForCountry(countryCode: string): string {
    return `config/country-sport-priorities/country/${countryCode}`;
  }

  /** `config/default-unique-tournaments/BD/football` */
  configDefaultUniqueTournaments(countryCode: string, sport = this.getDefaultSport()): string {
    return `config/default-unique-tournaments/${countryCode}/${sport}`;
  }

  /**
   * `config/top-unique-tournaments/BD/football`
   * Distinct from "default" — returns the *top* (featured) tournaments for a
   * country. Home page fires both `default` and `top` variants.
   * Antigravity confirmed: `config/top-unique-tournaments/00/football` (global)
   * and `config/top-unique-tournaments/BD/football` (country-specific).
   */
  configTopUniqueTournaments(countryCode: string, sport = this.getDefaultSport()): string {
    return `config/top-unique-tournaments/${countryCode}/${sport}`;
  }

  /** `odds/providers/BD/web` */
  oddsProviders(countryCode: string): string {
    return `odds/providers/${countryCode}/web`;
  }

  /** `odds/providers/BD/web-odds` */
  oddsProvidersWebOdds(countryCode: string): string {
    return `odds/providers/${countryCode}/web-odds`;
  }

  /**
   * `odds/providers/BD/web-featured`
   * Third variant of the odds provider endpoint — returns featured-only providers.
   * Confirmed from Antigravity live capture.
   */
  oddsProvidersWebFeatured(countryCode: string): string {
    return `odds/providers/${countryCode}/web-featured`;
  }

  /**
   * `branding/providers/BD/web`
   * Branding/sponsor data for the given country.
   * Confirmed from Antigravity live capture.
   */
  brandingProviders(countryCode: string): string {
    return `branding/providers/${countryCode}/web`;
  }

  // ─── TV / Broadcast ───────────────────────────────────────────────────────

  /** `tv/event/15624970/country-channels` — broadcast info per country */
  tvEventCountryChannels(eventId: number): string {
    return `tv/event/${eventId}/country-channels`;
  }

  /** `tv/channel/{channelId}/schedule` — channel's broadcast schedule */
  tvChannelSchedule(channelId: number): string {
    return `tv/channel/${channelId}/schedule`;
  }

  // ─── Search ────────────────────────────────────────────────────────────────
  // Confirmed from sofascore-wrapper search.py

  /** `search/all/?q={query}&page={page}` — global search across all entity types */
  searchAll(query: string, page = 0): string {
    return `search/all/?q=${encodeURIComponent(query)}&page=${page}`;
  }

  /** `search/events/?q={query}&page={page}` — search for matches/events */
  searchEvents(query: string, page = 0): string {
    return `search/events/?q=${encodeURIComponent(query)}&page=${page}`;
  }

  /** `search/player-team-persons/?q={query}&page={page}` — search for players */
  searchPlayers(query: string, page = 0): string {
    return `search/player-team-persons/?q=${encodeURIComponent(query)}&page=${page}`;
  }

  /** `search/teams/?q={query}&page={page}` — search for teams */
  searchTeams(query: string, page = 0): string {
    return `search/teams/?q=${encodeURIComponent(query)}&page=${page}`;
  }

  /** `search/unique-tournaments/?q={query}&page={page}` — search for leagues */
  searchLeagues(query: string, page = 0): string {
    return `search/unique-tournaments/?q=${encodeURIComponent(query)}&page=${page}`;
  }

  /**
   * `search/suggestions/default`
   * Returns default search suggestions shown before the user types anything.
   * Confirmed from Antigravity live capture (search bar open state).
   */
  searchSuggestionsDefault(): string {
    return 'search/suggestions/default';
  }

  // ─── Rankings ─────────────────────────────────────────────────────────────

  /**
   * `rankings/type/1` — ATP Rankings, `rankings/type/2` — WTA Rankings.
   * Tennis-specific global player rankings. Confirmed from Antigravity.
   * rankingTypeId: 1 = ATP, 2 = WTA (SofaScore internal IDs).
   */
  rankingsType(rankingTypeId: number): string {
    return `rankings/type/${rankingTypeId}`;
  }

  // ─── Image CDN (img.sofascore.com) ─────────────────────────────────────────
  // These patterns use a DIFFERENT host: img.sofascore.com
  // They cannot be proxied through the same sofascore.com base URL.
  // The frontend should reference img.sofascore.com directly for images.
  // These methods return FULL URLs for use in image URL construction helpers.

  /** `https://img.sofascore.com/api/v1/player/{id}/image` */
  imgPlayerUrl(playerId: number): string {
    return `https://img.sofascore.com/api/v1/player/${playerId}/image`;
  }

  /** `https://img.sofascore.com/api/v1/team/{id}/image` */
  imgTeamUrl(teamId: number): string {
    return `https://img.sofascore.com/api/v1/team/${teamId}/image`;
  }

  /** `https://img.sofascore.com/api/v1/unique-tournament/{id}/image` */
  imgTournamentUrl(tournamentId: number): string {
    return `https://img.sofascore.com/api/v1/unique-tournament/${tournamentId}/image`;
  }

  /** `https://img.sofascore.com/api/v1/category/{id}/image` */
  imgCategoryUrl(categoryId: number): string {
    return `https://img.sofascore.com/api/v1/category/${categoryId}/image`;
  }

  /** `https://img.sofascore.com/api/v1/country/{countryCode}/flag` */
  imgCountryFlagUrl(countryCode: string): string {
    return `https://img.sofascore.com/api/v1/country/${countryCode}/flag`;
  }

  // ─── Odds (global) ─────────────────────────────────────────────────────────

  /** `odds/top-team-streaks/wins/all` — global top team winning streaks */
  oddsTopTeamStreaks(): string {
    return 'odds/top-team-streaks/wins/all';
  }

  /**
   * `odds/1/featured-events/football` — featured odds events by provider + sport slug.
   */
  oddsFeaturedEvents(providerId: number, sport: string): string {
    return `odds/${providerId}/featured-events/${sport}`;
  }

  /**
   * `odds/1/featured-events-by-popularity/football`
   */
  oddsFeaturedEventsByPopularity(providerId: number, sport: string): string {
    return `odds/${providerId}/featured-events-by-popularity/${sport}`;
  }

  // ─── News ──────────────────────────────────────────────────────────────────

  /**
   * `sofascore-news/en/posts` — paginated news feed.
   * Used on the home page, match detail page, player page, and team page.
   * For captured query params (`?page=1&per_page=12&categories=news`), use
   * `sofascoreNewsPostsWithParams`.
   */
  sofascoreNewsPosts(lang = 'en'): string {
    return `sofascore-news/${lang}/posts`;
  }

  /**
   * Same as `sofascoreNewsPosts` with query string from Sofascore api documentation
   * (e.g. `page`, `per_page`, `categories`).
   */
  sofascoreNewsPostsWithParams(
    lang = 'en',
    params?: SofascoreNewsPostsQueryParams,
  ): string {
    const base = this.sofascoreNewsPosts(lang);
    return params
      ? appendQueryString(base, params as Record<string, string | number | boolean | undefined>)
      : base;
  }

  /**
   * Every relative path template inferred from `Sofascore api documentation/*.md`
   * (see `sofa-documented-paths.catalog.ts`). Use for coverage checks and onboarding.
   */
  documentedPathTemplates(): readonly string[] {
    return SOFASCORE_DOCUMENTED_PATH_TEMPLATES;
  }

  // ─── Bundle helpers (groups of related paths) ─────────────────────────────

  /**
   * All paths fetched on the match detail page.
   * Confirmed from: developer_finding.txt, matchstat_nextjs API routes,
   * sofascore-wrapper match.py.
   */
  matchDetailPaths(eventId: number): string[] {
    return [
      this.eventDetail(eventId),
      this.eventIncidents(eventId),
      this.eventStatistics(eventId),
      this.eventLineups(eventId),
      this.eventShotmap(eventId),
      this.eventWinProbability(eventId),
      this.eventPointByPoint(eventId),
      this.eventInnings(eventId),
      this.eventPregameForm(eventId),
      this.eventH2h(eventId),
      this.eventH2hEvents(eventId),
      this.eventTeamStreaks(eventId),
      this.eventManagers(eventId),
      this.eventHighlights(eventId),
      this.eventBestPlayersSummary(eventId),
      this.eventVotes(eventId),
      this.eventOfficialTweets(eventId),
      this.eventAiInsights(eventId),
      this.eventMeta(eventId),
      this.eventGraph(eventId),
      this.eventPointsOverview(eventId),
      this.tvEventCountryChannels(eventId),
      this.eventOddsFeatured(eventId),
      this.eventOddsAll(eventId),
      this.eventWinningOdds(eventId),
    ];
  }

  /** Hot paths polled every 30 s while a match is in progress. */
  liveVolatilePathsForEvent(eventId: number): string[] {
    return [
      this.eventIncidents(eventId),
      this.eventStatistics(eventId),
      this.eventLineups(eventId),
      this.eventWinProbability(eventId),
      this.eventTeamStreaks(eventId),
    ];
  }

  /**
   * All paths needed for a full team profile bundle.
   * Confirmed from: developer_finding.txt, Next.js sofa-h2h,
   * sofascore-wrapper team.py, Antigravity live capture.
   */
  teamBundlePaths(teamId: number): string[] {
    return [
      this.teamDetail(teamId),
      this.teamRankings(teamId),
      this.teamStatisticsSeasons(teamId),
      this.teamRecentUniqueTournaments(teamId),
      this.teamPerformance(teamId),
      this.teamFeaturedEvent(teamId),
      this.teamFeaturedPlayers(teamId),
      this.teamPlayers(teamId),
      this.teamNearEvents(teamId),
      this.teamEventsNext(teamId),
      this.teamEventsLast(teamId),
    ];
  }

  /**
   * Paths fetched for a finished event (historical backfill).
   * These are stable once the match ends — stored as immutable snapshots.
   */
  finishedEventBackfillPaths(eventId: number): string[] {
    return [
      this.eventDetail(eventId),
      this.eventIncidents(eventId),
      this.eventStatistics(eventId),
      this.eventLineups(eventId),
      this.eventShotmap(eventId),
      this.eventH2h(eventId),
      this.eventH2hEvents(eventId),
      this.eventTeamStreaks(eventId),
      this.eventPregameForm(eventId),
      this.eventHighlights(eventId),
      this.eventBestPlayersSummary(eventId),
      this.eventManagers(eventId),
      this.eventOfficialTweets(eventId),
      this.eventAiInsights(eventId),
      this.eventMeta(eventId),
      this.eventGraph(eventId),
    ];
  }

  /**
   * Reference / config paths fetched in the nightly global-config cron.
   *
   * `countryCodes` must be supplied by the caller (CountryRegistryService or
   * IngestionService) — this method is a pure path builder and has no
   * internal knowledge of which countries are active. This keeps the contract
   * service truly stateless and avoids circular dependencies.
   *
   * Pass an empty array to get only the sport-global paths.
   */
  globalConfigPaths(countryCodes: string[], sport = this.getDefaultSport()): string[] {
    const paths: string[] = [
      this.countryAlpha2(),
      this.configCountrySportPriorities(),
      this.sportCategoriesAll(sport),
      this.sportTrendingTopPlayers(sport),
      this.sportLiveTournaments(sport),
      this.eventNewlyAdded(),
      this.sofascoreNewsPosts(),
      this.searchSuggestionsDefault(),
      // Global (country-agnostic) top tournaments — code '00' = world
      this.configTopUniqueTournaments('00', sport),
    ];

    for (const cc of countryCodes) {
      paths.push(
        this.configCountrySportPriorityForCountry(cc),
        this.configDefaultUniqueTournaments(cc, sport),
        this.configTopUniqueTournaments(cc, sport),
        this.oddsProviders(cc),
        this.oddsProvidersWebOdds(cc),
        this.oddsProvidersWebFeatured(cc),
        this.brandingProviders(cc),
      );
    }

    return paths;
  }
}

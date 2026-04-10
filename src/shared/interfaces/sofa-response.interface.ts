/**
 * Typed subsets of SofaScore JSON for normalization and for documenting
 * response shapes captured under `Sofascore api documentation/`.
 *
 * **Historical fidelity (same JSON as live):**
 * - `raw_snapshots.payload` stores the **verbatim** provider JSON (`jsonb`).
 * - That is the source of truth for replaying past states; do not require
 *   these interfaces to cover every field before persisting.
 *
 * **These interfaces:**
 * - Describe fields we **read** in code (normalize, APIs) or want to
 *   guarantee in tests.
 * - Grow **incrementally** when you paste a new capture: add optional
 *   properties rather than breaking existing payloads.
 * - Are **not** a full OpenAPI spec — SofaScore adds sport-specific keys often.
 *
 * When you add a new endpoint to `SofaContractService`, prefer adding a
 * `*Response` interface here (from a real response sample) before adding
 * a dedicated `sofa_*` table, so columns match what you actually store.
 *
 * **Missing properties:** treat every field as optional unless you have a
 * sample where it is always present. Ingestion uses `sofa-payload-guards.ts`
 * for safe coercion; normalized rows use `null` when data is absent.
 */
export interface SofaResponse<T = unknown> {
  [key: string]: T | unknown;
}

/** Nested translation map on many SofaScore entities (`fieldTranslations`). */
export interface SofaFieldTranslations {
  nameTranslation?: Record<string, string>;
  shortNameTranslation?: Record<string, string>;
  [key: string]: Record<string, string> | undefined;
}

/**
 * Player object embedded in event/team responses (not the full `player/{id}` document).
 * Captured from: american football match → `event/{id}/best-players`.
 */
export interface SofaPlayer {
  id: number;
  name: string;
  firstName?: string;
  lastName?: string;
  slug: string;
  shortName?: string;
  position?: string;
  height?: number;
  userCount?: number;
  gender?: string;
  marketValueCurrency?: string;
  dateOfBirthTimestamp?: number;
  fieldTranslations?: SofaFieldTranslations;
}

/**
 * `event/{id}/best-players` (NFL sample in Sofascore api documentation).
 * `value` / `label` are stat-specific (e.g. passing yards).
 */
export interface SofaBestPlayerPick {
  value: string;
  label: string;
  player: SofaPlayer;
}

export interface EventBestPlayersResponse {
  bestHomeTeamPlayer?: SofaBestPlayerPick;
  bestAwayTeamPlayer?: SofaBestPlayerPick;
}

/**
 * Compact `event/{id}/h2h` sample: `{"teamDuel":{...},"managerDuel":null}`.
 * Full H2H documents may include more keys; keep extras via `SofaResponse`.
 */
export interface EventH2hTeamDuel {
  homeWins: number;
  awayWins: number;
  draws: number;
}

export interface EventH2hSummaryResponse {
  teamDuel?: EventH2hTeamDuel | null;
  managerDuel?: unknown;
}

/**
 * `tv/event/{id}/country-channels` — channel id lists per country code.
 */
export interface TvEventCountryChannelsResponse {
  countryChannels: Record<string, number[]>;
}

export interface SofaTeam {
  id: number;
  name: string;
  /** Long label — e.g. IPL `fullName` vs `name`. */
  fullName?: string;
  slug: string;
  shortName?: string;
  gender?: string;
  sport?: { id: number; name: string; slug: string };
  country?: {
    alpha2?: string;
    alpha3?: string;
    name?: string;
    slug?: string;
  };
  teamColors?: { primary: string; secondary: string; text: string };
  nameCode?: string;
  ranking?: number;
  /** Club vs national / provider-specific enum — varies by sport. */
  type?: number;
  class?: number;
  userCount?: number;
  national?: boolean;
  disabled?: boolean;
}

/**
 * Score block — NFL uses `current`, `display`, `period1`…; cricket may send `{}` pre-match.
 */
export interface SofaScore {
  current?: number;
  display?: number;
  period1?: number;
  period2?: number;
  period3?: number;
  period4?: number;
  overtime?: number;
  normaltime?: number;
  [key: string]: unknown;
}

/**
 * `event.tournament` — wrapper with both competition id and `uniqueTournament`
 * (see cricket / NFL captures in `Sofascore api documentation/`).
 */
export interface SofaTournament {
  /** Competition / parent tournament id — `tournament/{id}/season/...` when used. */
  id?: number;
  name: string;
  slug: string;
  category?: {
    id: number;
    name: string;
    slug: string;
    sport: { id: number; name: string; slug: string };
    country?: { alpha2?: string; name?: string; alpha3?: string; slug?: string };
    flag?: string;
    alpha2?: string;
    priority?: number;
    fieldTranslations?: SofaFieldTranslations;
  };
  uniqueTournament?: {
    id: number;
    name: string;
    slug: string;
    primaryColorHex?: string;
    secondaryColorHex?: string;
    userCount?: number;
    hasRounds?: boolean;
    hasPerformanceGraphFeature?: boolean;
    hasEventPlayerStatistics?: boolean;
    hasBoxScore?: boolean;
    displayInverseHomeAwayTeams?: boolean;
    category?: SofaTournament['category'];
    country?: Record<string, unknown>;
    fieldTranslations?: SofaFieldTranslations;
  };
  priority?: number;
  competitionType?: number;
  isLive?: boolean;
  startTimestamp?: number;
  endTimestamp?: number;
}

export interface SofaEvent {
  id: number;
  slug: string;
  customId?: string;
  status: {
    code: number;
    description: string;
    type: string;
  };
  winnerCode?: number;
  homeTeam: SofaTeam;
  awayTeam: SofaTeam;
  homeScore: SofaScore | Record<string, unknown>;
  awayScore: SofaScore | Record<string, unknown>;
  tournament: SofaTournament;
  season?: { id: number; name: string; year: string; editor?: boolean };
  roundInfo?: { round: number; name?: string; roundSlug?: string };
  startTimestamp: number;
  endTimestamp?: number;
  venue?: Record<string, unknown>;
  periods?: Record<string, unknown>;
  time?: Record<string, unknown>;
  changes?: Record<string, unknown>;
  coverage?: number;
  hasGlobalHighlights?: boolean;
  hasEventPlayerStatistics?: boolean;
  hasEventPlayerHeatMap?: boolean;
  detailId?: number;
  crowdsourcingDataDisplayEnabled?: boolean;
  id2?: number;
  isEditor?: boolean;
}

export interface SofaScheduledEventsResponse {
  events: SofaEvent[];
  hasNextPage?: boolean;
}

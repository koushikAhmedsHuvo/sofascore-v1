import { registerAs } from "@nestjs/config";

/**
 * Single source of truth for SofaScore-compatible *path semantics* and
 * tunables that would otherwise be scattered across services.
 *
 * Provider base URL + HTTP client identity stay in `provider.config.ts`.
 * Change env vars here — not string literals in ingestion / proxy code.
 */
export const sofaContractConfig = registerAs("sofaContract", () => ({
  /** Default sport slug in API paths (e.g. football). */
  defaultSport: process.env.SOFA_DEFAULT_SPORT ?? "football",

  /**
   * All sports the ingestion engine actively pre-warms.
   * Set SOFA_ACTIVE_SPORTS as comma-separated slugs (e.g. football,basketball,cricket,tennis).
   * Falls back to football when the env var is unset to protect provider budget.
   */
  activeSports: (process.env.SOFA_ACTIVE_SPORTS ?? "football")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /** Odds provider id segment: event/{id}/odds/{this}/featured */
  oddsProviderId: parseInt(process.env.SOFA_ODDS_PROVIDER_ID ?? "1", 10),

  /** Pagination cursor for team/{id}/events/next/{n} and .../last/{n} */
  teamEventsPageIndex: parseInt(process.env.SOFA_TEAM_EVENTS_PAGE ?? "0", 10),

  /**
   * How many latest seasons to pull standings / cup trees / top-players for.
   */
  tournamentSeasonsLookback: parseInt(
    process.env.SOFA_TOURNAMENT_SEASONS_LOOKBACK ?? "2",
    10,
  ),

  /**
   * OPTIONAL seed country codes (comma-separated ISO2).
   * Used ONLY as a fallback while the CountryRegistryService DB table is
   * empty (i.e., the first ever startup before the discovery cron runs).
   *
   * Once `sofa_countries` is populated by CountryRegistryService, this
   * value is ignored. Do NOT rely on this for production configuration.
   * Leave blank to discover all countries from the API automatically.
   *
   * Example: SOFA_CONFIG_COUNTRY_CODES=BD,US,GB
   */
  configCountryCodes: (process.env.SOFA_CONFIG_COUNTRY_CODES ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean),

  /**
   * Relative path appended to provider base for Terminus HTTP health probe.
   * Must be a cheap GET that returns 200 when the provider is up.
   */
  healthProbeRelativePath:
    process.env.SOFA_HEALTH_PROBE_PATH ?? "sport/football/categories/all",
}));

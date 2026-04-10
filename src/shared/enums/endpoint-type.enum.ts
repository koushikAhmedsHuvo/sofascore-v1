/**
 * Classifies SofaScore-compatible endpoints by data volatility.
 * Drives TTL decisions and cron refresh frequency.
 */
export enum EndpointType {
  /** Live match: scores, incidents, statistics — refresh every 30s */
  LIVE = 'live',
  /** Scheduled events by date — refresh every 5 min */
  SCHEDULED = 'scheduled',
  /** Recently completed matches (< 7 days ago) */
  RECENT = 'recent',
  /** Historical (finished, > 7 days) — long TTL, rarely changes */
  HISTORICAL = 'historical',
  /** Static metadata: teams, tournaments, seasons — very long TTL */
  METADATA = 'metadata',
  /** Immutable after first fetch: won't be re-fetched externally */
  IMMUTABLE = 'immutable',
}

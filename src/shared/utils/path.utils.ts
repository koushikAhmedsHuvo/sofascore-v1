/**
 * Path normalization, query-param hashing, endpoint volatility classification
 * (`EndpointType`), and date helpers used by `SnapshotService` (TTL / cache keys)
 * and ingestion backfills.
 */
import { createHash } from "crypto";
import { EndpointType } from "../enums/endpoint-type.enum";

/**
 * Normalises a SofaScore-compatible API path into a canonical key.
 *
 * Strips leading/trailing slashes and normalises whitespace.
 * Example: "/unique-tournament/7/scheduled-events/2026-04-04/"
 *       → "unique-tournament/7/scheduled-events/2026-04-04"
 */
export function normalizePath(rawPath: string): string {
  return rawPath.trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Produces a stable MD5 hash of sorted query params.
 * Empty string when no params are present.
 */
export function hashParams(params: Record<string, string> = {}): string {
  const keys = Object.keys(params).sort();
  if (keys.length === 0) return "";
  const canonical = keys.map((k) => `${k}=${params[k]}`).join("&");
  return createHash("md5").update(canonical).digest("hex");
}

/**
 * Classifies a SofaScore-compatible path into a volatility bucket.
 *
 * Decision tree (evaluated top-to-bottom, first match wins):
 *
 *  LIVE        → in-progress incident/stat/probability endpoints
 *  SCHEDULED   → upcoming/today scheduled events and tournament lists
 *  HISTORICAL  → past completed event data (incidents/stats/h2h for old matches)
 *  METADATA    → teams, tournaments, seasons, standings, categories, config
 *  RECENT      → event detail sub-endpoints for non-historical matches
 *  IMMUTABLE   → (set externally when event status = FINISHED and age > 7 days)
 */
export function classifyEndpoint(path: string): EndpointType {
  const p = path.toLowerCase();

  // ── 1. LIVE (highest priority, shortest TTL) ──────────────────────────────
  if (
    p.includes("live-tournaments") ||
    p.includes("events/live") ||
    p.endsWith("/live")
  ) {
    return EndpointType.LIVE;
  }

  // In-progress volatile sub-endpoints (live during a match)
  if (
    p.match(
      /event\/\d+\/(incidents|statistics|graph\/win-probability|graph|point-by-point|team-streaks|points\/overview)$/,
    )
  ) {
    return EndpointType.LIVE;
  }

  // ── 2. SCHEDULED (date-bound future/today data) ───────────────────────────
  if (p.includes("scheduled-events") || p.includes("scheduled-tournaments")) {
    const dateMatch = p.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) {
      const pathDate = new Date(dateMatch[1]);
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      // Heuristic: dates older than 7 days (vs *server local “today”*) get HISTORICAL TTL.
      // Not timezone-perfect for all locales — good enough for snapshot expiry skew.
      if (pathDate < sevenDaysAgo) return EndpointType.HISTORICAL;
    }
    return EndpointType.SCHEDULED;
  }

  // ── 3. METADATA (static reference data, long TTL) ────────────────────────
  if (
    // Tournament metadata and season sub-paths (top-ratings added from Antigravity)
    p.match(
      /unique-tournament\/\d+\/(seasons?|standings|cuptrees|top-players|top-ratings)/,
    ) ||
    // Simple tournament detail
    p.match(/^unique-tournament\/\d+$/) ||
    // Season-level sub-paths
    p.match(
      /unique-tournament\/\d+\/season\/\d+\/(team-events|cuptrees|top-players|top-players-per-game|top-ratings)/,
    ) ||
    p.match(/tournament\/\d+\/season\/\d+\/standings/) ||
    // Team profile sub-paths (all fairly static)
    p.match(
      /team\/\d+\/(rankings|team-statistics|recent-unique-tournaments|performance|featured-event|featured-players|players|transfers|media)/,
    ) ||
    p.match(
      /team\/\d+\/unique-tournament\/\d+\/season\/\d+\/(statistics|top-players)/,
    ) ||
    p.match(/^team\/\d+$/) ||
    // Player static data
    p.match(
      /^player\/\d+\/(performance|attribute-overviews|statistics-seasons|unique-tournaments|national-team-statistics|transfer-history|statistics|last-year-summary|media)/,
    ) ||
    // Rankings (ATP/WTA) — long TTL
    p.startsWith("rankings/type/") ||
    // Config, reference and geo
    p.startsWith("config/") ||
    p.startsWith("country/") ||
    p.startsWith("branding/") ||
    p.startsWith("odds/providers") ||
    p.includes("categories/all") ||
    p.includes("event-count") ||
    p.includes("trending-top-players") ||
    p.includes("offers/banner") ||
    p.startsWith("sofascore-news/") ||
    p.startsWith("search/suggestions")
  ) {
    return EndpointType.METADATA;
  }

  // ── 4. HISTORICAL (finished-event immutable sub-data) ────────────────────
  if (
    p.includes("/h2h") ||
    p.includes("highlights") ||
    p.includes("managers") ||
    p.includes("official-tweets") ||
    p.includes("votes") ||
    p.includes("pregame-form") ||
    p.includes("country-channels") ||
    p.includes("newly-added-events") ||
    p.includes("innings") ||
    p.includes("ai-insights") ||
    p.includes("/meta") ||
    p.includes("media/summary")
  ) {
    return EndpointType.HISTORICAL;
  }

  // Odds: medium volatility — treat as recent
  if (p.includes("/odds/") || p.includes("/winning-odds")) {
    return EndpointType.RECENT;
  }

  // ── 5. RECENT (event sub-endpoints, medium TTL) ───────────────────────────
  if (p.match(/event\/\d+/) || p.match(/team\/\d+\/events\/(next|last)/)) {
    return EndpointType.RECENT;
  }

  // Conservative default: long TTL — unknown paths are treated as stable-ish.
  return EndpointType.HISTORICAL;
}

/**
 * Computes `expires_at` from TTL seconds. **`0` → `null`** (cache never treated as
 * stale). Snapshot cleanup only deletes expired **`live`** rows, not other types.
 */
export function computeExpiresAt(ttlSeconds: number): Date | null {
  if (ttlSeconds <= 0) return null;
  const exp = new Date();
  exp.setSeconds(exp.getSeconds() + ttlSeconds);
  return exp;
}

/**
 * Formats a date as YYYY-MM-DD for use in SofaScore paths.
 */
export function formatDateForPath(date: Date): string {
  return date.toISOString().split("T")[0];
}

/**
 * Generates an array of YYYY-MM-DD strings from startDate to endDate inclusive.
 */
export function dateRange(start: Date, end: Date): string[] {
  const dates: string[] = [];
  const current = new Date(start);
  current.setUTCHours(0, 0, 0, 0);
  const endNorm = new Date(end);
  endNorm.setUTCHours(0, 0, 0, 0);

  while (current <= endNorm) {
    dates.push(formatDateForPath(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

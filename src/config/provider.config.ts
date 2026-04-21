import { registerAs } from "@nestjs/config";

/**
 * Outbound HTTP client for the SofaScore-compatible data provider.
 *
 * The sportsdata365 URLs are open at the subscription level — no per-request
 * API key is required by default. PROVIDER_API_KEY and PROVIDER_AUTH_HEADER_NAME
 * are optional overrides for providers that DO require a key.
 * When PROVIDER_API_KEY is absent or empty, no auth header is sent.
 */
export const providerConfig = registerAs("provider", () => ({
  /**
   * Base URL for all provider calls.
   * Path suffixes after this are identical to SofaScore's public API paths.
   * Example: https://sportsdata365.com/football/api/v1/h2h/sports
   */
  baseUrl:
    process.env.PROVIDER_BASE_URL ??
    "https://sportsdata365.com/football/api/v1/h2h/sports",

  /**
   * Optional API key. Leave blank (the default) when provider access is
   * subscription-based at the IP/domain level (e.g., sportsdata365).
   * Set only when your provider explicitly requires a per-request key.
   */
  apiKey: process.env.PROVIDER_API_KEY ?? "",

  /**
   * Header name to use when apiKey is non-empty.
   * Ignored when apiKey is blank.
   */
  authHeaderName: process.env.PROVIDER_AUTH_HEADER_NAME ?? "x-api-key",

  timeoutMs: parseInt(process.env.PROVIDER_TIMEOUT_MS ?? "15000", 10),
  retryAttempts: parseInt(process.env.PROVIDER_RETRY_ATTEMPTS ?? "5", 10),
  retryDelayMs: parseInt(process.env.PROVIDER_RETRY_DELAY_MS ?? "1000", 10),

  /** Mimic the SofaScore browser client so the provider accepts the request. */
  referer: process.env.SOFA_REFERER ?? "https://www.sofascore.com",
  origin: process.env.SOFA_ORIGIN ?? "https://www.sofascore.com",
  userAgent:
    process.env.SOFA_USER_AGENT ??
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}));

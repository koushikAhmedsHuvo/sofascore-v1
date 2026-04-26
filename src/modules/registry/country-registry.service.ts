import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { QueryFailedError, Repository } from "typeorm";
import { SofaCountryEntity } from "../../shared/entities/sofa-country.entity";
import { SofaContractService } from "../contract/sofa-contract.service";
import { ProviderClientService } from "../snapshot/provider-client.service";

/**
 * Global **singleton** — the single source of truth for "which country codes
 * should the backend fetch country-specific config for?"
 *
 * NO country codes are ever hardcoded. The list is built entirely from the
 * SofaScore provider API at startup:
 *
 *   `config/country-sport-priorities/country`
 *   → returns every country SofaScore knows about, with per-sport priority
 *     weights. We extract alpha2 codes, rank by overall priority, and persist
 *     them in `sofa_countries`.
 *
 * Consumers call `getActiveCountryCodes()`. They never hard-code any list.
 *
 * The top-N limit (default 50) prevents us from fetching per-country config
 * for 200+ irrelevant markets. Tune via SOFA_COUNTRY_REGISTRY_LIMIT env var.
 * Any country can be activated/deactivated via the admin API without a deploy.
 */
@Injectable()
export class CountryRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CountryRegistryService.name);

  /** In-memory fast path — keyed alpha2 → priority, sorted by priority asc. */
  private activeCodes: string[] = [];

  constructor(
    @InjectRepository(SofaCountryEntity)
    private readonly countryRepo: Repository<SofaCountryEntity>,
    private readonly contract: SofaContractService,
    private readonly providerClient: ProviderClientService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.loadFromDb();

    const shouldRefresh =
      this.configService.get<boolean>(
        "ingestion.enableRegistryBootstrapRefresh",
      ) ?? false;
    if (!shouldRefresh) {
      this.logger.log(
        "[CountryRegistry] Bootstrap provider refresh disabled; using DB/env state.",
      );
      return;
    }

    this.discoverAndRefresh().catch((err) =>
      this.logger.warn(
        `[CountryRegistry] Bootstrap discovery failed (will retry on next cron): ${(err as Error).message}`,
      ),
    );
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Returns active country codes ordered by priority (lowest = most important).
   * Falls back to env-configured codes if the DB is empty.
   */
  getActiveCountryCodes(): string[] {
    if (this.activeCodes.length > 0) return this.activeCodes;

    // Graceful degradation: env seed list if DB not yet populated
    const seed = this.contract.getConfigCountryCodes();
    this.logger.warn(
      `[CountryRegistry] DB not yet populated — using env seed (${seed.length} codes). ` +
        `Run POST /admin/registry/countries/refresh to populate.`,
    );
    return seed;
  }

  /**
   * Discovers all countries from `config/country-sport-priorities/country`,
   * upserts into `sofa_countries`, and refreshes the in-memory list.
   * Called on startup and by the daily cron.
   */
  async discoverAndRefresh(): Promise<{ upserted: number }> {
    this.logger.log("[CountryRegistry] Starting country discovery...");

    const path = this.contract.configCountrySportPriorities();
    const limit = this.getLimit();

    let raw: unknown;
    try {
      const { data } = await this.providerClient.fetch<unknown>(path);
      raw = data;
    } catch {
      // Failure already logged by ProviderClientService (path + HTTP status).
      return { upserted: 0 };
    }

    const entries = this.parseCountries(raw);
    if (entries.length === 0) {
      this.logger.warn("[CountryRegistry] No countries parsed from response.");
      return { upserted: 0 };
    }

    // Cap how many markets get per-country config fetches (cost control).
    const topEntries = entries.slice(0, limit);

    await this.countryRepo
      .createQueryBuilder()
      .insert()
      .into(SofaCountryEntity)
      .values(
        // `priority` = 0..N-1 row order after sort-by-score — lower idx = higher importance.
        topEntries.map((e, idx) => ({
          alpha2: e.alpha2,
          priority: idx,
          isActive: true,
        })) as object[],
      )
      .orUpdate(["priority", "is_active", "last_refreshed_at"], ["alpha2"])
      .execute();

    await this.loadFromDb();

    this.logger.log(
      `[CountryRegistry] Upserted ${topEntries.length} countries (limit=${limit}).`,
    );
    return { upserted: topEntries.length };
  }

  async setActive(alpha2: string, active: boolean): Promise<void> {
    await this.countryRepo
      .createQueryBuilder()
      .insert()
      .into(SofaCountryEntity)
      .values({
        alpha2: alpha2.toUpperCase(),
        isActive: active,
        priority: 999,
      } as object)
      .orUpdate(["is_active", "last_refreshed_at"], ["alpha2"])
      .execute();
    await this.loadFromDb();
  }

  async setPriority(alpha2: string, priority: number): Promise<void> {
    await this.countryRepo.update(
      { alpha2: alpha2.toUpperCase() },
      { priority },
    );
    await this.loadFromDb();
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /** Caps how many countries we upsert from the discovery response (default 50). */
  private getLimit(): number {
    const raw = process.env.SOFA_COUNTRY_REGISTRY_LIMIT;
    const parsed = parseInt(raw ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
  }

  /** Refreshes `activeCodes` from `sofa_countries` where `is_active` (priority ASC). */
  private async loadFromDb(): Promise<void> {
    try {
      const rows = await this.countryRepo.find({
        where: { isActive: true },
        order: { priority: "ASC" },
      });
      this.activeCodes = rows.map((r) => r.alpha2);
      this.logger.debug(
        `[CountryRegistry] Loaded ${this.activeCodes.length} active country codes from DB.`,
      );
    } catch (err) {
      if (err instanceof QueryFailedError && this.isUndefinedTable(err)) {
        this.activeCodes = [];
        this.logger.error(
          "[CountryRegistry] Table `sofa_countries` is missing. Apply migrations: `yarn migration:run` " +
            "(see src/database/data-source.ts). Using env seed until the table exists.",
        );
        return;
      }
      throw err;
    }
  }

  /** PostgreSQL 42P01 — relation does not exist. */
  private isUndefinedTable(err: QueryFailedError): boolean {
    const code = (err.driverError as { code?: string } | undefined)?.code;
    return code === "42P01";
  }

  /**
   * Parses the `config/country-sport-priorities/country` response.
   *
   * SofaScore returns something like:
   *   { "categories": [{ "alpha2": "BD", "priority": { "football": 1, ... } }, ...] }
   * or a flat array — shape may vary. We try both shapes defensively and rank
   * by overall priority score (sum across sports), ascending.
   */
  private parseCountries(
    raw: unknown,
  ): Array<{ alpha2: string; score: number }> {
    if (!raw || typeof raw !== "object") return [];

    // Shape 1: { categories: [...] }
    const asObj = raw as Record<string, unknown>;
    const list: unknown[] = Array.isArray(asObj["categories"])
      ? (asObj["categories"] as unknown[])
      : Array.isArray(asObj["data"])
        ? (asObj["data"] as unknown[])
        : Array.isArray(raw)
          ? (raw as unknown[])
          : [];

    const result: Array<{ alpha2: string; score: number }> = [];

    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;

      const alpha2 = (entry["alpha2"] ?? entry["country"] ?? "") as string;
      if (!alpha2 || alpha2.length !== 2) continue;

      // Compute a priority score — lower = more important market
      let score = 0;
      const priorities = entry["priority"];
      if (priorities && typeof priorities === "object") {
        score = Object.values(priorities as Record<string, number>).reduce(
          (sum, v) => sum + (typeof v === "number" ? v : 0),
          0,
        );
      } else if (typeof entry["priority"] === "number") {
        score = entry["priority"] as number;
      }

      result.push({ alpha2: alpha2.toUpperCase(), score });
    }

    // Sort ascending by score (lower = higher priority market)
    result.sort((a, b) => a.score - b.score);

    // Deduplicate
    const seen = new Set<string>();
    return result.filter(({ alpha2 }) => {
      if (seen.has(alpha2)) return false;
      seen.add(alpha2);
      return true;
    });
  }
}

import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SofaTournamentEntity } from "../../shared/entities/sofa-tournament.entity";
import { SofaSportEntity } from "../../shared/entities/sofa-sport.entity";
import { SofaContractService } from "../contract/sofa-contract.service";
import { ProviderClientService } from "../snapshot/provider-client.service";
import { CountryRegistryService } from "./country-registry.service";

/**
 * Global **singleton** — the single source of truth for "which tournaments
 * should the ingestion engine currently process?"
 *
 * NO hardcoded IDs anywhere. The list is built entirely from the
 * SofaScore provider API on every startup and nightly refresh:
 *
 *   1. `sport/{sport}/categories/all`
 *      → all categories (country/competition groups) with their
 *        nested `uniqueTournament` list
 *
 *   2. `config/default-unique-tournaments/{cc}/{sport}` per country
 *      → the tournaments SofaScore itself considers important per market;
 *        these get priority = 0..N (lower = fetched first by cron)
 *
 * Result is persisted in `sofa_tournaments` (is_active, priority columns)
 * so the system survives restarts without calling the provider again.
 *
 * Other services call `getActiveTournamentIds(sport?)` — they never
 * care how the list was built.
 */
@Injectable()
export class TournamentRegistryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TournamentRegistryService.name);

  /** In-memory cache: sport → ordered tournament IDs. Rebuilt from DB. */
  private registry = new Map<string, number[]>();

  constructor(
    @InjectRepository(SofaTournamentEntity)
    private readonly tournamentRepo: Repository<SofaTournamentEntity>,
    @InjectRepository(SofaSportEntity)
    private readonly sportRepo: Repository<SofaSportEntity>,
    private readonly contract: SofaContractService,
    private readonly providerClient: ProviderClientService,
    private readonly countryRegistry: CountryRegistryService,
    private readonly configService: ConfigService,
  ) {}

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * On every app boot:
   * 1. Load previously discovered tournaments from DB into memory.
   * 2. Attempt a live refresh from the provider (non-blocking — failures
   *    don't prevent startup, stale DB data is used instead).
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.loadFromDb();

    const shouldRefresh =
      this.configService.get<boolean>(
        "ingestion.enableRegistryBootstrapRefresh",
      ) ?? false;
    if (!shouldRefresh) {
      this.logger.log(
        "[Registry] Bootstrap provider refresh disabled; using DB state.",
      );
      return;
    }

    // Refresh in background — never block startup
    this.discoverAndRefresh().catch((err) =>
      this.logger.warn(
        `Bootstrap discovery failed (will retry on next daily cron): ${(err as Error).message}`,
      ),
    );
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Returns active tournament IDs ordered by priority (ascending).
   * Falls back to all active tournaments for the given sport.
   */
  getActiveTournamentIds(sport?: string): number[] {
    const key = sport ?? this.contract.getDefaultSport();
    return this.registry.get(key) ?? [];
  }

  /** Returns all known sports that have at least one active tournament. */
  getTrackedSports(): string[] {
    return [...this.registry.keys()];
  }

  /**
   * Trigger a full re-discovery from the provider API for **all active sports**.
   * Called by the nightly metadata cron and on application bootstrap.
   */
  async discoverAndRefresh(
    sports = this.contract.getActiveSports(),
  ): Promise<{ discovered: number; updated: number }> {
    this.logger.log(
      `[Registry] Starting tournament discovery for sports: ${sports.join(", ")}`,
    );

    let discovered = 0;
    let updated = 0;

    for (const sport of sports) {
      try {
        // Step 1: All categories → extract every uniqueTournament for this sport
        const sportDiscovered = await this.discoverFromCategories(sport);
        discovered += sportDiscovered;

        // Step 2: Prioritize using country default-tournament lists
        const sportUpdated = await this.applyPriorityFromDefaults(sport);
        updated += sportUpdated;

        // Step 3: Upsert into sofa_sports so the sport is tracked in DB
        await this.upsertSport(sport, sportDiscovered);

        this.logger.log(
          `[Registry] [${sport}] ${sportDiscovered} tournaments found, ${sportUpdated} priorities updated`,
        );
      } catch (err) {
        if (err instanceof ServiceUnavailableException) {
          this.logger.warn(
            `[Registry] [${sport}] Discovery skipped — provider unreachable or rejected ` +
              `the request (e.g. missing API key → HTTP 403). Will retry on cron. ${(err as Error).message}`,
          );
          continue;
        }
        this.logger.error(
          `[Registry] [${sport}] Discovery error: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }

    // Reload memory registry from DB after all sports are processed
    await this.loadFromDb();

    this.logger.log(
      `[Registry] Discovery complete — total: ${discovered} tournaments, ${updated} priorities updated`,
    );

    return { discovered, updated };
  }

  /**
   * Enable or disable a specific tournament.
   * Used by ops endpoints to include/exclude without code changes.
   */
  async setActive(sofaId: number, active: boolean): Promise<void> {
    await this.tournamentRepo.update({ sofaId }, { isActive: active });
    await this.loadFromDb();
    this.logger.log(`[Registry] Tournament ${sofaId} isActive → ${active}`);
  }

  /**
   * Manually set priority for a tournament (lower = fetched sooner).
   */
  async setPriority(sofaId: number, priority: number): Promise<void> {
    await this.tournamentRepo.update({ sofaId }, { priority });
    await this.loadFromDb();
  }

  // ─── Discovery internals ──────────────────────────────────────────────────

  /**
   * Upserts a row in `sofa_sports` to record that this sport was discovered
   * and how many tournaments were found. Idempotent — keyed on `slug`.
   */
  private async upsertSport(
    slug: string,
    tournamentCount: number,
  ): Promise<void> {
    await this.sportRepo
      .createQueryBuilder()
      .insert()
      .into(SofaSportEntity)
      .values({
        slug,
        isActive: true,
        tournamentCount,
        lastDiscoveredAt: new Date(),
      })
      .orUpdate(
        ["is_active", "tournament_count", "last_discovered_at", "updated_at"],
        ["slug"],
      )
      .execute();
  }

  /**
   * Fetches `sport/{sport}/categories/all` and upserts every
   * uniqueTournament found into `sofa_tournaments`.
   */
  private async discoverFromCategories(sport: string): Promise<number> {
    const path = this.contract.sportCategoriesAll(sport);
    const { data } = await this.providerClient.fetch<{
      categories?: Array<{
        id: number;
        name: string;
        slug?: string;
        alpha2?: string;
        country?: { alpha2: string; name: string };
        tournaments?: Array<{
          id: number;
          name: string;
          slug?: string;
          primaryColorHex?: string;
          secondaryColorHex?: string;
          userCount?: number;
        }>;
      }>;
    }>(path);

    const categories = data.categories ?? [];
    let count = 0;

    for (const cat of categories) {
      const countryAlpha2 = cat.country?.alpha2 ?? cat.alpha2 ?? null;
      const tournaments = await this.fetchCategoryTournaments(
        cat.id,
        cat.tournaments ?? [],
      );

      for (const t of tournaments) {
        await this.tournamentRepo
          .createQueryBuilder()
          .insert()
          .into(SofaTournamentEntity)
          .values({
            sofaId: t.id,
            name: t.name,
            slug: t.slug ?? null,
            sport,
            categoryName: cat.name,
            categoryId: cat.id,
            categorySlug: cat.slug ?? null,
            countryAlpha2,
            primaryColorHex: t.primaryColorHex ?? null,
            secondaryColorHex: t.secondaryColorHex ?? null,
            userCount: t.userCount ?? null,
            isActive: true,
            priority: 999,
            lastRefreshedAt: new Date(),
            rawMeta: t as Record<string, unknown>,
          } as object)
          .orUpdate(
            [
              "name",
              "slug",
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

        count++;
      }
    }

    this.logger.log(
      `[Registry] Discovered ${count} tournaments from categories`,
    );
    return count;
  }

  /**
   * Some provider variants return tournaments nested directly in
   * `sport/{sport}/categories/all`, others require a second hop:
   * `category/{id}/unique-tournaments` (groups[].uniqueTournaments[]).
   */
  private async fetchCategoryTournaments(
    categoryId: number,
    inline: Array<{
      id: number;
      name: string;
      slug?: string;
      primaryColorHex?: string;
      secondaryColorHex?: string;
      userCount?: number;
    }>,
  ): Promise<
    Array<{
      id: number;
      name: string;
      slug?: string;
      primaryColorHex?: string;
      secondaryColorHex?: string;
      userCount?: number;
    }>
  > {
    if (inline.length > 0) return inline;

    try {
      const { data } = await this.providerClient.fetch<{
        groups?: Array<{
          uniqueTournaments?: Array<{
            id: number;
            name: string;
            slug?: string;
            primaryColorHex?: string;
            secondaryColorHex?: string;
            userCount?: number;
          }>;
        }>;
        uniqueTournaments?: Array<{
          id: number;
          name: string;
          slug?: string;
          primaryColorHex?: string;
          secondaryColorHex?: string;
          userCount?: number;
        }>;
      }>(this.contract.categoryUniqueTournaments(categoryId));

      if (
        Array.isArray(data.uniqueTournaments) &&
        data.uniqueTournaments.length > 0
      ) {
        return data.uniqueTournaments;
      }

      if (!Array.isArray(data.groups)) return [];
      return data.groups.flatMap((g) =>
        Array.isArray(g.uniqueTournaments) ? g.uniqueTournaments : [],
      );
    } catch {
      return [];
    }
  }

  /**
   * Calls `config/default-unique-tournaments/{cc}/{sport}` for every
   * active country code (from CountryRegistryService — never hardcoded)
   * and sets priority on matching tournaments.
   * Tournaments that appear in more country defaults get lower (better) priority.
   */
  private async applyPriorityFromDefaults(sport: string): Promise<number> {
    // Source of truth is the CountryRegistryService — dynamically discovered
    const countryCodes = this.countryRegistry.getActiveCountryCodes();
    const priorityMap = new Map<number, number>(); // sofaId → priority score

    /** Monotonic counter across *all* country lists — earlier appearances in the combined stream win. */
    let position = 0;

    for (const cc of countryCodes) {
      const path = this.contract.configDefaultUniqueTournaments(cc, sport);

      try {
        const { data } = await this.providerClient.fetch<{
          uniqueTournaments?: Array<{ id: number }>;
        }>(path);

        const ids = (data.uniqueTournaments ?? []).map((t) => t.id);

        for (const id of ids) {
          // Keep the smallest `position` seen for this tournament (first list wins in iteration order).
          const existing = priorityMap.get(id) ?? Infinity;
          if (position < existing) {
            priorityMap.set(id, position);
          }
          position++;
        }
      } catch {
        // Non-fatal — provider may omit some markets (404) or block (403).
      }
    }

    let updated = 0;
    for (const [sofaId, priority] of priorityMap) {
      const result = await this.tournamentRepo.update({ sofaId }, { priority });
      if ((result.affected ?? 0) > 0) updated++;
    }

    this.logger.log(
      `[Registry] Prioritized ${updated} tournaments from ${countryCodes.length} country defaults`,
    );
    return updated;
  }

  /**
   * Rebuilds the in-memory registry from the DB.
   * Groups tournaments by sport, ordered by priority asc then sofaId asc.
   */
  private async loadFromDb(): Promise<void> {
    const tournaments = await this.tournamentRepo.find({
      where: { isActive: true },
      order: { priority: "ASC", sofaId: "ASC" },
      select: ["sofaId", "sport", "priority"],
    });

    const grouped = new Map<string, number[]>();
    for (const t of tournaments) {
      const arr = grouped.get(t.sport) ?? [];
      arr.push(t.sofaId);
      grouped.set(t.sport, arr);
    }

    this.registry = grouped;

    const totalCount = tournaments.length;
    const sportSummary = [...grouped.entries()]
      .map(([s, ids]) => `${s}: ${ids.length}`)
      .join(", ");

    this.logger.log(
      `[Registry] Loaded ${totalCount} active tournaments from DB (${sportSummary})`,
    );
  }
}

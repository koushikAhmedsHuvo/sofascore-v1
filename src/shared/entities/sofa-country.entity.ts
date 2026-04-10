import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * Stores SofaScore-supported country codes discovered dynamically from
 * `config/country-sport-priorities/country`.
 *
 * This table is the single source of truth for which countries we fetch
 * country-specific config (top-tournaments, odds providers, branding) for.
 * No country code is ever hardcoded in application code.
 */
@Entity({ name: 'sofa_countries' })
export class SofaCountryEntity {
  /** ISO 3166-1 alpha-2 code, e.g. 'BD', 'US', 'GB'. */
  @PrimaryColumn({ name: 'alpha2', type: 'varchar', length: 2 })
  alpha2: string;

  /**
   * Priority derived from how often this country appears across SofaScore's
   * per-country config responses. Lower = higher priority (0 = most important).
   * Used to limit how many countries we actively fetch config for.
   */
  @Index()
  @Column({ name: 'priority', type: 'integer', default: 999 })
  priority: number;

  /**
   * Whether we actively fetch country-specific config (top-tournaments,
   * odds providers) for this country. Defaults to true on discovery.
   * Can be manually disabled via admin API without code change.
   */
  @Index()
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  /** Last time this country record was refreshed from the API. */
  @UpdateDateColumn({ name: 'last_refreshed_at', type: 'timestamptz' })
  lastRefreshedAt: Date;
}

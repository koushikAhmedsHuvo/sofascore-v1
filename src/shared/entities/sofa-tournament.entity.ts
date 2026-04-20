import { Column, Entity, Index, OneToMany } from "typeorm";
import { BaseEntity } from "./base.entity";
import { SofaEvent } from "./sofa-event.entity";

/**
 * Normalized tournament (unique-tournament in SofaScore terminology).
 * Keyed by SofaScore's integer ID to guarantee idempotent upserts.
 *
 * `sofa_id` matches `uniqueTournament.id` inside `event.tournament` / categories API.
 * `user_count` mirrors `uniqueTournament.userCount` when the provider sends it.
 *
 * **Optional API fields:** category, colors, slug, `user_count`, etc. are nullable
 * (`nullable: true`, `| null`). Required: `sofaId`, `name`, `sport`, `is_active`, `priority`.
 */
@Entity({ name: "sofa_tournaments" })
export class SofaTournamentEntity extends BaseEntity {
  /** SofaScore unique-tournament ID — the natural business key. */
  @Index({ unique: true })
  @Column({ name: "sofa_id", type: "integer" })
  sofaId: number;

  @Column({ name: "name", type: "varchar", length: 256 })
  name: string;

  @Column({ name: "slug", type: "varchar", length: 256, nullable: true })
  slug: string | null;

  @Column({ name: "sport", type: "varchar", length: 64, default: "football" })
  sport: string;

  @Column({
    name: "category_name",
    type: "varchar",
    length: 256,
    nullable: true,
  })
  categoryName: string | null;

  @Column({
    name: "category_id",
    type: "integer",
    nullable: true,
  })
  categoryId: number | null;

  @Column({
    name: "category_slug",
    type: "varchar",
    length: 256,
    nullable: true,
  })
  categorySlug: string | null;

  @Column({
    name: "country_alpha2",
    type: "varchar",
    length: 4,
    nullable: true,
  })
  countryAlpha2: string | null;

  @Column({
    name: "primary_color_hex",
    type: "varchar",
    length: 16,
    nullable: true,
  })
  primaryColorHex: string | null;

  @Column({
    name: "secondary_color_hex",
    type: "varchar",
    length: 16,
    nullable: true,
  })
  secondaryColorHex: string | null;

  @Column({
    name: "user_count",
    type: "integer",
    nullable: true,
  })
  userCount: number | null;

  /**
   * Whether this tournament is currently tracked for ingestion.
   * Flipped to true by TournamentRegistryService on discovery.
   * Can be manually disabled via ops API without code change.
   * Index coverage: composite partial index (is_active, priority) WHERE is_active = true
   * (created in TournamentRegistry migration) and (sport, priority) WHERE is_active = true
   * (created in MultiSportIndexes migration).
   */
  @Column({ name: "is_active", type: "boolean", default: true })
  isActive: boolean;

  /**
   * Ingestion priority (lower = first). Derived from the provider's
   * default-unique-tournaments response. 0 = highest priority.
   * The cron processes tournaments ordered by this value.
   */
  @Column({ name: "priority", type: "integer", default: 999 })
  priority: number;

  /** Last time this tournament's metadata was successfully refreshed. */
  @Column({ name: "last_refreshed_at", type: "timestamptz", nullable: true })
  lastRefreshedAt: Date | null;

  /** Full raw metadata snapshot for forward-compatibility. */
  @Column({ name: "raw_meta", type: "jsonb", nullable: true })
  rawMeta: Record<string, unknown> | null;

  @OneToMany(() => SofaEvent, (e) => e.tournament, { lazy: true })
  events: Promise<SofaEvent[]>;
}

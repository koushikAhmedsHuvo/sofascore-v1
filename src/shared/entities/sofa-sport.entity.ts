import { Column, Entity, Index } from "typeorm";
import { BaseEntity } from "./base.entity";

/**
 * One row per sport slug actively tracked by the ingestion engine.
 *
 * Populated / updated by {@link TournamentRegistryService.discoverAndRefresh}
 * every time categories are discovered from the provider.
 *
 * Natural key: `slug` (e.g. "football", "basketball", "cricket", "tennis").
 * Matches the `sport` varchar column on `sofa_tournaments`, `sofa_events`,
 * `sofa_teams`, and `raw_snapshots`.
 */
@Entity({ name: "sofa_sports" })
export class SofaSportEntity extends BaseEntity {
  /** Sport slug — matches `Sport` enum values and SofaScore API path segments. */
  @Index({ unique: true })
  @Column({ name: "slug", type: "varchar", length: 64 })
  slug: string;

  /** Whether this sport is currently being actively ingested. */
  @Column({ name: "is_active", type: "boolean", default: true })
  isActive: boolean;

  /** Number of unique tournaments discovered for this sport on last refresh. */
  @Column({ name: "tournament_count", type: "integer", default: 0 })
  tournamentCount: number;

  /** When this sport's tournament registry was last successfully refreshed from provider. */
  @Column({ name: "last_discovered_at", type: "timestamptz", nullable: true })
  lastDiscoveredAt: Date | null;
}

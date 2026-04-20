import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { EndpointType } from "../enums/endpoint-type.enum";

/**
 * Stores every SofaScore-compatible API response verbatim as JSONB.
 *
 * **Historical data (single source of truth per URL):** this table is the
 * authoritative store for “what did the API return for `path_key` (+ params)?”.
 * Use it for audit, replay, and diffing. Do not duplicate the same fetch in
 * another table unless you need a different access pattern (see `sofa_*`).
 *
 * Key design decisions:
 * - `path_key` is the canonical SofaScore path (e.g. "unique-tournament/7/scheduled-events/2026-04-04").
 * - `params_hash` captures any query-string variation so the same path
 *   with different params gets distinct rows.
 * - `payload` is the raw JSON from the provider, stored identically so
 *   consumers don't need contract changes.
 * - `expires_at` drives TTL logic; null = immutable (historical, never expires).
 * - `endpoint_type` drives cron refresh priority.
 */
@Entity({ name: "raw_snapshots" })
@Index(["pathKey", "paramsHash"], { unique: true })
@Index(["endpointType", "expiresAt"])
@Index(["sport", "endpointType"])
export class RawSnapshot {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  /**
   * Canonical SofaScore path without leading slash.
   * Example: "unique-tournament/7/scheduled-events/2026-04-04"
   * Index coverage: leading column of the unique composite (pathKey, paramsHash).
   */
  @Column({ name: "path_key", type: "varchar", length: 512 })
  pathKey: string;

  /**
   * MD5/SHA of sorted query params. Empty string when no params.
   * Together with path_key forms the unique cache key.
   */
  @Column({ name: "params_hash", type: "varchar", length: 64, default: "" })
  paramsHash: string;

  /** Raw JSON payload exactly as returned by the provider. */
  @Column({ name: "payload", type: "jsonb" })
  payload: Record<string, unknown>;

  /** Sport scope for this snapshot. */
  @Column({
    name: "sport",
    type: "varchar",
    length: 64,
    default: "football",
  })
  sport: string;

  /** Endpoint volatility classification for TTL and refresh decisions. */
  @Column({
    name: "endpoint_type",
    type: "varchar",
    length: 32,
    default: EndpointType.HISTORICAL,
  })
  endpointType: EndpointType;

  /** When the provider was last successfully called. */
  @Column({ name: "fetched_at", type: "timestamptz" })
  fetchedAt: Date;

  /**
   * NULL = immutable / never expires (finished historical events).
   * Set to a future timestamp for volatile endpoints.
   * Index coverage: partial index `WHERE expires_at IS NOT NULL` created in InitialSchema migration.
   */
  @Column({ name: "expires_at", type: "timestamptz", nullable: true })
  expiresAt: Date | null;

  /** HTTP status code from provider on last fetch. */
  @Column({
    name: "provider_status",
    type: "smallint",
    nullable: true,
  })
  providerStatus: number | null;

  /** Number of times this path has been served from cache (analytics). */
  @Column({ name: "hit_count", type: "integer", default: 0 })
  hitCount: number;

  @CreateDateColumn({ type: "timestamptz", name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ type: "timestamptz", name: "updated_at" })
  updatedAt: Date;

  get isExpired(): boolean {
    if (this.expiresAt === null) return false;
    return this.expiresAt < new Date();
  }

  get isImmutable(): boolean {
    return this.expiresAt === null;
  }
}

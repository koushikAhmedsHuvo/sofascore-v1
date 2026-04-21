import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RawSnapshot } from '../../shared/entities/raw-snapshot.entity';
import { EndpointType } from '../../shared/enums/endpoint-type.enum';
import {
  classifyEndpoint,
  computeExpiresAt,
  hashParams,
  normalizePath,
} from '../../shared/utils/path.utils';
import { ProviderClientService } from './provider-client.service';
import { ConfigService } from '@nestjs/config';
import { SofaScoreValidatorService } from './sofascore-validator.service';

export interface SnapshotReadResult {
  payload: Record<string, unknown>;
  source: 'cache' | 'database' | 'provider';
  snapshot: RawSnapshot;
}

/**
 * Core service implementing the DB-first cache-aside pattern.
 *
 * **Read path (implemented):** PostgreSQL `raw_snapshots` → if missing or expired,
 * outbound GET to the provider → upsert → return. (A separate in-process Nest cache
 * layer is *not* wired here today — adding `CACHE_MANAGER` would be an optional L1.)
 *
 * **Write path:** upsert on `(path_key, params_hash)` using `ON CONFLICT`, safe under
 * concurrent crons. TTL comes from {@link classifyEndpoint}; `ttlSeconds === 0` yields
 * `expires_at = NULL` (never “expired” for re-fetch). **`deleteExpired` only removes
 * `live` rows** — all other types stay in the table for historical replay.
 */
@Injectable()
export class SnapshotService {
  private readonly logger = new Logger(SnapshotService.name);

  private readonly ttlMap: Record<EndpointType, number>;

  constructor(
    @InjectRepository(RawSnapshot)
    private readonly snapshotRepo: Repository<RawSnapshot>,
    private readonly providerClient: ProviderClientService,
    private readonly configService: ConfigService,
    private readonly validatorService: SofaScoreValidatorService,
  ) {
    const ttl = this.configService.get<Record<string, number>>('ingestion.ttl') ?? {};
    this.ttlMap = {
      [EndpointType.LIVE]: ttl['live'] ?? 30,
      [EndpointType.SCHEDULED]: ttl['scheduled'] ?? 300,
      [EndpointType.RECENT]: ttl['recent'] ?? 3600,
      [EndpointType.HISTORICAL]: ttl['historical'] ?? 0,
      [EndpointType.METADATA]: ttl['metadata'] ?? ttl['historical'] ?? 0,
      [EndpointType.IMMUTABLE]: ttl['immutable'] ?? 0,
    };
  }

  /**
   * DB-first read: return an unexpired row if present; otherwise call the provider
   * and persist. `isExpired` on the entity encodes TTL (see `RawSnapshot`).
   */
  async getOrFetch(
    rawPath: string,
    params: Record<string, string> = {},
    sport = 'football',
  ): Promise<SnapshotReadResult> {
    const pathKey = normalizePath(rawPath);
    const paramsHash = hashParams(params);

    // 1. Try database
    const existing = await this.snapshotRepo.findOne({
      where: { pathKey, paramsHash },
    });

    if (existing && !existing.isExpired) {
      this.logger.debug(`✓ DB hit: ${pathKey}`);
      // Best-effort metrics; failure here must not break the read path.
      void this.snapshotRepo.increment({ id: existing.id }, 'hitCount', 1);
      return { payload: existing.payload, source: 'database', snapshot: existing };
    }

    if (existing?.isExpired) {
      this.logger.debug(`⚠ Stale snapshot for ${pathKey}, refreshing from provider`);
    }

    // 2. Provider call
    this.logger.log(`→ Provider fallback: ${pathKey}`);
    const { data, status } = await this.providerClient.fetch<Record<string, unknown>>(
      pathKey,
      params,
    );

    if (this.shouldValidateSchema(pathKey)) {
      const validationResult = this.validatorService.validateResponse(
        data,
        this.buildProviderUrl(pathKey),
      );

      if (!validationResult.valid) {
        this.logger.warn(
          `Schema mismatch for ${pathKey}; skipping snapshot upsert and returning provider unavailable`,
        );

        throw new ServiceUnavailableException({
          message: 'Provider response schema mismatch',
          path: pathKey,
          issues: validationResult.issues,
          missingKeys: validationResult.missingKeys,
        });
      }
    }

    // 3. Persist / upsert
    const snapshot = await this.upsert(pathKey, paramsHash, data, sport, status);
    return { payload: data, source: 'provider', snapshot };
  }

  private shouldValidateSchema(pathKey: string): boolean {
    // The minimum required Zod shape is the event detail payload.
    return /^event\/[^/]+$/.test(pathKey);
  }

  private buildProviderUrl(pathKey: string): string {
    const baseUrl =
      this.configService.get<string>('provider.baseUrl')?.replace(/\/+$/, '') ?? '';
    return `${baseUrl}/${pathKey}`;
  }

  /**
   * Upsert a raw snapshot. Conflict target `(path_key, params_hash)` updates payload,
   * TTL, and fetch time so concurrent crons coalesce to one row per logical URL.
   */
  async upsert(
    pathKey: string,
    paramsHash: string,
    payload: Record<string, unknown>,
    sport = 'football',
    providerStatus?: number,
  ): Promise<RawSnapshot> {
    const endpointType = classifyEndpoint(pathKey);
    const ttlSeconds = this.ttlMap[endpointType];
    const expiresAt = computeExpiresAt(ttlSeconds);
    const now = new Date();

    await this.snapshotRepo
      .createQueryBuilder()
      .insert()
      .into(RawSnapshot)
      .values({
        pathKey,
        paramsHash,
        payload,
        sport,
        endpointType,
        fetchedAt: now,
        expiresAt,
        providerStatus: providerStatus ?? null,
        hitCount: 0,
      } as object)
      .orUpdate(
        ['payload', 'endpoint_type', 'fetched_at', 'expires_at', 'provider_status', 'updated_at'],
        ['path_key', 'params_hash'],
      )
      .execute();

    const upserted = await this.snapshotRepo.findOneOrFail({
      where: { pathKey, paramsHash },
    });

    this.logger.debug(
      `✓ Upserted snapshot: ${pathKey} [${endpointType}] expires=${expiresAt?.toISOString() ?? 'never'}`,
    );

    return upserted;
  }

  /**
   * Retrieves a snapshot strictly from the DB (no provider fallback).
   * Used by admin/monitoring endpoints.
   */
  async findByPath(
    rawPath: string,
    params: Record<string, string> = {},
  ): Promise<RawSnapshot> {
    const pathKey = normalizePath(rawPath);
    const paramsHash = hashParams(params);

    const snapshot = await this.snapshotRepo.findOne({
      where: { pathKey, paramsHash },
    });

    if (!snapshot) {
      throw new NotFoundException(`No snapshot found for path: ${pathKey}`);
    }
    return snapshot;
  }

  /**
   * Returns expired snapshot count by type — used by monitoring endpoints.
   */
  async getExpiredCount(): Promise<Record<string, number>> {
    const now = new Date();
    const result = await this.snapshotRepo
      .createQueryBuilder('s')
      .select('s.endpoint_type', 'endpointType')
      .addSelect('COUNT(*)', 'count')
      .where('s.expires_at < :now', { now })
      .groupBy('s.endpoint_type')
      .getRawMany<{ endpointType: string; count: string }>();

    return Object.fromEntries(result.map((r) => [r.endpointType, parseInt(r.count, 10)]));
  }

  /**
   * Removes **only** expired **`live`** snapshots (in-match volatile cache).
   *
   * **Do not** delete scheduled/recent/historical/metadata rows here — that would
   * destroy the SofaScore historical archive. Those types use `expires_at` only
   * to drive `isExpired` / re-fetch behaviour; rows stay in the table until
   * overwritten by a new upsert.
   */
  async deleteExpired(): Promise<number> {
    const now = new Date();
    const result = await this.snapshotRepo
      .createQueryBuilder()
      .delete()
      .from(RawSnapshot)
      .where('expires_at IS NOT NULL AND expires_at < :now', { now })
      .andWhere('endpoint_type = :live', { live: EndpointType.LIVE })
      .execute();

    const deleted = result.affected ?? 0;
    this.logger.log(`Cleanup: deleted ${deleted} expired live snapshots`);
    return deleted;
  }

  /** Row count of `raw_snapshots` (all endpoint types, any expiry). */
  async getTotalCount(): Promise<number> {
    return this.snapshotRepo.count();
  }

  /** Per-`endpoint_type` totals — includes expired rows until `deleteExpired` runs. */
  async getCountByType(): Promise<Record<string, number>> {
    const result = await this.snapshotRepo
      .createQueryBuilder('s')
      .select('s.endpoint_type', 'endpointType')
      .addSelect('COUNT(*)', 'count')
      .groupBy('s.endpoint_type')
      .getRawMany<{ endpointType: string; count: string }>();

    return Object.fromEntries(result.map((r) => [r.endpointType, parseInt(r.count, 10)]));
  }
}

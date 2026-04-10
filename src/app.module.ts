/**
 * Root Nest module. Wires global cross-cutting concerns (config, logging, cache,
 * rate limiting, scheduling) and feature modules in a deliberate order:
 * database → contract singleton → country registry → tournament registry →
 * snapshot/normalize/ingestion → public proxy and ops endpoints.
 *
 * **Security notes (defence in depth with nginx):**
 * - `ThrottlerModule` limits abuse on HTTP controllers (e.g. public proxy).
 * - Pino redacts `Authorization` / `x-token` from logs (see `LoggerModule` below).
 * - Internal routes (`/internal/*`, `/admin/*`) should still be restricted by
 *   network policy in production — this app does not replace a firewall.
 */
import { Module, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { CacheModule } from '@nestjs/cache-manager';
import { LoggerModule } from 'nestjs-pino';

import {
  appConfig,
  databaseConfig,
  providerConfig,
  ingestionConfig,
  sofaContractConfig,
} from './config';
import { SofaContractModule } from './modules/contract/sofa-contract.module';
import { CountryRegistryModule } from './modules/registry/country-registry.module';
import { TournamentRegistryModule } from './modules/registry/tournament-registry.module';
import { DatabaseModule } from './database/database.module';
import { SnapshotModule } from './modules/snapshot/snapshot.module';
import { ProxyModule } from './modules/proxy/proxy.module';
import { IngestionModule } from './modules/ingestion/ingestion.module';
import { NormalizeModule } from './modules/normalize/normalize.module';
import { HealthModule } from './modules/health/health.module';
import { MetricsModule } from './modules/metrics/metrics.module';

@Module({
  imports: [
    // ─── Config ───────────────────────────────────────────────────────────
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      load: [
        appConfig,
        databaseConfig,
        providerConfig,
        ingestionConfig,
        sofaContractConfig,
      ],
      cache: true,
    }),

    // ─── Structured Logging (pino) ────────────────────────────────────────
    LoggerModule.forRootAsync({
      useFactory: () => ({
        pinoHttp: {
          level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
          transport:
            process.env.NODE_ENV !== 'production'
              ? { target: 'pino-pretty', options: { colorize: true } }
              : undefined,
          redact: ['req.headers.authorization', 'req.headers["x-token"]'],
          /**
           * Nest injects `context` (e.g. `NestFactory`, `InstanceLoader`) on every
           * line via nestjs-pino — noisy in dev. Remove from output; messages stay.
           */
          formatters: {
            log(object: Record<string, unknown>) {
              if ('context' in object) {
                const { context: _ctx, ...rest } = object;
                return rest;
              }
              return object;
            },
          },
        },
        /** path-to-regexp v8 (Nest 11+) — named splat, not bare `*`. */
        forRoutes: [{ path: '*path', method: RequestMethod.ALL }],
      }),
    }),

    // ─── Cron Scheduling ─────────────────────────────────────────────────
    ScheduleModule.forRoot(),

    // ─── Rate Limiting ────────────────────────────────────────────────────
    ThrottlerModule.forRootAsync({
      useFactory: () => ({
        throttlers: [
          {
            ttl: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
            limit: parseInt(process.env.THROTTLE_LIMIT ?? '120', 10),
          },
        ],
      }),
    }),

    // ─── In-process Cache ─────────────────────────────────────────────────
    // Upgrade to cache-manager-ioredis for production Redis cache
    CacheModule.register({
      isGlobal: true,
      ttl: parseInt(process.env.CACHE_TTL_SECONDS ?? '300', 10) * 1000,
      max: parseInt(process.env.CACHE_MAX_ITEMS ?? '1000', 10),
    }),

    // ─── Database ─────────────────────────────────────────────────────────
    DatabaseModule,

    /** Singleton path + provider contract — import once, inject everywhere */
    SofaContractModule,

    /**
     * Global singleton registries — self-discover data from the SofaScore API
     * on startup. No hardcoded IDs, country codes, or tournament lists anywhere.
     *
     * Boot order matters:
     *   1. CountryRegistryModule  — discovers active country codes first
     *   2. TournamentRegistryModule — uses country codes for priority assignment
     * Both must be initialized before IngestionModule.
     */
    CountryRegistryModule,
    TournamentRegistryModule,

    // ─── Feature Modules ──────────────────────────────────────────────────
    SnapshotModule,
    NormalizeModule,
    IngestionModule,
    ProxyModule,
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}

/**
 * Application entrypoint. Configures middleware (helmet, compression, CORS),
 * global validation and exception handling, optional Swagger at `/docs`,
 * and graceful shutdown hooks. Port and API prefix come from environment
 * variables (`PORT`, `API_PREFIX`).
 */
import { NestFactory } from '@nestjs/core';
import { LogLevel, RequestMethod, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap(): Promise<void> {
  // Full Nest framework INFO is noisy unless explicitly requested.
  const verboseNest = process.env.NEST_VERBOSE_BOOTSTRAP === 'true';
  const swaggerEnabled =
    process.env.SWAGGER_ENABLED === 'true' ||
    process.env.NODE_ENV !== 'production';
  const nestLoggerLevels: LogLevel[] | undefined = verboseNest
    ? undefined
    : ['error', 'warn', 'fatal'];

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    ...(nestLoggerLevels !== undefined ? { logger: nestLoggerLevels } : {}),
  });

  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.use(compression());

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin:
      corsOrigins.length > 0
        ? corsOrigins
        : ['http://localhost:4200', 'http://localhost:3000', 'https://matchstat.com'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials: true,
  });

  const apiPrefix = process.env.API_PREFIX ?? 'api/v1';
  app.setGlobalPrefix(apiPrefix, {
    exclude: [
      { path: '/', method: RequestMethod.GET },
      { path: '/healthcheck', method: RequestMethod.GET },
      { path: '/provider-debug', method: RequestMethod.GET },
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Matchstat SofaScore Backend API')
      .setDescription(
        `
## Overview

Enterprise NestJS backend for SofaScore-compatible data ingestion, caching, and serving.

### Key Features
- **DB-first proxy**: Serves raw SofaScore JSON from PostgreSQL. Falls back to provider on miss/stale.
- **Cron ingestion**: Automated scheduled-events, backfill, metadata, and live refresh jobs.
- **Normalized entities**: Typed tables for events, teams, and tournaments (JSONB scores for multi-sport).
- **Observability**: Job audit log, staleness metrics, provider fallback rate monitoring.
- **Zero consumer changes**: Preserves SofaScore response shape for existing frontend/nginx contracts.

### Provider Base URL
\`https://sportsdata365.com/football/api/v1/h2h/sports\`

Same path suffixes as SofaScore's internal API (confirmed by Mihir).
      `,
      )
      .setVersion('1.0')
      .addTag('Sofa Proxy (DB-first)', 'Public JSON proxy - same paths as SofaScore / sportsdata365.')
      .addTag('Ingestion (Internal / Ops)', 'Cron/backfill triggers - protect at nginx.')
      .addTag('Health & Observability', 'Liveness/readiness and internal metrics.')
      .addTag(
        'Admin - Country Registry',
        'Dynamic ISO2 list from provider - no hardcoded country codes.',
      )
      .addTag(
        'Admin - Tournament Registry',
        'Dynamic unique tournament IDs from categories API - no hardcoded tournament list.',
      )
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  app.enableShutdownHooks();

  const port = parseInt(process.env.PORT ?? '3010', 10);
  await app.listen(port);

  const logger = app.get(Logger);
  logger.log(`SofaScore backend running on port ${port}`, 'Bootstrap');
  if (swaggerEnabled) {
    logger.log(`Swagger docs: http://localhost:${port}/docs`, 'Bootstrap');
  }
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});

# sofascore-nest-api

**Matchstat SofaScore Backend** — NestJS 11 + PostgreSQL 16

Enterprise-grade backend for SofaScore-compatible data ingestion, persistent caching, and serving. Eliminates repeated paid API calls by storing historical data in PostgreSQL and serving it DB-first.

---

## Architecture

```
Browser / Angular / Next.js
        │
        ▼
   Nginx (matchstat.com)
   /tn-base/reverse-proxy/football/api/v1/h2h/sports/{path}
        │
        ▼
   ProxyController  (GET /api/v1/sofa/:sport/*path)
        │
        ▼
   SnapshotService  ──── DB Hit? ──→ return raw JSON (fast path)
        │  DB Miss/Stale
        ▼
   ProviderClientService
   (sportsdata365.com/football/api/v1/h2h/sports/{path})
        │
        ▼
   Upsert → raw_snapshots
        │
        ▼
   NormalizeService → sofa_events, sofa_teams, sofa_tournaments
        │
        ▼
   Return SofaScore-shaped JSON (consumers see no change)

── Cron Jobs (background) ──────────────────────────────────
  Every 5 min   → scheduled events (today)
  Every 30 min  → scheduled events (tomorrow)
  Daily 03:00   → historical backfill
  Daily 04:00   → tournament/team metadata refresh
  Daily 02:00   → cleanup expired snapshots
```

## Module Map

| Module            | Responsibility                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `SnapshotModule`  | Two-layer cache (in-memory + PostgreSQL `raw_snapshots`). DB-first read with provider fallback. |
| `IngestionModule` | Cron orchestrator + manual trigger API. Fetches from provider, persists snapshots.              |
| `NormalizeModule` | Parses raw payloads into typed `sofa_events`, `sofa_teams`, `sofa_tournaments` rows.            |
| `ProxyModule`     | Public wildcard controller — serves raw SofaScore-shaped JSON.                                  |
| `HealthModule`    | Liveness/readiness probes + provider connectivity check.                                        |
| `MetricsModule`   | Ops dashboard endpoint: row counts, staleness, ingestion error rate.                            |

## Database Tables

| Table              | Purpose                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| `raw_snapshots`    | Verbatim JSONB store. Primary cache layer. Keyed by `(path_key, params_hash)`.      |
| `sofa_events`      | Normalized match events (sofa_id unique key). JSONB scores for multi-sport support. |
| `sofa_teams`       | Normalized team metadata.                                                           |
| `sofa_tournaments` | Normalized tournament metadata.                                                     |
| `ingestion_jobs`   | Audit log for every cron/backfill run. Used for monitoring and alerting.            |

## TTL Strategy

| Endpoint Type | TTL       | Example Paths                                                          |
| ------------- | --------- | ---------------------------------------------------------------------- |
| `live`        | 30s       | `sport/football/live-tournaments`                                      |
| `scheduled`   | 5 min     | `unique-tournament/{id}/scheduled-events/{date}` (recent/future dates) |
| `recent`      | 1 hour    | `event/{id}/incidents`, `event/{id}/statistics`                        |
| `historical`  | 24 hours  | Finished match paths, older scheduled events                           |
| `metadata`    | 24 hours  | `unique-tournament/{id}`, `team/{id}`, seasons                         |
| `immutable`   | ∞ (never) | NULL `expires_at` — never re-fetched                                   |

## Quick Start

```bash
cp .env.example .env
# Fill in POSTGRES_PASSWORD, PROVIDER_API_KEY, PRIORITY_TOURNAMENT_IDS

npm install
npm run migration:run
npm run start:dev
```

Swagger docs: http://localhost:3010/docs

## Docker

```bash
cp .env.example .env
docker compose up -d
```

## Migrations

```bash
# Generate a new migration after entity changes
npm run migration:generate src/database/migrations/YourMigrationName

# Apply pending migrations
npm run migration:run

# Revert last migration
npm run migration:revert
```

## Environment Variables

See `.env.example` for full reference with descriptions.

Critical variables:

- `PROVIDER_BASE_URL` — sportsdata365.com base (set by Mihir)
- `PROVIDER_API_KEY` — API key from Mihir / ops
- `PROVIDER_RETRY_ATTEMPTS` — max total attempts per provider call (set to `5` for alert threshold)
- `PRIORITY_TOURNAMENT_IDS` — comma-separated unique-tournament IDs to ingest
- `BACKFILL_DAYS_BACK` — how many days of history to backfill on cron run
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — SMTP transport for alert emails
- `ALERT_EMAIL_TO` — alert recipient mailbox

## URL Contract (Nginx → Backend)

| Public URL (nginx)                                         | Internal URL (NestJS)          |
| ---------------------------------------------------------- | ------------------------------ |
| `/tn-base/reverse-proxy/football/api/v1/h2h/sports/{path}` | `/api/v1/sofa/football/{path}` |

Frontend clients and the existing nginx configs **do not need to change**.

## Ops Endpoints

| Endpoint                                           | Purpose                               |
| -------------------------------------------------- | ------------------------------------- |
| `GET /api/v1/health`                               | Full health check (DB + provider)     |
| `GET /api/v1/health/liveness`                      | Liveness probe                        |
| `GET /api/v1/health/readiness`                     | Readiness probe (DB only)             |
| `GET /api/v1/internal/metrics`                     | Snapshot counts, staleness, job stats |
| `GET /api/v1/internal/ingestion/jobs`              | Recent ingestion job audit log        |
| `GET /api/v1/internal/ingestion/jobs/stats`        | Job success/fail rates                |
| `POST /api/v1/internal/ingestion/backfill`         | Manual historical backfill trigger    |
| `POST /api/v1/internal/ingestion/scheduled-events` | Manual scheduled-events trigger       |
| `POST /api/v1/internal/ingestion/metadata`         | Manual metadata refresh               |

All `/internal/*` endpoints should be restricted to internal IPs in nginx.

## Monitoring Checklist

- [ ] Alert when `ingestion_jobs.error_count > 0` for any job in last hour
- [ ] Alert when `raw_snapshots.expired` count grows without cleanup running
- [ ] Alert when provider fallback rate exceeds threshold (DB misses / total requests)
- [ ] Alert when `ingestion_jobs.status = 'running'` for > 30 minutes (hung job)
- [ ] Dashboard: `total snapshots by type` over time (storage growth)

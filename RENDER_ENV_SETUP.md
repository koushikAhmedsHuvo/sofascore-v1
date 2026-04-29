# Render Environment Setup

This project currently reads PostgreSQL config from `POSTGRES_*` variables.
It does not use a single `DATABASE_URL` directly.

If Render gives you a database URL like:

```text
postgresql://sofascore_user:iKfgxblmtROfenMfZjhtz8TqI8cv4hKE@dpg-d7oqgmn7f7vs73b2q9jg-a/sofascore
```

set these in Render:

```env
POSTGRES_HOST=dpg-d7oqgmn7f7vs73b2q9jg-a
POSTGRES_PORT=5432
POSTGRES_USER=sofascore_user
POSTGRES_PASSWORD=iKfgxblmtROfenMfZjhtz8TqI8cv4hKE
POSTGRES_DB=sofascore
POSTGRES_SCHEMA=public
```

Minimum required app envs for Render:

```env
NODE_ENV=production
PORT=10000
SWAGGER_ENABLED=true


PROVIDER_BASE_URL=https://domain.com/football/api/v1/h2h/sports
PROVIDER_API_KEY=your-provider-key
PROVIDER_AUTH_HEADER_NAME=x-api-key

CORS_ORIGINS=https://your-frontend-domain.com
```

Important:

- Do not use local-only placeholder values such as `local-dev-2026` on Render.
- If your provider access is IP/domain-based and does not require a per-request key, leave `PROVIDER_API_KEY` empty.

Recommended additional envs:

```env
API_PREFIX=api/v1
TYPEORM_SYNC=false
TYPEORM_LOGGING=false

PROVIDER_TIMEOUT_MS=15000
PROVIDER_RETRY_ATTEMPTS=5
PROVIDER_RETRY_DELAY_MS=1000

SOFA_DEFAULT_SPORT=football
SOFA_ACTIVE_SPORTS=football
SOFA_CONFIG_COUNTRY_CODES=BD,GB,IN,US,DE,ES,IT,FR,BR
SOFA_TEAM_EVENTS_PAGE=0
SOFA_TOURNAMENT_SEASONS_LOOKBACK=2
SOFA_ODDS_PROVIDER_ID=1
SOFA_HEALTH_PROBE_PATH=sport/football/categories/all

INGESTION_REQUEST_DELAY_MS=500
BACKFILL_DAYS_BACK=365
INGESTION_ENABLE_FULL_FOOTBALL_PLAN=true
INGESTION_ENABLE_SCHEDULED_CRON=true
INGESTION_ENABLE_LIVE_CRON=true
INGESTION_RUN_BOOTSTRAP_ON_STARTUP=true
INGESTION_ENABLE_REGISTRY_BOOTSTRAP_REFRESH=true
INGESTION_ENABLE_FOCUSED_COMPATIBILITY_JOBS=false
INGESTION_RUN_FOCUSED_FLOW_ON_STARTUP=false
INGESTION_NIGHTLY_BACKFILL_DAYS=3
INGESTION_PROGRESS_FLUSH_EVERY=50
INGESTION_MARK_RUNNING_STALE_ON_STARTUP=true

TTL_LIVE_S=30
TTL_SCHEDULED_S=300
TTL_RECENT_S=3600
TTL_HISTORICAL_S=0
TTL_METADATA_S=0
TTL_IMMUTABLE_S=0

THROTTLE_TTL_MS=60000
THROTTLE_LIMIT=120
```

Optional only if you use email alerts:

```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=alerts@example.com
SMTP_PASS=change-me
ALERT_EMAIL_TO=ops@example.com
```

Optional request identity headers:

```env
SOFA_REFERER=https://www.sofascore.com
SOFA_ORIGIN=https://www.sofascore.com
SOFA_USER_AGENT=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36
```

Notes:

- On Render Web Service, `PORT=10000` is a safe default unless your service is configured differently.
- If your frontend is on multiple domains, put them comma-separated in `CORS_ORIGINS`.
- If Render Postgres requires SSL and connection fails, the app code may need a small SSL config update because this project currently only reads host/port/user/password/db fields.

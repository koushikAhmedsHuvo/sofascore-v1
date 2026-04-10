/** PostgreSQL connection settings from `POSTGRES_*` environment variables. */
import { registerAs } from '@nestjs/config';

export const databaseConfig = registerAs('database', () => ({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  name: process.env.POSTGRES_DB ?? 'sofascore_db',
  username: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? '',
  schema: process.env.POSTGRES_SCHEMA ?? 'public',
  synchronize: process.env.TYPEORM_SYNC === 'true',
  logging: process.env.TYPEORM_LOGGING === 'true',
}));

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import {
  RawSnapshot,
  SofaEvent,
  SofaTeamEntity,
  SofaTournamentEntity,
  IngestionJob,
  SofaCountryEntity,
} from '../shared/entities';

dotenv.config();

/**
 * Standalone TypeORM DataSource used exclusively by the TypeORM CLI
 * for migration generation and execution.
 *
 * Application runtime uses TypeOrmModule.forRootAsync() in AppModule.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
  database: process.env.POSTGRES_DB ?? 'sofascore_db',
  username: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? '',
  schema: process.env.POSTGRES_SCHEMA ?? 'public',
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true',
  entities: [
    RawSnapshot,
    SofaEvent,
    SofaTeamEntity,
    SofaTournamentEntity,
    IngestionJob,
    SofaCountryEntity,
  ],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  migrationsTableName: 'typeorm_migrations',
});

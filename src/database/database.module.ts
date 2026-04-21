/**
 * PostgreSQL connection for the whole app. Credentials and schema come from env
 * via `database.config` — never hardcoded. `synchronize` defaults to false;
 * schema changes go through TypeORM migrations. Pool sizing in `extra` may be
 * tuned per environment for ingestion-heavy workloads.
 */
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  RawSnapshot,
  SofaEvent,
  SofaTeamEntity,
  SofaTournamentEntity,
  IngestionJob,
  SofaCountryEntity,
  SofaSportEntity,
} from "../shared/entities";

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        type: "postgres",
        host: cfg.get<string>("database.host"),
        port: cfg.get<number>("database.port"),
        database: cfg.get<string>("database.name"),
        username: cfg.get<string>("database.username"),
        password: cfg.get<string>("database.password"),
        schema: cfg.get<string>("database.schema"),
        synchronize: cfg.get<boolean>("database.synchronize") ?? false,
        logging: cfg.get<boolean>("database.logging") ?? false,
        entities: [
          RawSnapshot,
          SofaEvent,
          SofaTeamEntity,
          SofaTournamentEntity,
          IngestionJob,
          SofaCountryEntity,
          SofaSportEntity,
        ],
        migrations: [__dirname + "/migrations/*.{ts,js}"],
        migrationsTableName: "typeorm_migrations",
        /**
         * Connection pool tuned for high-throughput ingestion + read serving.
         * Increase max for production workloads with many concurrent cron jobs.
         */
        extra: {
          max: 20,
          min: 2,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        },
      }),
    }),
  ],
})
export class DatabaseModule {}

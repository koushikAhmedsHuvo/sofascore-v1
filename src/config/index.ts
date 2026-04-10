/**
 * Central export for `@nestjs/config` `registerAs` factories. Import
 * `ConfigModule.forRoot({ load: [...] })` from `app.module` using these symbols
 * so environment-driven settings stay in one place per domain (app, DB, provider,
 * ingestion, sofa contract).
 */
export { appConfig } from './app.config';
export { databaseConfig } from './database.config';
export { providerConfig } from './provider.config';
export { ingestionConfig } from './ingestion.config';
export { sofaContractConfig } from './sofa-contract.config';

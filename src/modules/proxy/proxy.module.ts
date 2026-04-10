/**
 * Public DB-first proxy: exposes `ProxyController` under the global API prefix.
 * Depends only on `SnapshotModule` — no direct DB or provider imports here.
 */
import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';
import { SnapshotModule } from '../snapshot/snapshot.module';

@Module({
  imports: [SnapshotModule],
  controllers: [ProxyController],
})
export class ProxyModule {}

import { Global, Module } from '@nestjs/common';
import { SofaContractService } from './sofa-contract.service';

/**
 * Global module: `SofaContractService` is a **singleton** (default Nest scope)
 * and is registered once for the entire app. Import this module once in
 * `AppModule`; other modules can inject `SofaContractService` without
 * re-importing.
 */
@Global()
@Module({
  providers: [SofaContractService],
  exports: [SofaContractService],
})
export class SofaContractModule {}

import { Controller, Get } from "@nestjs/common";
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
  HttpHealthIndicator,
  HealthCheckResult,
} from "@nestjs/terminus";
import { ApiOperation, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { SofaContractService } from "../contract/sofa-contract.service";
import { HealthCheckResponseDto, LivenessResponseDto } from "../../common/dto";

/**
 * Health endpoints for orchestrators (K8s, Docker, load balancers).
 *
 * - **GET /** — full check: PostgreSQL + upstream sportsdata365 probe
 * - **GET /liveness** — process only (always fast)
 * - **GET /readiness** — DB only (used before receiving traffic)
 */
@ApiTags("Health & Observability")
@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly http: HttpHealthIndicator,
    private readonly sofaContract: SofaContractService,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: "Full health check",
    description:
      "PostgreSQL ping + HTTP GET to the provider health URL from SofaContractService. " +
      "Returns Terminus `HealthCheckResult`.",
  })
  @ApiOkResponse({
    description: "Terminus aggregated health document.",
    type: HealthCheckResponseDto,
  })
  check(): Promise<HealthCheckResult> {
    const providerUrl = this.sofaContract.getProviderHealthCheckUrl();
    const providerHeaders = this.sofaContract.buildProviderHeaders();

    return this.health.check([
      () => this.db.pingCheck("postgresql"),
      () =>
        this.http.pingCheck("sportsdata365-provider", providerUrl, {
          headers: providerHeaders,
        }),
    ]);
  }

  @Get("liveness")
  @ApiOperation({
    summary: "Liveness probe",
    description:
      "Returns 200 if the Node process is running. Does not check DB or provider.",
  })
  @ApiOkResponse({ type: LivenessResponseDto })
  liveness(): LivenessResponseDto {
    return { status: "ok", timestamp: new Date().toISOString() };
  }

  @Get("readiness")
  @HealthCheck()
  @ApiOperation({
    summary: "Readiness probe",
    description:
      "Returns 200 only when PostgreSQL accepts connections. Use before routing traffic.",
  })
  @ApiOkResponse({ type: HealthCheckResponseDto })
  readiness(): Promise<HealthCheckResult> {
    return this.health.check([() => this.db.pingCheck("postgresql")]);
  }
}

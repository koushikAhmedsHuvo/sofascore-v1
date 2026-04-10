import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** GET /health/liveness */
export class LivenessResponseDto {
  @ApiProperty({ example: 'ok' })
  status: string;

  @ApiProperty({ example: '2026-04-04T12:00:00.000Z' })
  timestamp: string;
}

/**
 * GET /health / GET /health/readiness — Terminus `HealthCheckResult`.
 * Shape varies slightly by Nest/Terminus version; keys are typically `status`, `info`, `error`, `details`.
 */
export class HealthCheckResponseDto {
  @ApiProperty({ example: 'ok', description: 'Overall: ok | error | shim' })
  status: string;

  @ApiPropertyOptional({
    description: 'Per-indicator healthy details when status is ok.',
    example: { postgresql: { status: 'up' } },
  })
  info?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Per-indicator error payloads when status is error.',
  })
  error?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Combined per-check status map.',
  })
  details?: Record<string, unknown>;
}

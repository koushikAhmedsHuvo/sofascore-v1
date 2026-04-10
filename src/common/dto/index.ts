/**
 * OpenAPI schema classes (`@ApiProperty`) and request DTOs (`class-validator`)
 * shared by HTTP controllers. Import from here in controllers for `@ApiOkResponse`,
 * `@ApiBody`, and runtime validation — keeps Swagger accurate and DRY.
 */
export * from './message-response.dto';
export * from './ingestion-request.dto';
export * from './ingestion-response.dto';
export * from './ingestion-job.dto';
export * from './api-coverage.dto';
export * from './health.dto';
export * from './metrics.dto';
export * from './registry.dto';
export * from './sofa-proxy.dto';

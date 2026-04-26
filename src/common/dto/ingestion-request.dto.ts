import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** POST /internal/ingestion/backfill/scheduled-events */
export class BackfillScheduledEventsBodyDto {
  @ApiPropertyOptional({
    description: 'How many calendar days back to fetch scheduled-events for each tournament.',
    example: 90,
    default: 365,
    minimum: 1,
    maximum: 3650,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(3650)
  daysBack?: number;
}

/** POST /internal/ingestion/backfill/match-details */
export class BackfillMatchDetailsBodyDto {
  @ApiPropertyOptional({
    description: 'Max number of finished events to backfill in this run.',
    example: 100,
    default: 100,
    minimum: 1,
    maximum: 10000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  limit?: number;
}

/** POST /internal/ingestion/scheduled-events */
export class ScheduledEventsIngestBodyDto {
  @ApiPropertyOptional({
    description: 'UTC date (YYYY-MM-DD). Defaults to today if omitted.',
    example: '2026-04-04',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}

/** GET /internal/ingestion/jobs */
export class IngestionJobsQueryDto {
  @ApiPropertyOptional({
    description: 'Max rows (default 50).',
    example: 50,
    default: 50,
    minimum: 1,
    maximum: 500,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Filter jobs by exact job type.',
    example: 'scheduled-events',
  })
  @IsOptional()
  @IsString()
  jobType?: string;
}

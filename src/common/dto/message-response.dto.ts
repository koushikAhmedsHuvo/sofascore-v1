import { ApiProperty } from '@nestjs/swagger';

/** Standard async-job acknowledgement returned by many POST /internal/ingestion routes. */
export class MessageResponseDto {
  @ApiProperty({
    example: 'Scheduled-events backfill started. Monitor via /internal/ingestion/jobs.',
    description: 'Human-readable status; the job runs in the background.',
  })
  message: string;
}

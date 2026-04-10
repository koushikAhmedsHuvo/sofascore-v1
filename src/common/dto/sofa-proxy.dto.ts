import { ApiProperty } from '@nestjs/swagger';

/**
 * Example fragment for Swagger — real responses follow SofaScore JSON shapes verbatim.
 */
export class SofaProxyExampleEventDto {
  @ApiProperty({ example: 13981730 })
  id: number;

  @ApiProperty({
    example: { home: 'Team A', away: 'Team B' },
    description: 'Varies by sport — see live provider responses.',
  })
  teams?: Record<string, unknown>;

  @ApiProperty({ example: 'notstarted' })
  status?: string;
}

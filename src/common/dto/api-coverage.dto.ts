import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Nested block under api-coverage: dynamic registry snapshot. */
export class RegistryStateDto {
  @ApiProperty({
    example: ['BD', 'US', 'GB'],
    description: 'Active ISO2 codes from CountryRegistryService.',
    type: [String],
  })
  activeCountryCodes: string[];

  @ApiProperty({ example: 142 })
  activeTournamentCount: number;

  @ApiProperty({
    example: [23, 8, 34],
    description: 'First N tournament IDs (sample).',
    type: [Number],
  })
  activeTournamentIdsSample: number[];

  @ApiProperty({ example: ['football'], type: [String] })
  trackedSports: string[];
}

/** Examples of fully resolved path strings (not templates). */
export class ResolvedPathExamplesDto {
  @ApiProperty({
    example: ['country/alpha2', 'sport/football/categories/all'],
    type: [String],
  })
  globalConfigPaths: string[];

  @ApiProperty({
    example: [
      'unique-tournament/23/scheduled-events/2026-04-04',
      'unique-tournament/8/scheduled-events/2026-04-04',
    ],
    type: [String],
  })
  firstTournamentScheduledEvents: string[];
}

/**
 * GET /internal/ingestion/api-coverage — self-documentation of supported SofaScore paths.
 * The `coverage` map groups human-readable path *templates* by category.
 */
export class ApiCoverageResponseDto {
  @ApiProperty({
    example: 'https://sportsdata365.com/football/api/v1/h2h/sports',
  })
  providerBaseUrl: string;

  @ApiProperty({ example: 'football' })
  defaultSport: string;

  @ApiProperty({ example: 1, description: 'Odds provider segment in paths (e.g. event/…/odds/1/featured).' })
  oddsProviderId: number;

  @ApiProperty({ example: 0, description: 'Page index for team events next/last.' })
  teamEventsPageIndex: number;

  @ApiProperty({ example: 2, description: 'Seasons of history for tournament metadata cron.' })
  tournamentSeasonsLookback: number;

  @ApiProperty({
    example: 'sport/football/categories/all',
    description: 'Relative path used for Terminus provider health probe.',
  })
  healthProbeUrl: string;

  @ApiProperty({ type: RegistryStateDto })
  registryState: RegistryStateDto;

  @ApiProperty({
    description: 'Explains that paths come from SofaContractService + registries.',
  })
  note: string;

  @ApiProperty({ type: ResolvedPathExamplesDto })
  resolvedPathExamples: ResolvedPathExamplesDto;

  @ApiProperty({
    description:
      'Canonical list of every path template inferred from `Sofascore api documentation/` ' +
      '(see `sofa-documented-paths.catalog.ts`). Superset of grouped `coverage` below.',
    type: [String],
  })
  documentedPathTemplates: string[];

  @ApiProperty({
    description:
      'Map of category name → list of path templates (placeholders like {id}, {sport}).',
    example: {
      'sport-level': ['sport/{sport}/categories/all'],
      'tournament-scheduled-events': ['unique-tournament/{id}/scheduled-events/{date}'],
    },
  })
  coverage: Record<string, string[] | string>;
}

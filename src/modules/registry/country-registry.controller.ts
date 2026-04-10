import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { CountryRegistryService } from './country-registry.service';
import {
  CountryListResponseDto,
  CountryPriorityBodyDto,
  CountryPriorityResponseDto,
  CountryRefreshResponseDto,
  CountryToggleResponseDto,
} from '../../common/dto';

/**
 * Admin API for the dynamic country-code registry (no hardcoded ISO2 lists).
 * Restrict to internal networks in production (nginx allow-list).
 */
@ApiTags('Admin — Country Registry')
@Controller('admin/registry/countries')
export class CountryRegistryController {
  constructor(private readonly registry: CountryRegistryService) {}

  @Get()
  @ApiOperation({
    summary: 'List active country codes',
    description:
      'Returns ISO2 codes in priority order as stored by CountryRegistryService ' +
      '(discovered from `config/country-sport-priorities/country`).',
  })
  @ApiOkResponse({ type: CountryListResponseDto })
  getCountries(): CountryListResponseDto {
    return { countries: this.registry.getActiveCountryCodes() };
  }

  @Post('refresh')
  @ApiOperation({
    summary: 'Re-discover countries from the provider',
    description:
      'Calls the global country-sport-priorities endpoint, re-ranks markets, ' +
      'upserts `sofa_countries`, and refreshes the in-memory list.',
  })
  @ApiOkResponse({ type: CountryRefreshResponseDto })
  async refresh(): Promise<CountryRefreshResponseDto> {
    return this.registry.discoverAndRefresh();
  }

  @Post(':alpha2/activate')
  @ApiOperation({ summary: 'Activate a country for per-market config ingestion' })
  @ApiParam({
    name: 'alpha2',
    description: 'ISO 3166-1 alpha-2 code',
    example: 'US',
  })
  @ApiOkResponse({ type: CountryToggleResponseDto })
  async activate(@Param('alpha2') alpha2: string): Promise<CountryToggleResponseDto> {
    await this.registry.setActive(alpha2.toUpperCase(), true);
    return { alpha2: alpha2.toUpperCase(), isActive: true };
  }

  @Post(':alpha2/deactivate')
  @ApiOperation({
    summary: 'Deactivate a country',
    description: 'Skips config/top-tournaments and odds provider fetches for this market until re-enabled.',
  })
  @ApiParam({ name: 'alpha2', example: 'US' })
  @ApiOkResponse({ type: CountryToggleResponseDto })
  async deactivate(@Param('alpha2') alpha2: string): Promise<CountryToggleResponseDto> {
    await this.registry.setActive(alpha2.toUpperCase(), false);
    return { alpha2: alpha2.toUpperCase(), isActive: false };
  }

  @Post(':alpha2/priority')
  @ApiOperation({
    summary: 'Set country priority',
    description: 'Lower numeric priority = processed earlier when iterating markets.',
  })
  @ApiParam({ name: 'alpha2', example: 'US' })
  @ApiBody({ type: CountryPriorityBodyDto })
  @ApiOkResponse({ type: CountryPriorityResponseDto })
  async setPriority(
    @Param('alpha2') alpha2: string,
    @Body() body: CountryPriorityBodyDto,
  ): Promise<CountryPriorityResponseDto> {
    await this.registry.setPriority(alpha2.toUpperCase(), body.priority);
    return { alpha2: alpha2.toUpperCase(), priority: body.priority };
  }
}

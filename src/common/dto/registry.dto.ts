import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Min } from "class-validator";

/** GET /admin/registry/countries */
export class CountryListResponseDto {
  @ApiProperty({
    example: ["BD", "US", "GB"],
    description: "ISO2 codes in priority order (CountryRegistryService).",
    type: [String],
  })
  countries: string[];
}

/** POST /admin/registry/countries/refresh */
export class CountryRefreshResponseDto {
  @ApiProperty({ example: 50, description: "Number of country rows upserted." })
  upserted: number;
}

/** POST /admin/registry/countries/:alpha2/activate|deactivate */
export class CountryToggleResponseDto {
  @ApiProperty({ example: "US" })
  alpha2: string;

  @ApiProperty({ example: true })
  isActive: boolean;
}

/** POST /admin/registry/countries/:alpha2/priority — JSON body `{ "priority": number }`. */
export class CountryPriorityBodyDto {
  @ApiProperty({
    example: 5,
    description: "Lower = higher priority in config fetch order.",
  })
  @IsInt()
  @Min(0)
  priority: number;
}

export class CountryPriorityResponseDto {
  @ApiProperty({ example: "US" })
  alpha2: string;

  @ApiProperty({ example: 5 })
  priority: number;
}

/** GET /admin/registry/sports */
export class SportsListResponseDto {
  @ApiProperty({ example: ["football"], type: [String] })
  sports: string[];
}

/** GET /admin/registry/tournaments | GET /admin/registry/tournaments/:sport */
export class TournamentIdsResponseDto {
  @ApiProperty({ example: "football" })
  sport: string;

  @ApiProperty({ example: [23, 8, 34], type: [Number] })
  ids: number[];
}

/** POST /admin/registry/refresh */
export class TournamentRefreshResponseDto {
  @ApiProperty({ example: true })
  ok: boolean;

  @ApiProperty({ example: "Discovery started in background" })
  message: string;
}

export class TournamentToggleResponseDto {
  @ApiProperty({ example: true })
  ok: boolean;

  @ApiProperty({ example: 23339 })
  sofaId: number;

  @ApiProperty({ example: true })
  isActive: boolean;
}

/** POST /admin/registry/tournaments/:id/priority — JSON body `{ "priority": number }`. */
export class TournamentPriorityBodyDto {
  @ApiProperty({
    example: 10,
    description: "Lower = processed earlier by cron.",
  })
  @IsInt()
  @Min(0)
  priority: number;
}

export class TournamentPriorityResponseDto {
  @ApiProperty({ example: true })
  ok: boolean;

  @ApiProperty({ example: 23339 })
  sofaId: number;

  @ApiProperty({ example: 10 })
  priority: number;
}

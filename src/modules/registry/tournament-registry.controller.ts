import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import { TournamentRegistryService } from "./tournament-registry.service";
import {
  SportsListResponseDto,
  TournamentIdsResponseDto,
  TournamentPriorityBodyDto,
  TournamentPriorityResponseDto,
  TournamentRefreshResponseDto,
  TournamentToggleResponseDto,
} from "../../common/dto";

/**
 * Ops endpoints for TournamentRegistryService — inspect and mutate which
 * `uniqueTournament` IDs are active for ingestion **without redeploying**.
 *
 * Protect with auth / IP allow-list in production.
 */
@ApiTags("Admin — Tournament Registry")
@Controller("admin/registry")
export class TournamentRegistryController {
  constructor(private readonly registry: TournamentRegistryService) {}

  @Get("sports")
  @ApiOperation({
    summary: "List sports with at least one active tournament",
  })
  @ApiOkResponse({ type: SportsListResponseDto })
  getSports(): SportsListResponseDto {
    return { sports: this.registry.getTrackedSports() };
  }

  @Get("tournaments")
  @ApiOperation({
    summary: "List active tournament IDs (default sport)",
    description:
      "Same as `GET .../tournaments/:sport` but uses the default sport when omitted.",
  })
  @ApiOkResponse({ type: TournamentIdsResponseDto })
  getTournamentsDefault(): TournamentIdsResponseDto {
    return this.buildTournamentIdsResponse(undefined);
  }

  @Get("tournaments/:sport")
  @ApiOperation({
    summary: "List active tournament IDs for a sport",
    description: "Path segment filters by sport slug (e.g. `football`).",
  })
  @ApiParam({
    name: "sport",
    example: "football",
    description: "Sport slug",
  })
  @ApiOkResponse({ type: TournamentIdsResponseDto })
  getTournamentsBySport(
    @Param("sport") sport: string,
  ): TournamentIdsResponseDto {
    return this.buildTournamentIdsResponse(sport);
  }

  private buildTournamentIdsResponse(sport?: string): TournamentIdsResponseDto {
    return {
      sport: sport ?? "football",
      ids: this.registry.getActiveTournamentIds(sport),
    };
  }

  @Post("refresh")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Re-run full tournament discovery",
    description:
      "Fires discovery in the background and returns 202 immediately. " +
      "Calls `sport/{sport}/categories/all` and merges default-tournament priorities per country.",
  })
  @ApiOkResponse({ type: TournamentRefreshResponseDto })
  refresh(): TournamentRefreshResponseDto {
    this.registry.discoverAndRefresh().catch(() => {
      // errors are logged inside discoverAndRefresh
    });
    return { ok: true, message: "Discovery started in background" };
  }

  @Post("tournaments/:id/activate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Activate a tournament for ingestion" })
  @ApiParam({
    name: "id",
    description: "SofaScore unique tournament id",
    example: 23339,
  })
  @ApiOkResponse({ type: TournamentToggleResponseDto })
  async activate(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<TournamentToggleResponseDto> {
    await this.registry.setActive(id, true);
    return { ok: true, sofaId: id, isActive: true };
  }

  @Post("tournaments/:id/deactivate")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Deactivate a tournament (skip in cron)" })
  @ApiParam({ name: "id", example: 23339 })
  @ApiOkResponse({ type: TournamentToggleResponseDto })
  async deactivate(
    @Param("id", ParseIntPipe) id: number,
  ): Promise<TournamentToggleResponseDto> {
    await this.registry.setActive(id, false);
    return { ok: true, sofaId: id, isActive: false };
  }

  @Post("tournaments/:id/priority")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Set tournament priority",
    description: "Lower number = processed earlier in ingestion crons.",
  })
  @ApiParam({ name: "id", example: 23339 })
  @ApiBody({ type: TournamentPriorityBodyDto })
  @ApiOkResponse({ type: TournamentPriorityResponseDto })
  async setPriority(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: TournamentPriorityBodyDto,
  ): Promise<TournamentPriorityResponseDto> {
    await this.registry.setPriority(id, body.priority);
    return { ok: true, sofaId: id, priority: body.priority };
  }
}

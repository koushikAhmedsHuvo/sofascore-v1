import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request, Response } from "express";
import { ThrottlerGuard } from "@nestjs/throttler";
import { SnapshotService } from "../snapshot/snapshot.service";
import { normalizePath } from "../../shared/utils/path.utils";
/**
 * Wildcard proxy controller — the primary public surface.
 *
 * URL contract (preserved from existing Matchstat nginx config):
 *   GET /api/v1/sofa/:sport/*path
 *   → DB-first lookup → provider fallback
 *   → returns raw SofaScore-shaped JSON
 *
 * Frontend and nginx consumers keep calling the same URL shape as before.
 * No contract change required.
 *
 * Example mappings:
 *   GET /api/v1/sofa/football/unique-tournament/7/scheduled-events/2026-04-04
 *   GET /api/v1/sofa/football/team/27/events/next/0
 *   GET /api/v1/sofa/football/event/15624970/incidents
 */
@ApiTags("Sofa Proxy (DB-first)")
@UseGuards(ThrottlerGuard)
@Controller("sofa")
export class ProxyController {
  constructor(private readonly snapshotService: SnapshotService) {}

  /**
   * Catch-all wildcard: serves any SofaScore-compatible path.
   * Returns raw provider JSON; adds tracing headers (see @ApiHeader below).
   */
  @Get(":sport/*path")
  @ApiOperation({
    summary: "DB-first SofaScore proxy",
    description:
      "Returns raw SofaScore-shaped JSON. Checks PostgreSQL first; on miss or stale TTL, " +
      "fetches from the configured provider (e.g. sportsdata365) and persists a snapshot.",
  })
  @ApiParam({
    name: "sport",
    description:
      "Sport slug as used in provider paths (football, tennis, basketball, …).",
    example: "football",
  })
  @ApiParam({
    name: "path",
    description:
      "Everything after /sofa/:sport/ — same suffix as www.sofascore.com/api/v1/{path}.",
    example: "unique-tournament/7/scheduled-events/2026-04-04",
  })
  @ApiHeader({
    name: "X-Sofa-Source",
    description:
      "Where the payload came from: `database` (cache hit) or `provider` (fresh fetch).",
    schema: { type: "string", enum: ["database", "provider"] },
  })
  @ApiHeader({
    name: "X-Sofa-Path",
    description: "Normalized relative path (no leading slash).",
    example: "event/13981730/incidents",
  })
  @ApiHeader({
    name: "X-Sofa-Fetched-At",
    description: "ISO timestamp when the snapshot was written.",
  })
  @ApiHeader({
    name: "X-Sofa-Expires-At",
    description:
      "ISO expiry for this snapshot TTL, or the literal `immutable` for finished data.",
  })
  @ApiHeader({
    name: "Cache-Control",
    description:
      "Short public cache when served from DB; no-cache on provider miss.",
  })
  @ApiResponse({
    status: 200,
    description:
      "Raw JSON body — **exact shape from SofaScore / sportsdata365** (varies by path). " +
      "See `SofaProxyExampleEventDto` for one illustrative fragment only.",
    schema: {
      type: "object",
      additionalProperties: true,
      example: {
        event: { id: 13981730, tournament: { name: "Premier League" } },
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: "Throttled — too many requests from this IP.",
  })
  async proxyGet(
    @Param("sport") sport: string,
    @Param("path") pathParam: string | string[],
    @Query() query: Record<string, string>,
    @Req() req: Request & { sofaRawResponse?: boolean },
    @Res() res: Response,
  ): Promise<void> {
    // Mark as raw so ResponseTransformInterceptor doesn't wrap the payload.
    req.sofaRawResponse = true;

    const wildcardPath = Array.isArray(pathParam)
      ? pathParam.join("/")
      : pathParam;
    const sofaPath = normalizePath(wildcardPath);

    const { payload, source, snapshot } = await this.snapshotService.getOrFetch(
      sofaPath,
      query,
      sport,
    );

    res.setHeader("X-Sofa-Source", source);
    res.setHeader("X-Sofa-Path", sofaPath);
    res.setHeader("X-Sofa-Fetched-At", snapshot.fetchedAt?.toISOString() ?? "");
    res.setHeader(
      "X-Sofa-Expires-At",
      snapshot.expiresAt?.toISOString() ?? "immutable",
    );
    res.setHeader(
      "Cache-Control",
      source === "database" ? "public, max-age=60" : "no-cache",
    );

    res.json({
      ...payload,
      _source: {
        retrievedFrom: source === "database" ? "local-db" : "external-api",
        message:
          source === "database"
            ? "Data retrieved from local database (cached snapshot)"
            : "Data retrieved from external provider API (live fetch)",
        fetchedAt: snapshot.fetchedAt?.toISOString() ?? null,
        expiresAt: snapshot.expiresAt?.toISOString() ?? "immutable",
      },
    });
  }
}

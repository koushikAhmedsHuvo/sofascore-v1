import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SofaTournamentEntity } from '../../shared/entities/sofa-tournament.entity';
import { SofaTeamEntity } from '../../shared/entities/sofa-team.entity';
import { SofaEvent } from '../../shared/entities/sofa-event.entity';
import {
  SofaEvent as ISofaEvent,
  SofaTeam as ISofaTeam,
  SofaTournament as ISofaTournament,
} from '../../shared/interfaces/sofa-response.interface';
import { EventStatus } from '../../shared/enums/event-status.enum';
import {
  optionalFiniteNumber,
  optionalRecord,
  optionalString,
  parseScheduledEventForNormalize,
  scoreObjectForColumn,
} from './sofa-payload-guards';

/**
 * Converts raw SofaScore JSON payloads into typed, indexed PostgreSQL rows.
 *
 * Design rules:
 * - All writes use upsert ON CONFLICT on sofa_id to guarantee idempotency.
 * - Teams and tournaments are upserted before events (FK resolution).
 * - Raw payload is always preserved in `raw_payload` / `raw_meta` for
 *   forward compatibility when SofaScore adds new fields.
 * - **Missing optional fields** → `null` columns; never throw. See
 *   `sofa-payload-guards.ts` for required-field policy on events.
 * - This service is called by ingestion cron jobs — not by proxy routes.
 */
@Injectable()
export class NormalizeService {
  private readonly logger = new Logger(NormalizeService.name);

  constructor(
    @InjectRepository(SofaTournamentEntity)
    private readonly tournamentRepo: Repository<SofaTournamentEntity>,
    @InjectRepository(SofaTeamEntity)
    private readonly teamRepo: Repository<SofaTeamEntity>,
    @InjectRepository(SofaEvent)
    private readonly eventRepo: Repository<SofaEvent>,
  ) {}

  /**
   * Processes a SofaScore scheduled-events payload and normalizes all
   * tournaments, teams, and events it contains.
   *
   * Returns counts for monitoring.
   */
  async normalizeScheduledEventsPayload(
    payload: Record<string, unknown>,
    sport = 'football',
  ): Promise<{ tournaments: number; teams: number; events: number }> {
    const rawList = payload['events'];
    const rawEvents = Array.isArray(rawList) ? rawList : [];

    const events: ISofaEvent[] = [];
    for (const item of rawEvents) {
      if (parseScheduledEventForNormalize(item)) {
        events.push(item as ISofaEvent);
      } else {
        this.logger.warn(
          'Skipping scheduled-events row: missing id, homeTeam.id, awayTeam.id, or startTimestamp — ' +
            'cannot satisfy NOT NULL columns (full object may still exist in raw_snapshots).',
        );
      }
    }

    if (!events.length) {
      return { tournaments: 0, teams: 0, events: 0 };
    }

    let tournamentsUpserted = 0;
    let teamsUpserted = 0;
    let eventsUpserted = 0;

    // Deduplicate within this batch before hitting the DB
    const tournamentMap = new Map<number, ISofaTournament>();
    const teamMap = new Map<number, ISofaTeam>();

    for (const event of events) {
      const utId = optionalFiniteNumber(event.tournament?.uniqueTournament?.id);
      if (utId !== undefined && event.tournament) {
        tournamentMap.set(utId, event.tournament as unknown as ISofaTournament);
      }
      const hid = optionalFiniteNumber(event.homeTeam?.id);
      const aid = optionalFiniteNumber(event.awayTeam?.id);
      if (hid !== undefined) teamMap.set(hid, event.homeTeam);
      if (aid !== undefined) teamMap.set(aid, event.awayTeam);
    }

    // Upsert tournaments
    for (const [id, t] of tournamentMap) {
      await this.upsertTournament(id, t, sport);
      tournamentsUpserted++;
    }

    // Upsert teams
    for (const [id, team] of teamMap) {
      await this.upsertTeam(id, team, sport);
      teamsUpserted++;
    }

    // Upsert events
    for (const event of events) {
      await this.upsertEvent(event, sport);
      eventsUpserted++;
    }

    this.logger.debug(
      `Normalized: ${eventsUpserted} events, ${teamsUpserted} teams, ${tournamentsUpserted} tournaments`,
    );

    return {
      tournaments: tournamentsUpserted,
      teams: teamsUpserted,
      events: eventsUpserted,
    };
  }

  /**
   * Upserts from `scheduled-events` payload fragments; prefers `uniqueTournament`
   * fields when present (SofaScore nests metadata under both).
   */
  private async upsertTournament(
    sofaId: number,
    t: ISofaTournament,
    sport: string,
  ): Promise<void> {
    const uniqueTournament = t.uniqueTournament;
    const displayName =
      optionalString(uniqueTournament?.name) ??
      optionalString(t.name) ??
      'Unknown tournament';
    await this.tournamentRepo
      .createQueryBuilder()
      .insert()
      .into(SofaTournamentEntity)
      .values({
        sofaId,
        name: displayName,
        slug: uniqueTournament?.slug ?? t.slug ?? null,
        sport,
        categoryName: optionalString(t.category?.name) ?? null,
        categoryId: optionalFiniteNumber(t.category?.id) ?? null,
        categorySlug: optionalString(t.category?.slug) ?? null,
        countryAlpha2:
          optionalString(t.category?.country?.alpha2) ??
          optionalString(t.category?.alpha2) ??
          null,
        primaryColorHex: optionalString(uniqueTournament?.primaryColorHex) ?? null,
        secondaryColorHex: optionalString(uniqueTournament?.secondaryColorHex) ?? null,
        userCount: optionalFiniteNumber(uniqueTournament?.userCount) ?? null,
        rawMeta: t as unknown as Record<string, unknown>,
      } as object)
      .orUpdate(
        [
          'name',
          'slug',
          'category_name',
          'category_id',
          'category_slug',
          'country_alpha2',
          'primary_color_hex',
          'secondary_color_hex',
          'user_count',
          'raw_meta',
          'updated_at',
        ],
        ['sofa_id'],
      )
      .execute();
  }

  /** Team row from home/away references in the same scheduled-events batch. */
  private async upsertTeam(
    sofaId: number,
    team: ISofaTeam,
    sport: string,
  ): Promise<void> {
    await this.teamRepo
      .createQueryBuilder()
      .insert()
      .into(SofaTeamEntity)
      .values({
        sofaId,
        name: optionalString(team.name) ?? 'Unknown team',
        fullName: optionalString(team.fullName) ?? null,
        slug: optionalString(team.slug) ?? null,
        shortName: optionalString(team.shortName) ?? null,
        nameCode: optionalString(team.nameCode) ?? null,
        sport: optionalString(team.sport?.slug) ?? sport,
        countryAlpha2: optionalString(team.country?.alpha2) ?? null,
        gender: optionalString(team.gender) ?? null,
        userCount: optionalFiniteNumber(team.userCount) ?? null,
        teamType: optionalFiniteNumber(team.type) ?? null,
        teamClass: optionalFiniteNumber(team.class) ?? null,
        primaryColor: optionalString(team.teamColors?.primary) ?? null,
        secondaryColor: optionalString(team.teamColors?.secondary) ?? null,
        textColor: optionalString(team.teamColors?.text) ?? null,
        rawMeta: team as unknown as Record<string, unknown>,
      } as object)
      .orUpdate(
        [
          'name',
          'full_name',
          'slug',
          'short_name',
          'name_code',
          'sport',
          'country_alpha2',
          'gender',
          'user_count',
          'team_type',
          'team_class',
          'primary_color',
          'secondary_color',
          'text_color',
          'raw_meta',
          'updated_at',
        ],
        ['sofa_id'],
      )
      .execute();
  }

  /**
   * Event upsert after teams/tournaments exist. Scores stored as JSONB for
   * multi-sport shapes (periods, overtime, tennis sets, etc.).
   */
  private async upsertEvent(event: ISofaEvent, sport: string): Promise<void> {
    const required = parseScheduledEventForNormalize(event);
    if (!required) {
      this.logger.warn(
        `Skipping event normalize: invalid payload for sofa_id candidate — ${JSON.stringify(event).slice(0, 200)}`,
      );
      return;
    }

    const statusType = this.mapStatus(optionalString(event.status?.type));

    const homeScore = scoreObjectForColumn(event.homeScore);
    const awayScore = scoreObjectForColumn(event.awayScore);

    await this.eventRepo
      .createQueryBuilder()
      .insert()
      .into(SofaEvent)
      .values({
        sofaId: required.id,
        slug: optionalString(event.slug) ?? null,
        customId: optionalString(event.customId) ?? null,
        sport,
        homeTeamSofaId: required.homeTeamSofaId,
        awayTeamSofaId: required.awayTeamSofaId,
        tournamentSofaId: optionalFiniteNumber(event.tournament?.uniqueTournament?.id) ?? null,
        competitionSofaId: optionalFiniteNumber(event.tournament?.id) ?? null,
        seasonId: optionalFiniteNumber(event.season?.id) ?? null,
        seasonName: optionalString(event.season?.name) ?? null,
        seasonYear: optionalString(event.season?.year) ?? null,
        round: optionalFiniteNumber(event.roundInfo?.round) ?? null,
        roundName: optionalString(event.roundInfo?.name) ?? null,
        startTimestamp: required.startTimestamp,
        endTimestamp: optionalFiniteNumber(event.endTimestamp) ?? null,
        venue: optionalRecord(event.venue),
        statusType,
        statusCode: optionalFiniteNumber(event.status?.code) ?? null,
        statusDescription: optionalString(event.status?.description) ?? null,
        winnerCode: optionalFiniteNumber(event.winnerCode) ?? null,
        homeScore,
        awayScore,
        rawPayload: event as unknown as Record<string, unknown>,
      } as object)
      .orUpdate(
        [
          'slug',
          'custom_id',
          'season_id',
          'season_name',
          'season_year',
          'round',
          'round_name',
          'end_timestamp',
          'venue',
          'competition_sofa_id',
          'status_type',
          'status_code',
          'status_description',
          'winner_code',
          'home_score',
          'away_score',
          'raw_payload',
          'updated_at',
        ],
        ['sofa_id'],
      )
      .execute();
  }

  /**
   * Maps API status strings to our enum. **Unknown or future SofaScore values
   * default to `NOT_STARTED`** — adjust if you need stricter handling.
   */
  private mapStatus(type: string | undefined): EventStatus {
    const t = (type ?? 'notstarted').toLowerCase();
    const map: Record<string, EventStatus> = {
      notstarted: EventStatus.NOT_STARTED,
      inprogress: EventStatus.IN_PROGRESS,
      halftime: EventStatus.HALFTIME,
      pause: EventStatus.PAUSE,
      finished: EventStatus.FINISHED,
      postponed: EventStatus.POSTPONED,
      canceled: EventStatus.CANCELED,
      awarded: EventStatus.AWARDED,
      interrupted: EventStatus.INTERRUPTED,
      coverage_lost: EventStatus.COVERAGE_LOST,
    };
    return map[t] ?? EventStatus.NOT_STARTED;
  }
}

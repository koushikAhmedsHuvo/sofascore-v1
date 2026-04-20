import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { SofaTournamentEntity } from './sofa-tournament.entity';
import { SofaTeamEntity } from './sofa-team.entity';
import { EventStatus } from '../enums/event-status.enum';

/**
 * Normalized sports event (match) entity.
 *
 * Columns mirror fields from SofaScore `event/{id}` and scheduled-events
 * payloads (see `Sofascore api documentation/` captures). Scores stay JSONB
 * because shapes vary: NFL uses numeric period keys; cricket may use `{}`
 * before start; tennis adds set fields.
 *
 * Full document (including `periods`, `time`, `changes`, …) is in `raw_payload`.
 *
 * **Optional API fields → entity:** every column that SofaScore may omit is
 * `nullable: true` in TypeORM and typed `| null` in TypeScript. Required
 * normalized keys: `sofaId`, `homeTeamSofaId`, `awayTeamSofaId`, `startTimestamp`,
 * `rawPayload`, `sport`, `statusType`.
 *
 * **`raw_payload` vs `raw_snapshots`:** `raw_snapshots` stores **whole** responses
 * keyed by path (e.g. full `scheduled-events` day). `raw_payload` here is the
 * **single event object** from that list for fast per-event access. Sub-resources
 * (`event/{id}/statistics`, …) live only under `raw_snapshots` when backfill runs;
 * use those rows for complete historical detail, not only this column.
 */
@Entity({ name: 'sofa_events' })
@Index(['homeTeamSofaId', 'awayTeamSofaId', 'startTimestamp'])
@Index(['tournamentSofaId', 'startTimestamp'])
@Index(['statusType', 'startTimestamp'])
@Index(['sport', 'statusType', 'startTimestamp'])
export class SofaEvent extends BaseEntity {
  /** SofaScore event integer ID — primary business key. */
  @Index({ unique: true })
  @Column({ name: 'sofa_id', type: 'integer' })
  sofaId: number;

  @Column({ name: 'slug', type: 'varchar', length: 256, nullable: true })
  slug: string | null;

  /** `customId` on the API — stable string key for some sports (e.g. cricket). */
  @Column({ name: 'custom_id', type: 'varchar', length: 64, nullable: true })
  customId: string | null;

  @Column({ name: 'sport', type: 'varchar', length: 64, default: 'football' })
  sport: string;

  @Column({ name: 'home_team_sofa_id', type: 'integer' })
  homeTeamSofaId: number;

  @Column({ name: 'away_team_sofa_id', type: 'integer' })
  awayTeamSofaId: number;

  /**
   * `event.tournament.uniqueTournament.id` — id used in `unique-tournament/{id}/…` routes.
   */
  @Column({ name: 'tournament_sofa_id', type: 'integer', nullable: true })
  tournamentSofaId: number | null;

  /**
   * `event.tournament.id` when present — competition / wrapper id (can differ from unique tournament).
   */
  @Column({ name: 'competition_sofa_id', type: 'integer', nullable: true })
  competitionSofaId: number | null;

  @Column({ name: 'season_id', type: 'integer', nullable: true })
  seasonId: number | null;

  @Column({ name: 'season_name', type: 'varchar', length: 128, nullable: true })
  seasonName: string | null;

  /** `season.year` from API (string e.g. `"2026"`). */
  @Column({ name: 'season_year', type: 'varchar', length: 16, nullable: true })
  seasonYear: string | null;

  @Column({ name: 'round', type: 'smallint', nullable: true })
  round: number | null;

  /** `roundInfo.name` when present (e.g. knockout round label). */
  @Column({ name: 'round_name', type: 'varchar', length: 256, nullable: true })
  roundName: string | null;

  /** Unix timestamp (seconds) of match start. */
  @Index()
  @Column({ name: 'start_timestamp', type: 'bigint' })
  startTimestamp: number;

  /** `endTimestamp` on event detail (scheduled end / actual end depending on status). */
  @Column({ name: 'end_timestamp', type: 'bigint', nullable: true })
  endTimestamp: number | null;

  /** Venue / stadium block from `event.venue`. */
  @Column({ name: 'venue', type: 'jsonb', nullable: true })
  venue: Record<string, unknown> | null;

  @Column({
    name: 'status_type',
    type: 'varchar',
    length: 32,
    default: EventStatus.NOT_STARTED,
  })
  statusType: EventStatus;

  @Column({ name: 'status_code', type: 'smallint', nullable: true })
  statusCode: number | null;

  /** `status.description` e.g. `"Not started"`. */
  @Column({ name: 'status_description', type: 'varchar', length: 256, nullable: true })
  statusDescription: string | null;

  @Column({ name: 'winner_code', type: 'smallint', nullable: true })
  winnerCode: number | null;

  /**
   * Home / away score objects — structure is sport-specific (period keys, `current`, `display`, …).
   */
  @Column({ name: 'home_score', type: 'jsonb', nullable: true })
  homeScore: Record<string, unknown> | null;

  @Column({ name: 'away_score', type: 'jsonb', nullable: true })
  awayScore: Record<string, unknown> | null;

  /** Full SofaScore event payload for downstream consumers. */
  @Column({ name: 'raw_payload', type: 'jsonb' })
  rawPayload: Record<string, unknown>;

  @ManyToOne(() => SofaTournamentEntity, { nullable: true, eager: false })
  @JoinColumn({ name: 'tournament_id' })
  tournament: SofaTournamentEntity | null;

  @ManyToOne(() => SofaTeamEntity, { nullable: true, eager: false })
  @JoinColumn({ name: 'home_team_id' })
  homeTeam: SofaTeamEntity | null;

  @ManyToOne(() => SofaTeamEntity, { nullable: true, eager: false })
  @JoinColumn({ name: 'away_team_id' })
  awayTeam: SofaTeamEntity | null;

  get isFinished(): boolean {
    return this.statusType === EventStatus.FINISHED;
  }

  get isLive(): boolean {
    return [EventStatus.IN_PROGRESS, EventStatus.HALFTIME, EventStatus.PAUSE].includes(
      this.statusType,
    );
  }
}

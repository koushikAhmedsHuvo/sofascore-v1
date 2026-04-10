import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity';

/**
 * Normalized team entity keyed by SofaScore integer team ID.
 *
 * Mirrors `homeTeam` / `awayTeam` objects from `event/{id}` and scheduled-events
 * (see captures under `Sofascore api documentation/`). Extended fields (`fullName`,
 * `userCount`, `type`, `class`) come from live JSON; `raw_meta` keeps the full blob.
 *
 * **Optional API fields:** all columns except `sofaId` and `name` are nullable in DB
 * (`nullable: true`, TypeScript `| null`) when the provider omits them.
 */
@Entity({ name: 'sofa_teams' })
export class SofaTeamEntity extends BaseEntity {
  @Index({ unique: true })
  @Column({ name: 'sofa_id', type: 'integer' })
  sofaId: number;

  @Column({ name: 'name', type: 'varchar', length: 256 })
  name: string;

  /** Long display name when API sends `fullName` (e.g. IPL franchise). */
  @Column({ name: 'full_name', type: 'varchar', length: 512, nullable: true })
  fullName: string | null;

  @Column({ name: 'slug', type: 'varchar', length: 256, nullable: true })
  slug: string | null;

  @Column({
    name: 'short_name',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  shortName: string | null;

  @Column({
    name: 'name_code',
    type: 'varchar',
    length: 8,
    nullable: true,
  })
  nameCode: string | null;

  @Column({ name: 'sport', type: 'varchar', length: 64, default: 'football' })
  sport: string;

  /** Popularity counter from API (`userCount`). */
  @Column({ name: 'user_count', type: 'integer', nullable: true })
  userCount: number | null;

  /**
   * API `type` — e.g. club vs national (semantics vary by sport).
   */
  @Column({ name: 'team_type', type: 'smallint', nullable: true })
  teamType: number | null;

  /** API `class` when present. */
  @Column({ name: 'team_class', type: 'smallint', nullable: true })
  teamClass: number | null;

  @Column({
    name: 'country_alpha2',
    type: 'varchar',
    length: 4,
    nullable: true,
  })
  countryAlpha2: string | null;

  @Column({
    name: 'gender',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  gender: string | null;

  @Column({
    name: 'primary_color',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  primaryColor: string | null;

  @Column({
    name: 'secondary_color',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  secondaryColor: string | null;

  @Column({
    name: 'text_color',
    type: 'varchar',
    length: 16,
    nullable: true,
  })
  textColor: string | null;

  /** Full SofaScore team object for schema forward-compatibility. */
  @Column({ name: 'raw_meta', type: 'jsonb', nullable: true })
  rawMeta: Record<string, unknown> | null;
}

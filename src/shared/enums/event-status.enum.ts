/**
 * Mirrors SofaScore `event.status.type` strings (lowercase in API responses).
 * Used for indexing live matches and backfills; unknown types should be mapped
 * cautiously (see `NormalizeService.mapStatus`).
 */
export enum EventStatus {
  NOT_STARTED = 'notstarted',
  IN_PROGRESS = 'inprogress',
  HALFTIME = 'halftime',
  PAUSE = 'pause',
  FINISHED = 'finished',
  POSTPONED = 'postponed',
  CANCELED = 'canceled',
  AWARDED = 'awarded',
  INTERRUPTED = 'interrupted',
  COVERAGE_LOST = 'coverage_lost',
}

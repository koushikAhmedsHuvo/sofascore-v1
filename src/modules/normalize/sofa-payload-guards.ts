/**
 * Safe extraction helpers for SofaScore JSON.
 *
 * The provider does **not** guarantee a stable schema across sports or API
 * versions. Optional nested objects may be omitted; numeric ids may appear as
 * strings in edge cases; scores may be `{}`, objects, or (rarely) numbers.
 *
 * **Policy for normalization:**
 * - Never throw on missing optional display fields — store `null` / skip column.
 * - Skip an entire event row if **required** keys are missing (`id`, teams,
 *   `startTimestamp`) — the full document remains in `raw_snapshots` if fetched
 *   elsewhere; normalized table is best-effort.
 */

/** Finite non-NaN number, or `undefined`. */
export function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

export function optionalRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Score payload: only persist as JSONB when the value is a non-array object.
 * Primitives are dropped for normalized columns (still in `raw_payload`).
 */
export function scoreObjectForColumn(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export interface MinimalTeamRef {
  id: number;
}

export interface MinimalScheduledEvent {
  id?: unknown;
  homeTeam?: { id?: unknown };
  awayTeam?: { id?: unknown };
  startTimestamp?: unknown;
  tournament?: unknown;
  status?: { type?: unknown; code?: unknown; description?: unknown };
}

/**
 * Returns `null` if the event cannot be normalized safely (missing required fields).
 */
export function parseScheduledEventForNormalize(
  raw: unknown,
): {
  id: number;
  homeTeamSofaId: number;
  awayTeamSofaId: number;
  startTimestamp: number;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as MinimalScheduledEvent;

  const id = optionalFiniteNumber(e.id);
  const homeId = optionalFiniteNumber(e.homeTeam?.id);
  const awayId = optionalFiniteNumber(e.awayTeam?.id);
  const startTs = optionalFiniteNumber(e.startTimestamp);

  if (id === undefined || homeId === undefined || awayId === undefined || startTs === undefined) {
    return null;
  }

  return {
    id,
    homeTeamSofaId: homeId,
    awayTeamSofaId: awayId,
    startTimestamp: startTs,
  };
}

import {
  optionalFiniteNumber,
  optionalString,
  parseScheduledEventForNormalize,
  scoreObjectForColumn,
} from './sofa-payload-guards';

describe('sofa-payload-guards', () => {
  it('parseScheduledEventForNormalize accepts complete payload', () => {
    expect(
      parseScheduledEventForNormalize({
        id: 1,
        homeTeam: { id: 2 },
        awayTeam: { id: 3 },
        startTimestamp: 1700000000,
      }),
    ).toEqual({
      id: 1,
      homeTeamSofaId: 2,
      awayTeamSofaId: 3,
      startTimestamp: 1700000000,
    });
  });

  it('parseScheduledEventForNormalize rejects missing team ids', () => {
    expect(
      parseScheduledEventForNormalize({
        id: 1,
        homeTeam: {},
        awayTeam: { id: 3 },
        startTimestamp: 1700000000,
      }),
    ).toBeNull();
  });

  it('optionalFiniteNumber coerces numeric strings', () => {
    expect(optionalFiniteNumber('42')).toBe(42);
  });

  it('scoreObjectForColumn drops primitives', () => {
    expect(scoreObjectForColumn(3)).toBeNull();
    expect(scoreObjectForColumn({ current: 1 })).toEqual({ current: 1 });
  });

  it('optionalString handles missing', () => {
    expect(optionalString(undefined)).toBeUndefined();
    expect(optionalString('x')).toBe('x');
  });
});

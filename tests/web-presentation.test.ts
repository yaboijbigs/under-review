import { describe, expect, it } from 'vitest';
import { defaultNflSeason } from '../apps/web/lib/presentation.js';

describe('default NFL season',()=>{
  it.each([
    ['2026-12-31T23:59:59.999Z',2026],
    ['2027-01-01T00:00:00.000Z',2026],
    ['2027-02-14T23:00:00.000Z',2026],
    ['2027-06-30T23:59:59.999Z',2026],
    ['2027-07-01T00:00:00.000Z',2027],
    ['2027-09-10T00:00:00.000Z',2027],
  ])('uses season %s → %i',(timestamp,expected)=>{
    expect(defaultNflSeason(new Date(timestamp))).toBe(expected);
  });
});

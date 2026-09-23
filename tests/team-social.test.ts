import { describe, expect, it } from 'vitest';
import { TEAM_SOCIAL, TEAM_SOCIAL_VERIFIED_AT, teamSocialHandle, teamShortName } from '../packages/core/src/team-social.js';

describe('official NFL team X mentions', () => {
  it('covers all 32 clubs with unique verified handles and primary-source provenance', () => {
    expect(Object.keys(TEAM_SOCIAL).sort()).toEqual('ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LAC LAR LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WAS'.split(' '));
    expect(new Set(Object.values(TEAM_SOCIAL).map(team => team.handle.toLowerCase())).size).toBe(32);
    for (const [code, team] of Object.entries(TEAM_SOCIAL)) {
      expect(team.handle).toMatch(/^@[A-Za-z0-9_]{1,15}$/);
      expect(new URL(team.sourceUrl).protocol).toBe('https:');
      expect(teamSocialHandle(code)).toBe(team.handle);
      expect(teamShortName(code)).toMatch(/^[A-Za-z0-9]+$/);
      expect(teamShortName(code)!.length).toBeLessThan(team.handle.length);
    }
    expect(TEAM_SOCIAL_VERIFIED_AT).toBe('2026-09-23');
  });
  it.each([['LA','@RamsNFL'],['STL','@RamsNFL'],['OAK','@Raiders'],['SD','@Chargers'],['SDG','@Chargers'],['JAC','@Jaguars'],['WSH','@Commanders'],['WFT','@Commanders'],['GNB','@Packers'],['KAN','@Chiefs'],['NWE','@Patriots'],['NOR','@Saints'],['SFO','@49ers'],['TAM','@Buccaneers']])('maps %s to its current official franchise account', (code, handle) => {
    expect(teamSocialHandle(code)).toBe(handle);
  });
  it('normalizes case and whitespace without inventing accounts for unknown codes', () => {
    expect(teamSocialHandle(' nyj ')).toBe('@NYJets');
    expect(teamSocialHandle('UNKNOWN')).toBeNull();
    expect(teamSocialHandle('constructor')).toBeNull();
    expect(teamShortName(' nyj ')).toBe('Jets');
    expect(teamShortName('LA')).toBe('Rams');
    expect(teamShortName('OAK')).toBe('Raiders');
    expect(teamShortName('SD')).toBe('Chargers');
    expect(teamShortName('UNKNOWN')).toBeNull();
  });
});

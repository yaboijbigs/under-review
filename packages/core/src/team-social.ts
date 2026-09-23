/** Official club social links checked 2026-09-23; Atlanta's club article embeds the NFL's account mention. */
export const TEAM_SOCIAL_VERIFIED_AT = '2026-09-23';
export const TEAM_SOCIAL = {
  ARI: { handle: '@AZCardinals', sourceUrl: 'https://www.azcardinals.com/' },
  ATL: { handle: '@AtlantaFalcons', sourceUrl: 'https://www.atlantafalcons.com/news/drake-london-nfl-top-100-players-2025' },
  BAL: { handle: '@Ravens', sourceUrl: 'https://www.baltimoreravens.com/' },
  BUF: { handle: '@BuffaloBills', sourceUrl: 'https://www.buffalobills.com/' },
  CAR: { handle: '@Panthers', sourceUrl: 'https://www.panthers.com/' },
  CHI: { handle: '@ChicagoBears', sourceUrl: 'https://www.chicagobears.com/' },
  CIN: { handle: '@Bengals', sourceUrl: 'https://www.bengals.com/' },
  CLE: { handle: '@Browns', sourceUrl: 'https://www.clevelandbrowns.com/' },
  DAL: { handle: '@DallasCowboys', sourceUrl: 'https://www.dallascowboys.com/' },
  DEN: { handle: '@Broncos', sourceUrl: 'https://www.denverbroncos.com/' },
  DET: { handle: '@Lions', sourceUrl: 'https://www.detroitlions.com/' },
  GB: { handle: '@Packers', sourceUrl: 'https://www.packers.com/' },
  HOU: { handle: '@HoustonTexans', sourceUrl: 'https://www.houstontexans.com/' },
  IND: { handle: '@Colts', sourceUrl: 'https://www.colts.com/' },
  JAX: { handle: '@Jaguars', sourceUrl: 'https://www.jaguars.com/' },
  KC: { handle: '@Chiefs', sourceUrl: 'https://www.chiefs.com/' },
  LAC: { handle: '@Chargers', sourceUrl: 'https://www.chargers.com/' },
  LAR: { handle: '@RamsNFL', sourceUrl: 'https://www.therams.com/' },
  LV: { handle: '@Raiders', sourceUrl: 'https://www.raiders.com/' },
  MIA: { handle: '@MiamiDolphins', sourceUrl: 'https://www.miamidolphins.com/' },
  MIN: { handle: '@Vikings', sourceUrl: 'https://www.vikings.com/' },
  NE: { handle: '@Patriots', sourceUrl: 'https://www.patriots.com/' },
  NO: { handle: '@Saints', sourceUrl: 'https://www.neworleanssaints.com/' },
  NYG: { handle: '@Giants', sourceUrl: 'https://www.giants.com/' },
  NYJ: { handle: '@NYJets', sourceUrl: 'https://www.newyorkjets.com/' },
  PHI: { handle: '@Eagles', sourceUrl: 'https://www.philadelphiaeagles.com/' },
  PIT: { handle: '@Steelers', sourceUrl: 'https://www.steelers.com/' },
  SEA: { handle: '@Seahawks', sourceUrl: 'https://www.seahawks.com/' },
  SF: { handle: '@49ers', sourceUrl: 'https://www.49ers.com/' },
  TB: { handle: '@Buccaneers', sourceUrl: 'https://www.buccaneers.com/' },
  TEN: { handle: '@Titans', sourceUrl: 'https://www.tennesseetitans.com/' },
  WAS: { handle: '@Commanders', sourceUrl: 'https://www.commanders.com/' },
} as const;

const aliases: Record<string, keyof typeof TEAM_SOCIAL> = {
  LA: 'LAR', STL: 'LAR', OAK: 'LV', SD: 'LAC', SDG: 'LAC', JAC: 'JAX',
  WSH: 'WAS', WFT: 'WAS', GNB: 'GB', KAN: 'KC', NWE: 'NE', NOR: 'NO', SFO: 'SF', TAM: 'TB',
};
const shortNames:Record<keyof typeof TEAM_SOCIAL,string>={
  ARI:'Cardinals',ATL:'Falcons',BAL:'Ravens',BUF:'Bills',CAR:'Panthers',CHI:'Bears',CIN:'Bengals',CLE:'Browns',
  DAL:'Cowboys',DEN:'Broncos',DET:'Lions',GB:'Packers',HOU:'Texans',IND:'Colts',JAX:'Jaguars',KC:'Chiefs',
  LAC:'Chargers',LAR:'Rams',LV:'Raiders',MIA:'Dolphins',MIN:'Vikings',NE:'Patriots',NO:'Saints',NYG:'Giants',
  NYJ:'Jets',PHI:'Eagles',PIT:'Steelers',SEA:'Seahawks',SF:'49ers',TB:'Buccaneers',TEN:'Titans',WAS:'Commanders',
};
function canonicalTeam(team:string):keyof typeof TEAM_SOCIAL|null{
  const code=team.trim().toUpperCase(),canonical=aliases[code]??code;
  return Object.hasOwn(TEAM_SOCIAL,canonical)?canonical as keyof typeof TEAM_SOCIAL:null;
}

/** Historical franchise/provider aliases intentionally mention the current official club account. */
export function teamSocialHandle(team: string): string | null {
  const canonical=canonicalTeam(team);
  return canonical?TEAM_SOCIAL[canonical].handle:null;
}
/** Club nicknames preserve the matchup without generating account mentions. */
export function teamShortName(team:string):string|null{
  const canonical=canonicalTeam(team);
  return canonical?shortNames[canonical]:null;
}

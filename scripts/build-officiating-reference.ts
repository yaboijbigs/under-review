import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { calibrationGame } from '../packages/core/src/officiating-calibration.js';
import { OFFICIATING_REFERENCE_VERSION, officiatingResultSchema } from '../packages/core/src/officiating-contracts.js';
import { prepareStateModel } from '../packages/core/src/officiating-state-model.js';
import { OFFICIATING_REFERENCE_PARAMETERS, OFFICIATING_TEAM_ALIASES, officiatingObjectChecksum, officiatingReferenceChecksum, validOfficiatingModels, validOfficiatingReference, verifyOfficiatingPrediction, type OfficiatingReference, type OfficiatingSeasonReference } from '../packages/core/src/officiating-reference.js';
import { checksumBytes, checksumFile, readOfficiatingCorpus, writeAtomic } from './lib/officiating-sources.js';

const root = process.cwd(), arguments_ = process.argv.slice(2);
if (arguments_.some(argument => argument !== '--write')) throw new Error('Only --write is supported; the default validates without writing.');
const input = path.join(root, 'data/officiating-evaluation/impact-2026.json');
const bytes = await readFile(input), evaluation = JSON.parse(bytes.toString('utf8'));
if (evaluation.schemaVersion !== 1 || evaluation.through !== 2026 || evaluation.selection?.prior !== OFFICIATING_REFERENCE_PARAMETERS.prior || evaluation.selection?.crewAdjustment !== OFFICIATING_REFERENCE_PARAMETERS.crewAdjustment || !evaluation.models || !Array.isArray(evaluation.predictions)) throw new Error('Release evaluation or frozen parameter selection is missing.');
const inputCodeChecksums: Record<string, string> = {};
for (const name of ['officiating-observations', 'officiating-frequency', 'officiating-state-model', 'officiating-impact', 'officiating-calibration', 'officiating-contracts', 'officiating-reference']) {
  inputCodeChecksums[name] = await checksumFile(path.join(root, `packages/core/src/${name}.ts`));
  if (['officiating-observations', 'officiating-frequency', 'officiating-state-model', 'officiating-impact'].includes(name) && evaluation.provenance?.[name] !== inputCodeChecksums[name]) throw new Error(`Evaluation used a different ${name} implementation; rerun the release evaluation.`);
}
for (const file of ['scripts/build-officiating-corpus.ts', 'scripts/lib/officiating-sources.ts', 'scripts/build-officiating-reference.ts', 'scripts/evaluate-officiating-impact.ts']) inputCodeChecksums[file] = await checksumFile(path.join(root, file));
const years = Array.from({ length: 12 }, (_, index) => 2015 + index), corpus = await readOfficiatingCorpus(root, years);
const corpusChecksums: Record<string, string> = {}, sourceChecksums: Record<string, string> = {};
for (const year of years) {
  const metadata = JSON.parse(await readFile(path.join(root, `data/officiating-corpus/season-${year}.metadata.json`), 'utf8'));
  if (JSON.stringify(metadata.teamAliases) !== JSON.stringify(OFFICIATING_TEAM_ALIASES)) throw new Error(`Runtime and corpus franchise aliases disagree: ${year}`);
  corpusChecksums[String(year)] = metadata.checksum;
  if (evaluation.corpusChecksums?.[String(year)] !== metadata.checksum) throw new Error(`Evaluation used a different or unrecorded corpus snapshot: ${year}; rerun the release evaluation.`);
  for (const [kind, source] of Object.entries(metadata.sources) as [string, { url: string; checksum: string }][]) sourceChecksums[`${year}:${kind}:${source.url}`] = source.checksum;
}
if (JSON.stringify(Object.keys(evaluation.corpusChecksums).sort()) !== JSON.stringify(years.map(String))) throw new Error('Evaluation corpus provenance is incomplete.');
const preparedModels = new Map<number, Pick<OfficiatingSeasonReference, 'frequency' | 'state' | 'impact'>>();
for (let year = 2020; year <= 2026; year++) {
  const models: unknown = evaluation.models[String(year)];
  if (!validOfficiatingModels(models, year)) throw new Error(`Invalid chronological evaluation fit: ${year}`);
  preparedModels.set(year, { ...models, state: prepareStateModel(models.state) });
}
const expected = new Map(corpus.filter(entry => entry.game.season >= 2020).map(entry => [entry.game.id, entry]));
const predictions = new Map<string, ReturnType<typeof officiatingResultSchema.parse>>();
for (const raw of evaluation.predictions) {
  const prediction = officiatingResultSchema.parse(raw), entry = expected.get(prediction.gameId);
  if (!entry || predictions.has(prediction.gameId) || prediction.season !== entry.game.season || raw.match?.id !== entry.game.id || raw.match?.homeTeam !== entry.game.homeTeam || raw.match?.awayTeam !== entry.game.awayTeam || raw.match?.homeScore !== entry.game.homeScore || raw.match?.awayScore !== entry.game.awayScore || raw.crewStatus !== entry.crewStatus || JSON.stringify(raw.crew) !== JSON.stringify(entry.crew)) throw new Error(`Evaluation/corpus identity conflict: ${prediction.gameId}`);
  const models = preparedModels.get(prediction.season)!;
  verifyOfficiatingPrediction(entry.observation, models, prediction);
  predictions.set(prediction.gameId, prediction);
}
if (predictions.size !== expected.size) throw new Error('Evaluation omits completed corpus games.');
const seasons: OfficiatingReference['seasons'] = {};
for (let year = 2023; year <= 2026; year++) {
  const models = evaluation.models[String(year)];
  if (!models?.frequency || !models.state || !models.impact) throw new Error(`Missing target fit: ${year}`);
  const calibration = [...predictions.values()].filter(result => result.season >= year - 3 && result.season < year).flatMap(result => {
    const summary = calibrationGame(result);
    return summary ? [summary] : [];
  }).sort((a, b) => a.season - b.season || a.gameId.localeCompare(b.gameId));
  const crewAssignments: OfficiatingSeasonReference['crewAssignments'] = {};
  for (const entry of corpus.filter(entry => entry.game.season === year).sort((a, b) => a.game.id.localeCompare(b.game.id))) crewAssignments[entry.game.id] = { status: entry.crewStatus, roles: entry.crew };
  seasons[String(year)] = { ...models,
    modelChecksums: { frequency: officiatingObjectChecksum(models.frequency), state: models.state.checksum, impact: officiatingObjectChecksum(models.impact) },
    calibration, crewAssignments,
    sourceChecksums: Object.fromEntries(Object.entries(sourceChecksums).filter(([key]) => Number(key.split(':')[0]) >= year - 8 && Number(key.split(':')[0]) <= year)),
  };
}
const payload: Omit<OfficiatingReference, 'checksum'> = { schemaVersion: 1, version: OFFICIATING_REFERENCE_VERSION, license: 'CC-BY-4.0', attribution: 'nflverse / nflfastR; Lee Sharpe schedules', parameters: { ...OFFICIATING_REFERENCE_PARAMETERS }, teamAliases: { ...OFFICIATING_TEAM_ALIASES }, seasons,
  provenance: { corpusChecksums, sourceChecksums, inputCodeChecksums, evaluationChecksum: checksumBytes(bytes) } };
const reference: OfficiatingReference = { ...payload, checksum: officiatingReferenceChecksum(payload) };
if (!validOfficiatingReference(reference)) throw new Error('Constructed officiating reference failed integrity validation.');
const output = Buffer.from(JSON.stringify(reference) + '\n');
if (arguments_.includes('--write')) await writeAtomic(path.join(root, 'packages/core/reference/officiating-reference.json'), output);
console.log(JSON.stringify({ written: arguments_.includes('--write'), file: 'packages/core/reference/officiating-reference.json', bytes: output.length, checksum: checksumBytes(output), payloadChecksum: reference.checksum, reproducedPredictions: predictions.size,
  seasons: Object.fromEntries(Object.entries(seasons).map(([year, entry]) => [year, { trainingGames: entry.frequency.games, calibrationGames: entry.calibration.length, crewAssignments: Object.keys(entry.crewAssignments).length }])) }));

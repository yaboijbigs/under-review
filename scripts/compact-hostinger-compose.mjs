#!/usr/bin/env node
// Usage: node scripts/compact-hostinger-compose.mjs [input.yaml] [output.yaml]
// Requires the installed Next.js dependency and Docker Compose; no Docker daemon
// or deployment credentials are needed. This only writes a compact Compose file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const { minify } = createRequire(import.meta.url)('next/dist/compiled/terser');
const services = ['bootstrap', 'coverage', 'check'];
const commandPrefix = ['node', '--import', 'tsx', '--input-type=module', '-e'];
const limit = 8192;
let temporaryDirectory;
let temporaryFile;

function parseCompose(file, projectDirectory) {
  const result = spawnSync('docker', ['compose', '--project-directory', projectDirectory, '-f', file,
    'config', '--no-interpolate', '--format', 'json'], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, COMPOSE_DISABLE_ENV_FILE: '1' },
  });
  // Do not print parsed configuration, environment values, or Docker diagnostics.
  if (result.error || result.status !== 0) throw new Error('Docker Compose could not validate the configuration without interpolation.');
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('Docker Compose did not return valid configuration JSON.'); }
}

try {
  assert.ok(process.argv.length <= 4, 'Usage: node scripts/compact-hostinger-compose.mjs [input.yaml] [output.yaml]');
  const input = path.resolve(process.argv[2] ?? 'deploy/compose.public.yaml');
  const output = path.resolve(process.argv[3] ?? 'deploy/private/compose.compact.yaml');
  assert.notEqual(input, output, 'The output path must differ from the original manifest.');
  const projectDirectory = path.dirname(input);
  const original = parseCompose(input, projectDirectory);
  let content = (await readFile(input, 'utf8')).replaceAll('\r\n', '\n');
  const compactCommands = new Map();

  for (const service of services) {
    const command = original.services?.[service]?.command;
    assert.ok(Array.isArray(command) && command.length === 6, `Expected one inline JavaScript command in ${service}.`);
    assert.deepEqual(command.slice(0, -1), commandPrefix, `Unexpected command prefix in ${service}.`);
    assert.equal(typeof command[5], 'string');
    const compact = (await minify(command[5], { module: true, compress: true, mangle: true, format: { comments: false } })).code;
    assert.ok(compact, `Minification produced an empty command for ${service}.`);
    const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: compact, encoding: 'utf8', timeout: 5000 });
    assert.ok(!syntax.error && syntax.status === 0, `Compacted JavaScript failed syntax validation for ${service}.`);
    compactCommands.set(service, compact);

    const servicePattern = new RegExp(`^  ${service}:\\n[\\s\\S]*?(?=^  [A-Za-z_][\\w-]*:|^[^ \\n]|$(?![\\s\\S]))`, 'm');
    const block = servicePattern.exec(content);
    assert.ok(block, `Could not locate the original ${service} service block.`);
    const commandPattern = /^    command:\n(?:      - [^\n]*\n){5}      - \|\n(?:        [^\n]*\n|\n)+/m;
    const inline = commandPattern.exec(block[0]);
    assert.ok(inline, `Expected the documented multiline command layout in ${service}.`);
    const start = block.index + inline.index;
    const replacement = `    command: [node,--import,tsx,--input-type=module,-e,'${compact.replaceAll("'", "''")}']\n`;
    content = content.slice(0, start) + replacement + content.slice(start + inline[0].length);
  }

  content = content.replaceAll('&app-env', '&e').replaceAll('*app-env', '*e').replaceAll('&guard', '&g').replaceAll('*guard', '*g');
  content = content.split('\n').map(line => /^\s+\w[\w_]*: [\[{]/.test(line) && !line.includes('command: [node,--import')
    ? line.replace(/, +/g, ',') : line).join('\n');
  content = content.replace(/^( +)/gm, spaces => ' '.repeat(Math.ceil(spaces.length / 2)));
  assert.ok(content.length <= limit, `Configuration still exceeds Hostinger's ${limit}-character limit: ${content.length}.`);

  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'under-review-compose-'));
  temporaryFile = path.join(temporaryDirectory, 'compact.yaml');
  await writeFile(temporaryFile, content, { mode: 0o600 });
  const compact = parseCompose(temporaryFile, projectDirectory);
  for (const service of services) {
    assert.deepEqual(compact.services?.[service]?.command, [...commandPrefix, compactCommands.get(service)], `Compacted command changed during YAML parsing: ${service}.`);
    // Only these three code strings may differ; every other parsed value must match.
    compact.services[service].command[5] = original.services[service].command[5];
  }
  assert.deepEqual(compact, original, 'Compaction changed a deployment setting.');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, content, { mode: 0o600 });
  console.log(JSON.stringify({ compacted: true, input, output, characters: content.length, limit,
    syntaxChecked: services, configurationPreserved: true }));
} catch (error) {
  // Assertion diagnostics can embed configuration objects; output only the message.
  console.error(error instanceof Error ? error.message.split('\n')[0] : 'Compose compaction failed.');
  process.exitCode = 1;
} finally {
  if (temporaryFile) await unlink(temporaryFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (temporaryDirectory) await rmdir(temporaryDirectory);
}

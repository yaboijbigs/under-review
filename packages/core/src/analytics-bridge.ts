import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analysisSchema, gameSchema, type AnalysisRequest, type AnalysisResult } from './contracts.js';

export class AnalyticsEngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) {
    super(message);
    this.name = 'AnalyticsEngineError';
  }
}

export interface AnalyticsOptions {
  rscript?: string;
  scriptPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function assertJson(value: unknown): void {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new AnalyticsEngineError('analytics_input_invalid', 'Analytics input contains a non-finite number.');
  if (Array.isArray(value)) value.forEach(assertJson);
  else if (value && typeof value === 'object') Object.values(value).forEach(assertJson);
  else if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw new AnalyticsEngineError('analytics_input_invalid', 'Analytics input is not JSON data.');
}

/** Fixed executable/script and two filesystem arguments, with no shell or interpolated R expressions. */
export async function runRRequest(request: Record<string, unknown>, options: AnalyticsOptions = {}): Promise<Record<string, unknown>> {
  assertJson(request);
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw new AnalyticsEngineError('analytics_input_too_large', 'Analytics request exceeds its byte limit.');
  const temporary = await mkdtemp(path.join(tmpdir(), 'under-review-r-'));
  const input = path.join(temporary, 'input.json');
  const output = path.join(temporary, 'output.json');
  const executable = options.rscript ?? process.env.RSCRIPT_BIN ?? 'Rscript';
  const script = path.resolve(options.scriptPath ?? process.env.ANALYTICS_SCRIPT ?? 'analytics/run.R');
  try {
    await writeFile(input, encoded, { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = { LANG: 'C.UTF-8', TZ: 'UTC', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' };
    for (const name of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'HOME', 'TMP', 'TEMP', 'TMPDIR', 'R_HOME', 'R_LIBS', 'R_LIBS_USER', 'R_LIBS_SITE', 'R_DEFAULT_PACKAGES', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
      if (process.env[name]) environment[name] = process.env[name];
    }
    const exitCode = await new Promise<number>((resolve, reject) => {
      let settled = false;
      let stderrBytes = 0;
      const child = spawn(executable, ['--vanilla', script, input, output], {
        shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: environment,
        detached: process.platform !== 'win32',
      });
      const stop = (): void => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* The process may have exited between timeout and termination. */ }
      };
      const finish = (error?: Error, code = 1): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(code);
      };
      const timer = setTimeout(() => {
        stop();
        finish(new AnalyticsEngineError('analytics_timeout', 'Analytics exceeded its configured execution time.', true));
      }, options.timeoutMs ?? 300_000);
      child.on('error', (error: NodeJS.ErrnoException) => finish(new AnalyticsEngineError(error.code === 'ENOENT' ? 'engine_unavailable' : 'analytics_spawn_failed', error.code === 'ENOENT' ? 'Rscript is unavailable. Install the pinned R runtime or configure RSCRIPT_BIN.' : 'The analytics process could not start.')));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 1024 * 1024) {
          stop();
          finish(new AnalyticsEngineError('analytics_log_limit', 'Analytics exceeded its diagnostic output limit.'));
        }
      });
      child.on('close', (code) => finish(undefined, code ?? 1));
    });
    let result: Record<string, unknown>;
    try {
      const info = await stat(output);
      if (info.size > (options.maxOutputBytes ?? 32 * 1024 * 1024)) throw new AnalyticsEngineError('analytics_output_too_large', 'Analytics output exceeds its byte limit.');
      result = JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>;
      if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('not an object');
    } catch (error) {
      if (error instanceof AnalyticsEngineError) throw error;
      throw new AnalyticsEngineError('analytics_output_invalid', 'Analytics did not produce a valid JSON response.');
    }
    if (result.error && typeof result.error === 'object') {
      const engineError = result.error as Record<string, unknown>;
      const code = engineError.code;
      const safeCode = typeof code === 'string' && /^[a-z][a-z0-9_]{1,80}$/.test(code) ? code : 'analytics_failed';
      const detail = typeof engineError.message === 'string' ? engineError.message
        .replace(/https?:\/\/\S+/gi, '[source URL]')
        .replace(/(password|token|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
        .replace(/[\r\n\t]+/g, ' ').slice(0, 400) : 'Check the model/runtime status.';
      throw new AnalyticsEngineError(safeCode, `R analytics failed (${safeCode}): ${detail}`);
    }
    if (exitCode !== 0) throw new AnalyticsEngineError('analytics_failed', 'R analytics exited unsuccessfully.');
    if (result.schemaVersion !== 1) throw new AnalyticsEngineError('analytics_contract_version', 'Unsupported analytics response contract.');
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function runAnalytics(request: AnalysisRequest, options: AnalyticsOptions = {}): Promise<AnalysisResult> {
  if (request.schemaVersion !== 1 || request.action !== 'analyze' || !Array.isArray(request.plays) || !Array.isArray(request.snapshots)) {
    throw new AnalyticsEngineError('analytics_input_invalid', 'Invalid analysis request contract.');
  }
  gameSchema.parse(request.game);
  const response = await runRRequest(request as unknown as Record<string, unknown>, options);
  const parsed = analysisSchema.safeParse(response);
  if (!parsed.success) throw new AnalyticsEngineError('analytics_output_invalid', 'Analytics results failed their typed response contract.');
  return parsed.data;
}

import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
import { runAnalytics, runRRequest } from '../packages/core/src/analytics-bridge.js';
import type { AnalysisRequest } from '../packages/core/src/contracts.js';

afterEach(() => { mock.spawn.mockReset(); });

function subprocess(result?: unknown, code = 0) {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), pid: undefined, kill: vi.fn() });
  mock.spawn.mockImplementation((_executable: string, args: string[]) => {
    if (result !== undefined) void writeFile(args[3], typeof result === 'string' ? result : JSON.stringify(result)).then(() => child.emit('close', code));
    return child;
  });
  return child;
}

const input: AnalysisRequest = {
  schemaVersion: 1, action: 'analyze',
  game: { id: '2099_01_TST_TES', season: 2099, week: 1, gameType: 'REG', homeTeam: 'TES', awayTeam: 'TST', homeScore: 0, awayScore: 0, kickoffAt: null, providerData: { synthetic: true } },
  plays: [], ftn: [], snapshots: [], config: {},
};

describe('bounded R JSON bridge', () => {
  it('uses fixed separate arguments and accepts a validated typed result', async () => {
    const output = { schemaVersion: 1, metrics: [], events: [], timeline: [], coverage: [], models: [], warnings: ['Synthetic bridge test only.'] };
    subprocess(output);
    expect(await runAnalytics(input)).toEqual(output);
    const [executable, args, options] = mock.spawn.mock.calls[0];
    expect(executable).toBe('Rscript');
    expect(args).toHaveLength(4);
    expect(args[0]).toBe('--vanilla');
    expect(args[2]).toMatch(/input\.json$/);
    expect(args[3]).toMatch(/output\.json$/);
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options.env.OMP_NUM_THREADS).toBe('1');
    expect(options.env.X_CLIENT_SECRET).toBeUndefined();
  });

  it('rejects malformed or incomplete result contracts instead of making up metrics', async () => {
    subprocess('{not-json');
    await expect(runRRequest({ schemaVersion: 1, action: 'analyze' })).rejects.toMatchObject({ code: 'analytics_output_invalid' });
    subprocess({ schemaVersion: 1, metrics: [] });
    await expect(runAnalytics(input)).rejects.toMatchObject({ code: 'analytics_output_invalid' });
  });

  it('terminates overdue work with a structured timeout', async () => {
    const child = subprocess();
    await expect(runRRequest({ schemaVersion: 1, action: 'analyze' }, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'analytics_timeout', retryable: true });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('retains useful structured R failures while redacting URLs and secret-like details', async () => {
    subprocess({ schemaVersion: 1, error: { code: 'model_missing', message: 'Model absent; token=not-a-real-secret https://example.invalid/artifact?signature=private' } }, 1);
    try {
      await runRRequest({ schemaVersion: 1, action: 'analyze' });
      throw new Error('Expected bridge failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'model_missing' });
      expect((error as Error).message).toContain('Model absent');
      expect((error as Error).message).not.toContain('not-a-real-secret');
      expect((error as Error).message).not.toContain('signature=private');
    }
  });
});

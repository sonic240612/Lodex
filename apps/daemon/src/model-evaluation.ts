import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  AppError,
  makeCommand,
  modelConfigSchema,
  type InferenceEvent,
  type InferenceProvider,
  type InferenceRequest,
  type ModelConfig,
  type ModelDescriptor,
  type Session,
  type Usage,
} from '@lodex/contracts';
import { createInferenceProvider } from '@lodex/providers';
import { Store } from '@lodex/storage';
import { projectReadToolNames } from '@lodex/tools';
import { startServer } from './server';
import { ToolCallAssembler } from './tool-stream';

export interface EvaluationOptions {
  config: ModelConfig;
  variant: 'baseline' | 'eco' | 'both';
  suite: 'smoke' | 'context';
  rounds: number;
  soakHours?: number;
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  totalTimeoutMs: number;
  maxCallsPerTurn: number;
  maxCostUsd: number;
  allowCloud: boolean;
  outputDirectory: string;
  workerPath?: string;
  modelFile?: string;
  engineFile?: string;
  engineVersion?: string;
}
interface Dependencies {
  providerFactory?: (config: ModelConfig) => InferenceProvider;
  apiKey?: string;
  signal?: AbortSignal;
  onProgress?: (result: EvaluationCase) => void;
}
interface EvaluationCall {
  purpose: string;
  startedAt: string;
  durationMs: number;
  completed: boolean;
  usage: Partial<Usage>;
  reservedCostUsd: number;
  chargedCostUsd: number | null;
  errorCode?: string;
}
export interface EvaluationCase {
  round: number;
  variant: 'baseline' | 'eco';
  task: string;
  passed: boolean;
  reasons: string[];
  durationMs: number;
  status: string;
  calls: EvaluationCall[];
  compactions: { beforeTokens: number; afterTokens: number; method: string; reason: string }[];
  peakInputTokens: number | null;
  processRssBytes: number;
}
export interface EvaluationReport {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  finishedAt: string;
  requestedSoakHours: number | null;
  soakElapsedMs: number;
  soakCompleted: boolean;
  environment: { platform: string; arch: string; node: string };
  config: ModelConfig;
  engineVersion: string | null;
  files: { kind: 'model' | 'engine'; bytes: number; sha256: string }[];
  descriptor: ModelDescriptor | null;
  limits: Pick<
    EvaluationOptions,
    'requestTimeoutMs' | 'turnTimeoutMs' | 'totalTimeoutMs' | 'maxCallsPerTurn' | 'maxCostUsd'
  >;
  suite: EvaluationOptions['suite'];
  cases: EvaluationCase[];
  summary: {
    variant: 'baseline' | 'eco';
    cases: number;
    passed: number;
    successRate: number;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    unmeasuredInputCalls: number;
    unmeasuredOutputCalls: number;
    compactedTokens: number;
    costUsd: number;
    uncertainCostUsd: number;
  }[];
  stopped: 'running' | 'completed' | 'duration_reached' | 'cancelled' | 'cost_budget' | 'error';
  errorCode?: string;
  /** A smoke run is evidence for this exact run, never a model certification. */
  validation: 'not_certified';
}

const allowedTools = new Set<string>([
  ...projectReadToolNames,
  'propose_edit',
  'propose_changes',
  'recall_observation',
  'read_tool_result',
  'search_history',
]);
const code = (error: unknown) =>
  error instanceof AppError
    ? error.code
    : error instanceof Error && error.name === 'TimeoutError'
      ? 'EVALUATION_TIMEOUT'
      : 'EVALUATION_FAILED';
const delay = (signal: AbortSignal) =>
  new Promise<void>((done, fail) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      done();
    }, 25);
    function stop() {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      fail(signal.reason);
    }
    signal.addEventListener('abort', stop, { once: true });
  });

export function validateEvaluationOptions(options: EvaluationOptions) {
  modelConfigSchema.parse(options.config);
  if (options.config.provider === 'demo' || options.config.managedModelId)
    throw new AppError(
      'EVALUATION_PROVIDER',
      '평가는 명시한 외부 로컬 서버 또는 OpenRouter 모델을 사용하세요.',
    );
  if (!options.config.model) throw new AppError('EVALUATION_MODEL', '평가할 모델 ID가 필요합니다.');
  for (const [name, value] of Object.entries({
    rounds: options.rounds,
    requestTimeoutMs: options.requestTimeoutMs,
    turnTimeoutMs: options.turnTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
    maxCallsPerTurn: options.maxCallsPerTurn,
  }))
    if (!Number.isSafeInteger(value) || value < 1)
      throw new AppError('EVALUATION_LIMIT', `${name}에는 양의 정수가 필요합니다.`);
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd < 0 || options.maxCostUsd > 1000)
    throw new AppError('EVALUATION_COST', '비용 상한은 0~1000 USD로 지정하세요.');
  if (
    options.soakHours !== undefined &&
    (!Number.isFinite(options.soakHours) || options.soakHours <= 0 || options.soakHours > 72)
  )
    throw new AppError('EVALUATION_SOAK', '반복 검사 시간은 0시간 초과, 72시간 이하로 지정하세요.');
  if (options.config.provider === 'openrouter' && (!options.allowCloud || !options.maxCostUsd))
    throw new AppError(
      'EVALUATION_CLOUD_CONSENT',
      'OpenRouter 평가는 --allow-cloud와 양수 --max-cost-usd를 명시해야 합니다.',
    );
  if (
    !['baseline', 'eco', 'both'].includes(options.variant) ||
    !['smoke', 'context'].includes(options.suite)
  )
    throw new AppError('EVALUATION_SUITE', '평가 모드나 과제 구성이 올바르지 않습니다.');
}

async function hashFile(path: string, kind: 'model' | 'engine', signal: AbortSignal) {
  const canonical = await realpath(path),
    before = await lstat(canonical, { bigint: true });
  if (!before.isFile())
    throw new AppError('EVALUATION_FILE', '모델/엔진은 일반 파일 경로여야 합니다.');
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new AppError('EVALUATION_FILE_CHANGED', '해시 계산 전 파일이 변경되었습니다.');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, signal }))
      hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs
    )
      throw new AppError('EVALUATION_FILE_CHANGED', '해시 계산 중 파일이 변경되었습니다.');
    return { kind, bytes: Number(after.size), sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** Independent scoring reads fixture files only; it never runs generated programs. */
async function grade(
  project: string,
  task: string,
  answer: string,
  marker: string,
  preserved: Map<string, string>,
  noteMarker?: string,
) {
  const reasons: string[] = [];
  if (!answer.includes(marker)) reasons.push('expected_answer_missing');
  if (noteMarker && !answer.includes(noteMarker)) reasons.push('observation_answer_missing');
  const app = await readFile(join(project, 'app.txt'), 'utf8').catch(() => '');
  const expected = task === 'read' ? 'theme=light\nretries=0\n' : 'theme=dark\nretries=3\n';
  if (app !== expected) reasons.push('file_content_mismatch');
  for (const [name, expected] of preserved)
    if ((await readFile(join(project, name), 'utf8').catch(() => '')) !== expected)
      reasons.push('unrelated_file_changed:' + name);
  const listing = (await readdir(project)).sort();
  if (listing.some((name) => name !== 'app.txt' && !preserved.has(name)))
    reasons.push('unexpected_file_created');
  return reasons;
}

export async function runModelEvaluation(
  options: EvaluationOptions,
  dependencies: Dependencies = {},
): Promise<EvaluationReport> {
  validateEvaluationOptions(options);
  if (
    options.config.provider === 'openrouter' &&
    !dependencies.apiKey &&
    !dependencies.providerFactory
  )
    throw new AppError('EVALUATION_API_KEY', 'OPENROUTER_API_KEY가 필요합니다.');
  const abort = new AbortController();
  const signal = AbortSignal.any([
    abort.signal,
    dependencies.signal ?? new AbortController().signal,
    AbortSignal.timeout(options.totalTimeoutMs),
  ]);
  const variants = options.variant === 'both' ? (['baseline', 'eco'] as const) : [options.variant];
  const report: EvaluationReport = {
    schemaVersion: 1,
    id: randomUUID(),
    startedAt: new Date().toISOString(),
    finishedAt: '',
    requestedSoakHours: options.soakHours ?? null,
    soakElapsedMs: 0,
    soakCompleted: false,
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    config: {
      ...options.config,
      cloudConsent: options.allowCloud,
      projectCloudConsent: options.allowCloud,
    },
    engineVersion: options.engineVersion ?? null,
    files: [],
    descriptor: null,
    limits: {
      requestTimeoutMs: options.requestTimeoutMs,
      turnTimeoutMs: options.turnTimeoutMs,
      totalTimeoutMs: options.totalTimeoutMs,
      maxCallsPerTurn: options.maxCallsPerTurn,
      maxCostUsd: options.maxCostUsd,
    },
    suite: options.suite,
    cases: [],
    summary: [],
    stopped: 'running',
    validation: 'not_certified',
  };
  const provider =
    dependencies.providerFactory?.(report.config) ??
    createInferenceProvider(
      report.config.provider,
      report.config.baseUrl,
      dependencies.apiKey ?? null,
    );
  let spent = 0,
    uncertain = 0,
    calls: EvaluationCall[] = [];
  const wrapper: InferenceProvider = {
    listModels: (s) => provider.listModels(s),
    capabilities: (model) => provider.capabilities(model),
    countInputTokens: (request, s) =>
      provider.countInputTokens?.(
        request,
        AbortSignal.any([s, signal, AbortSignal.timeout(options.requestTimeoutMs)]),
      ) ?? Promise.resolve(null),
    async *generate(request, parentSignal) {
      const callSignal = AbortSignal.any([
        parentSignal,
        signal,
        AbortSignal.timeout(options.requestTimeoutMs),
      ]);
      callSignal.throwIfAborted();
      if (calls.length >= options.maxCallsPerTurn)
        throw new AppError('EVALUATION_CALL_LIMIT', '평가 턴의 모델 호출 한도에 도달했습니다.');
      const price = report.descriptor?.pricing;
      const reservation =
        request.config.provider === 'openrouter'
          ? price!.prompt * request.config.contextBudgetTokens +
            price!.completion * request.config.maxTokens +
            price!.request
          : 0;
      if (spent + uncertain + reservation > options.maxCostUsd + 1e-12) {
        const error = new AppError('EVALUATION_COST_BUDGET', '평가 전체 비용 상한에 도달했습니다.');
        abort.abort(error);
        throw error;
      }
      uncertain += reservation;
      const record: EvaluationCall = {
        purpose: request.purpose ?? 'chat',
        startedAt: new Date().toISOString(),
        durationMs: 0,
        completed: false,
        usage: {},
        reservedCostUsd: reservation,
        chargedCostUsd: null,
      };
      calls.push(record);
      const started = performance.now(),
        assembler = new ToolCallAssembler(),
        toolEvents: InferenceEvent[] = [];
      let finish: InferenceEvent | undefined;
      try {
        const restricted: InferenceRequest = {
          ...request,
          ...(request.tools
            ? { tools: request.tools.filter((tool) => allowedTools.has(tool.function.name)) }
            : {}),
        };
        for await (const event of provider.generate(restricted, callSignal)) {
          callSignal.throwIfAborted();
          if (event.type === 'tool_call_delta') {
            assembler.add(event);
            toolEvents.push(event);
          } else if (event.type === 'finished') finish = event;
          else {
            if (event.type === 'usage') Object.assign(record.usage, event.usage);
            yield event;
          }
        }
        if (!finish)
          throw new AppError('EVALUATION_STREAM', '평가 응답이 정상 종료되지 않았습니다.');
        for (const call of assembler.finish()) {
          if (!allowedTools.has(call.name))
            throw new AppError('EVALUATION_TOOL_DENIED', '평가에서 허용되지 않은 도구 호출입니다.');
          const args = JSON.parse(call.arguments) as Record<string, unknown>;
          if ('thenRun' in args)
            throw new AppError(
              'EVALUATION_TOOL_DENIED',
              '평가에서는 모델이 작성한 명령을 실행하지 않습니다.',
            );
        }
        for (const event of toolEvents) yield event;
        record.completed = true;
        yield finish;
      } catch (error) {
        record.errorCode = code(error);
        throw error;
      } finally {
        record.durationMs = performance.now() - started;
        const reported = record.usage.costUsd;
        if (typeof reported === 'number' && Number.isFinite(reported) && reported >= 0) {
          record.chargedCostUsd = reported;
          spent += reported;
          uncertain = Math.max(0, uncertain - reservation);
          if (spent + uncertain > options.maxCostUsd + 1e-12)
            abort.abort(
              new AppError('EVALUATION_COST_BUDGET', '실제 비용이 평가 상한에 도달했습니다.'),
            );
        } else if (request.config.provider !== 'openrouter') record.chargedCostUsd = 0;
      }
    },
  };
  const directory = await mkdtemp(join(tmpdir(), 'lodex-evaluation-'));
  const canonical = await realpath(directory),
    identity = await lstat(canonical, { bigint: true });
  const cleanupDirectory = async () => {
    const current = await lstat(directory, { bigint: true });
    if (
      dirname(resolve(directory)) === resolve(tmpdir()) &&
      (await realpath(directory)) === canonical &&
      current.ino === identity.ino &&
      current.dev === identity.dev &&
      !current.isSymbolicLink()
    )
      await rm(directory, { recursive: true, force: true });
  };
  const store = await Store.open(
    join(directory, 'state.sqlite'),
    options.workerPath ?? resolve('apps/daemon/dist/worker.cjs'),
  ).catch(async (error) => {
    await cleanupDirectory();
    throw error;
  });
  const token = randomBytes(32).toString('hex');
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  let soakStarted: number | undefined;
  const save = async () => {
    await mkdir(options.outputDirectory, { recursive: true });
    const target = join(options.outputDirectory, report.id + '.json'),
      temporary = target + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  };
  try {
    signal.throwIfAborted();
    report.descriptor =
      (
        await provider.listModels(
          AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs)]),
        )
      ).find((model) => model.id === report.config.model) ?? null;
    if (report.config.provider === 'openrouter' && !report.descriptor?.pricing)
      throw new AppError(
        'EVALUATION_PRICING',
        '모델 가격을 확인할 수 없어 유료 평가를 시작하지 않았습니다.',
      );
    if (options.modelFile) report.files.push(await hashFile(options.modelFile, 'model', signal));
    if (options.engineFile) report.files.push(await hashFile(options.engineFile, 'engine', signal));
    app = await startServer({
      store,
      token,
      ...(dependencies.apiKey ? { openrouterKey: dependencies.apiKey } : {}),
      providerFactory: () => wrapper,
      observationRoot: join(directory, 'observations'),
    });
    const api = async (path: string, body: unknown, operationSignal = signal) => {
      const response = await fetch(`http://127.0.0.1:${app!.port}${path}`, {
        method: 'POST',
        signal: operationSignal,
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok)
        throw new AppError('EVALUATION_API', `평가 요청 실패 (HTTP ${response.status}).`);
      return response.json();
    };
    const soakUntil =
      options.soakHours === undefined ? null : Date.now() + options.soakHours * 3_600_000;
    if (soakUntil) soakStarted = Date.now();
    evaluationLoop: for (
      let round = 1;
      soakUntil ? Date.now() < soakUntil : round <= options.rounds;
      round++
    ) {
      for (const variant of variants) {
        signal.throwIfAborted();
        const project = join(directory, `project-${round}-${variant}`),
          marker = `fact-${randomBytes(8).toString('hex')}`;
        await mkdir(project);
        const preserved = new Map([
          ['facts.txt', `Project verification token: ${marker}\n`],
          ['keep.txt', 'Keep this file unchanged.\n'],
        ]);
        await Promise.all(
          [...preserved].map(([name, text]) => writeFile(join(project, name), text)),
        );
        await writeFile(join(project, 'app.txt'), 'theme=light\nretries=0\n');
        const { project: registered } = await api('/v1/projects', { path: project });
        let { session } = (await api(
          '/v1/commands',
          makeCommand({
            type: 'create_session',
            sessionId: randomUUID(),
            title: `Evaluation ${variant}`,
            config: { ...report.config, eco: variant === 'eco' },
            projectId: registered.id,
          }),
        )) as { session: Session };
        ({ session } = await api(
          '/v1/commands',
          makeCommand({
            type: 'set_permission_mode',
            sessionId: session.id,
            expectedVersion: session.version,
            mode: 'auto',
          }),
        ));
        const tasks: { id: string; prompt: string; noteMarker?: string }[] = [
          {
            id: 'read',
            prompt:
              'Read facts.txt, app.txt, and keep.txt using project tools. Reply with the exact verification token from facts.txt. Do not modify anything.',
          },
          {
            id: 'edit',
            prompt:
              'Update app.txt exactly to theme=dark followed by retries=3, one setting per line with a final newline. Keep every other file unchanged. Use project editing tools and verify the result. Include the verification token read in the previous turn in your final answer.',
          },
        ];
        if (options.suite === 'context')
          for (let i = 0; i < 8; i++) {
            const noteMarker = `note-${i}-${randomBytes(6).toString('hex')}`;
            const text =
              Array.from(
                { length: 96 },
                (_, line) =>
                  `Record ${line}: sample sensor ${i}, stable observation ${'0123456789abcdef'.repeat(5)}.`,
              ).join('\n') + `\nVerification: ${noteMarker}\n`;
            preserved.set(`notes-${i}.txt`, text);
            await writeFile(join(project, `notes-${i}.txt`), text);
            tasks.push({
              id: `context-${i}`,
              noteMarker,
              prompt: `Read all of notes-${i}.txt using project tools. Report its Verification value and the original project verification token from our previous work. Do not modify files.`,
            });
          }
        tasks.push({
          id: 'recall',
          prompt:
            'Without changing any files, report the original project verification token from facts.txt and confirm app.txt now contains theme=dark and retries=3. Use earlier work and verify only if needed.',
        });
        for (const task of tasks) {
          if (soakUntil && Date.now() >= soakUntil) break evaluationLoop;
          signal.throwIfAborted();
          calls = [];
          const started = performance.now(),
            turnSignal = AbortSignal.any([signal, AbortSignal.timeout(options.turnTimeoutMs)]);
          let reasons: string[] = [],
            status = 'failed';
          try {
            const latest = await store.session(session.id);
            await api(
              '/v1/commands',
              makeCommand({
                type: 'send_message',
                sessionId: session.id,
                expectedVersion: latest.version,
                content: task.prompt,
              }),
              turnSignal,
            );
            for (;;) {
              turnSignal.throwIfAborted();
              session = await store.session(session.id);
              if (session.run?.status !== 'running') break;
              if (
                session.messages
                  .at(-1)
                  ?.activities?.some((activity) => activity.approval?.status === 'pending')
              )
                throw new AppError('EVALUATION_APPROVAL', '평가에서 승인 대기가 발생했습니다.');
              await delay(turnSignal);
            }
            status = session.run?.status ?? 'missing_run';
            const answer = session.messages.at(-1);
            reasons = await grade(
              project,
              task.id,
              answer?.content.slice(answer.finalResponseOffset ?? 0) ?? '',
              marker,
              preserved,
              task.noteMarker,
            );
            if (status !== 'completed') reasons.push('run_' + status);
          } catch (error) {
            reasons = [code(error)];
            const current = await store.session(session.id);
            if (current.run?.status === 'running')
              await api(
                '/v1/commands',
                makeCommand({ type: 'cancel_run', sessionId: current.id, runId: current.run.id }),
                AbortSignal.timeout(10000),
              ).catch(() => undefined);
            const settle = AbortSignal.timeout(10000);
            while ((await store.session(session.id)).run?.status === 'running') await delay(settle);
          }
          session = await store.session(session.id);
          const last = session.messages.at(-1);
          const compactions: EvaluationCase['compactions'] = [];
          for (const activity of last?.activities ?? [])
            if (
              activity.status === 'completed' &&
              ['Eco 자동 요약', '컨텍스트 자동 LLM 압축'].includes(activity.label)
            ) {
              try {
                const value = JSON.parse(activity.text) as Record<string, unknown>;
                if (
                  value.method === 'semantic' &&
                  typeof value.originalInputTokens === 'number' &&
                  typeof value.compactedInputTokens === 'number'
                )
                  compactions.push({
                    beforeTokens: value.originalInputTokens,
                    afterTokens: value.compactedInputTokens,
                    method: 'semantic',
                    reason: value.strategy === 'incremental' ? 'incremental' : 'threshold',
                  });
              } catch {
                /* An unstructured activity is not a measured reduction. */
              }
            }
          if (!compactions.length && last?.runContextCompaction)
            compactions.push({
              beforeTokens: last.runContextCompaction.originalEstimateTokens,
              afterTokens: last.runContextCompaction.compactedEstimateTokens,
              method: last.runContextCompaction.method ?? 'unknown',
              reason: last.runContextCompaction.strategy ?? 'unknown',
            });
          const result: EvaluationCase = {
            round,
            variant,
            task: task.id,
            passed: !reasons.length,
            reasons,
            durationMs: performance.now() - started,
            status,
            calls,
            compactions,
            peakInputTokens: calls.some((call) => typeof call.usage.inputTokens === 'number')
              ? Math.max(0, ...calls.map((call) => call.usage.inputTokens ?? 0))
              : null,
            processRssBytes: process.memoryUsage().rss,
          };
          report.cases.push(result);
          dependencies.onProgress?.(result);
          await save();
          if (signal.aborted) throw signal.reason;
          if (reasons.some((reason) => reason.startsWith('EVALUATION_'))) break;
        }
      }
    }
    report.stopped = soakUntil ? 'duration_reached' : 'completed';
  } catch (error) {
    report.errorCode = code(signal.aborted ? signal.reason : error);
    report.stopped =
      report.errorCode === 'EVALUATION_COST_BUDGET'
        ? 'cost_budget'
        : dependencies.signal?.aborted
          ? 'cancelled'
          : report.errorCode === 'EVALUATION_TIMEOUT'
            ? 'duration_reached'
            : 'error';
  } finally {
    abort.abort(new AppError('EVALUATION_FINISHED', '평가가 종료되었습니다.'));
    if (app) await app.close();
    else await store.close();
    report.finishedAt = new Date().toISOString();
    report.soakElapsedMs = soakStarted ? Date.now() - soakStarted : 0;
    report.soakCompleted =
      options.soakHours !== undefined &&
      report.soakElapsedMs >= options.soakHours * 3_600_000 &&
      report.stopped === 'duration_reached';
    report.summary = variants.map((variant) => {
      const cases = report.cases.filter((item) => item.variant === variant),
        calls = cases.flatMap((item) => item.calls),
        passed = cases.filter((item) => item.passed).length;
      return {
        variant,
        cases: cases.length,
        passed,
        successRate: cases.length ? passed / cases.length : 0,
        durationMs: cases.reduce((sum, item) => sum + item.durationMs, 0),
        inputTokens: calls.reduce((sum, call) => sum + (call.usage.inputTokens ?? 0), 0),
        outputTokens: calls.reduce((sum, call) => sum + (call.usage.outputTokens ?? 0), 0),
        unmeasuredInputCalls: calls.filter((call) => call.usage.inputTokens == null).length,
        unmeasuredOutputCalls: calls.filter((call) => call.usage.outputTokens == null).length,
        compactedTokens: cases
          .flatMap((item) => item.compactions)
          .reduce((sum, item) => sum + Math.max(0, item.beforeTokens - item.afterTokens), 0),
        costUsd: calls.reduce((sum, call) => sum + (call.chargedCostUsd ?? 0), 0),
        uncertainCostUsd: calls.reduce(
          (sum, call) => sum + (call.chargedCostUsd === null ? call.reservedCostUsd : 0),
          0,
        ),
      };
    });
    try {
      await save();
    } finally {
      await cleanupDirectory();
    }
  }
  return report;
}

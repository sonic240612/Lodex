import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  AppError,
  commandSchema,
  deleteSessionsSchema,
  editActionSchema,
  type ChangeStatus,
  type ChangeSet,
  type SecretSource,
  activityProposal,
  providerSchema,
  localUrlSchema,
  prepareAutopilot,
  autopilotPrompt,
  localProfileInputSchema,
  runtimeSettingsSchema,
  runtimeActionSchema,
  type Command,
  type InferenceProvider,
  type Session,
} from '@lodex/contracts';
import { Store } from '@lodex/storage';
import { ChatCompletionProvider, DemoProvider } from '@lodex/providers';
import { compileContext, type CompiledContext } from '@lodex/context';
import {
  inspectProject,
  projectTools,
  applyEdit,
  undoEdit,
  checkEdit,
  writeChanges,
  checkChanges,
  executionTool,
  inspectDocker,
  cleanupExecution,
  executeCommand,
} from '@lodex/tools';
import { runAgent } from './agent-runner';
import { planningTool } from './planning';
import { verificationTools } from './autopilot';
import { RuntimeManager, type RuntimeLease } from '@lodex/local-runtime';
import { inspectSkillDirectory, skillCatalog, type RegisteredSkill } from '@lodex/skills';
import { skillTools } from './skills';
import { McpConnection, importMcpConfigurations, mcpConfigSchema } from '@lodex/mcp';
import { RunMcp, selectedMcpTools } from './mcp';
import { loadMcpSecret } from './secrets';
import { z } from 'zod';
declare const __dirname: string;
const skillRegistrationInput = z
  .strictObject({
    path: z.string().min(1).max(4096),
    dialect: z.enum(['standard', 'codex', 'claude', 'pi']).default('standard'),
    id: z.uuid().optional(),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine((value) => !!value.id === !!value.expectedRevision);
const skillRemovalInput = z.strictObject({
  id: z.uuid(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
});

interface ServerOptions {
  token: string;
  store: Store;
  openrouterKey?: string | null;
  openrouterKeySource?: SecretSource;
  envFilePath?: string;
  providerFactory?: (session: Session, key: string | null) => InferenceProvider;
  commandExecutor?: typeof executeCommand;
  supervisorPath?: string;
  mcpSupervisorPath?: string;
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new AppError('CONTENT_TYPE', 'JSON 요청이 필요합니다.', 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 262144) throw new AppError('BODY_LIMIT', '요청이 너무 큽니다.', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('INVALID_JSON', '잘못된 JSON 요청입니다.');
  }
}
function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}
export async function startServer(options: ServerOptions) {
  const { store } = options;
  const mcpSupervisorPath =
    options.mcpSupervisorPath ??
    (typeof __dirname === 'string'
      ? join(__dirname, 'mcp-supervisor.cjs')
      : resolve('apps/daemon/dist/mcp-supervisor.cjs'));
  const resolveMcpSecret = async (name: string) => (await loadMcpSecret(name, options)) ?? null;
  const shutdown = new AbortController();
  const runtime = new RuntimeManager(
    store,
    options.supervisorPath ??
      (typeof __dirname === 'string'
        ? join(__dirname, 'supervisor.cjs')
        : resolve('apps/daemon/dist/supervisor.cjs')),
  );
  let openrouterKey = options.openrouterKey ?? null;
  let openrouterKeySource: SecretSource =
    options.openrouterKeySource ?? (openrouterKey ? 'os_keychain' : 'none');
  const active = new Map<string, { abort: AbortController; task: Promise<void> }>();
  const streams = new Set<ServerResponse>();
  let queue: Promise<unknown> = Promise.resolve();
  let closing = false;
  // Recovery marks commands interrupted. The cleanup endpoint uses persisted ownership;
  // an unavailable Docker engine must not prevent the desktop from opening.
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };
  async function execute(
    session: Session,
    controller: AbortController,
    context: CompiledContext,
    skills: RegisteredSkill[],
    mcpSelections: ReturnType<typeof selectedMcpTools>,
  ): Promise<void> {
    let lease: RuntimeLease | undefined;
    const autopilot = session.autopilot;
    const loadSignal =
      autopilot && autopilot.runId === session.run?.id
        ? AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(
              Math.max(
                1,
                autopilot.limits.minutes * 60000 - (Date.now() - Date.parse(autopilot.startedAt)),
              ),
            ),
          ])
        : controller.signal;
    try {
      if (session.config.provider === 'llama-server' && session.config.managedModelId) {
        lease = await runtime.acquire(
          session.config.managedModelId,
          loadSignal,
          session.config.managedModelVersion,
        );
        session = {
          ...session,
          config: { ...session.config, model: lease.model, baseUrl: lease.baseUrl },
        };
        context = { ...context, request: { ...context.request, config: session.config } };
      }
      const provider =
        options.providerFactory?.(
          session,
          session.config.provider === 'openrouter' ? openrouterKey : (lease?.key ?? null),
        ) ??
        (session.config.provider === 'demo'
          ? new DemoProvider()
          : new ChatCompletionProvider(
              session.config.provider,
              session.config.baseUrl,
              session.config.provider === 'openrouter' ? openrouterKey : (lease?.key ?? null),
            ));
      const project =
        session.projectId && context.request.tools?.length
          ? await store.project(session.projectId)
          : undefined;
      await runAgent({
        store,
        session,
        provider,
        controller,
        context,
        skills,
        mcp: new RunMcp({
          selections: mcpSelections,
          supervisorPath: mcpSupervisorPath,
          resolveSecret: resolveMcpSecret,
        }),
        ...(project ? { project } : {}),
        ...(options.commandExecutor ? { commandExecutor: options.commandExecutor } : {}),
      });
    } catch (error) {
      await store
        .updateRun({
          sessionId: session.id,
          runId: session.run!.id,
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          error: controller.signal.aborted
            ? '사용자가 응답을 중지했습니다.'
            : loadSignal.aborted
              ? '설정한 실행 시간을 초과했습니다.'
              : error instanceof AppError
                ? error.message
                : '모델 또는 프로젝트 초기화에 실패했습니다.',
        })
        .catch(() => undefined);
    } finally {
      try {
        await lease?.release();
      } finally {
        active.delete(session.run!.id);
      }
    }
  }
  async function command(command: Command) {
    const receipt = await store.receipt(command);
    if (receipt) return receipt;
    let context: CompiledContext | undefined;
    let selectedSkills: RegisteredSkill[] = [];
    let mcpSelections: ReturnType<typeof selectedMcpTools> = [];
    if (
      'sessionId' in command &&
      command.type !== 'create_session' &&
      command.type !== 'cancel_run'
    ) {
      const target = await store.session(command.sessionId);
      if (target.run && active.has(target.run.id) && target.run.status !== 'running')
        throw new AppError('BUSY', '중지한 실행을 정리하는 중입니다.', 409);
    }
    if (command.type === 'send_message' || command.type === 'start_autopilot') {
      const session = await store.session(command.sessionId);
      if (
        session.config.provider === 'openrouter' &&
        !session.mcpCloudConsent &&
        (session.hasMcpHistory || (session.mode !== 'plan' && session.mcp?.length))
      )
        throw new AppError(
          'MCP_CLOUD_CONSENT',
          'MCP 도구 설명과 실행 결과를 OpenRouter로 보내려면 이 대화의 MCP 전송 동의가 필요합니다. 선택을 해제해도 이전 내용은 기록에 남습니다.',
          403,
        );
      if (command.type === 'start_autopilot' && session.mcp?.length)
        throw new AppError(
          'MCP_AUTOPILOT',
          'MCP 도구를 선택한 대화는 아직 Autopilot을 지원하지 않습니다. MCP 선택을 해제하고 실행하세요.',
        );
      if (session.mode !== 'plan')
        mcpSelections = selectedMcpTools(session, await store.registeredMcp());
      const registrations = await store.registeredSkills();
      selectedSkills = (session.skills ?? []).map((selection) => {
        const skill = registrations.find((entry) => entry.id === selection.id);
        if (!skill || skill.revision !== selection.revision)
          throw new AppError(
            'SKILL_CHANGED',
            '선택한 스킬이 변경되거나 삭제되었습니다. 스킬 선택을 다시 확인하세요.',
            409,
          );
        if (!skill.invocation.model)
          throw new AppError(
            'SKILL_INVOCATION',
            '자동 호출을 허용하지 않는 스킬은 현재 대화 도구로 사용할 수 없습니다.',
            403,
          );
        return skill;
      });
      if (
        session.config.provider === 'openrouter' &&
        !session.skillCloudConsent &&
        (selectedSkills.length ||
          session.hasSkillHistory ||
          session.messages.some((message) =>
            message.activities?.some((activity) => activity.skillRead),
          ))
      )
        throw new AppError(
          'SKILL_CLOUD_CONSENT',
          '스킬 메타데이터와 읽은 내용을 OpenRouter로 보내려면 이 대화의 스킬 전송 동의가 필요합니다. 이전에 읽은 내용도 대화 기록에 남아 있습니다.',
          403,
        );
      if (session.config.managedModelId) {
        const profile = (await store.localProfiles()).find(
          (p) => p.id === session.config.managedModelId,
        );
        if (
          session.config.provider !== 'llama-server' ||
          !profile ||
          profile.version !== session.config.managedModelVersion
        )
          throw new AppError(
            'MODEL_PROFILE_CHANGED',
            '관리 모델 설정이 바뀌었거나 삭제되었습니다. 모델 목록에서 새 대화를 만드세요.',
            409,
          );
        if (session.config.contextBudgetTokens > profile.settings.contextSize)
          throw new AppError(
            'ENGINE_CONTEXT_LIMIT',
            '앱 컨텍스트 예산은 관리 엔진의 컨텍스트 길이 이하여야 합니다.',
          );
      }
      for (const other of (await store.snapshot()).sessions) {
        if (
          session.projectId &&
          other.projectId === session.projectId &&
          ((other.run && active.has(other.run.id)) ||
            other.messages.some((m) => m.activities?.some((a) => a.execution?.cleanupPending)))
        )
          throw new AppError(
            'PROJECT_BUSY',
            '이 프로젝트에서 실행 또는 컨테이너 정리가 진행 중입니다.',
            409,
          );
      }
      if (command.expectedVersion !== session.version)
        throw new AppError(
          'VERSION_CONFLICT',
          '대화가 변경되었습니다. 최신 상태를 불러온 뒤 다시 시도하세요.',
          409,
        );
      if (session.config.provider !== 'demo' && !session.config.model)
        throw new AppError('MODEL_REQUIRED', '먼저 모델 ID를 설정하세요.');
      if (session.config.provider === 'openrouter') {
        if (!session.config.cloudConsent)
          throw new AppError('CLOUD_CONSENT', '이 대화의 OpenRouter 전송 동의가 필요합니다.', 403);
        if (!openrouterKey)
          throw new AppError('KEY_REQUIRED', '설정에서 OpenRouter API 키를 저장하세요.');
      }
      if (active.size >= 4)
        throw new AppError(
          'CONCURRENCY_LIMIT',
          '초기 버전은 동시에 최대 4개의 응답을 처리합니다.',
          429,
        );
      if (session.config.provider === 'llama-server') {
        const state = await store.snapshot();
        if (
          state.sessions.some(
            (s) => s.run?.status === 'running' && s.config.provider === 'llama-server',
          )
        )
          throw new AppError(
            'LOCAL_BUSY',
            '로컬 GPU 응답은 한 번에 하나씩 실행합니다. 현재 응답을 기다리거나 중지하세요.',
            409,
          );
      }
      const tools =
        session.projectId &&
        (session.config.provider !== 'openrouter' || session.config.projectCloudConsent)
          ? projectTools.filter(
              (tool) => session.mode !== 'plan' || !tool.function.name.startsWith('propose_'),
            )
          : [];
      tools.push(planningTool);
      tools.push(...mcpSelections.map((value) => value.definition));
      if (selectedSkills.length) tools.push(...skillTools);
      if (
        session.mode !== 'plan' &&
        session.execution?.backend === 'docker' &&
        tools.some((tool) => tool.function.name === 'read_file')
      )
        tools.push(executionTool);
      let content: string;
      if (command.type === 'start_autopilot') {
        const autopilot = prepareAutopilot(session, command.taskIds, command.limits);
        tools.push(...verificationTools);
        content = autopilotPrompt(autopilot);
      } else content = command.content;
      context = compileContext(
        session,
        content,
        tools,
        selectedSkills.length
          ? skillCatalog(selectedSkills, { maxBytes: session.config.eco ? 3000 : 6000 })
          : undefined,
      );
    }
    const result = await store.apply(command, context?.manifest);
    if (
      !result.replayed &&
      (command.type === 'send_message' || command.type === 'start_autopilot')
    ) {
      const abort = new AbortController();
      const task = execute(result.session, abort, context!, selectedSkills, mcpSelections);
      active.set(result.session.run!.id, { abort, task });
    }
    if (command.type === 'cancel_run') active.get(command.runId)?.abort.abort();
    return result;
  }
  const server = createServer(async (request, response) => {
    try {
      if (closing) throw new AppError('SHUTTING_DOWN', '앱을 종료하는 중입니다.', 503);
      const expected = Buffer.from('Bearer ' + options.token);
      const actual = Buffer.from(request.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new AppError('UNAUTHORIZED', '인증되지 않은 요청입니다.', 401);
      if (request.headers.origin !== undefined)
        throw new AppError('ORIGIN_DENIED', '브라우저의 직접 접근은 허용되지 않습니다.', 403);
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (request.headers.host !== '127.0.0.1:' + port)
        throw new AppError('HOST_DENIED', '잘못된 로컬 호스트입니다.', 403);
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        json(response, 200, {
          ...(await store.snapshot()),
          openrouterConfigured: !!openrouterKey,
          openrouterKeySource,
          envFilePath: options.envFilePath,
        });
      } else if (request.method === 'GET' && url.pathname === '/v1/mcp') {
        json(response, 200, { servers: await store.registeredMcp() });
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/import') {
        const parsed = z
          .strictObject({ text: z.string().max(131072), cwd: z.string().max(4096).optional() })
          .safeParse(await readJson(request));
        if (!parsed.success) throw new AppError('MCP_IMPORT', 'MCP 설정 JSON을 확인하세요.');
        json(response, 200, {
          candidates: importMcpConfigurations(parsed.data.text, parsed.data.cwd),
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/register') {
        const parsed = z
          .strictObject({
            config: mcpConfigSchema,
            approved: z.literal(true),
            id: z.uuid().optional(),
            expectedRevision: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .refine((value) => !!value.id === !!value.expectedRevision)
          .safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('MCP_CONFIG', 'MCP 연결 설정과 실행 허용을 확인하세요.');
        const input = parsed.data;
        json(response, 200, {
          server: await serial(async () => {
            if (
              input.id &&
              (await store.snapshot()).sessions.some(
                (session) =>
                  session.mcp?.some((selection) => selection.serverId === input.id) &&
                  session.run &&
                  (session.run.status === 'running' || active.has(session.run.id)),
              )
            )
              throw new AppError(
                'BUSY',
                'MCP 서버를 사용하는 실행이 끝난 뒤 다시 검사하세요.',
                409,
              );
            if (
              input.id &&
              (await store.registeredMcp()).find((server) => server.id === input.id)?.revision !==
                input.expectedRevision
            )
              throw new AppError(
                'VERSION_CONFLICT',
                'MCP 등록 정보가 바뀌었습니다. 목록을 다시 불러오세요.',
                409,
              );
            const connection = await McpConnection.connect({
              config: input.config,
              supervisorPath: mcpSupervisorPath,
              resolveSecret: resolveMcpSecret,
              signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(30000)]),
            });
            const registration = connection.registration;
            await connection.close();
            return store.saveRegisteredMcp(
              { ...registration, ...(input.id ? { id: input.id } : {}) },
              input.expectedRevision,
            );
          }),
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/remove') {
        const parsed = skillRemovalInput.safeParse(await readJson(request));
        if (!parsed.success) throw new AppError('MCP_CONFIG', 'MCP 등록 정보를 확인하세요.');
        json(
          response,
          200,
          await serial(async () => {
            await store.removeRegisteredMcp(parsed.data.id, parsed.data.expectedRevision);
            return { servers: await store.registeredMcp() };
          }),
        );
      } else if (request.method === 'GET' && url.pathname === '/v1/skills') {
        json(response, 200, { skills: await store.registeredSkills() });
      } else if (request.method === 'POST' && url.pathname === '/v1/skills/register') {
        const parsed = skillRegistrationInput.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('SKILL_INPUT', '스킬 폴더와 등록 정보를 확인하세요.');
        const input = parsed.data;
        json(response, 200, {
          skill: await serial(async () => {
            if (input.id) {
              const previous = (await store.registeredSkills()).find(
                (skill) => skill.id === input.id,
              );
              if (!previous || previous.revision !== input.expectedRevision)
                throw new AppError(
                  'VERSION_CONFLICT',
                  '스킬 정보가 변경되었습니다. 목록을 다시 불러오세요.',
                  409,
                );
            }
            const skill = await inspectSkillDirectory(input.path, {
              dialect: input.dialect,
              signal: AbortSignal.timeout(15000),
            });
            return store.saveRegisteredSkill(
              { ...skill, ...(input.id ? { id: input.id } : {}) },
              input.expectedRevision,
            );
          }),
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/skills/remove') {
        const parsed = skillRemovalInput.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('SKILL_INPUT', '삭제할 스킬의 등록 정보를 확인하세요.');
        json(
          response,
          200,
          await serial(async () => {
            await store.removeRegisteredSkill(parsed.data.id, parsed.data.expectedRevision);
            return { skills: await store.registeredSkills() };
          }),
        );
      } else if (request.method === 'GET' && url.pathname === '/v1/runtime') {
        json(response, 200, await runtime.snapshot());
      } else if (request.method === 'POST' && url.pathname === '/v1/runtime/profiles') {
        const input = localProfileInputSchema.safeParse(await readJson(request));
        if (!input.success)
          throw new AppError(
            'PROFILE_INPUT',
            input.error.issues[0]?.message ?? '모델 설정이 올바르지 않습니다.',
          );
        json(response, 200, { profile: await runtime.register(input.data) });
      } else if (request.method === 'POST' && url.pathname === '/v1/runtime/settings') {
        const settings = runtimeSettingsSchema.safeParse(await readJson(request));
        if (!settings.success)
          throw new AppError('RUNTIME_SETTINGS', 'VRAM 설정 범위가 올바르지 않습니다.');
        await runtime.configure(settings.data);
        json(response, 200, await runtime.snapshot());
      } else if (request.method === 'POST' && url.pathname === '/v1/runtime/action') {
        const parsed = runtimeActionSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new AppError('RUNTIME_ACTION', '모델 작업이 올바르지 않습니다.');
        const value = parsed.data;
        if (value.action === 'load') {
          const lease = await runtime.acquire(value.profileId, AbortSignal.timeout(180000));
          await lease.release();
        } else if (value.action === 'unload') await runtime.unload(value.profileId);
        else await runtime.remove(value.profileId);
        json(response, 200, await runtime.snapshot());
      } else if (request.method === 'GET' && url.pathname === '/v1/execution/check') {
        const { executionConfigSchema } = await import('@lodex/contracts');
        const config = executionConfigSchema.safeParse({ image: url.searchParams.get('image') });
        if (!config.success)
          throw new AppError('IMAGE_INVALID', '이미지 이름이 올바르지 않습니다.');
        json(response, 200, await inspectDocker(config.data.image));
      } else if (request.method === 'POST' && url.pathname === '/v1/execution/cleanup') {
        const { idSchema } = await import('@lodex/contracts');
        const value = (await readJson(request)) as { sessionId?: unknown };
        const id = idSchema.safeParse(value.sessionId);
        if (!id.success) throw new AppError('INVALID_COMMAND', '대화 ID가 필요합니다.');
        json(response, 200, {
          session: await serial(async () => {
            const session = await store.session(id.data);
            if (session.run && active.has(session.run.id))
              throw new AppError('BUSY', '실행 종료를 기다리세요.', 409);
            for (const activity of session.messages.flatMap((m) => m.activities ?? [])) {
              if (activity.execution?.cleanupPending) {
                const execution = {
                  ...activity.execution,
                  cleanupPending: !(await cleanupExecution(activity.execution)),
                };
                await store.recordExecution(session.id, activity.id, execution);
              }
            }
            return store.session(session.id);
          }),
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/edits') {
        const parsed = editActionSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('INVALID_COMMAND', '파일 변경 요청이 올바르지 않습니다.');
        json(response, 200, {
          session: await serial(async () => {
            const action = parsed.data;
            const session = await store.session(action.sessionId);
            const edit = activityProposal(
              session.messages
                .flatMap((m) => m.activities ?? [])
                .find((a) => a.id === action.activityId),
            );
            if (!edit || !session.projectId)
              throw new AppError('EDIT_NOT_FOUND', '수정안을 찾을 수 없습니다.', 404);
            if (action.action === 'apply' && edit.status === 'applied') return session;
            if (action.action === 'undo' && edit.status === 'reverted') return session;
            for (const other of (await store.snapshot()).sessions) {
              if (
                other.projectId === session.projectId &&
                ((other.run && active.has(other.run.id)) ||
                  other.messages.some((m) =>
                    m.activities?.some((a) => a.execution?.cleanupPending),
                  ))
              )
                throw new AppError(
                  'BUSY',
                  '이 프로젝트의 응답이 끝난 뒤 변경을 적용해 주세요.',
                  409,
                );
            }
            const project = await store.project(session.projectId);
            const pending = await store.beginEdit(action);
            const pendingEdit = activityProposal(
              pending.messages
                .flatMap((m) => m.activities ?? [])
                .find((a) => a.id === action.activityId),
            )!;
            let status: ChangeStatus = 'uncertain';
            let observations: ChangeSet['observations'];
            const check = async (checkSignal: AbortSignal) => {
              if ('files' in pendingEdit) {
                const result = await checkChanges(project, pendingEdit, checkSignal);
                observations = result.observations;
                return result.status;
              }
              return checkEdit(project, pendingEdit, checkSignal);
            };
            let error: string | undefined;
            const signal = AbortSignal.timeout(15000);
            try {
              if ('files' in pendingEdit) {
                if (action.action !== 'check')
                  await writeChanges(project, pendingEdit, action.action, signal, async (file) => {
                    await store.recordCreatedFile(
                      session.id,
                      action.activityId,
                      file.path,
                      file.stagingId,
                      file.identity!,
                    );
                  });
              } else {
                if (action.action === 'apply') await applyEdit(project, pendingEdit, signal);
                if (action.action === 'undo') await undoEdit(project, pendingEdit, signal);
              }
              status = await check(signal);
              if (status === 'conflict')
                error =
                  '파일이 수정안의 원본 및 결과와 다릅니다. 다시 읽고 새 수정안을 만들어 주세요.';
            } catch (failure) {
              error =
                failure instanceof AppError
                  ? failure.message
                  : '파일 상태를 확인하지 못했습니다. 경로와 접근 권한을 확인해 주세요.';
              try {
                status = await check(AbortSignal.timeout(5000));
              } catch {
                /* Outcome remains uncertain. */
              }
            }
            return store.finishEdit(session.id, action.activityId, status, error, observations);
          }),
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/sessions/delete') {
        const parsed = deleteSessionsSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('INVALID_COMMAND', '삭제할 대화 목록이 올바르지 않습니다.');
        json(
          response,
          200,
          await serial(async () => {
            // A cancelled run may still be releasing a provider or tool operation.
            const state = await store.snapshot();
            for (const target of parsed.data.targets) {
              const session = state.sessions.find((s) => s.id === target.sessionId);
              if (session?.run && active.has(session.run.id))
                throw new AppError('BUSY', '실행을 정리하는 중입니다. 잠시 후 삭제해 주세요.', 409);
            }
            return store.deleteSessions(parsed.data);
          }),
        );
      } else if (request.method === 'POST' && url.pathname === '/v1/projects') {
        const value = (await readJson(request)) as { path?: unknown };
        const project = await inspectProject(value?.path);
        json(response, 200, { project: await serial(() => store.registerProject(project)) });
      } else if (request.method === 'GET' && url.pathname === '/v1/events') {
        const cursor = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
        if (
          typeof cursor !== 'string' ||
          !/^\d+$/.test(cursor) ||
          !Number.isSafeInteger(Number(cursor))
        )
          throw new AppError('BAD_CURSOR', '잘못된 이벤트 커서입니다.');
        let after = Number(cursor),
          busy = false;
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Content-Type-Options': 'nosniff',
        });
        response.write(': connected\n\n');
        streams.add(response);
        const pump = async () => {
          if (busy || response.destroyed || response.writableNeedDrain) return;
          busy = true;
          try {
            for (const event of await store.events(after)) {
              after = event.seq;
              const ready = response.write(
                'id: ' + event.seq + '\ndata: ' + JSON.stringify(event) + '\n\n',
              );
              if (!ready) break;
            }
          } catch {
            response.destroy();
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(() => {
          void pump();
        }, 120);
        const heartbeat = setInterval(() => {
          if (!response.writableNeedDrain) response.write(': heartbeat\n\n');
        }, 15000);
        response.on('close', () => {
          clearInterval(timer);
          clearInterval(heartbeat);
          streams.delete(response);
        });
        void pump();
      } else if (request.method === 'POST' && url.pathname === '/v1/commands') {
        const parsed = commandSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('INVALID_COMMAND', '명령 형식 또는 설정 범위가 올바르지 않습니다.');
        json(response, 200, await serial(() => command(parsed.data)));
      } else if (request.method === 'PUT' && url.pathname === '/v1/secret') {
        if (openrouterKeySource === 'environment' || openrouterKeySource === 'env_file')
          throw new AppError(
            'ENV_MANAGED_KEY',
            '.env 또는 환경 변수에서 키를 관리 중입니다. 해당 값을 수정하고 앱을 다시 시작하세요.',
            409,
          );
        const value = (await readJson(request)) as { key?: unknown };
        if (!(
          value.key === null ||
          (typeof value.key === 'string' && value.key.length <= 1000 && !/[\r\n]/.test(value.key))
        ))
          throw new AppError('INVALID_KEY', '잘못된 키 형식입니다.');
        openrouterKey = value.key;
        openrouterKeySource = openrouterKey ? 'os_keychain' : 'none';
        json(response, 200, { configured: !!openrouterKey });
      } else if (request.method === 'GET' && url.pathname === '/v1/models') {
        const provider = providerSchema.parse(url.searchParams.get('provider'));
        const parsedUrl = localUrlSchema.safeParse(
          url.searchParams.get('baseUrl') ?? 'http://127.0.0.1:8080/v1',
        );
        if (!parsedUrl.success)
          throw new AppError('INVALID_SERVER_URL', parsedUrl.error.issues[0]!.message);
        const baseUrl = parsedUrl.data;
        const adapter =
          provider === 'demo'
            ? new DemoProvider()
            : new ChatCompletionProvider(
                provider,
                baseUrl,
                provider === 'openrouter' ? openrouterKey : null,
              );
        json(response, 200, { models: await adapter.listModels() });
      } else {
        throw new AppError('NOT_FOUND', '지원하지 않는 API입니다.', 404);
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const known = error instanceof AppError;
      json(response, known ? error.status : 500, {
        error: {
          code: known ? error.code : 'INTERNAL',
          message: known ? error.message : '요청을 처리하지 못했습니다.',
        },
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  return {
    port: address.port,
    async close() {
      closing = true;
      shutdown.abort();
      for (const run of active.values()) run.abort.abort();
      await runtime.close();
      await queue;
      await Promise.allSettled([...active.values()].map((run) => run.task));
      for (const stream of streams) stream.end();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await store.close();
    },
  };
}

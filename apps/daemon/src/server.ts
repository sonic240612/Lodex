import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AppError,
  commandSchema,
  deleteSessionsSchema,
  editActionSchema,
  approvalActionSchema,
  elicitationActionSchema,
  type ChangeStatus,
  type ChangeSet,
  type EditAction,
  type ApprovalAction,
  type ElicitationAction,
  type SecretSource,
  activityProposal,
  providerSchema,
  localUrlSchema,
  prepareAutopilot,
  autopilotPrompt,
  prepareGoal,
  resumeGoal,
  goalPrompt,
  localProfileInputSchema,
  runtimeSettingsSchema,
  runtimeActionSchema,
  modelDownloadInputSchema,
  modelDownloadActionSchema,
  engineInstallSchema,
  engineManagerActionSchema,
  modelInspectionInputSchema,
  type Command,
  type InferenceProvider,
  type Session,
  mcpContentInputSchema,
  mcpSubscriptionInputSchema,
  mcpCompletionInputSchema,
  type McpContextAttachment,
  resolveModelConfig,
  resolveAuxiliaryModel,
  type ModelConfig,
  type ModelPricing,
  type Activity,
  telegramConfigSchema,
  backupSettingsSchema,
} from '@lodex/contracts';
import { Store } from '@lodex/storage';
import {
  ChatCompletionProvider,
  createInferenceProvider,
  openRouterAccount,
} from '@lodex/providers';
import { defaultProviderBaseUrl, isLocalProvider } from '@lodex/contracts';
import { OpenRouterCatalog } from './model-catalog';
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
  hostExecutionTool,
  hostFileTools,
  inspectDocker,
  cleanupExecution,
  executeCommand,
  executeHostCommand,
  isProjectReadTool,
  webFetchTool,
  webSearchTool,
  readProjectInstructions,
  fetchWebPage,
} from '@lodex/tools';
import { runAgent } from './agent-runner';
import { planningTool } from './planning';
import { setTaskListTool, updateTaskTool } from './task-list';
import { startTaskList } from '@lodex/contracts';
import { historySearchTool, toolResultRecallTool } from './history';
import { goalCompletionTool, goalResumeEvidence, verificationTools } from './autopilot';
import { reconcileCosts } from './costs';
import { compactManually } from './manual-compaction';
import { reviewWorkTool } from './review';
import { validateCloudTransmission } from './cloud-consent';
import { RuntimeManager } from '@lodex/local-runtime';
import {
  discoverSkillDirectories,
  inspectSkillDirectory,
  skillCatalog,
  type RegisteredSkill,
} from '@lodex/skills';
import { skillTools, prepareDirectSkill, type DirectSkill } from './skills';
import { filterSkillTools } from './skill-policy';
import { UpdatePreparation } from './update-preparation';
import {
  McpConnection,
  importMcpConfigurations,
  mcpConfigSchema,
  McpOAuthManager,
  type McpConfig,
  type ElicitResult,
} from '@lodex/mcp';
import { RunMcp, selectedMcpTools } from './mcp';
import { loadMcpSecret, loadTelegramSecret, telegramToken } from './secrets';
import { Telegram } from './telegram';
import { Worktrees } from './worktrees';
import { LanguageServers, lspTools } from './lsp';
import { languageServerConfigSchema, lspOperationSchema, lspQuerySchema } from '@lodex/contracts';
import {
  WorktreeReviews,
  worktreeTools,
  worktreeReviewSchema,
  worktreeMergeSchema,
} from './worktree-reviews';
import {
  CommandJobs,
  commandJobTools,
  commandJobActionSchema,
  commandJobResizeActionSchema,
} from './jobs';
import { McpContentPreviews } from './mcp-content';
import { McpResourceSubscriptions } from './mcp-subscriptions';
import { OAuthEnvStore } from './oauth-store';
import { InferenceScheduler } from './inference-scheduler';
import { BrowserSession, browserTool } from '@lodex/tools';
import { browserConfigSchema } from '@lodex/contracts';
import { browserSettings } from './browser-settings';
import { Automations } from './automations';
import { automationInputSchema } from '@lodex/contracts';
import { subagentTool } from './subagents';
import { isObservationMarker, ObservationPack, observationRecallTool } from './observations';
import { Backups } from './backups';
import { BackupImporter } from './backup-import';
import { z } from 'zod';
declare const __dirname: string;
const skillRegistrationInput = z
  .strictObject({
    path: z.string().min(1).max(4096),
    dialect: z
      .enum(['standard', 'codex', 'claude', 'pi', 'opencode', 'openclaw', 'hermes'])
      .default('standard'),
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
  worktreeRoot?: string;
  observationRoot?: string;
  telegramFetch?: typeof fetch;
  telegramToken?: string;
  token: string;
  store: Store;
  openrouterKey?: string | null;
  openrouterKeySource?: SecretSource;
  envFilePath?: string;
  providerFactory?: (session: Session, key: string | null) => InferenceProvider;
  commandExecutor?: typeof executeCommand;
  hostCommandExecutor?: typeof executeHostCommand;
  webFetcher?: Parameters<typeof fetchWebPage>[0]['fetcher'];
  supervisorPath?: string;
  mcpSupervisorPath?: string;
  modelRoot?: string;
  modelFetch?: typeof fetch;
  engineRoot?: string;
  engineFetch?: typeof fetch;
  backupRoot?: string;
}
async function readJson(request: IncomingMessage, maxBytes = 262144): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new AppError('CONTENT_TYPE', 'JSON 요청이 필요합니다.', 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) throw new AppError('BODY_LIMIT', '요청이 너무 큽니다.', 413);
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
function operationSignal(response: ServerResponse, shutdown: AbortSignal): AbortSignal {
  const disconnected = new AbortController();
  response.once('close', () => {
    if (!response.writableEnded) disconnected.abort();
  });
  return AbortSignal.any([shutdown, disconnected.signal, AbortSignal.timeout(30000)]);
}
export async function startServer(options: ServerOptions) {
  const { store } = options;
  const observations = options.observationRoot
    ? new ObservationPack(options.observationRoot)
    : undefined;
  const mcpSupervisorPath =
    options.mcpSupervisorPath ??
    (typeof __dirname === 'string'
      ? join(__dirname, 'mcp-supervisor.cjs')
      : resolve('apps/daemon/dist/mcp-supervisor.cjs'));
  const resolveMcpSecret = async (name: string) => (await loadMcpSecret(name, options)) ?? null;
  const oauthStore = options.envFilePath ? new OAuthEnvStore(options.envFilePath) : undefined;
  const oauth = oauthStore ? new McpOAuthManager({ tokenStore: oauthStore }) : undefined;
  const requireOAuth = () => {
    if (!oauth)
      throw new AppError('OAUTH_STORAGE', 'OAuth 저장에 사용할 앱 .env 경로가 필요합니다.');
    return oauth;
  };
  const resolveOAuthToken = async (
    config: McpConfig,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    if (config.transport === 'stdio' || !config.oauth) return undefined;
    const token = await requireOAuth().accessToken(
      { resourceUrl: config.url, clientId: config.oauth.clientId },
      signal,
    );
    if (!token)
      throw new AppError(
        'MCP_OAUTH_REQUIRED',
        '이 서버에 OAuth 로그인이 필요합니다. MCP 설정에서 로그인하세요.',
        401,
      );
    return token;
  };
  const shutdown = new AbortController();
  const updatePreparation = new UpdatePreparation();
  const publicModelCatalog = new OpenRouterCatalog(store, () =>
    new ChatCompletionProvider('openrouter', '', null).listModels(),
  );
  const contentPreviews = new McpContentPreviews();
  const resourceSubscriptions = new McpResourceSubscriptions();
  const runtime = new RuntimeManager(
    store,
    options.supervisorPath ??
      (typeof __dirname === 'string'
        ? join(__dirname, 'supervisor.cjs')
        : resolve('apps/daemon/dist/supervisor.cjs')),
    {
      ...(options.modelRoot ? { modelRoot: options.modelRoot } : {}),
      ...(options.modelFetch ? { fetch: options.modelFetch } : {}),
      ...(options.engineRoot ? { engineRoot: options.engineRoot } : {}),
      ...(options.engineFetch ? { engineFetch: options.engineFetch } : {}),
    },
  );
  const backups = options.backupRoot
    ? await Backups.open(options.backupRoot, async () => {
        const [
          state,
          profiles,
          settings,
          skills,
          mcp,
          telegramState,
          worktreeState,
          browserState,
          automationState,
          languageState,
        ] = await Promise.all([
          store.snapshot(),
          store.localProfiles(),
          store.runtimeSettings(),
          store.registeredSkills(),
          store.registeredMcp(),
          store.integration('telegram'),
          store.integration('worktrees'),
          store.integration('browser'),
          store.integration('automations'),
          store.integration('language_servers'),
        ]);
        const telegramDocument = telegramState?.document as
          { config?: unknown; bot?: unknown; owner?: unknown } | undefined;
        return {
          state,
          profiles,
          runtimeSettings: settings,
          skills,
          mcp,
          integrations: {
            telegram: telegramDocument
              ? {
                  config: telegramDocument.config,
                  bot: telegramDocument.bot,
                  owner: telegramDocument.owner,
                }
              : null,
            worktrees: worktreeState?.document ?? null,
            browser: browserState?.document ?? null,
            automations: automationState?.document ?? null,
            language_servers: languageState?.document ?? null,
          },
        };
      })
    : undefined;
  let openrouterKey = options.openrouterKey ?? null;
  const backupImporter = new BackupImporter(store);
  async function validateInferenceConfig(config: ModelConfig) {
    if (config.managedModelId) {
      const profile = (await store.localProfiles()).find((p) => p.id === config.managedModelId);
      if (
        config.provider !== 'llama-server' ||
        !profile ||
        profile.version !== config.managedModelVersion
      )
        throw new AppError(
          'MODEL_PROFILE_CHANGED',
          '관리 모델 설정이 바뀌었거나 삭제되었습니다. 모델 목록에서 이 대화에 사용할 모델을 다시 선택하세요.',
          409,
        );
      if (config.contextBudgetTokens > profile.settings.contextSize)
        throw new AppError(
          'ENGINE_CONTEXT_LIMIT',
          '앱 컨텍스트 예산은 관리 엔진의 컨텍스트 길이 이하여야 합니다.',
        );
    }
    if (config.provider !== 'demo' && !config.model)
      throw new AppError('MODEL_REQUIRED', '먼저 역할에 사용할 모델 ID를 설정하세요.');
    if (config.provider === 'openrouter') {
      if (!config.cloudConsent)
        throw new AppError('CLOUD_CONSENT', '이 역할의 OpenRouter 전송 동의가 필요합니다.', 403);
      if (!openrouterKey)
        throw new AppError('KEY_REQUIRED', '설정에서 OpenRouter API 키를 저장하세요.');
    }
  }
  const inference = new InferenceScheduler(runtime, () => openrouterKey, options.providerFactory);
  let openrouterKeySource: SecretSource =
    options.openrouterKeySource ?? (openrouterKey ? 'os_keychain' : 'none');
  type ActiveRun = {
    abort: AbortController;
    interrupt?: (() => void) | null;
    task: Promise<void>;
    approval?: {
      sessionId: string;
      activityId: string;
      resolve: (activity: Activity) => void;
      reject: (reason: unknown) => void;
    };
    elicitation?: {
      sessionId: string;
      activityId: string;
      resolve: (result: ElicitResult) => void;
      reject: (reason: unknown) => void;
    };
  };
  const active = new Map<string, ActiveRun>();
  let telegram!: Telegram;
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
  const waitForApproval = (
    runId: string,
    sessionId: string,
    activityId: string,
    signal: AbortSignal,
  ): Promise<Activity> =>
    new Promise((resolve, reject) => {
      const run = active.get(runId);
      if (!run) {
        reject(new AppError('RUN_NOT_FOUND', '실행 중인 응답을 찾을 수 없습니다.', 409));
        return;
      }
      if (run.approval) {
        reject(new AppError('APPROVAL_PENDING', '이미 검토를 기다리는 수정안이 있습니다.', 409));
        return;
      }
      if (run.elicitation) {
        reject(
          new AppError('ELICITATION_PENDING', '이미 MCP 사용자 입력을 기다리고 있습니다.', 409),
        );
        return;
      }
      const clear = () => {
        signal.removeEventListener('abort', abort);
        if (run.approval?.activityId === activityId) delete run.approval;
      };
      const abort = () => {
        clear();
        reject(signal.reason);
      };
      run.approval = {
        sessionId,
        activityId,
        resolve: (activity) => {
          clear();
          resolve(activity);
        },
        reject: (reason) => {
          clear();
          reject(reason);
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  const waitForElicitation = (
    runId: string,
    sessionId: string,
    activityId: string,
    signal: AbortSignal,
  ): Promise<ElicitResult> =>
    new Promise((resolve, reject) => {
      const run = active.get(runId);
      if (!run) {
        reject(new AppError('RUN_NOT_FOUND', '실행 중인 응답을 찾을 수 없습니다.', 409));
        return;
      }
      if (run.approval || run.elicitation) {
        reject(new AppError('ELICITATION_PENDING', '이미 사용자 결정을 기다리고 있습니다.', 409));
        return;
      }
      const clear = () => {
        signal.removeEventListener('abort', abort);
        if (run.elicitation?.activityId === activityId) delete run.elicitation;
      };
      const abort = () => {
        clear();
        reject(signal.reason);
      };
      run.elicitation = {
        sessionId,
        activityId,
        resolve: (result) => {
          clear();
          resolve(result);
        },
        reject: (reason) => {
          clear();
          reject(reason);
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  const finishApproval = (session: Session, activityId: string) => {
    if (!session.run) return;
    const pending = active.get(session.run.id)?.approval;
    if (pending?.sessionId !== session.id || pending.activityId !== activityId) return;
    const activity = session.messages
      .flatMap((message) => message.activities ?? [])
      .find((entry) => entry.id === activityId);
    if (activity) pending.resolve(structuredClone(activity));
    else pending.reject(new AppError('EDIT_NOT_FOUND', '검토한 수정안을 찾을 수 없습니다.', 404));
  };
  const reviewEdit = async (action: EditAction): Promise<Session> => {
    const session = await store.session(action.sessionId);
    const activity = session.messages
      .flatMap((message) => message.activities ?? [])
      .find((entry) => entry.id === action.activityId);
    const edit = activityProposal(activity);
    if (!edit || !session.projectId)
      throw new AppError('EDIT_NOT_FOUND', '수정안을 찾을 수 없습니다.', 404);
    if (
      activity?.approval?.status === 'pending' &&
      (action.action === 'apply' || action.action === 'reject')
    )
      throw new AppError(
        'APPROVAL_REQUIRED',
        '진행 중인 작업은 범용 권한 요청에서 수락하거나 거절해 주세요.',
        409,
      );
    if (action.action === 'apply' && edit.status === 'applied') {
      finishApproval(session, action.activityId);
      return session;
    }
    if (action.action === 'undo' && edit.status === 'reverted') return session;
    if (action.action === 'reject' && edit.status === 'rejected') {
      finishApproval(session, action.activityId);
      return session;
    }
    if (action.action === 'reject') {
      const liveApproval =
        !!session.run && active.get(session.run.id)?.approval?.activityId === action.activityId;
      await store.beginEdit(action, liveApproval);
      const rejected = await store.finishEdit(session.id, action.activityId, 'rejected');
      finishApproval(rejected, action.activityId);
      return rejected;
    }
    const liveApproval =
      action.action === 'apply' &&
      !!session.run &&
      active.get(session.run.id)?.approval?.activityId === action.activityId;
    for (const other of (await store.snapshot()).sessions) {
      if (
        other.projectId === session.projectId &&
        ((other.run && active.has(other.run.id)) ||
          other.messages.some((message) =>
            message.activities?.some((activity) => activity.execution?.cleanupPending),
          )) &&
        !(liveApproval && other.id === session.id)
      )
        throw new AppError('BUSY', '이 프로젝트의 응답이 끝난 뒤 변경을 적용해 주세요.', 409);
    }
    const project = await store.project(session.projectId);
    const pending = await store.beginEdit(action, liveApproval);
    const pendingEdit = activityProposal(
      pending.messages
        .flatMap((message) => message.activities ?? [])
        .find((activity) => activity.id === action.activityId),
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
        error = '파일이 수정안의 원본 및 결과와 다릅니다. 다시 읽고 새 수정안을 만들어 주세요.';
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
    const finished = await store.finishEdit(
      session.id,
      action.activityId,
      status,
      error,
      observations,
    );
    finishApproval(finished, action.activityId);
    return finished;
  };
  const reviewApproval = async (action: ApprovalAction): Promise<Session> => {
    const current = await store.session(action.sessionId);
    const pendingActivity = current.messages
      .flatMap((message) => message.activities ?? [])
      .find((entry) => entry.id === action.activityId);
    if (
      pendingActivity?.approval?.kind !== 'file' &&
      (!current.run || active.get(current.run.id)?.approval?.activityId !== action.activityId)
    )
      throw new AppError(
        'APPROVAL_EXPIRED',
        '이 명령 또는 MCP 요청은 더 이상 실행 중이 아니어서 결정할 수 없습니다.',
        409,
      );
    const decided = await store.decideApproval(action);
    const activity = decided.messages
      .flatMap((message) => message.activities ?? [])
      .find((entry) => entry.id === action.activityId);
    if (!activity?.approval)
      throw new AppError('APPROVAL_NOT_FOUND', '권한 요청을 찾을 수 없습니다.', 404);
    if (
      (activity.approval.kind === 'file' || activity.approval.kind === 'fusion') &&
      activityProposal(activity)
    ) {
      try {
        return await reviewEdit({
          sessionId: decided.id,
          expectedVersion: decided.version,
          activityId: action.activityId,
          action: action.action === 'approve' ? 'apply' : 'reject',
        });
      } catch (error) {
        decided.run && active.get(decided.run.id)?.approval?.reject(error);
        throw error;
      }
    }
    finishApproval(decided, action.activityId);
    return decided;
  };
  const reviewElicitation = async (action: ElicitationAction): Promise<Session> => {
    const current = await store.session(action.sessionId);
    const activity = current.messages
      .flatMap((message) => message.activities ?? [])
      .find((entry) => entry.id === action.activityId);
    const pending = activity?.elicitation;
    const live = current.run ? active.get(current.run.id)?.elicitation : undefined;
    if (!pending || pending.status !== 'pending' || live?.activityId !== action.activityId)
      throw new AppError(
        'MCP_ELICITATION_EXPIRED',
        '이 MCP 입력 요청은 더 이상 실행 중이 아닙니다.',
        409,
      );
    if (action.action === 'accept') {
      const content = action.content ?? {};
      const fields = pending.fields ?? [];
      const known = new Set(fields.map((field) => field.name));
      if (Object.keys(content).some((name) => !known.has(name)))
        throw new AppError('MCP_ELICITATION_VALUE', 'MCP 폼에 없는 입력값이 포함되어 있습니다.');
      for (const field of fields) {
        const value = content[field.name];
        if (value === undefined) {
          if (field.required)
            throw new AppError(
              'MCP_ELICITATION_VALUE',
              `${field.title} 필드는 반드시 입력해야 합니다.`,
            );
          continue;
        }
        if (field.type === 'boolean') {
          if (typeof value !== 'boolean')
            throw new AppError('MCP_ELICITATION_VALUE', `${field.title} 값이 올바르지 않습니다.`);
          continue;
        }
        if (field.type === 'number' || field.type === 'integer') {
          if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            (field.type === 'integer' && !Number.isInteger(value)) ||
            (field.minimum !== undefined && value < field.minimum) ||
            (field.maximum !== undefined && value > field.maximum)
          )
            throw new AppError('MCP_ELICITATION_VALUE', `${field.title} 값이 범위를 벗어났습니다.`);
          continue;
        }
        if (field.type === 'multiselect') {
          const allowed = new Set(field.options?.map((option) => option.value));
          if (
            !Array.isArray(value) ||
            value.some((item) => typeof item !== 'string' || !allowed.has(item)) ||
            new Set(value).size !== value.length ||
            (field.minItems !== undefined && value.length < field.minItems) ||
            (field.maxItems !== undefined && value.length > field.maxItems)
          )
            throw new AppError(
              'MCP_ELICITATION_VALUE',
              `${field.title} 선택값이 올바르지 않습니다.`,
            );
          continue;
        }
        if (typeof value !== 'string')
          throw new AppError('MCP_ELICITATION_VALUE', `${field.title} 값이 올바르지 않습니다.`);
        if (
          (field.minLength !== undefined && value.length < field.minLength) ||
          (field.maxLength !== undefined && value.length > field.maxLength) ||
          (field.type === 'select' && !field.options?.some((option) => option.value === value))
        )
          throw new AppError('MCP_ELICITATION_VALUE', `${field.title} 값이 범위를 벗어났습니다.`);
        if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
          throw new AppError(
            'MCP_ELICITATION_VALUE',
            `${field.title} 이메일 주소가 올바르지 않습니다.`,
          );
        if (field.format === 'uri') {
          try {
            new URL(value);
          } catch {
            throw new AppError('MCP_ELICITATION_VALUE', `${field.title} URL이 올바르지 않습니다.`);
          }
        }
        if (field.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value))
          throw new AppError('MCP_ELICITATION_VALUE', `${field.title} 날짜가 올바르지 않습니다.`);
        if (
          field.format === 'date-time' &&
          (!value.includes('T') || !Number.isFinite(Date.parse(value)))
        )
          throw new AppError(
            'MCP_ELICITATION_VALUE',
            `${field.title} 날짜와 시간이 올바르지 않습니다.`,
          );
      }
    }
    const decided = await store.decideElicitation(action);
    live.resolve({
      action: action.action,
      ...(action.action === 'accept' ? { content: action.content ?? {} } : {}),
    });
    return decided;
  };
  async function execute(
    session: Session,
    controller: AbortController,
    context: CompiledContext,
    skills: RegisteredSkill[],
    mcpSelections: ReturnType<typeof selectedMcpTools>,
    directSkill?: DirectSkill,
  ): Promise<void> {
    const childConfig = session.routing?.subagent ?? session.config;
    const baseConfig = session.config;
    session = { ...session, config: resolveModelConfig(session) };
    const autopilot = session.autopilot;
    const loadSignal =
      autopilot && autopilot.runId === session.run?.id && autopilot.limits.minutes
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
      loadSignal.throwIfAborted();
      const provider = inference.provider(session);
      const subagentProvider = session.routing?.subagentsEnabled
        ? inference.provider({ ...session, config: childConfig })
        : undefined;
      const pricing = new Map<string, ModelPricing>();
      const loadPricing = async (config: ModelConfig, target: InferenceProvider) => {
        if (config.provider !== 'openrouter') return;
        const descriptor = (await target.listModels(loadSignal)).find(
          (model) => model.id === config.model,
        );
        if (!descriptor?.pricing)
          throw new AppError(
            'MODEL_PRICING_UNAVAILABLE',
            `OpenRouter 모델 ${config.model}의 가격 정보를 확인할 수 없어 자동 실행을 시작하지 않았습니다.`,
          );
        pricing.set(config.provider + '\0' + config.model, descriptor.pricing);
      };
      if (autopilot) {
        await loadPricing(session.config, provider);
        if (subagentProvider) await loadPricing(childConfig, subagentProvider);
      }
      const project =
        session.projectId && context.request.tools?.length
          ? await store.project(session.projectId)
          : undefined;
      await runAgent({
        store,
        session,
        provider,
        baseConfig,
        providerFor: (config) => inference.provider({ ...session, config }),
        loadPricing: async (config) => {
          const key = config.provider + '\0' + config.model;
          if (!pricing.has(key))
            await loadPricing(config, inference.provider({ ...session, config }));
          return pricing.get(key);
        },
        controller,
        onInterruptible: (interrupt) => {
          const run = active.get(session.run!.id);
          if (run) run.interrupt = interrupt;
        },
        context,
        ...(context.request.tools?.some((tool) => tool.function.name === 'browser_action')
          ? { browser: new BrowserSession((await browserSettings(store)).config) }
          : {}),
        skills,
        ...(directSkill ? { directSkill } : {}),
        skillDependencies: mcpSelections.map(({ server }) => ({
          id: server.id,
          name: server.config.name,
          transport: server.config.transport,
        })),
        ...(session.routing?.subagentsEnabled
          ? {
              subagents: {
                config: childConfig,
                provider: subagentProvider!,
              },
            }
          : {}),
        pricing: (config) => pricing.get(config.provider + '\0' + config.model),
        ...(observations ? { observations } : {}),
        ...(options.webFetcher ? { webFetcher: options.webFetcher } : {}),
        commandExecutor: (input) => jobs.run(session, input, 'docker', executeCommand),
        hostCommandExecutor: (input) =>
          jobs.run(session, input, 'host', options.hostCommandExecutor ?? executeHostCommand),
        jobs,
        languageServers,
        ...(worktrees && worktreeReviews ? { worktrees, worktreeReviews } : {}),
        waitForApproval: (activityId, signal) =>
          waitForApproval(session.run!.id, session.id, activityId, signal),
        waitForElicitation: (activityId, signal) =>
          waitForElicitation(session.run!.id, session.id, activityId, signal),
        applyApprovedEdit: async (activityId) => {
          const current = await store.session(session.id);
          try {
            await serial(() =>
              reviewEdit({
                sessionId: current.id,
                expectedVersion: current.version,
                activityId,
                action: 'apply',
              }),
            );
          } catch (error) {
            active.get(session.run!.id)?.approval?.reject(error);
            throw error;
          }
        },
        mcp: new RunMcp({
          selections: mcpSelections,
          supervisorPath: mcpSupervisorPath,
          resolveSecret: resolveMcpSecret,
          resolveOAuthToken,
          ...(project
            ? { roots: [{ uri: pathToFileURL(project.path).href, name: project.name }] }
            : {}),
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
      active.delete(session.run!.id);
      telegram?.wake();
    }
  }
  async function command(command: Command) {
    if (closing) throw new AppError('SHUTTING_DOWN', '앱을 종료하는 중입니다.', 503);
    updatePreparation.assertAvailable();
    const receipt = await store.receipt(command);
    if (receipt) return receipt;
    let attachment: McpContextAttachment | undefined;
    if (command.type === 'attach_mcp_content') {
      attachment = contentPreviews.get(command.previewId);
      if (
        (await store.registeredMcp()).find((server) => server.id === attachment!.serverId)
          ?.revision !== attachment.serverRevision
      )
        throw new AppError(
          'MCP_CHANGED',
          '서버 등록이 변경되었습니다. MCP 내용을 다시 확인하세요.',
          409,
        );
    }
    let context: CompiledContext | undefined;
    let selectedSkills: RegisteredSkill[] = [];
    let directSkill: DirectSkill | undefined;
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
    if (
      command.type === 'send_message' ||
      command.type === 'start_task_list' ||
      command.type === 'start_autopilot' ||
      command.type === 'start_goal' ||
      command.type === 'resume_goal'
    ) {
      const stored = await store.session(command.sessionId);
      const modeSession = {
        ...stored,
        ...(command.type === 'start_task_list' ? { taskList: startTaskList(stored.taskList) } : {}),
        ...(command.type === 'start_goal' ||
        command.type === 'start_autopilot' ||
        command.type === 'start_task_list'
          ? { mode: 'build' as const }
          : command.type === 'send_message' && command.mode
            ? { mode: command.mode }
            : {}),
      };
      const session = { ...modeSession, config: resolveModelConfig(modeSession) };
      const configs = [session.config];
      const childConfig = session.routing?.subagent ?? stored.config;
      if (session.routing?.subagentsEnabled) configs.push(childConfig);
      const auxiliary = [
        session.routing?.summary,
        session.routing?.review,
        ...(session.taskList?.active
          ? session.taskList.tasks
              .filter((task) => task.status !== 'completed')
              .map((task) => task.model)
          : []),
      ].filter((config): config is ModelConfig => !!config);
      configs.push(...auxiliary);
      if (
        session.projectId &&
        auxiliary.some((config) => config.provider === 'openrouter' && !config.projectCloudConsent)
      )
        throw new AppError(
          'PROJECT_CLOUD_CONSENT',
          '요약·검토·작업별 OpenRouter 모델에 프로젝트 전송 동의가 필요합니다.',
          403,
        );
      validateCloudTransmission(session, configs);
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
        if (!skill.invocation.model && !skill.invocation.user)
          throw new AppError('SKILL_INVOCATION', '모델·사용자 호출이 모두 금지된 스킬입니다.', 403);
        return skill;
      });
      for (const config of configs) {
        await validateInferenceConfig(config);
      }
      if (
        session.routing?.subagentsEnabled &&
        session.projectId &&
        childConfig.provider === 'openrouter' &&
        !childConfig.projectCloudConsent
      )
        throw new AppError(
          'PROJECT_CLOUD_CONSENT',
          '서브에이전트에 프로젝트 작업을 맡기려면 해당 역할의 프로젝트 전송 동의가 필요합니다.',
          403,
        );
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
      if (active.size >= 4)
        throw new AppError(
          'CONCURRENCY_LIMIT',
          '초기 버전은 동시에 최대 4개의 응답을 처리합니다.',
          429,
        );
      if (isLocalProvider(resolveModelConfig(session).provider)) {
        const state = await store.snapshot();
        if (
          state.sessions.some(
            (s) => s.run?.status === 'running' && isLocalProvider(resolveModelConfig(s).provider),
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
              (tool) => session.mode !== 'plan' || isProjectReadTool(tool.function.name),
            )
          : [];
      tools.push(planningTool);
      if (session.mode === 'plan') tools.push(setTaskListTool);
      else if (
        session.taskList?.tasks.length &&
        !['start_goal', 'resume_goal', 'start_autopilot'].includes(command.type)
      )
        tools.push(updateTaskTool);
      tools.push(historySearchTool);
      if (
        session.projectId &&
        languageServers.available(session.projectId) &&
        tools.some((tool) => tool.function.name === 'read_file')
      )
        tools.push(...lspTools);
      tools.push(toolResultRecallTool);
      tools.push(webFetchTool);
      tools.push(webSearchTool);
      if (session.routing?.review) tools.push(reviewWorkTool);
      if (
        observations &&
        (session.config.eco ||
          session.messages.some((message) =>
            message.continuation?.some(
              (entry) =>
                entry.role === 'tool' &&
                (!!entry.observationId || isObservationMarker(entry.content)),
            ),
          ))
      )
        tools.push(observationRecallTool);
      if (session.routing?.subagentsEnabled) tools.push(subagentTool);
      if (worktreeReviews && tools.some((tool) => tool.function.name === 'read_file'))
        tools.push(
          ...worktreeTools.filter(
            (tool) => session.mode !== 'plan' || tool.function.name === 'review_worktree',
          ),
        );
      if (
        session.mode !== 'plan' &&
        session.permissionMode === 'full' &&
        (await browserSettings(store)).config.enabled
      )
        tools.push(browserTool);
      tools.push(...mcpSelections.map((value) => value.definition));
      if (selectedSkills.length) tools.push(...skillTools);
      if (
        session.mode !== 'plan' &&
        session.execution?.backend === 'docker' &&
        tools.some((tool) => tool.function.name === 'read_file')
      )
        tools.push(executionTool);
      if (
        session.mode !== 'plan' &&
        session.permissionMode === 'full' &&
        tools.some((tool) => tool.function.name === 'read_file')
      )
        tools.push(hostExecutionTool);
      if (jobs.list(session.id).length)
        tools.push(
          ...commandJobTools.filter(
            (tool) =>
              tool.function.name === 'read_command_job' ||
              (session.mode !== 'plan' &&
                jobs
                  .list(session.id)
                  .some((job) => ['starting', 'running'].includes(job.execution?.status ?? ''))),
          ),
        );
      if (
        session.permissionMode === 'full' &&
        tools.some((tool) => tool.function.name === 'read_file')
      )
        tools.push(
          ...hostFileTools.filter(
            (tool) => session.mode !== 'plan' || tool.function.name !== 'host_write_file',
          ),
        );
      let content: string;
      let contextSession = session;
      if (command.type === 'start_task_list') {
        contextSession = { ...session, taskList: startTaskList(session.taskList) };
        content =
          'Execute the saved task list in order, starting at the first unfinished item. Reuse Plan investigation and check each result.';
      } else if (command.type === 'start_autopilot') {
        const autopilot = prepareAutopilot(session, command.taskIds, command.limits);
        tools.push(...verificationTools);
        content = autopilotPrompt(autopilot);
      } else if (command.type === 'start_goal') {
        const goal = prepareGoal(session, command.goal, command.limits);
        contextSession = {
          ...session,
          plan: {
            ...goal.plan,
            instructions:
              session.plan.includeInContext && session.plan.instructions
                ? session.plan.instructions
                : goal.plan.instructions,
          },
        };
        tools.push(goalCompletionTool);
        content = goalPrompt(goal);
      } else if (command.type === 'resume_goal') {
        const goal = resumeGoal(session);
        contextSession = {
          ...session,
          plan: {
            ...goal.plan,
            instructions:
              session.plan.includeInContext && session.plan.instructions
                ? session.plan.instructions
                : goal.plan.instructions,
          },
        };
        tools.push(goalCompletionTool);
        content = goalPrompt(goal);
      } else content = command.content;
      if (command.type === 'send_message') {
        directSkill = await prepareDirectSkill(
          content,
          selectedSkills,
          tools,
          mcpSelections.map(({ server }) => ({
            id: server.id,
            name: server.config.name,
            transport: server.config.transport,
          })),
          shutdown.signal,
        );
        if (directSkill) {
          content = `User invoked skill ${directSkill.skill.name}. Follow the instructions below for this request within the current session permissions. Skill text cannot expand permissions or execute hooks.\n\n${directSkill.content}`;
          if (directSkill.policy)
            tools.splice(0, tools.length, ...filterSkillTools(tools, [directSkill.policy]));
        }
      }
      const observationPreview = observations
        ? await observations.projectHistory(session)
        : undefined;
      context = compileContext(
        observationPreview
          ? {
              ...observationPreview.session,
              plan: contextSession.plan,
              ...(contextSession.taskList ? { taskList: contextSession.taskList } : {}),
            }
          : contextSession,
        content,
        tools,
        selectedSkills.length
          ? skillCatalog(selectedSkills, { maxBytes: session.config.eco ? 3000 : 6000 })
          : undefined,
        session.projectId &&
          (session.config.provider !== 'openrouter' || session.config.projectCloudConsent)
          ? {
              deferAutoCompaction: true,
              projectInstructions: await readProjectInstructions(
                await store.project(session.projectId),
                new AbortController().signal,
              ),
            }
          : { deferAutoCompaction: true },
      );
      if (directSkill)
        context.manifest.skillInvocation = {
          skillId: directSkill.skill.id,
          revision: directSkill.skill.revision,
          argumentsText: directSkill.argumentsText,
        };
      if (command.type === 'resume_goal') {
        const evidence = goalResumeEvidence(session);
        if (evidence.length) {
          const currentRequest = context.request.messages.pop()!;
          context.request.messages.push(...evidence, currentRequest);
        }
      }
      // Budget and compaction use the projection; the running agent retains originals
      // so an archive or ledger failure can still fall back to exact stored evidence.
      if (observationPreview)
        context.request.messages = context.request.messages.map((message) => {
          const original = message.observationId
            ? observationPreview.originals.get(message.observationId)
            : undefined;
          return original ? { ...message, content: original.content } : message;
        });
    } else if (command.type === 'compact_context' || command.type === 'quick_compact_context') {
      const session = await store.session(command.sessionId);
      if (command.expectedVersion !== session.version)
        throw new AppError(
          'VERSION_CONFLICT',
          '대화가 변경되었습니다. 최신 상태를 불러온 뒤 다시 시도하세요.',
          409,
        );
      if (session.run?.status === 'running')
        throw new AppError('BUSY', '응답이 끝난 뒤 컨텍스트를 압축하세요.', 409);
      context = compileContext(session, '', [], undefined, { forceCompaction: true });
      if (!context.compaction)
        throw new AppError('COMPACTION_EMPTY', '압축할 완료된 대화 기록이 없습니다.');
      if (command.type === 'compact_context') {
        const resolved = { ...session, config: resolveAuxiliaryModel(session, 'summary') };
        if (resolved.config.provider === 'demo')
          throw new AppError(
            'COMPACTION_MODEL_REQUIRED',
            'LLM 컨텍스트 압축에는 실제 모델 연결이 필요합니다. 빠른 압축은 모델 없이 사용할 수 있습니다.',
          );
        await validateInferenceConfig(resolved.config);
        validateCloudTransmission(resolved, [resolved.config]);
        context.compaction = await compactManually({
          command,
          session: resolved,
          store,
          provider: inference.provider(resolved),
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(120_000)]),
        });
      } else context.compaction = { ...context.compaction, method: 'fast' };
    }
    const result = await store.apply(command, context?.manifest, attachment, context?.compaction);
    if (command.type === 'attach_mcp_content' && !result.replayed)
      contentPreviews.consume(command.previewId);
    if (command.type === 'remove_mcp_content' && !result.replayed)
      await resourceSubscriptions.unsubscribe(command.sessionId, command.attachmentId);
    if (
      !result.replayed &&
      (command.type === 'send_message' ||
        command.type === 'start_task_list' ||
        command.type === 'start_autopilot' ||
        command.type === 'start_goal' ||
        command.type === 'resume_goal')
    ) {
      const abort = new AbortController();
      const task = execute(
        result.session,
        abort,
        context!,
        selectedSkills,
        mcpSelections,
        directSkill,
      );
      active.set(result.session.run!.id, { abort, task });
    }
    if (command.type === 'cancel_run') active.get(command.runId)?.abort.abort();
    if (command.type === 'steer_run' && !result.replayed) active.get(command.runId)?.interrupt?.();
    return result;
  }
  const jobs = await CommandJobs.open(store);
  const languageServers = await LanguageServers.open(store);
  const worktrees = options.worktreeRoot
    ? await Worktrees.open(store, options.worktreeRoot)
    : undefined;
  const worktreeReviews = worktrees ? new WorktreeReviews(store, worktrees) : undefined;
  let telegramKeychainToken = options.telegramToken ?? null,
    telegramTokenSource: SecretSource = 'none';
  const resolveTelegramToken = async () => {
    const secret = await loadTelegramSecret({
      ...(options.envFilePath ? { envFilePath: options.envFilePath } : {}),
      keychainToken: telegramKeychainToken,
    });
    telegramTokenSource = secret.source;
    return secret.token;
  };
  telegram = await Telegram.open({
    store,
    loadToken: resolveTelegramToken,
    tokenSource: () => telegramTokenSource,
    dispatch: (value) => serial(() => command(value)),
    decideApproval: (value) => serial(() => reviewApproval(value)),
    decideElicitation: (value) => serial(() => reviewElicitation(value)),
    reconcileCosts: (sessionId) =>
      serial(async () => {
        const session = await store.session(sessionId);
        const config = { ...resolveModelConfig(session), provider: 'openrouter' as const };
        return reconcileCosts(store, session, inference.provider({ ...session, config }));
      }),
    ...(options.telegramFetch ? { fetch: options.telegramFetch } : {}),
  });
  const automations = await Automations.open({
    store,
    dispatch: (value) => serial(() => command(value)),
    available: (session) =>
      !closing &&
      !updatePreparation.blocked &&
      (!session.run || !active.has(session.run.id)) &&
      (!session.projectId || !jobs.hasActiveProject(session.projectId)),
  });
  let pendingMutations = 0;
  const server = createServer(async (request, response) => {
    let mutationTracked = false;
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
      if (request.method !== 'GET' && url.pathname !== '/v1/updates/release') {
        updatePreparation.assertAvailable();
        pendingMutations++;
        mutationTracked = true;
      }
      if (request.method === 'GET' && url.pathname === '/v1/state') {
        json(response, 200, {
          ...(await store.snapshot()),
          openrouterConfigured: !!openrouterKey,
          openrouterKeySource,
          envFilePath: options.envFilePath,
        });
      } else if (request.method === 'GET' && url.pathname === '/v1/telegram') {
        json(response, 200, telegram.status());
      } else if (request.method === 'PUT' && url.pathname === '/v1/telegram/secret') {
        if (telegramTokenSource === 'environment' || telegramTokenSource === 'env_file')
          throw new AppError(
            'ENV_MANAGED_KEY',
            '.env 또는 환경 변수에서 토큰을 관리 중입니다. 해당 값을 수정하고 앱을 다시 시작하세요.',
            409,
          );
        if (telegram.status().config.enabled)
          throw new AppError(
            'TELEGRAM_ACTIVE',
            'Telegram 연결을 끄고 설정을 저장한 뒤 토큰을 변경하세요.',
            409,
          );
        const value = (await readJson(request)) as { key?: unknown };
        if (!(value.key === null || typeof value.key === 'string'))
          throw new AppError('TELEGRAM_TOKEN', 'Telegram 봇 토큰 형식을 확인하세요.');
        const token = telegramToken(value.key);
        const status = await telegram.setToken(token);
        telegramKeychainToken = token;
        telegramTokenSource = token ? 'os_keychain' : 'none';
        json(response, 200, { ...status, tokenSource: telegramTokenSource });
      } else if (request.method === 'POST' && url.pathname === '/v1/telegram/config') {
        const value = telegramConfigSchema.safeParse(await readJson(request));
        if (!value.success)
          throw new AppError('TELEGRAM_CONFIG', '대화·Build 허용·Telegram 전송 동의를 확인하세요.');
        json(response, 200, await telegram.configure(value.data));
      } else if (request.method === 'POST' && url.pathname === '/v1/telegram/pair') {
        json(response, 200, await telegram.pair());
      } else if (request.method === 'POST' && url.pathname === '/v1/telegram/approve') {
        const value = z
          .strictObject({
            userId: z.number().int().positive().safe(),
            chatId: z.number().int().positive().safe(),
          })
          .safeParse(await readJson(request));
        if (!value.success) throw new AppError('TELEGRAM_PAIR', '연결할 계정 ID를 확인하세요.');
        json(response, 200, await telegram.approve(value.data.userId, value.data.chatId));
      } else if (request.method === 'POST' && url.pathname === '/v1/telegram/unpair') {
        json(response, 200, await telegram.unpair());
      } else if (request.method === 'GET' && url.pathname === '/v1/lsp') {
        json(response, 200, { servers: languageServers.list() });
      } else if (request.method === 'POST' && url.pathname === '/v1/lsp/register') {
        const input = z
          .strictObject({
            config: languageServerConfigSchema,
            id: z.uuid().optional(),
            expectedRevision: z.uuid().optional(),
          })
          .parse(await readJson(request));
        json(response, 200, {
          registration: await languageServers.register(
            input.config,
            input.id,
            input.expectedRevision,
          ),
        });
      } else if (
        request.method === 'POST' &&
        (url.pathname === '/v1/lsp/remove' || url.pathname === '/v1/lsp/stop')
      ) {
        const input = z
          .strictObject({ id: z.uuid(), revision: z.uuid() })
          .parse(await readJson(request));
        if (
          !languageServers
            .list()
            .some(
              (value) =>
                value.registration.id === input.id &&
                value.registration.revision === input.revision,
            )
        )
          throw new AppError('LSP_CHANGED', '언어 서버 설정을 다시 불러오세요.', 409);
        if (url.pathname.endsWith('/remove'))
          await languageServers.remove(input.id, input.revision);
        else await languageServers.stop(input.id);
        json(response, 200, { servers: languageServers.list() });
      } else if (request.method === 'POST' && url.pathname === '/v1/lsp/query') {
        const input = z
          .strictObject({
            projectId: z.uuid(),
            operation: lspOperationSchema,
            query: lspQuerySchema,
          })
          .parse(await readJson(request));
        const project = await store.project(input.projectId);
        json(
          response,
          200,
          await languageServers.query(
            project,
            input.operation,
            input.query,
            operationSignal(response, shutdown.signal),
          ),
        );
      } else if (request.method === 'POST' && url.pathname === '/v1/worktrees/review') {
        if (!worktreeReviews || !worktrees)
          throw new AppError('WORKTREE_PATH', 'Worktree 저장소가 연결되지 않았습니다.');
        const input = worktreeReviewSchema.parse(await readJson(request));
        const record = worktrees.list().find((record) => record.id === input.worktreeId);
        if (
          record?.projectId &&
          (jobs.hasActiveProject(record.projectId) ||
            (await store.snapshot()).sessions.some(
              (other) =>
                other.projectId === record.projectId &&
                other.run &&
                (other.run.status === 'running' || active.has(other.run.id)),
            ))
        )
          throw new AppError('WORKTREE_BUSY', 'Worktree 명령이 끝난 뒤 검토하세요.', 409);
        json(response, 200, {
          preview: await worktreeReviews.preview(
            input.worktreeId,
            AbortSignal.any([shutdown.signal, AbortSignal.timeout(60000)]),
            input,
          ),
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/worktrees/merge') {
        if (!worktreeReviews)
          throw new AppError('WORKTREE_PATH', 'Worktree 저장소가 연결되지 않았습니다.');
        const input = worktreeMergeSchema
          .extend({ sessionId: z.uuid() })
          .parse(await readJson(request, 16 * 1024 * 1024));
        const result = await serial(async () => {
          const session = await store.session(input.sessionId),
            preview = worktreeReviews!.get(input.previewId);
          if (session.mode === 'plan' || session.projectId !== preview.sourceProjectId)
            throw new AppError(
              'READ_ONLY',
              '원본 프로젝트의 Build 대화를 선택한 뒤 적용하세요.',
              403,
            );
          if (
            jobs.hasActiveProject(preview.sourceProjectId) ||
            (await store.snapshot()).sessions.some(
              (other) =>
                other.projectId === preview.sourceProjectId && other.run?.status === 'running',
            )
          )
            throw new AppError('PROJECT_BUSY', '원본 프로젝트의 실행이 끝난 뒤 적용하세요.', 409);
          const record = worktrees!.list().find((record) => record.id === preview.worktreeId);
          if (
            record?.projectId &&
            (jobs.hasActiveProject(record.projectId) ||
              (await store.snapshot()).sessions.some(
                (other) =>
                  other.projectId === record.projectId &&
                  other.run &&
                  (other.run.status === 'running' || active.has(other.run.id)),
              ))
          )
            throw new AppError('WORKTREE_BUSY', 'Worktree 명령이 끝난 뒤 적용하세요.', 409);
          await store.invalidateWorkspace(session.id);
          let merged: import('@lodex/contracts').WorktreeRecord;
          try {
            merged = await worktreeReviews!.apply(
              input.previewId,
              input.resolutions,
              AbortSignal.any([shutdown.signal, AbortSignal.timeout(60000)]),
            );
          } catch (error) {
            const changed = worktrees!.list().find((record) => record.id === preview.worktreeId);
            if (changed?.merge?.previewId === input.previewId)
              await store.recordWorkspaceChange(
                session.id,
                'worktree_merge',
                JSON.stringify(changed.merge),
              );
            throw error;
          }

          await store.recordWorkspaceChange(
            session.id,
            'worktree_merge',
            JSON.stringify(merged.merge),
          );
          return { record: merged, session: await store.session(session.id) };
        });
        json(response, 200, result);
      } else if (
        request.method === 'POST' &&
        (url.pathname === '/v1/worktrees/archive' || url.pathname === '/v1/worktrees/undo')
      ) {
        if (!worktrees || !worktreeReviews)
          throw new AppError('WORKTREE_PATH', 'Worktree 저장소가 연결되지 않았습니다.');
        const input = z
          .strictObject({ worktreeId: z.uuid(), sessionId: z.uuid() })
          .parse(await readJson(request));
        const result = await serial(async () => {
          const record = worktrees!.list().find((record) => record.id === input.worktreeId),
            session = await store.session(input.sessionId);
          if (!record || session.mode === 'plan' || session.projectId !== record.sourceProjectId)
            throw new AppError('READ_ONLY', '원본 프로젝트의 Build 대화에서 관리하세요.', 403);
          const related = new Set([record.sourceProjectId, record.projectId]);
          if (
            [...related].some((id) => id && jobs.hasActiveProject(id)) ||
            (await store.snapshot()).sessions.some(
              (other) =>
                related.has(other.projectId ?? '') &&
                other.run &&
                (other.run.status === 'running' || active.has(other.run.id)),
            )
          )
            throw new AppError(
              'WORKTREE_BUSY',
              '원본과 Worktree의 실행이 끝난 뒤 관리하세요.',
              409,
            );
          const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(120000)]);
          const updated = url.pathname.endsWith('/archive')
            ? await worktrees!.archive(record.id, signal)
            : await worktreeReviews!.undo(record.id, signal);
          await store.invalidateWorkspace(session.id);
          const archived = url.pathname.endsWith('/archive');
          await store.recordWorkspaceChange(
            session.id,
            archived ? 'worktree_archive' : 'worktree_undo',
            JSON.stringify(
              archived
                ? {
                    status: 'archived',
                    worktreeId: updated.id,
                    archive: updated.archive,
                    files: [{ path: updated.path, afterHash: null, applied: true }],
                  }
                : updated.merge,
            ),
          );
          return { record: updated, session: await store.session(session.id) };
        });
        json(response, 200, result);
      } else if (request.method === 'GET' && url.pathname === '/v1/worktrees') {
        json(response, 200, { records: worktrees?.list() ?? [] });
      } else if (request.method === 'POST' && url.pathname === '/v1/worktrees') {
        if (!worktrees)
          throw new AppError('WORKTREE_PATH', 'worktree 저장 경로가 설정되지 않았습니다.');
        const input = z.strictObject({ projectId: z.uuid() }).safeParse(await readJson(request));
        if (!input.success) throw new AppError('WORKTREE_PROJECT', '원본 프로젝트를 선택하세요.');
        const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(120000)]);
        json(
          response,
          200,
          await serial(async () => {
            const source = await store.project(input.data.projectId);
            if (
              (await store.snapshot()).sessions.some(
                (session) =>
                  session.projectId === source.id &&
                  session.run &&
                  (session.run.status === 'running' || active.has(session.run.id)),
              )
            )
              throw new AppError(
                'PROJECT_BUSY',
                '원본 프로젝트의 실행이 끝난 뒤 worktree를 만드세요.',
                409,
              );
            return worktrees.create(source, signal);
          }),
        );
      } else if (request.method === 'GET' && url.pathname === '/v1/mcp') {
        json(response, 200, { servers: await store.registeredMcp() });
      } else if (request.method === 'GET' && url.pathname === '/v1/mcp/subscriptions') {
        const sessionId = z.uuid().parse(url.searchParams.get('sessionId'));
        await store.session(sessionId);
        json(response, 200, { subscriptions: resourceSubscriptions.snapshot(sessionId) });
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/subscriptions') {
        const input = mcpSubscriptionInputSchema.safeParse(await readJson(request));
        if (!input.success)
          throw new AppError('MCP_SUBSCRIBE_INPUT', '구독할 대화와 첨부 자료를 확인하세요.');
        const signal = operationSignal(response, shutdown.signal);
        json(
          response,
          200,
          await serial(async () => {
            const session = await store.session(input.data.sessionId);
            if (session.version !== input.data.expectedVersion)
              throw new AppError(
                'VERSION_CONFLICT',
                '대화가 변경되었습니다. 최신 상태에서 다시 선택하세요.',
                409,
              );
            if (input.data.action === 'unsubscribe')
              return {
                subscriptions: await resourceSubscriptions.unsubscribe(
                  session.id,
                  input.data.attachmentId,
                ),
              };
            const attachment = session.mcpAttachments?.find(
              (entry) => entry.id === input.data.attachmentId,
            );
            if (!attachment)
              throw new AppError(
                'MCP_SUBSCRIBE_RESOURCE',
                '이 대화에 첨부한 자료만 구독할 수 있습니다.',
                404,
              );
            const registration = (await store.registeredMcp()).find(
              (entry) => entry.id === attachment.serverId,
            );
            if (!registration)
              throw new AppError(
                'MCP_CHANGED',
                '첨부 자료의 MCP 서버가 등록되어 있지 않습니다.',
                409,
              );
            return {
              subscriptions: await resourceSubscriptions.subscribe({
                sessionId: session.id,
                attachment,
                registration,
                signal,
                shutdown: shutdown.signal,
                connect: async (lifetime, resourceEvent) =>
                  McpConnection.connect({
                    config: registration.config,
                    expected: registration,
                    resolveSecret: resolveMcpSecret,
                    supervisorPath: mcpSupervisorPath,
                    signal: lifetime,
                    resourceEvent,
                    oauthToken: await resolveOAuthToken(registration.config, lifetime),
                  }),
              }),
            };
          }),
        );
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/content') {
        const parsed = mcpContentInputSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('MCP_CONTENT_INPUT', 'MCP 리소스·프롬프트 선택을 확인하세요.');
        const signal = operationSignal(response, shutdown.signal);
        json(
          response,
          200,
          await serial(async () => {
            const registration = (await store.registeredMcp()).find(
              (server) => server.id === parsed.data.serverId,
            );
            if (!registration || registration.revision !== parsed.data.serverRevision)
              throw new AppError('MCP_CHANGED', 'MCP 서버 정보가 변경되었습니다.', 409);
            if (
              (await store.snapshot()).sessions.some(
                (session) =>
                  session.mcp?.some((selection) => selection.serverId === registration.id) &&
                  session.run &&
                  (session.run.status === 'running' || active.has(session.run.id)),
              )
            )
              throw new AppError('BUSY', '이 MCP 서버의 실행이 끝난 뒤 내용을 불러오세요.', 409);
            signal.throwIfAborted();
            return contentPreviews.create(
              parsed.data,
              async () =>
                McpConnection.connect({
                  config: registration.config,
                  expected: registration,
                  resolveSecret: resolveMcpSecret,
                  supervisorPath: mcpSupervisorPath,
                  signal,
                  oauthToken: await resolveOAuthToken(registration.config, signal),
                }),
              signal,
            );
          }),
        );
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/completion') {
        const parsed = mcpCompletionInputSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('MCP_COMPLETION_INPUT', 'MCP 자동 완성 입력을 확인하세요.');
        const signal = operationSignal(response, shutdown.signal);
        json(
          response,
          200,
          await serial(async () => {
            const registration = (await store.registeredMcp()).find(
              (server) => server.id === parsed.data.serverId,
            );
            if (!registration || registration.revision !== parsed.data.serverRevision)
              throw new AppError('MCP_CHANGED', 'MCP 서버 정보가 변경되었습니다.', 409);
            const entry =
              parsed.data.kind === 'prompt'
                ? registration.prompts?.find(
                    (prompt) =>
                      prompt.name === parsed.data.entryKey &&
                      prompt.revision === parsed.data.entryRevision,
                  )
                : registration.resourceTemplates?.find(
                    (template) =>
                      template.uriTemplate === parsed.data.entryKey &&
                      template.revision === parsed.data.entryRevision,
                  );
            if (!registration.supportsCompletions || !entry?.supported)
              throw new AppError(
                'MCP_COMPLETION',
                '검토한 MCP 자료가 아니거나 서버가 자동 완성을 지원하지 않습니다.',
              );
            if (
              (await store.snapshot()).sessions.some(
                (session) =>
                  session.mcp?.some((selection) => selection.serverId === registration.id) &&
                  session.run &&
                  (session.run.status === 'running' || active.has(session.run.id)),
              )
            )
              throw new AppError('BUSY', '이 MCP 서버의 실행이 끝난 뒤 인자를 추천받으세요.', 409);
            signal.throwIfAborted();
            const connection = await McpConnection.connect({
              config: registration.config,
              expected: registration,
              resolveSecret: resolveMcpSecret,
              supervisorPath: mcpSupervisorPath,
              signal,
              oauthToken: await resolveOAuthToken(registration.config, signal),
            });
            try {
              return await connection.complete({
                serverRevision: parsed.data.serverRevision,
                kind: parsed.data.kind,
                entryKey: parsed.data.entryKey,
                revision: parsed.data.entryRevision,
                argumentName: parsed.data.argumentName,
                value: parsed.data.value,
                ...(parsed.data.arguments ? { arguments: parsed.data.arguments } : {}),
                signal,
              });
            } finally {
              await connection.close();
            }
          }),
        );
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/oauth/prepare') {
        const input = z
          .strictObject({
            resourceUrl: z.string().min(1).max(4096),
            clientId: z.string().max(512).default(''),
            scopes: z.array(z.string().min(1).max(256)).max(64).optional(),
            authorizationServer: z.string().min(1).max(4096).optional(),
          })
          .safeParse(await readJson(request));
        if (!input.success)
          throw new AppError('OAUTH_INPUT', '서버 주소·client ID·scope를 확인하세요.');
        json(
          response,
          200,
          await requireOAuth().prepare(input.data, operationSignal(response, shutdown.signal)),
        );
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/oauth/begin') {
        const input = z
          .strictObject({
            preparationId: z.uuid(),
            approvedOrigins: z.array(z.string().max(4096)).min(1).max(8),
          })
          .safeParse(await readJson(request));
        if (!input.success)
          throw new AppError('OAUTH_INPUT', '검토한 OAuth 주소의 승인이 필요합니다.');
        json(response, 200, await requireOAuth().begin(input.data));
      } else if (
        request.method === 'POST' &&
        ['/v1/mcp/oauth/status', '/v1/mcp/oauth/cancel'].includes(url.pathname)
      ) {
        const input = z.strictObject({ id: z.uuid() }).safeParse(await readJson(request));
        if (!input.success) throw new AppError('OAUTH_INPUT', 'OAuth 로그인 ID가 필요합니다.');
        if (url.pathname.endsWith('/cancel')) await requireOAuth().cancel(input.data.id);
        json(response, 200, requireOAuth().status(input.data.id));
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/oauth/disconnect') {
        const input = z
          .strictObject({
            resourceUrl: z.string().min(1).max(4096),
            clientId: z.string().max(512).default(''),
          })
          .safeParse(await readJson(request));
        if (!input.success)
          throw new AppError('OAUTH_INPUT', 'OAuth 서버 주소와 client ID가 필요합니다.');
        await serial(async () => {
          const matching = new Set(
            (await store.registeredMcp())
              .filter(
                (server) =>
                  server.config.transport !== 'stdio' &&
                  server.config.oauth?.clientId === input.data.clientId &&
                  new URL(server.config.url).href === new URL(input.data.resourceUrl).href,
              )
              .map((server) => server.id),
          );
          const runs = (await store.snapshot()).sessions
            .filter((session) => session.mcp?.some((selection) => matching.has(selection.serverId)))
            .flatMap((session) =>
              session.run && active.has(session.run.id) ? [active.get(session.run.id)!] : [],
            );
          for (const run of runs) run.abort.abort();
          await requireOAuth().disconnect(input.data);
          await Promise.allSettled(runs.map((run) => run.task));
        });
        json(response, 200, { disconnected: true });
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/import') {
        const parsed = z
          .strictObject({ text: z.string().max(131072), cwd: z.string().max(4096).optional() })
          .safeParse(await readJson(request));
        if (!parsed.success) throw new AppError('MCP_IMPORT', 'MCP 설정 입력을 확인하세요.');
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
        const signal = operationSignal(response, shutdown.signal);
        json(response, 200, {
          server: await serial(async () => {
            signal.throwIfAborted();
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
              oauthToken: await resolveOAuthToken(input.config, signal),
              supervisorPath: mcpSupervisorPath,
              resolveSecret: resolveMcpSecret,
              signal,
            });
            const registration = connection.registration;
            await connection.close();
            signal.throwIfAborted();
            const saved = await store.saveRegisteredMcp(
              { ...registration, ...(input.id ? { id: input.id } : {}) },
              input.expectedRevision,
            );
            if (input.id) await resourceSubscriptions.removeServer(input.id);
            return saved;
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
            await resourceSubscriptions.removeServer(parsed.data.id);
            return { servers: await store.registeredMcp() };
          }),
        );
      } else if (request.method === 'GET' && url.pathname === '/v1/automations') {
        json(response, 200, automations.snapshot());
      } else if (request.method === 'POST' && url.pathname === '/v1/automations') {
        const input = z
          .strictObject({ version: z.number().int().min(0), automation: automationInputSchema })
          .parse(await readJson(request));
        json(response, 200, await automations.configure(input.automation, input.version));
      } else if (request.method === 'POST' && url.pathname === '/v1/automations/remove') {
        const input = z
          .strictObject({ version: z.number().int().min(0), id: z.uuid() })
          .parse(await readJson(request));
        json(response, 200, await automations.remove(input.id, input.version));
      } else if (request.method === 'GET' && url.pathname === '/v1/browser') {
        json(response, 200, await browserSettings(store));
      } else if (request.method === 'POST' && url.pathname === '/v1/browser') {
        const parsed = z
          .strictObject({ version: z.number().int().min(0), config: browserConfigSchema })
          .safeParse(await readJson(request));
        if (!parsed.success) throw new AppError('BROWSER_CONFIG', '브라우저 설정을 확인하세요.');
        json(
          response,
          200,
          await serial(async () => {
            if (active.size)
              throw new AppError('BUSY', '진행 중인 작업이 끝난 뒤 브라우저 설정을 바꾸세요.', 409);
            await store.saveIntegration('browser', parsed.data.version, parsed.data.config);
            return browserSettings(store);
          }),
        );
      } else if (request.method === 'GET' && url.pathname === '/v1/skills') {
        json(response, 200, { skills: await store.registeredSkills() });
      } else if (request.method === 'GET' && url.pathname === '/v1/skills/discover') {
        const projectId = url.searchParams.get('projectId');
        let projectPath: string | undefined;
        if (projectId) {
          if (!z.uuid().safeParse(projectId).success)
            throw new AppError('SKILL_INPUT', '프로젝트 ID가 올바르지 않습니다.');
          const project = (await store.snapshot()).projects.find((entry) => entry.id === projectId);
          if (!project)
            throw new AppError('PROJECT_NOT_FOUND', '프로젝트를 찾을 수 없습니다.', 404);
          projectPath = project.path;
        }
        json(response, 200, {
          skills: await discoverSkillDirectories({
            ...(projectPath ? { projectPath } : {}),
            signal: AbortSignal.timeout(15000),
          }),
        });
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
      } else if (request.method === 'POST' && url.pathname === '/v1/updates/prepare') {
        json(
          response,
          200,
          await serial(() =>
            updatePreparation.prepare(async () => {
              if (pendingMutations > 1)
                throw new AppError(
                  'UPDATE_BUSY',
                  '진행 중인 설정 변경과 저장 작업이 끝난 뒤 업데이트를 설치하세요.',
                  409,
                );
              const state = await store.snapshot();
              if (
                active.size ||
                state.sessions.some(
                  (session) =>
                    session.run?.status === 'running' ||
                    jobs
                      .list(session.id)
                      .some(
                        (job) =>
                          ['starting', 'running'].includes(job.execution?.status ?? 'starting') ||
                          job.execution?.cleanupPending,
                      ),
                )
              )
                throw new AppError(
                  'UPDATE_BUSY',
                  '대화와 백그라운드 명령을 중지한 뒤 업데이트를 설치하세요.',
                  409,
                );
              if (!backups)
                throw new AppError(
                  'BACKUP_DISABLED',
                  '업데이트 전에 백업 폴더를 설정해야 합니다.',
                  503,
                );
              return (await backups.create('manual')).backup;
            }),
          ),
        );
      } else if (request.method === 'POST' && url.pathname === '/v1/updates/release') {
        const input = z.strictObject({ token: z.uuid() }).safeParse(await readJson(request));
        if (!input.success) throw new AppError('UPDATE_TOKEN', '업데이트 준비 상태를 확인하세요.');
        updatePreparation.release(input.data.token);
        json(response, 200, { released: true });
      } else if (request.method === 'GET' && url.pathname === '/v1/backups') {
        if (!backups)
          throw new AppError('BACKUP_DISABLED', '백업 폴더가 설정되지 않았습니다.', 503);
        json(response, 200, await backups.snapshot());
      } else if (request.method === 'POST' && url.pathname === '/v1/backups/create') {
        if (!backups)
          throw new AppError('BACKUP_DISABLED', '백업 폴더가 설정되지 않았습니다.', 503);
        json(response, 201, await backups.create('manual'));
      } else if (request.method === 'POST' && url.pathname === '/v1/backups/export') {
        if (!backups)
          throw new AppError('BACKUP_DISABLED', '백업 폴더가 설정되지 않았습니다.', 503);
        json(response, 201, await backups.create('export'));
      } else if (request.method === 'POST' && url.pathname === '/v1/backups/preview') {
        const input = z
          .strictObject({ path: z.string().min(1).max(4096) })
          .safeParse(await readJson(request));
        if (!input.success) throw new AppError('BACKUP_PATH', '복원할 백업 파일을 선택하세요.');
        json(response, 200, await backupImporter.preview(input.data.path));
      } else if (request.method === 'POST' && url.pathname === '/v1/backups/restore') {
        const input = z.strictObject({ token: z.uuid() }).safeParse(await readJson(request));
        if (!input.success)
          throw new AppError('BACKUP_PREVIEW', '복원 미리보기를 먼저 확인하세요.');
        const restored = await backupImporter.restore(input.data.token);
        await automations.reloadImported();
        await languageServers.reload();
        json(response, 200, restored);
      } else if (request.method === 'POST' && url.pathname === '/v1/backups/settings') {
        if (!backups)
          throw new AppError('BACKUP_DISABLED', '백업 폴더가 설정되지 않았습니다.', 503);
        const parsed = backupSettingsSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('BACKUP_SETTINGS', '백업 보존 설정이 올바르지 않습니다.');
        json(response, 200, await backups.configure(parsed.data));
      } else if (request.method === 'POST' && url.pathname === '/v1/backups/delete') {
        if (!backups)
          throw new AppError('BACKUP_DISABLED', '백업 폴더가 설정되지 않았습니다.', 503);
        const parsed = z
          .strictObject({ name: z.string().min(1).max(200) })
          .safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('BACKUP_NAME', '백업 파일 이름이 올바르지 않습니다.');
        json(response, 200, await backups.remove(parsed.data.name));
      } else if (request.method === 'POST' && url.pathname === '/v1/runtime/profiles') {
        const input = localProfileInputSchema.safeParse(await readJson(request));
        if (!input.success)
          throw new AppError(
            'PROFILE_INPUT',
            input.error.issues[0]?.message ?? '모델 설정이 올바르지 않습니다.',
          );
        json(response, 200, { profile: await runtime.register(input.data) });
      } else if (request.method === 'POST' && url.pathname === '/v1/runtime/inspect') {
        const input = modelInspectionInputSchema.safeParse(await readJson(request));
        if (!input.success)
          throw new AppError('MODEL_INSPECTION_INPUT', 'GGUF 모델 파일 경로가 올바르지 않습니다.');
        json(response, 200, { inspection: await runtime.inspectModel(input.data.modelPath) });
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
      } else if (request.method === 'POST' && url.pathname === '/v1/runtime/engines/catalog') {
        const input = (await readJson(request)) as { channel?: unknown };
        if (!input || (input.channel !== 'stable' && input.channel !== 'nightly'))
          throw new AppError('ENGINE_CHANNEL', '엔진 채널을 선택하세요.');
        json(response, 200, await runtime.engineCatalog(input.channel));
      } else if (request.method === 'POST' && url.pathname === '/v1/runtime/engines/install') {
        const parsed = engineInstallSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('ENGINE_INPUT', '설치할 엔진 릴리스와 파일을 선택하세요.');
        await runtime.installEngine(parsed.data);
        json(response, 202, await runtime.snapshot());
      } else if (request.method === 'POST' && url.pathname === '/v1/runtime/engines/action') {
        const parsed = engineManagerActionSchema.safeParse(await readJson(request));
        if (!parsed.success) throw new AppError('ENGINE_INPUT', '엔진 작업이 올바르지 않습니다.');
        await runtime.engineAction(parsed.data.id, parsed.data.action);
        json(response, 200, await runtime.snapshot());
      } else if (request.method === 'POST' && url.pathname === '/v1/runtime/downloads') {
        const parsed = modelDownloadInputSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('MODEL_DOWNLOAD_INPUT', 'Hugging Face 모델 정보가 올바르지 않습니다.');
        await runtime.startDownload(parsed.data);
        json(response, 202, await runtime.snapshot());
      } else if (request.method === 'POST' && url.pathname === '/v1/runtime/downloads/action') {
        const parsed = modelDownloadActionSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('MODEL_DOWNLOAD_ACTION', '다운로드 작업이 올바르지 않습니다.');
        await runtime.downloadAction(parsed.data.downloadId, parsed.data.action);
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
          session: await serial(() => reviewEdit(parsed.data)),
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/costs/reconcile') {
        const input = z
          .strictObject({ sessionId: z.uuid(), expectedVersion: z.number().int().nonnegative() })
          .parse(await readJson(request));
        json(
          response,
          200,
          await serial(async () => {
            const session = await store.session(input.sessionId);
            if (session.version !== input.expectedVersion)
              throw new AppError(
                'VERSION_CONFLICT',
                '대화가 변경되었습니다. 최신 상태에서 다시 조회하세요.',
                409,
              );
            const config = { ...resolveModelConfig(session), provider: 'openrouter' as const };
            return reconcileCosts(store, session, inference.provider({ ...session, config }));
          }),
        );
      } else if (request.method === 'POST' && url.pathname === '/v1/approvals') {
        const parsed = approvalActionSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('INVALID_COMMAND', '권한 결정 요청이 올바르지 않습니다.');
        json(response, 200, {
          session: await serial(() => reviewApproval(parsed.data)),
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/mcp/elicitation') {
        const parsed = elicitationActionSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('INVALID_COMMAND', 'MCP 입력 응답이 올바르지 않습니다.');
        json(response, 200, {
          session: await serial(() => reviewElicitation(parsed.data)),
        });
      } else if (request.method === 'POST' && url.pathname === '/v1/sessions/delete') {
        const parsed = deleteSessionsSchema.safeParse(await readJson(request));
        if (!parsed.success)
          throw new AppError('INVALID_COMMAND', '삭제할 대화 목록이 올바르지 않습니다.');
        json(
          response,
          200,
          await telegram.withPaused(() =>
            serial(async () => {
              // A cancelled run may still be releasing a provider or tool operation.
              const state = await store.snapshot();
              for (const target of parsed.data.targets) {
                const session = state.sessions.find((s) => s.id === target.sessionId);
                if (session?.run && active.has(session.run.id))
                  throw new AppError(
                    'BUSY',
                    '실행을 정리하는 중입니다. 잠시 후 삭제해 주세요.',
                    409,
                  );
              }
              const deleted = store.deleteSessions(parsed.data);
              await Promise.all(
                parsed.data.targets.map((target) =>
                  resourceSubscriptions.removeSession(target.sessionId),
                ),
              );
              if (observations)
                await Promise.all(
                  parsed.data.targets.map((target) => observations.removeSession(target.sessionId)),
                );
              return deleted;
            }),
          ),
        );
      } else if (request.method === 'GET' && url.pathname === '/v1/command-jobs') {
        const sessionId = url.searchParams.get('sessionId') ?? '';
        await store.session(sessionId);
        json(response, 200, { jobs: jobs.list(sessionId) });
      } else if (
        request.method === 'POST' &&
        ['/v1/command-jobs/input', '/v1/command-jobs/stop', '/v1/command-jobs/resize'].includes(
          url.pathname,
        )
      ) {
        if (url.pathname.endsWith('/resize')) {
          const input = commandJobResizeActionSchema.parse(await readJson(request));
          const session = await store.session(input.sessionId);
          if (session.mode === 'plan')
            throw new AppError(
              'READ_ONLY',
              'Plan 모드에서는 터미널 크기를 변경할 수 없습니다.',
              403,
            );
          json(response, 200, {
            job: await jobs.resize(input.sessionId, input.jobId, input.cols, input.rows),
          });
          return;
        }
        const input = commandJobActionSchema.parse(await readJson(request));
        const session = await store.session(input.sessionId);
        if (url.pathname.endsWith('/input') && session.mode === 'plan')
          throw new AppError('READ_ONLY', 'Plan 모드에서는 명령 입력을 보낼 수 없습니다.', 403);
        json(response, 200, {
          job: url.pathname.endsWith('/input')
            ? await jobs.input(input.sessionId, input.jobId, input.input, input.eof)
            : await jobs.stop(input.sessionId, input.jobId),
        });
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
      } else if (request.method === 'GET' && url.pathname === '/v1/openrouter/account') {
        json(
          response,
          200,
          await openRouterAccount(
            openrouterKey,
            AbortSignal.any([
              operationSignal(response, shutdown.signal),
              AbortSignal.timeout(15000),
            ]),
          ),
        );
      } else if (request.method === 'GET' && url.pathname === '/v1/models') {
        const provider = providerSchema.parse(url.searchParams.get('provider'));
        const parsedUrl = localUrlSchema.safeParse(
          isLocalProvider(provider)
            ? (url.searchParams.get('baseUrl') ?? defaultProviderBaseUrl(provider))
            : defaultProviderBaseUrl(provider),
        );
        if (!parsedUrl.success)
          throw new AppError('INVALID_SERVER_URL', parsedUrl.error.issues[0]!.message);
        const baseUrl = parsedUrl.data;
        const adapter = createInferenceProvider(
          provider,
          baseUrl,
          provider === 'openrouter' ? openrouterKey : null,
        );
        json(
          response,
          200,
          provider === 'openrouter'
            ? await publicModelCatalog.get(url.searchParams.get('refresh') === 'true')
            : {
                models: await adapter.listModels(),
                fetchedAt: new Date().toISOString(),
                source: 'live',
                stale: false,
              },
        );
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
    } finally {
      if (mutationTracked) pendingMutations--;
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
  automations.start();
  return {
    port: address.port,
    async close() {
      closing = true;
      shutdown.abort();
      await resourceSubscriptions.close();
      await automations.close();
      await telegram.close();
      for (const run of active.values()) run.abort.abort();
      await jobs.close();
      await worktrees?.close();
      await languageServers.close();
      await oauth?.close();
      await backups?.close();
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

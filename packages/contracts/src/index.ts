import { z } from 'zod';
import type { SecretSource } from './integrations';
import {
  agentRoutingConfigSchema,
  modelConfigSchema,
  resolveModelConfig,
  type AgentRoutingConfig,
  type ModelConfig,
  type ProviderId,
} from './routing';
export { localUrlSchema, isPrivateServerAddress } from './network';
export * from './runtime';
export * from './integrations';
export * from './routing';

export const PROTOCOL_VERSION = 1 as const;
export const idSchema = z.uuid();
export const taskSchema = z.strictObject({
  id: idSchema,
  title: z.string().trim().min(1).max(500),
  done: z.boolean(),
  criteria: z.string().trim().max(2000).optional(),
  verificationCommand: z.string().trim().max(8000).optional(),
  dependsOn: z.array(idSchema).max(100).optional(),
});
export const planSchema = z
  .strictObject({
    goal: z.string().trim().max(4000),
    instructions: z.string().trim().max(4000).default(''),
    includeInContext: z.boolean().default(false),
    criteria: z.string().trim().max(4000).optional(),
    verificationCommand: z.string().trim().max(8000).optional(),
    tasks: z
      .array(taskSchema)
      .max(100)
      .refine(
        (tasks) => new Set(tasks.map((t) => t.id)).size === tasks.length,
        '중복된 작업 ID입니다.',
      ),
  })
  .superRefine((plan, ctx) => {
    const tasks = new Map(plan.tasks.map((task) => [task.id, task]));
    const visiting = new Set<string>(),
      visited = new Set<string>();
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      visiting.add(id);
      for (const dependency of tasks.get(id)?.dependsOn ?? [])
        if (!tasks.has(dependency) || !visit(dependency)) return false;
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    if (plan.tasks.some((task) => !visit(task.id)))
      ctx.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: '작업 의존 관계에 순환 또는 없는 작업이 포함되어 있습니다.',
      });
  });
export type Plan = z.infer<typeof planSchema>;
export const defaultPlan = (): Plan => planSchema.parse({ goal: '', tasks: [] });
export const modeSchema = z.enum(['plan', 'build']);
export type AgentMode = z.infer<typeof modeSchema>;
export const executionConfigSchema = z
  .strictObject({
    backend: z.enum(['disabled', 'docker']).default('disabled'),
    image: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/)
      .default('node:24-bookworm-slim'),
    network: z.enum(['none', 'bridge']).default('none'),
    cpus: z.number().min(0.5).max(16).default(2),
    memoryMb: z.number().int().min(256).max(32768).default(2048),
    projectAccess: z.boolean().default(false),
  })
  .refine(
    (config) => config.backend === 'disabled' || config.projectAccess,
    '프로젝트 폴더 접근 허용이 필요합니다.',
  );
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;
export const defaultExecutionConfig = (): ExecutionConfig => executionConfigSchema.parse({});
export const runCommandSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .max(8000)
    .refine((s) => !s.includes('\0')),
  cwd: z.string().min(1).max(4096).default('.'),
  timeoutMs: z.number().int().min(1000).max(120000).default(60000),
  stdin: z.string().max(8000).default(''),
});
export interface CommandExecution {
  id: string;
  containerName: string;
  dockerHost?: string;
  containerId?: string;
  imageId?: string;
  command: string;
  cwd: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  cleanupPending: boolean;
  error?: string;
}
export const planDraftSchema = z.strictObject({
  goal: z.string().trim().min(1).max(4000),
  criteria: z.string().trim().min(1).max(4000),
  verificationCommand: z.string().trim().max(8000).optional(),
  tasks: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
        title: z.string().trim().min(1).max(500),
        criteria: z.string().trim().max(2000),
        verificationCommand: z.string().trim().max(8000).optional(),
        dependsOn: z.array(z.string().max(40)).max(100),
      }),
    )
    .min(1)
    .max(100),
});
export interface PlanProposal {
  plan: Plan;
  basePlan: Plan;
  status: 'proposed' | 'adopted';
}
export const autopilotLimitsSchema = z.strictObject({
  modelCalls: z.number().int().min(1).max(1000000).nullable().default(null),
  toolCalls: z.number().int().min(1).max(1000000).nullable().default(null),
  minutes: z.number().int().min(1).max(525600).nullable().default(null),
  outputTokens: z.number().int().min(1024).max(1000000000).nullable().default(null),
  costUsd: z.number().min(0.01).max(1000).default(1),
});
export interface AutopilotState {
  goalDriven?: boolean;
  runId: string;
  status: 'running' | 'paused' | 'completed' | 'cancelled' | 'interrupted';
  plan: Plan;
  taskIds: string[];
  completedTaskIds: string[];
  wholeGoal: boolean;
  evidence: {
    taskId: string | null;
    executionId?: string;
    summary?: string;
    passed: boolean;
    at: string;
  }[];
  limits: z.infer<typeof autopilotLimitsSchema>;
  modelCalls: number;
  toolCalls: number;
  reservedOutputTokens: number;
  spentCostUsd: number;
  reservedCostUsd: number;
  costUnconfirmed: boolean;
  startedAt: string;
  reason?: string;
}
const envelope = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: idSchema,
  actor: z.enum(['desktop', 'telegram']),
  policyVersion: z.literal(1),
};
const target = { sessionId: idSchema, expectedVersion: z.number().int().nonnegative() };
export const skillSelectionSchema = z.strictObject({
  id: idSchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const skillSelectionsSchema = z
  .array(skillSelectionSchema)
  .max(16)
  .refine(
    (skills) => new Set(skills.map((skill) => skill.id)).size === skills.length,
    '중복된 스킬 ID입니다.',
  );
export type SkillSelection = z.infer<typeof skillSelectionSchema>;
export const mcpSelectionSchema = z.strictObject({
  serverId: idSchema,
  serverRevision: z.string().regex(/^[a-f0-9]{64}$/),
  toolName: z.string().min(1).max(256),
  toolRevision: z.string().regex(/^[a-f0-9]{64}$/),
});
export const mcpSelectionsSchema = z
  .array(mcpSelectionSchema)
  .max(16)
  .refine(
    (values) =>
      new Set(values.map((value) => JSON.stringify([value.serverId, value.toolName]))).size ===
      values.length,
    '중복된 MCP 도구입니다.',
  );
export type McpSelection = z.infer<typeof mcpSelectionSchema>;
export const mcpAttachmentSchema = z.strictObject({
  id: idSchema,
  serverId: idSchema,
  serverRevision: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['resource', 'prompt']),
  entryKey: z.string().min(1).max(4096),
  entryRevision: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().max(24576),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().min(0).max(24576),
  readAt: z.iso.datetime(),
});
export type McpContextAttachment = z.infer<typeof mcpAttachmentSchema>;
export type McpContentPreview = McpContextAttachment & { expiresAt: string };
export const mcpContentInputSchema = z.strictObject({
  serverId: idSchema,
  serverRevision: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['resource', 'prompt']),
  entryKey: z.string().min(1).max(4096),
  entryRevision: z.string().regex(/^[a-f0-9]{64}$/),
  arguments: z.record(z.string().min(1).max(256), z.string().max(4096)).optional(),
});
export type McpContentInput = z.infer<typeof mcpContentInputSchema>;
export const deleteSessionsSchema = z
  .strictObject({
    ...envelope,
    type: z.literal('delete_sessions'),
    targets: z.array(z.strictObject(target)).min(1).max(100),
  })
  .refine((value) => new Set(value.targets.map((t) => t.sessionId)).size === value.targets.length);
export type DeleteSessions = z.infer<typeof deleteSessionsSchema>;
export interface SessionsDeletedEvent {
  seq: number;
  protocolVersion: 1;
  type: 'sessions_deleted';
  sessionIds: string[];
  createdAt: string;
}
export interface DeleteSessionsResult {
  commandId: string;
  event: SessionsDeletedEvent;
  replayed: boolean;
}
export const commandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...envelope,
    type: z.literal('create_session'),
    sessionId: idSchema,
    title: z.string().trim().min(1).max(120),
    config: modelConfigSchema,
    routing: agentRoutingConfigSchema.optional(),
    projectId: idSchema.nullable().default(null),
    mode: modeSchema.default('build'),
  }),
  z.strictObject({
    ...envelope,
    ...target,
    type: z.literal('configure_session'),
    config: modelConfigSchema,
  }),
  z.strictObject({
    ...envelope,
    ...target,
    type: z.literal('configure_routing'),
    routing: agentRoutingConfigSchema,
  }),
  z.strictObject({
    ...envelope,
    ...target,
    type: z.literal('send_message'),
    content: z.string().trim().min(1).max(64000),
  }),
  z.strictObject({
    ...envelope,
    ...target,
    type: z.literal('start_autopilot'),
    taskIds: z.array(idSchema).max(100),
    limits: autopilotLimitsSchema,
  }),
  z.strictObject({
    ...envelope,
    ...target,
    type: z.literal('start_goal'),
    goal: z.string().trim().min(1).max(4000),
    limits: autopilotLimitsSchema,
  }),
  z.strictObject({ ...envelope, ...target, type: z.literal('resume_goal') }),
  z.strictObject({ ...envelope, ...target, type: z.literal('stop_autopilot') }),
  z.strictObject({
    ...envelope,
    type: z.literal('set_auto_approve'),
    sessionId: idSchema,
    enabled: z.boolean(),
  }),
  z.strictObject({ ...envelope, ...target, type: z.literal('save_plan'), plan: planSchema }),
  z.strictObject({ ...envelope, ...target, type: z.literal('set_mode'), mode: modeSchema }),
  z.strictObject({
    ...envelope,
    ...target,
    type: z.literal('configure_execution'),
    execution: executionConfigSchema,
  }),
  z.strictObject({
    ...envelope,
    ...target,
    type: z.literal('configure_skills'),
    skills: skillSelectionsSchema,
    skillCloudConsent: z.boolean(),
  }),
  z.strictObject({ ...envelope, ...target, type: z.literal('adopt_plan'), activityId: idSchema }),
  z.strictObject({
    ...envelope,
    ...target,
    type: z.literal('configure_mcp'),
    mcp: mcpSelectionsSchema,
    mcpCloudConsent: z.boolean(),
  }),
  z.strictObject({
    ...envelope,
    type: z.literal('cancel_run'),
    sessionId: idSchema,
    runId: idSchema,
  }),
  z.strictObject({
    ...envelope,
    ...target,
    type: z.literal('attach_mcp_content'),
    previewId: idSchema,
    mcpCloudConsent: z.boolean(),
  }),
  z.strictObject({
    ...envelope,
    ...target,
    type: z.literal('remove_mcp_content'),
    attachmentId: idSchema,
  }),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandInput =
  z.input<typeof commandSchema> extends infer C
    ? C extends z.input<typeof commandSchema>
      ? Omit<C, keyof typeof envelope>
      : never
    : never;
export function makeCommand(input: CommandInput): Command {
  return commandSchema.parse({
    ...input,
    protocolVersion: 1,
    commandId: crypto.randomUUID(),
    actor: 'desktop',
    policyVersion: 1,
  });
}

export interface Metric {
  value: number;
  source: 'engine_reported' | 'provider_reported' | 'app_observed';
}
export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  billing: 'not_applicable' | 'pending_reconciliation' | 'reported';
  decodeTps: Metric | null;
  prefillTps: Metric | null;
  ttftMs: Metric | null;
}
export const emptyUsage = (provider: ProviderId): Usage => ({
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
  billing: provider === 'openrouter' ? 'pending_reconciliation' : 'not_applicable',
  decodeTps: null,
  prefillTps: null,
  ttftMs: null,
});
export interface Message {
  inferenceConfig?: ModelConfig;
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  status: 'complete' | 'streaming' | 'cancelled' | 'failed' | 'interrupted';
  error: string | null;
  usage: Usage | null;
  activities?: Activity[];
  continuation?: InferenceMessage[];
}
export interface SubagentRecord {
  id: string;
  task: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  provider: ProviderId;
  model: string;
  startedAt?: string;
  finishedAt?: string;
  text: string;
  error?: string;
  modelCalls: number;
  toolCalls: number;
  usage?: Partial<Usage>;
}
export interface EditProposal {
  offset?: number;
  operation?: 'apply' | 'undo';
  path: string;
  beforeHash: string;
  afterHash: string;
  oldText: string;
  newText: string;
  diff: string;
  status: 'proposed' | 'applying' | 'applied' | 'reverted' | 'rejected' | 'conflict' | 'uncertain';
  error?: string;
}
export type ChangeStatus = EditProposal['status'] | 'partial';
export interface CreatedFileProposal {
  kind: 'create';
  path: string;
  content: string;
  afterHash: string;
  stagingId: string;
  identity?: string;
  diff: string;
}
export type FileChange = EditProposal | CreatedFileProposal;
export interface ChangeSet {
  files: FileChange[];
  status: ChangeStatus;
  operation?: 'apply' | 'undo';
  observations?: { path: string; state: 'before' | 'after' | 'conflict' | 'unknown' }[];
  error?: string;
}
export const activityProposal = (activity?: Activity) => activity?.changes ?? activity?.edit;
export const editActionSchema = z.strictObject({
  sessionId: idSchema,
  expectedVersion: z.number().int().nonnegative(),
  activityId: idSchema,
  action: z.enum(['apply', 'check', 'undo', 'reject']),
});
export type EditAction = z.infer<typeof editActionSchema>;
export interface Activity {
  subagents?: SubagentRecord[];
  mcpCall?: {
    serverId: string;
    serverRevision: string;
    toolName: string;
    toolRevision: string;
    status: 'running' | 'completed' | 'failed' | 'unknown';
    startedAt: string;
    finishedAt?: string;
    error?: string;
  };
  skillRead?: {
    skillId: string;
    revision: string;
    sourceName: string;
    path: string;
    sha256: string;
    bytes: number;
    entrySha256: string;
    readAt: string;
  };
  execution?: CommandExecution;
  planProposal?: PlanProposal;
  edit?: EditProposal;
  changes?: ChangeSet;
  id: string;
  kind: 'thinking' | 'tool';
  label: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  text: string;
  arguments?: string;
}
export interface Project {
  id: string;
  name: string;
  path: string;
  identity: string;
  createdAt: string;
}
export interface Run {
  id: string;
  messageId: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt: string | null;
  // Older runs and the browser demo have no compiled inference request.
  context?: ContextManifest;
}
export interface ContextManifest {
  mcpAttachmentIds?: string[];
  mcpTools?: string[];
  skillCatalog?: { includedIds: string[]; omittedIds: string[]; serializedBytes: number };
  compilerVersion: 'context-v1';
  sourceSessionVersion: number;
  requestSha256: string;
  estimateSource: 'utf8_bytes_v1';
  inputEstimateTokens: number;
  outputReserveTokens: number;
  safetyReserveTokens: number;
  contextBudgetTokens: number;
  serializedBytes: number;
  messageCount: number;
  historyMessageIds: string[];
  excludedMessageIds: string[];
  planIncluded: boolean;
  eco: boolean;
}
export interface Session {
  routing?: AgentRoutingConfig;
  mcpAttachments?: McpContextAttachment[];
  mcp?: McpSelection[];
  mcpCloudConsent?: boolean;
  hasMcpHistory?: boolean;
  hasSkillHistory?: boolean;
  skills?: SkillSelection[];
  skillCloudConsent?: boolean;
  autopilot?: AutopilotState;
  autoApprove?: boolean;
  execution?: ExecutionConfig;
  mode?: AgentMode;
  id: string;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  config: ModelConfig;
  plan: Plan;
  messages: Message[];
  run: Run | null;
  projectId?: string | null;
}
export interface SessionEvent {
  seq: number;
  protocolVersion: 1;
  type: 'session_changed';
  sessionId: string;
  session: Session;
  createdAt: string;
}
export type DomainEvent =
  | SessionEvent
  | SessionsDeletedEvent
  | {
      seq: number;
      protocolVersion: 1;
      type: 'projects_changed';
      projects: Project[];
      createdAt: string;
    };
export interface Snapshot {
  protocolVersion: 1;
  deletedSessionIds?: string[];
  sessions: Session[];
  projects: Project[];
  lastSeq: number;
  openrouterConfigured: boolean;
  openrouterKeySource?: SecretSource;
  envFilePath?: string;
}
export interface CommandResult {
  commandId: string;
  session: Session;
  replayed: boolean;
}
export interface ModelDescriptor {
  id: string;
  name: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  defaultTemperature: number | null;
  defaultTopP: number | null;
  tools: boolean | null;
  pricing: ModelPricing | null;
}
export interface ModelPricing {
  /** USD per input token. */
  prompt: number;
  /** USD per generated token. */
  completion: number;
  /** Fixed USD charge per request. */
  request: number;
}
export interface ModelCapabilities {
  tools: boolean | null;
  streaming: boolean;
}
export interface InferenceMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  reasoningDetails?: Record<string, unknown>[];
  reasoningContent?: string;
}
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface InferenceRequest {
  config: ModelConfig;
  messages: InferenceMessage[];
  tools?: ToolDefinition[];
}
export type InferenceEvent =
  | { type: 'started' }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'provider_state_delta'; provider: ProviderId; model: string; data: unknown }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; arguments?: string }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'finished'; reason: string }
  | { type: 'error'; code: string; message: string };
export interface InferenceProvider {
  listModels(signal?: AbortSignal): Promise<ModelDescriptor[]>;
  capabilities(model: string): Promise<ModelCapabilities>;
  generate(request: InferenceRequest, signal: AbortSignal): AsyncIterable<InferenceEvent>;
}
// Cloud providers deliberately do not implement process loading or VRAM control.
export interface LocalRuntimeController {
  inspect(profileId: string): Promise<{ profileId: string; estimatedVramBytes: number | null }>;
  acquire(profileId: string): Promise<{ leaseId: string; instanceId: string }>;
  release(leaseId: string): Promise<void>;
  unload(instanceId: string): Promise<void>;
}
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function prepareAutopilot(
  session: Session,
  taskIds: string[],
  limits: z.infer<typeof autopilotLimitsSchema>,
  runId = '',
): AutopilotState {
  if (session.mode === 'plan' || !session.projectId)
    throw new AppError(
      'AUTOPILOT_POLICY',
      'Autopilot을 사용하려면 프로젝트 대화에서 Build 모드를 선택하세요.',
    );
  if (resolveModelConfig(session).provider === 'demo')
    throw new AppError('AUTOPILOT_MODEL_REQUIRED', '로컬 모델 또는 OpenRouter 모델을 연결하세요.');
  const plan = planSchema.parse(session.plan);
  if (!plan.goal || !plan.criteria || !plan.includeInContext || !plan.tasks.length)
    throw new AppError(
      'GOAL_REQUIRED',
      '목표·완료 기준·할 일을 저장하고 모델 요청에 계획 포함을 켜세요.',
    );
  const selected = new Set(taskIds.length ? taskIds : plan.tasks.map((t) => t.id));
  const include = (id: string) => {
    const task = plan.tasks.find((t) => t.id === id);
    if (!task) throw new AppError('TASK_NOT_FOUND', '선택한 작업이 현재 계획에 없습니다.');
    for (const dependency of task.dependsOn ?? [])
      if (!selected.has(dependency)) {
        selected.add(dependency);
        include(dependency);
      }
  };
  for (const id of selected) include(id);
  for (const task of plan.tasks.filter((t) => selected.has(t.id)))
    if (!task.criteria?.trim())
      throw new AppError(
        'VERIFICATION_REQUIRED',
        '선택한 작업과 선행 작업마다 완료 기준을 저장하세요.',
      );
  const wholeGoal = selected.size === plan.tasks.length;
  return {
    runId,
    status: 'running',
    plan,
    taskIds: plan.tasks.filter((t) => selected.has(t.id)).map((t) => t.id),
    completedTaskIds: [],
    wholeGoal,
    evidence: [],
    limits,
    modelCalls: 0,
    toolCalls: 0,
    reservedOutputTokens: 0,
    spentCostUsd: 0,
    reservedCostUsd: 0,
    costUnconfirmed: false,
    startedAt: new Date().toISOString(),
  };
}
export function prepareGoal(
  _session: Session,
  goal: string,
  limits: z.infer<typeof autopilotLimitsSchema>,
  runId = '',
): AutopilotState {
  const normalized = goal.trim();
  if (!normalized) throw new AppError('GOAL_REQUIRED', '/goal 뒤에 달성할 목표를 입력하세요.');
  const plan = planSchema.parse({
    goal: normalized,
    instructions: '채팅에서 /goal로 시작한 지속 실행 목표입니다.',
    includeInContext: true,
    criteria: '요청한 결과를 실제로 만들고 가능한 범위에서 확인한 뒤 완료 근거를 제시합니다.',
    tasks: [],
  });
  return {
    goalDriven: true,
    runId,
    status: 'running',
    plan,
    taskIds: [],
    completedTaskIds: [],
    wholeGoal: true,
    evidence: [],
    limits,
    modelCalls: 0,
    toolCalls: 0,
    reservedOutputTokens: 0,
    spentCostUsd: 0,
    reservedCostUsd: 0,
    costUnconfirmed: false,
    startedAt: new Date().toISOString(),
  };
}
export function resumeGoal(session: Session, runId = ''): AutopilotState {
  const previous = session.autopilot;
  if (!previous?.goalDriven || previous.status === 'completed' || previous.status === 'cancelled')
    throw new AppError('GOAL_NOT_PAUSED', '계속 실행할 목표가 없습니다.', 409);
  const { reason: _reason, ...rest } = structuredClone(previous);
  const limits = autopilotLimitsSchema.parse(rest.limits);
  return {
    ...rest,
    limits: {
      ...limits,
      modelCalls: null,
      toolCalls: null,
      minutes: null,
      outputTokens: null,
    },
    spentCostUsd: rest.spentCostUsd ?? 0,
    reservedCostUsd: rest.reservedCostUsd ?? 0,
    // A manual resume is the user's acknowledgement; the conservative reservation remains charged.
    costUnconfirmed: false,
    runId,
    status: 'running',
  };
}
export function goalPrompt(state: AutopilotState) {
  return [
    'Continue working autonomously until the user goal is achieved or a real blocker requires user action.',
    'Use the available tools to inspect, implement, and verify. Do not stop after merely explaining a plan.',
    'When a file change needs approval, propose it and pause. After approval, continue from the persisted conversation.',
    'Call complete_goal only after the goal is actually achieved. Include concrete evidence in that tool call.',
    'Goal: ' + state.plan.goal,
  ].join('\n');
}
export function readyAutopilotTasks(state: AutopilotState) {
  return state.plan.tasks.filter(
    (task) =>
      state.taskIds.includes(task.id) &&
      !state.completedTaskIds.includes(task.id) &&
      (task.dependsOn ?? []).every((id) => state.completedTaskIds.includes(id)),
  );
}
export function autopilotPrompt(state: AutopilotState) {
  return (
    'Execute the selected working plan within the configured budget. The user authorized this Autopilot run for the selected project. Work on ready tasks only. Use verify_task after checking a task against its saved completion criteria; a saved verification command will run in Docker when command execution is enabled, otherwise provide concrete evidence from your inspection. Never mark tasks complete in prose alone. After all selected tasks pass, call verify_goal with final evidence. A proposed file change is not applied until the user approves it. Stop and explain missing prerequisites.\nSelected task IDs: ' +
    JSON.stringify(state.taskIds) +
    '\nReady task IDs: ' +
    JSON.stringify(readyAutopilotTasks(state).map((t) => t.id))
  );
}

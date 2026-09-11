import { z } from 'zod';
import { localUrlSchema } from './network';
export { localUrlSchema, isPrivateServerAddress } from './network';

export const PROTOCOL_VERSION = 1 as const;
export const idSchema = z.uuid();
export const providerSchema = z.enum(['llama-server', 'openrouter', 'demo']);
export type ProviderId = z.infer<typeof providerSchema>;

export const modelConfigSchema = z.strictObject({
  provider: providerSchema.default('llama-server'),
  model: z.string().trim().max(200).default(''),
  baseUrl: localUrlSchema.default('http://127.0.0.1:8080/v1'),
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().gt(0).max(1).default(0.95),
  maxTokens: z.number().int().min(1).max(32768).default(2048),
  contextBudgetTokens: z.number().int().min(1024).max(2097152).default(32768),
  cloudConsent: z.boolean().default(false),
  projectCloudConsent: z.boolean().default(false),
  eco: z.boolean().default(false),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export const defaultModelConfig = (): ModelConfig => modelConfigSchema.parse({});
export const taskSchema = z.strictObject({
  id: idSchema,
  title: z.string().trim().min(1).max(500),
  done: z.boolean(),
});
export const planSchema = z.strictObject({
  goal: z.string().trim().max(4000),
  instructions: z.string().trim().max(4000).default(''),
  includeInContext: z.boolean().default(false),
  tasks: z
    .array(taskSchema)
    .max(100)
    .refine(
      (tasks) => new Set(tasks.map((t) => t.id)).size === tasks.length,
      '중복된 작업 ID입니다.',
    ),
});
export type Plan = z.infer<typeof planSchema>;
export const defaultPlan = (): Plan => planSchema.parse({ goal: '', tasks: [] });
const envelope = {
  protocolVersion: z.literal(PROTOCOL_VERSION),
  commandId: idSchema,
  actor: z.literal('desktop'),
  policyVersion: z.literal(1),
};
const target = { sessionId: idSchema, expectedVersion: z.number().int().nonnegative() };
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
    projectId: idSchema.nullable().default(null),
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
    type: z.literal('send_message'),
    content: z.string().trim().min(1).max(64000),
  }),
  z.strictObject({ ...envelope, ...target, type: z.literal('save_plan'), plan: planSchema }),
  z.strictObject({
    ...envelope,
    type: z.literal('cancel_run'),
    sessionId: idSchema,
    runId: idSchema,
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
export interface EditProposal {
  offset?: number;
  operation?: 'apply' | 'undo';
  path: string;
  beforeHash: string;
  afterHash: string;
  oldText: string;
  newText: string;
  diff: string;
  status: 'proposed' | 'applying' | 'applied' | 'reverted' | 'conflict' | 'uncertain';
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
  action: z.enum(['apply', 'check', 'undo']),
});
export type EditAction = z.infer<typeof editActionSchema>;
export interface Activity {
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
export type SecretSource = 'environment' | 'env_file' | 'os_keychain' | 'none';
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
  tools: boolean | null;
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

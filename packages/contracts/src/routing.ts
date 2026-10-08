import { z } from 'zod';
import { localUrlSchema } from './network';
import type { Session } from './index';

export const providerSchema = z.enum([
  'llama-server',
  'ollama',
  'vllm',
  'mlx',
  'openrouter',
  'demo',
]);
export type ProviderId = z.infer<typeof providerSchema>;
export const isLocalProvider = (
  provider: string,
): provider is 'llama-server' | 'ollama' | 'vllm' | 'mlx' =>
  ['llama-server', 'ollama', 'vllm', 'mlx'].includes(provider);
export const providerLabel = (provider: ProviderId): string =>
  ({
    'llama-server': 'llama-server',
    ollama: 'Ollama',
    vllm: 'vLLM',
    mlx: 'MLX',
    openrouter: 'OpenRouter',
    demo: '데모',
  })[provider];
export const defaultProviderBaseUrl = (provider: ProviderId): string =>
  provider === 'ollama'
    ? 'http://127.0.0.1:11434'
    : provider === 'vllm'
      ? 'http://127.0.0.1:8000/v1'
      : 'http://127.0.0.1:8080/v1';
export function normalizeProviderBaseUrl(provider: ProviderId, value: string): string {
  const parsed = localUrlSchema.parse(value);
  return provider === 'ollama' ? parsed.replace(/\/(?:v1|api)$/, '') : parsed;
}
export const modelConfigSchema = z
  .strictObject({
    provider: providerSchema.default('llama-server'),
    model: z.string().trim().max(200).default(''),
    baseUrl: localUrlSchema.optional(),
    keepAliveSeconds: z.number().int().min(0).max(86400).optional(),
    temperature: z.number().min(0).max(2).default(0.7),
    useDefaultTemperature: z.boolean().default(true),
    topP: z.number().gt(0).max(1).default(0.95),
    useDefaultTopP: z.boolean().default(true),
    maxTokens: z.number().int().min(1).max(1048576).default(6553),
    autoMaxTokens: z.boolean().default(true),
    contextBudgetTokens: z.number().int().min(1024).max(2097152).default(32768),
    cloudConsent: z.boolean().default(false),
    projectCloudConsent: z.boolean().default(false),
    eco: z.boolean().default(false),
    managedModelId: z.uuid().optional(),
    managedModelVersion: z.number().int().positive().optional(),
  })
  .transform((config) => ({
    ...config,
    baseUrl: normalizeProviderBaseUrl(
      config.provider,
      config.baseUrl ?? defaultProviderBaseUrl(config.provider),
    ),
  }))
  .refine(
    (config) =>
      config.managedModelId === undefined
        ? config.managedModelVersion === undefined
        : config.provider === 'llama-server' && config.managedModelVersion !== undefined,
    '관리 모델은 llama-server 공급자와 모델 설정 버전이 필요합니다.',
  );
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export const defaultModelConfig = (): ModelConfig => modelConfigSchema.parse({});
export const agentRoutingConfigSchema = z.strictObject({
  plan: modelConfigSchema.optional(),
  build: modelConfigSchema.optional(),
  subagent: modelConfigSchema.optional(),
  summary: modelConfigSchema.optional(),
  review: modelConfigSchema.optional(),
  subagentsEnabled: z.boolean().default(false),
});
export type AgentRoutingConfig = z.infer<typeof agentRoutingConfigSchema>;
export const defaultAgentRoutingConfig = (): AgentRoutingConfig =>
  agentRoutingConfigSchema.parse({});

/** Missing roles inherit the session's default model, never another role's settings. */
export function resolveModelConfig(
  session: Pick<Session, 'config' | 'mode' | 'routing'> & Partial<Pick<Session, 'taskList'>>,
): ModelConfig {
  if (session.mode !== 'plan' && session.taskList?.active) {
    const task = session.taskList.tasks.find((item) => item.status !== 'completed');
    if (task?.model) return task.model;
  }
  return session.routing?.[session.mode ?? 'build'] ?? session.config;
}

export function resolveAuxiliaryModel(
  session: Pick<Session, 'config' | 'mode' | 'routing'> & Partial<Pick<Session, 'taskList'>>,
  role: 'summary' | 'review',
): ModelConfig {
  return session.routing?.[role] ?? resolveModelConfig(session);
}

/** Provider-specific reasoning is replayable only to the same endpoint/model profile. */
export function sameModelIdentity(left: ModelConfig, right: ModelConfig): boolean {
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.baseUrl === right.baseUrl &&
    left.managedModelId === right.managedModelId &&
    left.managedModelVersion === right.managedModelVersion
  );
}

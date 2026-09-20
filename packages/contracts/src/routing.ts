import { z } from 'zod';
import { localUrlSchema } from './network';
import type { Session } from './index';

export const providerSchema = z.enum(['llama-server', 'openrouter', 'demo']);
export type ProviderId = z.infer<typeof providerSchema>;
export const modelConfigSchema = z
  .strictObject({
    provider: providerSchema.default('llama-server'),
    model: z.string().trim().max(200).default(''),
    baseUrl: localUrlSchema.default('http://127.0.0.1:8080/v1'),
    temperature: z.number().min(0).max(2).default(0.7),
    topP: z.number().gt(0).max(1).default(0.95),
    maxTokens: z.number().int().min(1).max(1048576).default(2048),
    autoMaxTokens: z.boolean().default(false),
    contextBudgetTokens: z.number().int().min(1024).max(2097152).default(32768),
    cloudConsent: z.boolean().default(false),
    projectCloudConsent: z.boolean().default(false),
    eco: z.boolean().default(false),
    managedModelId: z.uuid().optional(),
    managedModelVersion: z.number().int().positive().optional(),
  })
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
  subagentsEnabled: z.boolean().default(false),
});
export type AgentRoutingConfig = z.infer<typeof agentRoutingConfigSchema>;
export const defaultAgentRoutingConfig = (): AgentRoutingConfig =>
  agentRoutingConfigSchema.parse({});

/** Missing roles inherit the session's default model, never another role's settings. */
export function resolveModelConfig(
  session: Pick<Session, 'config' | 'mode' | 'routing'>,
): ModelConfig {
  return session.routing?.[session.mode ?? 'build'] ?? session.config;
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

import { z } from 'zod';
export const automationTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(10080) }),
  z.strictObject({
    kind: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  z.strictObject({
    kind: z.literal('files'),
    paths: z.array(z.string().trim().min(1).max(4096)).min(1).max(16),
    debounceSeconds: z.number().int().min(10).max(600).default(30),
  }),
]);
export const automationInputSchema = z.strictObject({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(100),
  sessionId: z.uuid(),
  prompt: z.string().trim().min(1).max(32768),
  enabled: z.boolean().default(false),
  trigger: automationTriggerSchema,
});
export type AutomationInput = z.infer<typeof automationInputSchema>;
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
export interface AutomationRecord extends Omit<AutomationInput, 'id'> {
  id: string;
  createdAt: string;
  updatedAt: string;
  nextAt?: string;
  fileHashes?: Record<string, string>;
  changedAt?: string;
  lastRun?: {
    startedAt: string;
    runId?: string;
    status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
    message?: string;
  };
}
export interface AutomationSnapshot {
  version: number;
  records: AutomationRecord[];
}

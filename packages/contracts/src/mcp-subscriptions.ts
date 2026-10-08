import { z } from 'zod';

export const mcpSubscriptionInputSchema = z.strictObject({
  sessionId: z.uuid(),
  attachmentId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(),
  action: z.enum(['subscribe', 'unsubscribe']),
});
export type McpSubscriptionInput = z.infer<typeof mcpSubscriptionInputSchema>;
export interface McpResourceSubscription {
  sessionId: string;
  attachmentId: string;
  serverId: string;
  uri: string;
  status: 'watching' | 'changed' | 'disconnected' | 'unsupported';
  startedAt: string;
  changedAt?: string;
  notifications: number;
}

import { z } from 'zod';
export type SecretSource = 'environment' | 'env_file' | 'os_keychain' | 'none';
export const telegramConfigSchema = z
  .strictObject({
    enabled: z.boolean(),
    sessionId: z.uuid().nullable(),
    allowBuild: z.boolean().default(false),
    transmissionConsent: z.boolean().default(false),
  })
  .refine(
    (value) => !value.enabled || (value.sessionId && value.transmissionConsent),
    '연결할 대화와 Telegram 전송 동의가 필요합니다.',
  );
export type TelegramConfig = z.infer<typeof telegramConfigSchema>;
export interface TelegramPeer {
  userId: number;
  chatId: number;
  name: string;
}
export interface TelegramStatus {
  configured: boolean;
  tokenSource?: SecretSource;
  config: TelegramConfig;
  bot?: { id: number; username: string };
  owner?: TelegramPeer;
  candidate?: TelegramPeer;
  pairingExpiresAt?: number;
  running: boolean;
  error?: string;
  pending: number;
  unknownDeliveries: number;
}
export interface WorktreeRecord {
  id: string;
  sourceProjectId: string;
  baseCommit: string;
  branch: string;
  path: string;
  projectId?: string;
  createdAt: string;
  status: 'creating' | 'ready' | 'interrupted';
  error?: string;
}

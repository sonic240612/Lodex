import { z } from 'zod';

export const engineSettingsSchema = z
  .strictObject({
    contextSize: z.number().int().min(1024).max(2097152).default(32768),
    gpuLayers: z
      .union([z.number().int().min(0).max(100000), z.enum(['auto', 'all'])])
      .default('auto'),
    threads: z.number().int().min(1).max(1024).default(4),
    batchThreads: z.number().int().min(1).max(1024).default(4),
    batchSize: z.number().int().min(1).max(65536).default(512),
    microBatchSize: z.number().int().min(1).max(65536).default(128),
    flashAttention: z.enum(['auto', 'on', 'off']).default('auto'),
    cacheTypeK: z
      .enum(['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'])
      .default('f16'),
    cacheTypeV: z
      .enum(['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1'])
      .default('f16'),
    kvOffload: z.boolean().default(true),
    chatTemplate: z.string().max(16000).default(''),
    extraArgs: z
      .array(
        z
          .string()
          .max(8000)
          .refine((s) => !/[\0\r\n]/.test(s)),
      )
      .max(100)
      .default([]),
  })
  .refine((s) => s.microBatchSize <= s.batchSize, 'micro batch는 batch보다 클 수 없습니다.');
export type EngineSettings = z.infer<typeof engineSettingsSchema>;
export const localProfileInputSchema = z.strictObject({
  id: z.uuid().optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
  name: z.string().trim().min(1).max(200),
  enginePath: z.string().min(1).max(4096),
  modelPath: z.string().min(1).max(4096),
  settings: engineSettingsSchema,
  vramReservationMb: z.number().int().min(0).max(1048576).default(22528),
});
export type LocalProfileInput = z.infer<typeof localProfileInputSchema>;
export interface LocalProfile extends Omit<LocalProfileInput, 'id' | 'expectedVersion'> {
  id: string;
  version: number;
  modelBytes: number;
  modelIdentity: string;
  engineIdentity: string;
  engineVersion: string;
  supportedFlags: string[];
  ggufVersion: number;
  modelName?: string;
  modelArchitecture?: string;
  tokenizerModel?: string;
  nativeContextSize?: number;
  embeddedChatTemplate?: boolean;
}
export const runtimeSettingsSchema = z
  .strictObject({
    version: z.number().int().nonnegative().default(0),
    vramBudgetMb: z.number().int().min(0).max(1048576).default(24576),
    headroomMb: z.number().int().min(0).max(65536).default(1024),
    autoUnloadIdle: z.boolean().default(true),
    idleUnloadMinutes: z.number().int().min(1).max(1440).default(10),
  })
  .refine((s) => s.headroomMb <= s.vramBudgetMb, '여유 VRAM은 전체 예산 이하여야 합니다.');
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export const runtimeActionSchema = z.strictObject({
  profileId: z.uuid(),
  action: z.enum(['load', 'unload', 'remove']),
});
const safePathParts = (value: string) =>
  !value.startsWith('/') &&
  !value.startsWith('\\') &&
  !value.split(/[\\/]/).some((part) => !part || part === '.' || part === '..');
export const modelDownloadInputSchema = z.strictObject({
  repository: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  file: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((value) => safePathParts(value) && value.toLowerCase().endsWith('.gguf')),
  revision: z.string().trim().min(1).max(200).default('main').refine(safePathParts),
  expectedSha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ModelDownloadInput = z.infer<typeof modelDownloadInputSchema>;
export const modelDownloadActionSchema = z.strictObject({
  downloadId: z.uuid(),
  action: z.enum(['cancel', 'remove']),
});
export const modelDownloadSchema = z.strictObject({
  id: z.uuid(),
  repository: modelDownloadInputSchema.shape.repository,
  file: modelDownloadInputSchema.shape.file,
  revision: modelDownloadInputSchema.shape.revision,
  status: z.enum(['downloading', 'completed', 'failed', 'cancelled']),
  downloadedBytes: z.number().int().nonnegative().max(1_099_511_627_776),
  totalBytes: z.number().int().nonnegative().max(1_099_511_627_776).nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  modelPath: z.string().max(4096).optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  error: z.string().max(2000).optional(),
});
export type ModelDownload = z.infer<typeof modelDownloadSchema>;
export const modelInspectionInputSchema = z.strictObject({
  modelPath: z.string().min(1).max(4096),
});
export interface ModelInspection {
  modelPath: string;
  modelBytes: number;
  ggufVersion: number;
  modelName?: string;
  modelArchitecture?: string;
  tokenizerModel?: string;
  nativeContextSize?: number;
  layerCount?: number;
  embeddedChatTemplate: boolean;
  recommendedSettings: EngineSettings;
  recommendedVramReservationMb: number;
  estimatedKvCacheMb: number | null;
  recommendation: string;
}
export interface RuntimeInstance {
  profileId: string;
  status: 'loading' | 'ready' | 'stopped' | 'failed';
  leases: number;
  reservedVramMb: number;
  startedAt: string;
  lastUsedAt: string;
  log: string;
  error?: string;
}
export interface GpuResourceSnapshot {
  index: number;
  name: string;
  totalVramMb: number;
  usedVramMb: number;
  freeVramMb: number;
  utilizationPercent: number | null;
}
export interface RuntimeResources {
  measuredAt: string;
  systemRamTotalMb: number;
  systemRamUsedMb: number;
  systemRamFreeMb: number;
  gpuSource: 'nvidia-smi' | 'unavailable';
  gpus: GpuResourceSnapshot[];
}
export interface RuntimeSnapshot {
  profiles: LocalProfile[];
  settings: RuntimeSettings;
  instances: RuntimeInstance[];
  resources: RuntimeResources;
  downloads: ModelDownload[];
}

export const backupSettingsSchema = z.strictObject({
  automatic: z.boolean().default(true),
  retentionCount: z.number().int().min(1).max(100).default(10),
  retentionDays: z.number().int().min(1).max(3650).default(30),
});
export type BackupSettings = z.infer<typeof backupSettingsSchema>;
export interface BackupRecord {
  name: string;
  createdAt: string;
  bytes: number;
  sha256: string;
}
export interface BackupSnapshot {
  settings: BackupSettings;
  backups: BackupRecord[];
}

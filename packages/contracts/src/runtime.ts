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
  ramReservationMb: z.number().int().min(0).max(4194304).optional(),
});
export type LocalProfileInput = z.infer<typeof localProfileInputSchema>;
export interface LocalProfile extends Omit<LocalProfileInput, 'id' | 'expectedVersion'> {
  id: string;
  version: number;
  modelBytes: number;
  modelIdentity: string;
  modelFiles?: { path: string; bytes: number; identity: string }[];
  engineIdentity: string;
  engineVersion: string;
  supportedFlags: string[];
  ggufVersion: number;
  modelName?: string;
  modelArchitecture?: string;
  tokenizerModel?: string;
  nativeContextSize?: number;
  embeddedChatTemplate?: boolean;
  embeddedToolTemplate?: boolean;
}
export const runtimeSettingsSchema = z
  .strictObject({
    version: z.number().int().nonnegative().default(0),
    vramBudgetMb: z.number().int().min(0).max(1048576).default(24576),
    headroomMb: z.number().int().min(0).max(65536).default(1024),
    ramBudgetMb: z.number().int().min(0).max(4194304).default(0),
    ramHeadroomMb: z.number().int().min(0).max(1048576).default(2048),
    gpuIndex: z.number().int().min(0).max(255).default(0),
    autoUnloadIdle: z.boolean().default(true),
    idleUnloadMinutes: z.number().int().min(1).max(1440).default(10),
  })
  .refine((s) => s.headroomMb <= s.vramBudgetMb, '여유 VRAM은 전체 예산 이하여야 합니다.')
  .refine(
    (s) => s.ramBudgetMb === 0 || s.ramHeadroomMb <= s.ramBudgetMb,
    '남겨 둘 RAM은 전체 RAM 예산 이하여야 합니다.',
  );
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
  action: z.enum(['cancel', 'remove', 'resume']),
});
export const modelDownloadPartSchema = z.strictObject({
  file: modelDownloadInputSchema.shape.file,
  downloadedBytes: z.number().int().nonnegative().max(1_099_511_627_776),
  totalBytes: z.number().int().nonnegative().max(1_099_511_627_776).nullable(),
  etag: z.string().max(1024).optional(),
  verifiedSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type ModelDownloadPart = z.infer<typeof modelDownloadPartSchema>;
export const modelDownloadSchema = z.strictObject({
  id: z.uuid(),
  repository: modelDownloadInputSchema.shape.repository,
  file: modelDownloadInputSchema.shape.file,
  revision: modelDownloadInputSchema.shape.revision,
  resolvedRevision: z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .optional(),
  expectedSha256: modelDownloadInputSchema.shape.expectedSha256,
  parts: z.array(modelDownloadPartSchema).min(1).max(256).optional(),
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
  modelFiles?: { path: string; bytes: number; identity: string }[];
  ggufVersion: number;
  modelName?: string;
  modelArchitecture?: string;
  tokenizerModel?: string;
  nativeContextSize?: number;
  layerCount?: number;
  embeddedChatTemplate: boolean;
  embeddedToolTemplate: boolean;
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
  reservedRamMb?: number;
  memoryWarning?: string;
  gpuIndex?: number;
  errorCode?: 'OUT_OF_MEMORY';
  startedAt: string;
  lastUsedAt: string;
  log: string;
  error?: string;
}
export interface GpuResourceSnapshot {
  index: number;
  uuid?: string;
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
  engines?: EngineManagerSnapshot;
}

export const enginePlatformSchema = z.enum(['win32', 'darwin', 'linux']);
export const engineArchitectureSchema = z.enum(['x64', 'arm64']);
export const engineBackendSchema = z.enum(['cpu', 'cuda', 'vulkan', 'metal']);
export const engineAssetSchema = z.strictObject({
  id: z.number().int().positive(),
  name: z.string().min(1).max(300),
  size: z.number().int().positive().max(2_147_483_648),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  url: z.url().max(2000),
});
export type EngineAsset = z.infer<typeof engineAssetSchema>;
export interface EngineVariant extends EngineAsset {
  platform: z.infer<typeof enginePlatformSchema>;
  architecture: z.infer<typeof engineArchitectureSchema>;
  backend: z.infer<typeof engineBackendSchema>;
  backendVersion?: string;
  dependencies: EngineAsset[];
  unavailableReason?: string;
}
export interface EngineCatalog {
  channel: 'stable' | 'nightly';
  releaseTag: string;
  releaseUrl: string;
  publishedAt: string;
  prerelease: boolean;
  variants: EngineVariant[];
}
export const managedEngineSchema = z.strictObject({
  id: z.uuid(),
  releaseTag: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  releaseUrl: z.url().max(2000),
  prerelease: z.boolean(),
  platform: enginePlatformSchema,
  architecture: engineArchitectureSchema,
  backend: engineBackendSchema,
  assets: z.array(engineAssetSchema).min(1).max(4),
  installedAt: z.iso.datetime(),
  engineRelativePath: z.string().min(1).max(1000),
});
export type ManagedEngine = z.infer<typeof managedEngineSchema> & {
  enginePath: string;
  referencedBy: string[];
  running: boolean;
};
export interface EngineInstallation {
  id: string;
  releaseTag: string;
  assetId: number;
  assetName: string;
  status: 'downloading' | 'extracting' | 'completed' | 'cancelled' | 'failed';
  downloadedBytes: number;
  totalBytes: number;
  error?: string;
}
export interface EngineManagerSnapshot {
  platform: string;
  architecture: string;
  installed: ManagedEngine[];
  installations: EngineInstallation[];
}
export const engineInstallSchema = z.strictObject({
  releaseTag: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  assetId: z.number().int().positive(),
});
export type EngineInstallInput = z.infer<typeof engineInstallSchema>;
export const engineManagerActionSchema = z.strictObject({
  id: z.uuid(),
  action: z.enum(['cancel', 'remove']),
});

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
export type BackupImportKind =
  'projects' | 'sessions' | 'profiles' | 'skills' | 'mcp' | 'integrations';
export interface BackupImportPreview {
  token: string;
  fileName: string;
  sha256: string;
  exportedAt: string;
  expiresAt: string;
  items: {
    kind: BackupImportKind;
    label: string;
    importable: number;
    conflicts: number;
    skipped: number;
  }[];
  warnings: string[];
}
export interface BackupImportResult {
  imported: Record<BackupImportKind, number>;
}
export interface BackupSnapshot {
  settings: BackupSettings;
  backups: BackupRecord[];
  lastFailure?: { at: string; message: string };
}

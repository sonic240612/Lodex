import { z } from 'zod';
export const languageServerConfigSchema = z.strictObject({
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64).default([]),
  languageId: z.string().regex(/^[A-Za-z0-9_+-]{1,64}$/),
  extensions: z
    .array(z.string().regex(/^\.[A-Za-z0-9_.-]{1,32}$/))
    .min(1)
    .max(30),
  hostExecutionConsent: z.literal(true),
});
export type LanguageServerConfig = z.infer<typeof languageServerConfigSchema>;
export interface LanguageServerRegistration {
  requiresReview?: boolean | undefined;
  id: string;
  revision: string;
  config: LanguageServerConfig;
  executableHash: string;
  executableIdentity: string;
  createdAt: string;
}
export interface LanguageServerStatus {
  registration: LanguageServerRegistration;
  running: boolean;
  active: boolean;
  error?: string;
}
export const lspQuerySchema = z.strictObject({
  serverId: z.uuid().optional(),
  path: z.string().min(1).max(4096),
  line: z.number().int().min(1).max(10000000).default(1),
  column: z.number().int().min(1).max(10000000).default(1),
});
export const lspOperationSchema = z.enum([
  'diagnostics',
  'definitions',
  'references',
  'hover',
  'document_symbols',
]);
export type LspOperation = z.infer<typeof lspOperationSchema>;
export type LspQuery = z.infer<typeof lspQuerySchema>;

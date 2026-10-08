import { z } from 'zod';
export const browserConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  channel: z.enum(['msedge', 'chrome']).default('msedge'),
});
export type BrowserConfig = z.infer<typeof browserConfigSchema>;
export interface BrowserSettings {
  version: number;
  config: BrowserConfig;
}

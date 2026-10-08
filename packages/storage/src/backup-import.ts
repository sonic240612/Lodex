import type { LocalProfile, Project, Session } from '@lodex/contracts';
import type { RegisteredSkill } from '@lodex/skills';
import type { McpRegistration } from '@lodex/mcp';

export interface BackupImportData {
  projects: Project[];
  sessions: Session[];
  profiles: LocalProfile[];
  skills: RegisteredSkill[];
  mcp: McpRegistration[];
  integrations?: { name: 'browser' | 'automations' | 'language_servers'; document: unknown }[];
}
export interface BackupImportCatalog extends Omit<BackupImportData, 'sessions'> {
  fingerprint: string;
  sessionIds: string[];
  deletedSessionIds: string[];
}

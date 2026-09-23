export type SkillDialect =
  'standard' | 'codex' | 'claude' | 'pi' | 'opencode' | 'openclaw' | 'hermes';
export type SkillInvocation = 'model' | 'user';
export type SkillPlatform = 'windows' | 'macos' | 'linux';

export interface SkillDiagnostic {
  code: string;
  message: string;
  field?: string;
  path?: string;
}

export interface SkillFile {
  /** Always relative to this registration's canonical root. */
  path: string;
  bytes: number;
  identity: string;
  fingerprint: string;
  kind: 'instructions' | 'metadata' | 'script' | 'reference' | 'asset' | 'other';
}

export interface SkillDependency {
  type: string;
  value: string;
  transport?: string;
  status: 'unverified';
}

/** A trusted application record, never an object supplied by the model.
 * The host owns persistence, session selection and cloud transmission policy.
 */
export interface RegisteredSkill {
  schemaVersion: 1;
  id: string;
  revision: string;
  source: { rootPath: string; rootIdentity: string; rootName: string };
  dialect: SkillDialect;
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  platforms?: SkillPlatform[];
  metadata: Record<string, string>;
  invocation: { model: boolean; user: boolean };
  dependencies: SkillDependency[];
  diagnostics: SkillDiagnostic[];
  files: SkillFile[];
  entrySha256: string;
  companionSha256: string | null;
  inspectedAt: string;
}

export interface SkillDescriptor {
  id: string;
  revision: string;
  name: string;
  description: string;
  sourceName: string;
}

export interface SkillCatalog {
  skills: SkillDescriptor[];
  omittedIds: string[];
  policyExcludedIds: string[];
  serializedBytes: number;
}

export interface SkillProvenance {
  skillId: string;
  revision: string;
  sourceName: string;
  path: string;
  sha256: string;
  bytes: number;
  entrySha256: string;
  readAt: string;
}

export interface SkillDocument {
  /** Exact decoded SKILL.md, including frontmatter and any UTF-8 BOM. */
  text: string;
  body: string;
  provenance: SkillProvenance;
}

export interface SkillResource {
  text: string;
  provenance: SkillProvenance;
}

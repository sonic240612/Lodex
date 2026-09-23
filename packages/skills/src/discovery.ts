import { homedir } from 'node:os';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { AppError } from '@lodex/contracts';
import { blockedName } from './files';
import type { DiscoveredSkill, SkillDialect } from './types';

type Root = {
  path: string;
  dialect: SkillDialect;
  scope: DiscoveredSkill['scope'];
  source: string;
};

const MAX_DIRECTORIES = 4096;
const MAX_RESULTS = 512;
const MAX_DEPTH = 8;

function roots(home: string, projectPath?: string): Root[] {
  const user = (path: string, dialect: SkillDialect, source: string): Root => ({
    path: join(home, ...path.split('/')),
    dialect,
    scope: 'user',
    source,
  });
  const values = [
    user('.codex/skills', 'codex', 'Codex'),
    user('.claude/skills', 'claude', 'Claude Code'),
    user('.pi/agent/skills', 'pi', 'pi'),
    user('.config/opencode/skills', 'opencode', 'OpenCode'),
    user('.config/opencode/skill', 'opencode', 'OpenCode legacy'),
    user('.openclaw/skills', 'openclaw', 'OpenClaw'),
    user('.hermes/skills', 'hermes', 'Hermes Agent'),
    user('.agents/skills', 'standard', 'Agent Skills'),
  ];
  if (!projectPath) return values;
  const project = (path: string, dialect: SkillDialect, source: string): Root => ({
    path: join(projectPath, ...path.split('/')),
    dialect,
    scope: 'project',
    source,
  });
  return values.concat([
    project('.codex/skills', 'codex', 'Codex'),
    project('.claude/skills', 'claude', 'Claude Code'),
    project('.pi/skills', 'pi', 'pi'),
    project('.opencode/skills', 'opencode', 'OpenCode'),
    project('.opencode/skill', 'opencode', 'OpenCode legacy'),
    project('skills', 'openclaw', 'OpenClaw workspace'),
    project('.openclaw/skills', 'openclaw', 'OpenClaw'),
    project('.hermes/skills', 'hermes', 'Hermes Agent'),
    project('.agents/skills', 'standard', 'Agent Skills'),
  ]);
}

async function scanRoot(
  root: Root,
  signal: AbortSignal,
  counters: { directories: number; results: number },
): Promise<DiscoveredSkill[]> {
  let canonical: string;
  try {
    const info = await lstat(root.path);
    if (!info.isDirectory() || info.isSymbolicLink()) return [];
    canonical = await realpath(root.path);
  } catch {
    return [];
  }
  const found: DiscoveredSkill[] = [];
  const queue = [{ path: canonical, depth: 0 }];
  while (queue.length && counters.directories < MAX_DIRECTORIES && counters.results < MAX_RESULTS) {
    signal.throwIfAborted();
    const current = queue.shift()!;
    counters.directories++;
    let directory;
    try {
      directory = await opendir(current.path);
    } catch {
      continue;
    }
    let hasEntry = false;
    const children: string[] = [];
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (entry.name === 'SKILL.md' && entry.isFile()) hasEntry = true;
      else if (
        current.depth < MAX_DEPTH &&
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !blockedName(entry.name)
      )
        children.push(join(current.path, entry.name));
    }
    if (hasEntry) {
      const rel = relative(canonical, current.path);
      if (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) {
        found.push({
          path: current.path,
          dialect: root.dialect,
          scope: root.scope,
          source: root.source,
        });
        counters.results++;
      }
      continue;
    }
    children.sort().forEach((path) => queue.push({ path, depth: current.depth + 1 }));
  }
  return found;
}

/** Searches only documented harness skill roots. It reads directory entries, never skill contents. */
export async function discoverSkillDirectories(
  options: { home?: string; projectPath?: string; signal?: AbortSignal } = {},
): Promise<DiscoveredSkill[]> {
  const home = options.home ?? homedir();
  if (!isAbsolute(home) || (options.projectPath && !isAbsolute(options.projectPath)))
    throw new AppError('SKILL_DISCOVERY_PATH', '스킬 검색 기준 경로가 올바르지 않습니다.');
  const signal = options.signal ?? new AbortController().signal;
  const counters = { directories: 0, results: 0 };
  const discovered: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const root of roots(home, options.projectPath)) {
    for (const candidate of await scanRoot(root, signal, counters)) {
      const key = process.platform === 'win32' ? candidate.path.toLowerCase() : candidate.path;
      if (seen.has(key)) continue;
      seen.add(key);
      discovered.push(candidate);
    }
    if (counters.directories >= MAX_DIRECTORIES || counters.results >= MAX_RESULTS) break;
  }
  return discovered.sort(
    (left, right) =>
      (left.scope === right.scope ? 0 : left.scope === 'project' ? -1 : 1) ||
      left.path.localeCompare(right.path),
  );
}

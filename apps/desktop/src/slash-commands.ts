import { t as localize } from './i18n';
import type { AgentMode, Session } from '@lodex/contracts';
import type { RegisteredSkill } from '@lodex/skills';

export const slashCommands = [
  {
    id: 'plan',
    label: '계획 모드',
    description: '이번 요청을 조사하고 작업 계획을 제안합니다.',
    aliases: ['계획 모드', '계획모드', '계획'],
    argument: '요청 내용',
  },
  {
    id: 'goal',
    label: '목표 추진',
    description: '목표를 정하고 달성할 때까지 진행합니다.',
    aliases: ['목표 추진', '목표추진', '목표'],
    argument: '달성할 목표',
  },
  {
    id: 'new',
    label: '새 대화',
    description: '현재 대화는 보존하고 새 대화를 준비합니다.',
    aliases: ['새 대화', '새대화'],
    argument: '',
  },
  {
    id: 'settings',
    label: '설정',
    description: '모델·스킬·MCP·Telegram·백업을 관리합니다.',
    aliases: ['설정'],
    argument: '',
  },
  {
    id: 'compact',
    label: '컨텍스트 압축',
    description: '현재 모델로 대화 내용을 요약합니다.',
    aliases: ['컨텍스트 압축', '컨텍스트압축', '압축'],
    argument: '',
  },
  {
    id: 'quick',
    label: '빠른 압축',
    description: '모델 호출 없이 컨텍스트를 압축합니다.',
    aliases: ['빠른 압축', '빠른압축'],
    argument: '',
  },
  {
    id: 'resume',
    label: '목표 계속',
    description: '일시 정지된 목표를 이어서 추진합니다.',
    aliases: ['목표 계속', '목표계속', '계속', '재개'],
    argument: '',
  },
  {
    id: 'stop',
    label: '응답 중지',
    description: '현재 실행을 중지합니다.',
    aliases: ['응답 중지', '응답중지', '중지'],
    argument: '',
  },
  {
    id: 'skill',
    label: '스킬 실행',
    description: '이 대화에 선택한 스킬을 인자와 함께 실행합니다.',
    aliases: ['스킬'],
    argument: '스킬 이름 인자',
  },
  {
    id: 'help',
    label: '명령 도움말',
    description: '슬래시 명령 목록을 표시합니다.',
    aliases: ['도움말', '명령어'],
    argument: '',
  },
] as const;
export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  aliases: readonly string[];
  argument: string;
  insertText?: string;
}
export type SlashCommandId = (typeof slashCommands)[number]['id'];
export type ParsedComposerInput =
  | { command: SlashCommandId; argument: string }
  | { command: 'message'; argument: string }
  | { command: 'unknown'; argument: string };

export function parseComposerInput(
  text: string,
  skills: readonly RegisteredSkill[] = [],
): ParsedComposerInput {
  const input = text.trim();
  if (!input.startsWith('/')) return { command: 'message', argument: input };
  const body = input.slice(1);
  const names = slashCommands
    .flatMap((command) =>
      [command.id, ...command.aliases].map((name) => ({ name, id: command.id })),
    )
    .sort((left, right) => right.name.length - left.name.length);
  for (const { name, id } of names) {
    if (
      body.toLowerCase() === name ||
      (body.toLowerCase().startsWith(name) && /\s/.test(body[name.length] ?? ''))
    )
      return {
        command: id,
        argument:
          id === 'skill'
            ? '/skill ' + body.slice(name.length).trim()
            : body.slice(name.length).trim(),
      };
  }
  if (
    skills.some(
      (skill) =>
        skill.invocation.user && skill.name.toLowerCase() === body.split(/\s/, 1)[0]?.toLowerCase(),
    )
  )
    return { command: 'skill', argument: input };
  // An absolute file path is ordinary chat text, not an unknown command.
  return {
    command: body.split(/\s/, 1)[0]?.includes('/') ? 'message' : 'unknown',
    argument: input,
  };
}

/** A running request keeps its permissions; an idle request opts into Plan explicitly. */
export function composerRequestMode(text: string, runningMode?: AgentMode): AgentMode {
  if (runningMode) return runningMode;
  const { command, argument } = parseComposerInput(text);
  return command === 'plan' && argument ? 'plan' : 'build';
}

export function availableSlashCommands(
  session: Session | undefined,
  connected: boolean,
  skills: readonly RegisteredSkill[] = [],
): readonly SlashCommand[] {
  const running = session?.run?.status === 'running';
  const builtins = slashCommands
    .filter((command) => {
      if (['new', 'settings', 'help'].includes(command.id)) return true;
      if (!connected) return false;
      if (command.id === 'stop') return !!running;
      if (running) return false;
      if (command.id === 'resume')
        return (
          !!session?.autopilot?.goalDriven &&
          ['paused', 'interrupted'].includes(session.autopilot.status)
        );
      if (['compact', 'quick'].includes(command.id))
        return !!session?.messages.some((message) => message.status === 'complete');
      return true;
    })
    .map((command) => ({
      ...command,
      label: localize(command.label),
      description: localize(command.description),
      argument: localize(command.argument),
    }));
  if (!connected || running) return builtins;
  const selected = skills.filter(
    (skill) =>
      skill.invocation.user &&
      session?.skills?.some((entry) => entry.id === skill.id && entry.revision === skill.revision),
  );
  return [
    ...builtins,
    ...selected.map((skill): SlashCommand => {
      const unique =
        selected.filter((entry) => entry.name.toLowerCase() === skill.name.toLowerCase()).length ===
        1;
      const collides = slashCommands.some((entry) =>
        [entry.id, ...entry.aliases].some((name) => name === skill.name.toLowerCase()),
      );
      const short = unique && !collides && /^[a-z0-9][a-z0-9-]*$/.test(skill.name);
      return {
        id: 'skill-' + skill.id,
        label: skill.name,
        description: skill.description,
        aliases: [skill.name, 'skill ' + skill.name],
        argument: skill.argumentHint ?? localize('인자'),
        insertText: short ? `/${skill.name} ` : `/skill ${skill.id} `,
      };
    }),
  ];
}

export function suggestSlashCommands(
  text: string,
  commands: readonly SlashCommand[],
): readonly SlashCommand[] {
  const input = text.trimStart();
  if (!input.startsWith('/') || input.includes('\n')) return [];
  const query = input.slice(1).toLowerCase();
  return commands.filter((command) =>
    [command.id, ...command.aliases, command.insertText?.trim().slice(1) ?? ''].some((name) =>
      name.toLowerCase().startsWith(query),
    ),
  );
}

export function moveSlashSelection(index: number, direction: number, length: number) {
  return length ? (index + direction + length) % length : 0;
}

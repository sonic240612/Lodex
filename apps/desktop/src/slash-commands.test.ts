import { describe, expect, it } from 'vitest';
import { defaultModelConfig, defaultPlan, type Session } from '@lodex/contracts';
import {
  availableSlashCommands,
  composerRequestMode,
  moveSlashSelection,
  parseComposerInput,
  slashCommands,
  suggestSlashCommands,
} from './slash-commands';

const session: Session = {
  id: crypto.randomUUID(),
  title: 'chat',
  version: 2,
  createdAt: '',
  updatedAt: '',
  config: defaultModelConfig(),
  plan: defaultPlan(),
  messages: [],
  run: null,
};

describe('composer slash commands', () => {
  it.each([
    ['/PLAN Fix MyFile.ts', 'plan', 'Fix MyFile.ts'],
    [' /계획 모드 코드 검토\n테스트 계획 ', 'plan', '코드 검토\n테스트 계획'],
    ['/계획', 'plan', ''],
    ['/목표 추진 앱 완성', 'goal', '앱 완성'],
    ['/목표 앱 완성', 'goal', '앱 완성'],
    ['/빠른 압축', 'quick', ''],
    ['/설정', 'settings', ''],
    ['/새 대화', 'new', ''],
    ['/목표 계속', 'resume', ''],
    ['/중지', 'stop', ''],
    ['/컨텍스트 압축', 'compact', ''],
    ['/도움말', 'help', ''],
  ])('parses %s without sending command text to the model', (input, command, argument) => {
    expect(parseComposerInput(input)).toEqual({ command, argument });
  });
  it('matches boundaries and treats paths and normal messages as messages', () => {
    expect(parseComposerInput('/goalish details').command).toBe('unknown');
    expect(parseComposerInput('/unknown')).toEqual({ command: 'unknown', argument: '/unknown' });
    expect(parseComposerInput('/home/user/project')).toEqual({
      command: 'message',
      argument: '/home/user/project',
    });
    expect(parseComposerInput('Please use /goal')).toEqual({
      command: 'message',
      argument: 'Please use /goal',
    });
  });
  it('uses Build for ordinary requests and only plans explicit requests with content', () => {
    expect(composerRequestMode('')).toBe('build');
    expect(composerRequestMode('Continue the previous plan')).toBe('build');
    expect(composerRequestMode('/plan')).toBe('build');
    expect(composerRequestMode('/plan Investigate the source')).toBe('plan');
    expect(composerRequestMode('/계획 소스를 조사해')).toBe('plan');
    expect(composerRequestMode('Apply it', 'plan')).toBe('plan');
    expect(composerRequestMode('/plan Check it', 'build')).toBe('build');
  });
  it('does not expose or recognize the removed Build command or its aliases', () => {
    for (const input of ['/build', '/build implement', '/빌드모드 수정', '/개발']) {
      expect(parseComposerInput(input).command).toBe('unknown');
      expect(suggestSlashCommands(input, slashCommands)).toEqual([]);
    }
    expect(slashCommands.map((command) => command.id)).not.toContain('build');
  });
  it('filters Korean and English prefixes, then closes after completion or arguments', () => {
    expect(suggestSlashCommands('/', slashCommands)).toHaveLength(slashCommands.length);
    expect(suggestSlashCommands('/계획', slashCommands).map((item) => item.id)).toEqual(['plan']);
    expect(suggestSlashCommands('/GO', slashCommands).map((item) => item.id)).toEqual(['goal']);
    expect(suggestSlashCommands('/goal ', slashCommands)).toEqual([]);
    expect(suggestSlashCommands('/목표 목표 내용', slashCommands)).toEqual([]);
    expect(suggestSlashCommands('message\n/', slashCommands)).toEqual([]);
    expect(suggestSlashCommands('/계획\n설계', slashCommands)).toEqual([]);
  });
  it('wraps navigation and handles empty menus', () => {
    expect(moveSlashSelection(0, -1, 4)).toBe(3);
    expect(moveSlashSelection(3, 1, 4)).toBe(0);
    expect(moveSlashSelection(0, -1, 0)).toBe(0);
  });
  it('limits the menu to commands usable in the current conversation', () => {
    const ids = (target: Session | undefined, connected = true) =>
      availableSlashCommands(target, connected).map((item) => item.id);
    expect(ids(undefined, false)).toEqual(['new', 'settings', 'help']);
    expect(ids(undefined)).toEqual(['plan', 'goal', 'new', 'settings', 'help']);
    expect(
      ids({
        ...session,
        run: {
          id: crypto.randomUUID(),
          messageId: crypto.randomUUID(),
          status: 'running',
          startedAt: '',
          finishedAt: null,
        },
      }),
    ).toEqual(['new', 'settings', 'stop', 'help']);
    expect(
      ids({
        ...session,
        messages: [
          {
            id: crypto.randomUUID(),
            role: 'user',
            content: 'text',
            createdAt: '',
            status: 'complete',
            error: null,
            usage: null,
          },
        ],
      }),
    ).toContain('quick');
    expect(
      ids({
        ...session,
        messages: [
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: '',
            createdAt: '',
            status: 'streaming',
            error: null,
            usage: null,
          },
        ],
      }),
    ).not.toContain('compact');
  });
});

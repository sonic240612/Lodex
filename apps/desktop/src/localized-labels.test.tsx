import { afterEach, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Activity, Session } from '@lodex/contracts';
import { defaultModelConfig, defaultPlan } from '@lodex/contracts';
import type { RegisteredSkill } from '@lodex/skills';
import { ActivityCards, activityTitle } from './ActivityCards';
import { workDuration } from './AssistantMessage';
import { availableSlashCommands, parseComposerInput } from './slash-commands';
import { setLocale } from './i18n';

afterEach(() => setLocale('ko'));
it('translates status dictionaries after switching language and preserves tool output', () => {
  const activity: Activity = {
    id: 'fixture',
    kind: 'tool',
    label: 'read_file',
    status: 'completed',
    text: '사용자 파일 내용',
  };
  expect(activityTitle(activity)).toBe('파일 읽기');
  setLocale('en');
  const html = renderToStaticMarkup(<ActivityCards activities={[activity]} inline />);
  expect(html).toContain('Read file');
  expect(html).toContain('Completed');
  expect(html).toContain('사용자 파일 내용');
  expect(workDuration('2026-10-08T00:00:00Z', '2026-10-08T01:02:03Z')).toBe('1h 2m');
  setLocale('ko');
  expect(activityTitle(activity)).toBe('파일 읽기');
});
it('translates built-in slash hints without translating user skills or changing command aliases', () => {
  const skill = {
    id: crypto.randomUUID(),
    name: '사용자 스킬',
    description: '내 스킬 설명',
    revision: '1',
    invocation: { user: true, model: true },
  } as RegisteredSkill;
  const session: Session = {
    id: crypto.randomUUID(),
    title: '',
    version: 1,
    createdAt: '',
    updatedAt: '',
    config: defaultModelConfig(),
    plan: defaultPlan(),
    run: null,
    messages: [],
    skills: [{ id: skill.id, revision: skill.revision }],
  };
  setLocale('en');
  const commands = availableSlashCommands(session, true, [skill]);
  expect(commands.find((command) => command.id === 'plan')?.label).toBe('Plan mode');
  expect(commands.find((command) => command.id === 'skill-' + skill.id)).toMatchObject({
    label: '사용자 스킬',
    description: '내 스킬 설명',
    argument: 'Arguments',
  });
  expect(parseComposerInput('/계획 조사')).toEqual({ command: 'plan', argument: '조사' });
});

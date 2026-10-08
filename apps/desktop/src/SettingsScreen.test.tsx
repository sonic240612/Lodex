import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultModelConfig } from '@lodex/contracts';
import { SettingsScreen, settingsSections } from './SettingsScreen';
import { SettingsSurface } from './SettingsSurface';
import { SlashMenu } from './SlashMenu';
import { slashCommands } from './slash-commands';
import { ModelManager } from './ModelManager';
import { RoutingSettings } from './RoutingSettings';
import { SkillManager } from './SkillManager';
import { McpManager } from './McpManager';
import { TelegramSettings } from './TelegramSettings';
import { WorktreeManager } from './WorktreeManager';
import { DataManager } from './DataManager';

describe('central settings screen', () => {
  it('exposes keyboard-accessible settings categories and one panel', () => {
    const html = renderToStaticMarkup(
      <SettingsScreen selected="telegram" onSelect={vi.fn()} onClose={vi.fn()}>
        <SettingsSurface embedded>content</SettingsSurface>
      </SettingsScreen>,
    );
    expect(html.match(/<dialog\b/g)).toHaveLength(1);
    expect(html.match(/role="tab"/g)).toHaveLength(settingsSections.length);
    expect(html).toContain('브라우저');
    expect(html).toContain('예약 실행');
    expect(html.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('설정 화면 닫기');
    for (const section of settingsSections) expect(html).toContain(section.label);
  });
  it.each([
    [
      'local',
      <ModelManager
        embedded
        hasSession={false}
        running={false}
        onClose={vi.fn()}
        onChoose={vi.fn()}
      />,
    ],
    [
      'routing',
      <RoutingSettings
        embedded
        base={defaultModelConfig()}
        hasMessages={false}
        running={false}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    ],
    [
      'skills',
      <SkillManager
        embedded
        session={undefined}
        projectId={undefined}
        provider="demo"
        connected
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    ],
    [
      'mcp',
      <McpManager
        embedded
        session={undefined}
        provider="demo"
        connected
        onClose={vi.fn()}
        onSave={vi.fn()}
        onAttach={vi.fn()}
        onRemoveAttachment={vi.fn()}
      />,
    ],
    ['telegram', <TelegramSettings embedded sessions={[]} selectedId={null} onClose={vi.fn()} />],
    [
      'worktree',
      <WorktreeManager
        embedded
        projects={[]}
        selectedId={null}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    ],
    ['data', <DataManager embedded onClose={vi.fn()} />],
  ])('embeds the %s editor without a nested modal', (_name, editor) => {
    const html = renderToStaticMarkup(editor);
    expect(html).toContain('settings-section');
    expect(html).not.toContain('<dialog');
    expect(html).toContain('aria-busy="false"');
  });
  it('retains standalone dialogs for quick settings and reports busy operations', () => {
    expect(renderToStaticMarkup(<SettingsSurface aria-busy>content</SettingsSurface>)).toContain(
      '<dialog aria-busy="true"',
    );
    expect(
      renderToStaticMarkup(
        <SettingsSurface embedded aria-busy>
          content
        </SettingsSurface>,
      ),
    ).toContain('<section aria-busy="true"');
  });
});

it('links slash choices to a single selected option for the composer', () => {
  const html = renderToStaticMarkup(
    <SlashMenu commands={slashCommands.slice(0, 3)} active={1} onSelect={vi.fn()} />,
  );
  expect(html).toContain('role="listbox"');
  expect(html.match(/role="option"/g)).toHaveLength(3);
  expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
  expect(html).toMatch(/aria-selected="true" id="slash-command-goal"/);
  expect(html).toContain('Tab 선택');
  expect(html).toContain('type="button"');
});

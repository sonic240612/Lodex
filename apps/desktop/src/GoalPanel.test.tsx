import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  autopilotLimitsSchema,
  defaultModelConfig,
  defaultPlan,
  prepareGoal,
  type Session,
} from '@lodex/contracts';
import { PlanEditor } from './App';

afterEach(() => vi.unstubAllGlobals());
const goal = 'Unique goal visible once';
function fixture(): Session {
  const session: Session = {
    id: crypto.randomUUID(),
    title: 'goal',
    version: 1,
    createdAt: '',
    updatedAt: '',
    config: { ...defaultModelConfig(), model: 'fixture' },
    mode: 'build',
    plan: { ...defaultPlan(), goal, criteria: 'Saved criterion', includeInContext: true },
    messages: [],
    run: null,
  };
  session.autopilot = prepareGoal(
    session,
    goal,
    autopilotLimitsSchema.parse({}),
    crypto.randomUUID(),
  );
  session.autopilot.status = 'completed';
  return session;
}
function render(session?: Session) {
  return renderToStaticMarkup(
    <PlanEditor session={session} ensureSession={vi.fn()} onError={vi.fn()} />,
  );
}

describe('goal panel', () => {
  it('shows only the goal field and launch controls in default Simple mode', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    const html = render();
    expect(html.match(/id="goal"/g)).toHaveLength(1);
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).toContain('목표만 입력하면');
    expect(html).not.toContain('id="goal-criteria"');
    expect(html).not.toContain('새 할 일');
  });
  it.each(['simple', 'advanced'] as const)(
    'renders one goal in %s even when execution history contains the same goal',
    (mode) => {
      vi.stubGlobal('localStorage', { getItem: () => mode });
      const html = render(fixture());
      expect(html.match(/id="goal"/g)).toHaveLength(1);
      expect(html.match(new RegExp(goal, 'g'))).toHaveLength(1);
      expect(html).toContain('실행 상태');
      if (mode === 'advanced') {
        expect(html).toContain('id="goal-criteria"');
        expect(html).toContain('id="goal-verification"');
        expect(html).toContain('새 할 일');
        expect(html).toContain('계획 실행');
      } else expect(html).toContain('목표 추진');
    },
  );
  it('locks mode buttons and the goal input during an active execution', () => {
    const session = fixture();
    session.run = {
      id: crypto.randomUUID(),
      messageId: crypto.randomUUID(),
      status: 'running',
      startedAt: '',
      finishedAt: null,
    };
    session.autopilot!.status = 'running';
    const html = render(session);
    expect(html.match(/aria-pressed="(?:true|false)" disabled=""/g)).toHaveLength(2);
    expect(html).toMatch(/<textarea[^>]*id="goal"[^>]*disabled=""/);
  });
});

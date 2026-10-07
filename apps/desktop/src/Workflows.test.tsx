import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { CommandJob, WorktreePreview } from '@lodex/contracts';
import { CommandJobRow } from './CommandJobsPanel';
import { WorktreeReviewPanel } from './WorktreeReviewPanel';
it('exposes live input and EOF with Plan disabled, and preserves uncertain job status', () => {
  const job: CommandJob = {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    actor: 'desktop',
    interactive: true,
    background: true,
    inputOpen: true,
    inputBytes: 0,
    createdAt: '',
  };
  const html = renderToStaticMarkup(
    <CommandJobRow job={job} readOnly={false} onUpdate={() => {}} />,
  );
  expect(html).toContain('입력 전달');
  expect(html).toContain('입력 종료(EOF)');
  expect(html).toContain('백그라운드');
  const plan = renderToStaticMarkup(<CommandJobRow job={job} readOnly onUpdate={() => {}} />);
  expect(plan).toMatch(/textarea[^>]*disabled/);
});
it('requires explicit conflict resolution before merge and disables apply outside the source Build session', () => {
  const preview: WorktreePreview = {
    id: crypto.randomUUID(),
    worktreeId: crypto.randomUUID(),
    sourceProjectId: crypto.randomUUID(),
    createdAt: '',
    files: [
      {
        path: 'a.txt',
        before: 'user\n',
        theirs: 'agent\n',
        merged: '<<<<<<< Current\nuser\n=======\nagent\n>>>>>>> Worktree\n',
        conflict: true,
        diff: 'review diff',
        beforeHash: '',
        theirsHash: '',
      },
    ],
  };
  const html = renderToStaticMarkup(
    <WorktreeReviewPanel preview={preview} canApply busy={false} onApply={() => {}} />,
  );
  expect(html).toContain('원본 유지');
  expect(html).toContain('Worktree 내용 사용');
  expect(html).toContain('충돌 해결 a.txt');
  expect(html).toMatch(/button[^>]*disabled[^>]*>검토한 변경 적용/);
  const noConflict = {
    ...preview,
    files: preview.files.map((file) => ({ ...file, conflict: false, merged: 'resolved\n' })),
  };
  expect(
    renderToStaticMarkup(
      <WorktreeReviewPanel preview={noConflict} canApply={false} busy={false} onApply={() => {}} />,
    ),
  ).toContain('원본 프로젝트의 Build 대화');
  expect(
    renderToStaticMarkup(
      <WorktreeReviewPanel preview={noConflict} canApply busy={false} onApply={() => {}} />,
    ),
  ).not.toMatch(/button[^>]*disabled[^>]*>검토한 변경 적용/);
});

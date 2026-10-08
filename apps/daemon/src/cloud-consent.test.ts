import { describe, expect, it } from 'vitest';
import { defaultModelConfig, defaultPlan, type Message, type Session } from '@lodex/contracts';
import { compileContext } from '@lodex/context';
import { validateCloudTransmission } from './cloud-consent';

const local = defaultModelConfig();
const cloud = {
  ...local,
  provider: 'openrouter' as const,
  model: 'fixture-cloud',
  cloudConsent: true,
  projectCloudConsent: false,
};
const now = new Date().toISOString();
function session(message: Partial<Message> = {}): Session {
  return {
    id: crypto.randomUUID(),
    title: 'Consent fixture',
    version: 1,
    createdAt: now,
    updatedAt: now,
    config: local,
    plan: defaultPlan(),
    mode: 'plan',
    permissionMode: 'ask',
    projectId: crypto.randomUUID(),
    run: null,
    messages: [
      {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Reviewed the project.',
        createdAt: now,
        status: 'complete',
        error: null,
        usage: null,
        ...message,
      },
    ],
  };
}

describe('project cloud transmission consent', () => {
  it.each([
    'lsp_hover',
    'lsp_diagnostics',
    'lsp_definition',
    'host_read_file',
    'review_worktree',
    'merge_worktree',
  ])('protects existing %s results when switching a local Plan session to OpenRouter', (label) => {
    const value = session({
      activities: [
        {
          id: crypto.randomUUID(),
          kind: 'tool',
          label,
          status: 'completed',
          text: 'Fixture project source.',
        },
      ],
    });
    expect(() => validateCloudTransmission(value, [cloud])).toThrow(
      expect.objectContaining({ code: 'PROJECT_CLOUD_CONSENT' }),
    );
    expect(() => validateCloudTransmission(value, [local])).not.toThrow();
    expect(() =>
      validateCloudTransmission(value, [{ ...cloud, projectCloudConsent: true }]),
    ).not.toThrow();
  });

  it.each(['lsp_hover', 'review_worktree'])(
    'protects raw %s continuation when display activities and project selection are absent',
    (toolName) => {
      const value = session({
        continuation: [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'fixture-call', name: toolName, arguments: '{}' }],
          },
          {
            role: 'tool',
            toolName,
            toolCallId: 'fixture-call',
            content: 'const fixturePrivateSource = 123;',
          },
        ],
      });
      value.projectId = null;
      value.config = cloud;
      const request = compileContext(value, 'Continue from the existing research.').request;
      expect(JSON.stringify(request)).toContain('fixturePrivateSource');
      expect(() => validateCloudTransmission(value, [cloud])).toThrow(
        expect.objectContaining({ code: 'PROJECT_CLOUD_CONSENT' }),
      );
    },
  );

  it('requires consent from every cloud role after tool details were replaced by a summary', () => {
    const value = session();
    value.projectId = null;
    value.hasProjectHistory = true;
    value.contextCompaction = {
      throughMessageId: value.messages[0]!.id,
      summary: 'Summary derived from project source.',
      createdAt: now,
      reason: 'manual',
      method: 'semantic',
      compactedMessageCount: 1,
      originalEstimateTokens: 1200,
      compactedEstimateTokens: 200,
    };
    expect(() =>
      validateCloudTransmission(value, [
        local,
        { ...cloud, projectCloudConsent: true },
        { ...cloud, model: 'summary-role' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'PROJECT_CLOUD_CONSENT' }));
    expect(() =>
      validateCloudTransmission(value, [local, { ...cloud, projectCloudConsent: true }]),
    ).not.toThrow();
  });

  it('does not require project consent for ordinary chat without project material', () => {
    const value = session();
    value.projectId = null;
    expect(() => validateCloudTransmission(value, [cloud])).not.toThrow();
  });
});

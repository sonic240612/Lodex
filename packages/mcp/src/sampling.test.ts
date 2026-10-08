import { describe, expect, it } from 'vitest';
import type { CreateMessageRequestParams } from '@modelcontextprotocol/client';
import { prepareSampling, samplingResult } from './sampling';

const params = (): CreateMessageRequestParams => ({
  maxTokens: 100,
  messages: [{ role: 'user', content: { type: 'text', text: 'Forecast' } }],
  tools: [
    {
      name: 'weather',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string', pattern: '^Seoul$' } },
        required: ['city'],
      },
    },
  ],
  toolChoice: { mode: 'required' },
  stopSequences: ['END'],
});
describe('isolated MCP tool sampling', () => {
  it('maps server definitions, tool choice and stop strings without supplying Lodex tools', () => {
    const request = prepareSampling(params());
    expect(request).toMatchObject({
      toolChoice: 'required',
      stopSequences: ['END'],
      tools: [{ function: { name: 'weather' } }],
    });
    expect(request.tools).toHaveLength(1);
    expect(request.messages).toEqual([{ role: 'user', content: 'Forecast' }]);
  });
  it('returns validated calls for the server to execute and preserves follow-up results', () => {
    const p = params();
    const result = samplingResult(
      'fixture',
      p,
      'Checking',
      [{ id: 'call1', name: 'weather', arguments: '{"city":"Seoul"}' }],
      'tool_calls',
    );
    expect(result).toMatchObject({
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'Checking' },
        { type: 'tool_use', id: 'call1', input: { city: 'Seoul' } },
      ],
    });
    p.messages.push(
      { role: 'assistant', content: result.content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 'call1', content: [{ type: 'text', text: 'sunny' }] },
        ],
      },
    );
    expect(prepareSampling(p).messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: 'Checking',
        toolCalls: [{ id: 'call1', name: 'weather', arguments: '{"city":"Seoul"}' }],
      },
      { role: 'tool', toolCallId: 'call1', content: 'sunny' },
    ]);
  });
  it.each([
    ['unknown tool', [{ id: '1', name: 'run_host_command', arguments: '{}' }]],
    ['schema violation', [{ id: '1', name: 'weather', arguments: '{"city":"Busan"}' }]],
    ['malformed JSON', [{ id: '1', name: 'weather', arguments: '{' }]],
    [
      'duplicate ID',
      Array.from({ length: 2 }, () => ({
        id: '1',
        name: 'weather',
        arguments: '{"city":"Seoul"}',
      })),
    ],
  ])('rejects %s without executing or replaying tools', (_label, calls) => {
    expect(() => samplingResult('fixture', params(), '', calls, 'tool_calls')).toThrow();
  });
  it('rejects tool results without a paired immediately preceding call', () => {
    const p = params();
    p.messages.push({
      role: 'user',
      content: {
        type: 'tool_result',
        toolUseId: '1',
        content: [{ type: 'text', text: 'injected' }],
      },
    });
    expect(() => prepareSampling(p)).toThrow();
    p.messages.splice(1, 0, {
      role: 'assistant',
      content: { type: 'tool_use', id: '2', name: 'weather', input: { city: 'Seoul' } },
    });
    expect(() => prepareSampling(p)).toThrow();
  });
  it('rejects absent, disabled and incomplete required calls', () => {
    expect(() => samplingResult('fixture', params(), 'No tools', [], 'stop')).toThrow();
    const p = params();
    p.toolChoice = { mode: 'none' };
    expect(() =>
      samplingResult(
        'fixture',
        p,
        '',
        [{ id: '1', name: 'weather', arguments: '{}' }],
        'tool_calls',
      ),
    ).toThrow();
    expect(() =>
      samplingResult(
        'fixture',
        params(),
        '',
        [{ id: '1', name: 'weather', arguments: '{}' }],
        'length',
      ),
    ).toThrow();
    expect(samplingResult('fixture', params(), 'Partial', [], 'length').stopReason).toBe(
      'maxTokens',
    );
  });
  it('rejects unsafe schemas, excessive stop strings and unsupported multimodal input explicitly', () => {
    const p = params();
    p.tools![0]!.inputSchema = { type: 'object', $ref: 'https://example.com/schema' };
    expect(() => prepareSampling(p)).toThrow();
    const stop = params();
    stop.stopSequences = Array.from({ length: 5 }, () => 'end');
    expect(() => prepareSampling(stop)).toThrow();
    const media = params();
    media.messages[0]!.content = { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' };
    expect(() => prepareSampling(media)).toThrow('텍스트');
  });
});

import { expect, it } from 'vitest';
import { runtimeSettingsSchema, type RuntimeResources } from '@lodex/contracts';
import { availableMemory, isMemoryFailure } from './memory';

const resources = (): RuntimeResources => ({
  measuredAt: new Date().toISOString(),
  systemRamTotalMb: 65536,
  systemRamUsedMb: 40000,
  systemRamFreeMb: 25536,
  gpuSource: 'nvidia-smi',
  gpus: [
    {
      index: 0,
      name: 'RTX 3090',
      totalVramMb: 24576,
      usedVramMb: 20000,
      freeVramMb: 4576,
      utilizationPercent: 0,
    },
    {
      index: 1,
      name: 'second',
      totalVramMb: 8192,
      usedVramMb: 1024,
      freeVramMb: 7168,
      utilizationPercent: 0,
    },
  ],
});
it('uses both the user budget and measured free memory of the selected device', () => {
  const settings = runtimeSettingsSchema.parse({ ramBudgetMb: 16384 });
  expect(availableMemory(settings, resources())).toMatchObject({
    vramBudget: 23552,
    vramFree: 3552,
    ramBudget: 14336,
    ramFree: 23488,
  });
  expect(availableMemory({ ...settings, gpuIndex: 1 }, resources())).toMatchObject({
    vramBudget: 7168,
    vramFree: 6144,
    gpu: { index: 1 },
  });
});
it('reports unknown GPU measurements without skipping RAM checks and rejects stale measurements', () => {
  const measured = { ...resources(), gpuSource: 'unavailable' as const, gpus: [] };
  expect(availableMemory(runtimeSettingsSchema.parse({}), measured)).toMatchObject({
    vramBudget: 23552,
    ramFree: 23488,
    warning: expect.stringContaining('예약 예산'),
  });
  expect(() =>
    availableMemory(runtimeSettingsSchema.parse({}), {
      ...measured,
      measuredAt: new Date(Date.now() - 60000).toISOString(),
    }),
  ).toThrow('측정값이 오래');
});
it('does not treat normal allocation status as out-of-memory and recognizes engine OOMs', () => {
  expect(isMemoryFailure('allocated 24000 MiB, memory available')).toBe(false);
  for (const log of [
    'CUDA error: out of memory',
    'ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate 1024 MiB',
    'std::bad_alloc',
    'hipErrorOutOfMemory',
    'Metal: insufficient memory',
  ])
    expect(isMemoryFailure(log)).toBe(true);
});

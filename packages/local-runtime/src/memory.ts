import { AppError, type RuntimeResources, type RuntimeSettings } from '@lodex/contracts';

export function availableMemory(
  settings: RuntimeSettings,
  resources: RuntimeResources,
  now = Date.now(),
  gpuRequired = true,
) {
  const age = now - Date.parse(resources.measuredAt);
  if (!Number.isFinite(age) || age < -5000 || age > 5000 || resources.systemRamTotalMb <= 0)
    throw new AppError(
      'RESOURCE_STALE',
      '메모리 측정값이 오래되어 모델을 로드하지 않았습니다. 잠시 후 다시 시도하세요.',
      409,
    );
  const gpu = resources.gpus.find((gpu) => gpu.index === settings.gpuIndex);
  if (gpuRequired && resources.gpuSource === 'nvidia-smi' && !gpu)
    throw new AppError(
      'GPU_NOT_FOUND',
      '선택한 GPU를 찾을 수 없습니다. 메모리 설정에서 GPU 번호를 확인하세요.',
      409,
    );
  return {
    vramBudget: Math.max(
      0,
      Math.min(settings.vramBudgetMb, gpu?.totalVramMb ?? Infinity) - settings.headroomMb,
    ),
    vramFree: gpu ? Math.max(0, gpu.freeVramMb - settings.headroomMb) : Infinity,
    ramBudget: Math.max(
      0,
      Math.min(settings.ramBudgetMb || resources.systemRamTotalMb, resources.systemRamTotalMb) -
        settings.ramHeadroomMb,
    ),
    ramFree: Math.max(0, resources.systemRamFreeMb - settings.ramHeadroomMb),
    gpu,
    warning: gpu
      ? undefined
      : 'GPU 사용량을 측정하지 못해 VRAM은 설정한 예약 예산만 검사합니다. RAM은 실제 여유 공간을 검사합니다.',
  };
}

export function isMemoryFailure(log: string) {
  return /(?:CUDA (?:error|out of memory)[^\n]*out of memory|CUDA out of memory|hipErrorOutOfMemory|std::bad_alloc|ggml[^\n]*(?:failed to allocate|out of memory)|(?:Metal|Vulkan)[^\n]*(?:out of memory|insufficient memory)|failed to allocate[^\n]*(?:buffer|memory))/i.test(
    log,
  );
}

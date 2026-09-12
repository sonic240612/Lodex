import { parentPort, workerData } from 'node:worker_threads';
import { AppError } from '@lodex/contracts';
import { StorageEngine } from './engine';
const port = parentPort;
if (!port) throw new Error('Storage must run in a worker.');
const engine = new StorageEngine((workerData as { path: string }).path);
engine.recover();
port.postMessage({ ready: true });
port.on('message', (request: { id: number; method: keyof StorageEngine; args: unknown[] }) => {
  try {
    const method = engine[request.method] as (...args: unknown[]) => unknown;
    if (
      typeof method !== 'function' ||
      ![
        'snapshot',
        'session',
        'events',
        'receipt',
        'apply',
        'updateRun',
        'close',
        'project',
        'registerProject',
        'deleteSessions',
        'beginEdit',
        'finishEdit',
        'recordCreatedFile',
        'recordExecution',
        'localProfiles',
        'saveLocalProfile',
        'removeLocalProfile',
        'runtimeSettings',
        'saveRuntimeSettings',
      ].includes(request.method)
    )
      throw new AppError('BAD_STORAGE_METHOD', 'Unknown storage operation.');
    const result = method.apply(engine, request.args);
    port.postMessage({ id: request.id, result });
    if (request.method === 'close') port.close();
  } catch (error) {
    port.postMessage({
      id: request.id,
      error:
        error instanceof AppError
          ? { code: error.code, message: error.message, status: error.status }
          : { code: 'STORAGE_ERROR', message: '데이터 저장에 실패했습니다.', status: 500 },
    });
  }
});

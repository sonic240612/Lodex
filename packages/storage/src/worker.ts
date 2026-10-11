import { parentPort, workerData } from 'node:worker_threads';
import { AppError } from '@lodex/contracts';
import { StorageEngine } from './engine';
const port = parentPort;
if (!port) throw new Error('Storage must run in a worker.');
const engine = new StorageEngine((workerData as { path: string }).path);
engine.recover();
port.postMessage({ ready: true });
let maintenanceTimer: NodeJS.Timeout | undefined;
const compactLegacyHistory = () => {
  try {
    if (engine.compactLegacyHistoryBatch()) maintenanceTimer = setTimeout(compactLegacyHistory, 50);
  } catch {
    maintenanceTimer = setTimeout(compactLegacyHistory, 5000);
  }
};
maintenanceTimer = setTimeout(compactLegacyHistory, 250);
port.on('message', (request: { id: number; method: keyof StorageEngine; args: unknown[] }) => {
  try {
    const method = engine[request.method] as (...args: unknown[]) => unknown;
    if (
      typeof method !== 'function' ||
      ![
        'snapshot',
        'compactLegacyHistoryBatch',
        'backupImportCatalog',
        'importBackup',
        'integration',
        'saveIntegration',
        'session',
        'events',
        'receipt',
        'apply',
        'updateRun',
        'includeRunInputs',
        'close',
        'project',
        'registerProject',
        'deleteSessions',
        'beginEdit',
        'finishEdit',
        'recordCreatedFile',
        'recordExecution',
        'recordWorkspaceChange',
        'invalidateWorkspace',
        'recordModelCall',
        'beginManualCompaction',
        'decideApproval',
        'decideElicitation',
        'recordSkillRead',
        'registeredMcp',
        'saveRegisteredMcp',
        'removeRegisteredMcp',
        'recordMcpCall',
        'localProfiles',
        'registeredSkills',
        'saveRegisteredSkill',
        'removeRegisteredSkill',
        'saveLocalProfile',
        'removeLocalProfile',
        'runtimeSettings',
        'saveRuntimeSettings',
      ].includes(request.method)
    )
      throw new AppError('BAD_STORAGE_METHOD', 'Unknown storage operation.');
    const result = method.apply(engine, request.args);
    port.postMessage({ id: request.id, result });
    if (request.method === 'close') {
      if (maintenanceTimer) clearTimeout(maintenanceTimer);
      port.close();
    }
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

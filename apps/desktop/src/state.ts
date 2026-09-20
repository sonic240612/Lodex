import { create } from 'zustand';
import {
  defaultModelConfig,
  type DomainEvent,
  type ModelConfig,
  type Session,
  type Snapshot,
  type Project,
} from '@lodex/contracts';
import { nativeDesktop } from './bridge';
import { loadLastModelConfig, saveLastModelConfig } from './model-preference';
interface WorkspaceState {
  sessions: Session[];
  deletedSessionIds: string[];
  removeSessions: (ids: string[]) => void;
  projects: Project[];
  selectedProjectId: string | null;
  selectedId: string | null;
  config: ModelConfig;
  connected: boolean;
  openrouterConfigured: boolean;
  openrouterKeySource?: Snapshot['openrouterKeySource'];
  envFilePath?: string;
  lastSeq: number;
  replace: (snapshot: Snapshot) => void;
  event: (event: DomainEvent) => void;
  upsert: (session: Session) => void;
  upsertProject: (project: Project) => void;
  selectProject: (id: string | null) => void;
  select: (id: string | null) => void;
  setConfig: (config: ModelConfig) => void;
  setConnected: (connected: boolean) => void;
  setKeyConfigured: (value: boolean) => void;
}
const initialConfig = nativeDesktop
  ? (loadLastModelConfig() ?? defaultModelConfig())
  : { ...defaultModelConfig(), provider: 'demo' as const, model: 'demo' };

export const useWorkspace = create<WorkspaceState>((set) => ({
  sessions: [],
  deletedSessionIds: [],
  removeSessions: (ids) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => !ids.includes(s.id)),
      deletedSessionIds: [...new Set([...state.deletedSessionIds, ...ids])],
      selectedId: state.selectedId && ids.includes(state.selectedId) ? null : state.selectedId,
    })),
  projects: [],
  selectedProjectId: null,
  selectedId: null,
  config: initialConfig,
  connected: false,
  openrouterConfigured: false,
  lastSeq: 0,
  replace: (snapshot) =>
    set((state) => ({
      ...snapshot,
      deletedSessionIds: [
        ...new Set([...state.deletedSessionIds, ...(snapshot.deletedSessionIds ?? [])]),
      ],
      sessions: snapshot.sessions.filter((s) => !state.deletedSessionIds.includes(s.id)),
      connected: true,
      selectedId:
        state.selectedId &&
        !state.deletedSessionIds.includes(state.selectedId) &&
        snapshot.sessions.some((s) => s.id === state.selectedId)
          ? state.selectedId
          : null,
    })),
  event: (event) =>
    set((state) =>
      event.seq <= state.lastSeq
        ? {}
        : event.type === 'sessions_deleted'
          ? {
              lastSeq: event.seq,
              deletedSessionIds: [...new Set([...state.deletedSessionIds, ...event.sessionIds])],
              sessions: state.sessions.filter((s) => !event.sessionIds.includes(s.id)),
              selectedId:
                state.selectedId && event.sessionIds.includes(state.selectedId)
                  ? null
                  : state.selectedId,
            }
          : event.type === 'projects_changed'
            ? { lastSeq: event.seq, projects: event.projects }
            : {
                lastSeq: event.seq,
                sessions: state.sessions.some(
                  (s) => s.id === event.sessionId && s.version > event.session.version,
                )
                  ? state.sessions
                  : [
                      ...(state.deletedSessionIds.includes(event.sessionId) ? [] : [event.session]),
                      ...state.sessions.filter((s) => s.id !== event.sessionId),
                    ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
              },
    ),
  upsert: (session) =>
    set((state) => {
      const old = state.sessions.find((s) => s.id === session.id);
      return state.deletedSessionIds.includes(session.id) || (old && old.version > session.version)
        ? {}
        : { sessions: [session, ...state.sessions.filter((s) => s.id !== session.id)] };
    }),
  upsertProject: (project) =>
    set((state) => ({ projects: [...state.projects.filter((p) => p.id !== project.id), project] })),
  selectProject: (selectedProjectId) => set({ selectedProjectId, selectedId: null }),
  select: (selectedId) =>
    set((state) => {
      const allowedId =
        selectedId && !state.deletedSessionIds.includes(selectedId) ? selectedId : null;
      const selected = allowedId
        ? state.sessions.find((session) => session.id === allowedId)
        : null;
      if (selected && nativeDesktop) saveLastModelConfig(selected.config);
      return {
        selectedId: allowedId,
        ...(selected
          ? { selectedProjectId: selected.projectId ?? null, config: selected.config }
          : {}),
      };
    }),
  setConfig: (config) => {
    if (nativeDesktop) saveLastModelConfig(config);
    set({ config });
  },
  setConnected: (connected) => set({ connected }),
  setKeyConfigured: (openrouterConfigured) =>
    set({
      openrouterConfigured,
      openrouterKeySource: openrouterConfigured ? 'os_keychain' : 'none',
    }),
}));

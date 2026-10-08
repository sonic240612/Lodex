import type { Session } from './index';

const projectTools = new Set([
  'inspect_path',
  'list_files',
  'find_files',
  'read_file',
  'read_many_files',
  'search_text',
  'propose_edit',
  'propose_changes',
  'make_directory',
  'move_path',
  'copy_path',
  'delete_path',
  'run_command',
  'run_host_command',
  'delegate_tasks',
  'review_worktree',
  'merge_worktree',
  'review_work',
  'read_command_job',
  'write_command_input',
  'stop_command_job',
  'resize_command_terminal',
]);
const projectTool = (name: string) =>
  projectTools.has(name) || name.startsWith('lsp_') || name.startsWith('host_');

/** Provenance survives model changes, compaction and removal of tool selections. */
export function hasProjectMaterial(session: Session): boolean {
  return !!(
    session.hasProjectHistory ||
    session.run?.context?.projectInstructions?.length ||
    session.messages.some(
      (message) =>
        message.activities?.some(
          (activity) =>
            activity.subagents?.length ||
            activity.execution ||
            activity.edit ||
            activity.changes ||
            projectTool(activity.label),
        ) ||
        message.continuation?.some(
          (entry) =>
            (entry.toolName && projectTool(entry.toolName)) ||
            entry.toolCalls?.some((call) => projectTool(call.name)),
        ),
    )
  );
}

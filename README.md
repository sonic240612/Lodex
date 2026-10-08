# Lodex

[English](README.md) · [한국어](README.ko.md)

A desktop workspace for local LLMs and OpenRouter.

## Run

Requires Node 24.11.1, npm 11.19.1, Rust 1.98.0, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/sonic240612/Lodex.git
cd Lodex
npm ci
npm run dev
```

On Windows, double-click `run-lodex.bat` to launch the development app.

## Models

- **Managed llama.cpp:** engine installation, resumable and split GGUF downloads, model profiles, context and generation settings, GPU layers, KV cache, threads, and memory reservations.
- **External servers:** llama-server, Ollama, vLLM, and MLX. External servers remain under your control.
- **OpenRouter:** model catalog and context defaults, account usage, request costs, budgets, retries, and cost reconciliation.
- **Model routing:** separate models for planning, building, subagents, summaries, and review; per-task model and cost settings. Models can change within a conversation.

Copy [`.env.example`](.env.example) to `.env` for API keys, or save them through desktop settings using the OS keychain. Credentials, databases, downloaded models, and local runtime files are ignored by Git.

## Work

- Local projects, scoped `AGENTS.md` / `CLAUDE.md` instructions, file search, edits, change review, and undo.
- `/plan` for one read-only planning turn, editable to-do lists, and `/goal` for continuous execution with completion checks.
- Isolated subagents with Git worktrees; paged reviews, text conflict resolution, binary file choices, merge undo, and recoverable archives.
- Docker and host commands, interactive PTY terminals, stdin/EOF, background jobs, cancellation, and additional instructions during a run.
- Web search and page reading; optional isolated Chrome/Edge automation in Full Access; registered language servers for diagnostics, definitions, references, hover, and symbols.
- Interval, daily, and project-file-change schedules using the conversation's permissions and model. OpenRouter usage is billed normally.
- Telegram pairing, remote chat, live approvals, task controls, and durable answer delivery.

Messages use Build by default. Type `/` to browse commands with the mouse or arrow keys and Tab. Common commands: `/plan`, `/goal`, `/resume`, `/stop`, `/compact`, `/quick`, `/skill`, `/new`, `/settings`.

## Permissions

| Mode           | Behavior                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Ask            | Read project files; ask before changes, commands, and external actions                             |
| Approve for me | Automatically approve ordinary project edits and limited safe operations; ask about risky actions  |
| Full Access    | Allow host files, commands, network, secrets, and selected MCP operations after a one-time warning |

Permissions persist per conversation. Plan remains read-only. File identity checks, cancellation, and execution records apply in every mode.

## Context and integrations

Eco uses small LLM summaries during work. Larger automatic compaction starts near 80% and targets about 25%, subject to retained instructions and model limits. Choose **Context compaction** for an LLM summary or **Quick compaction** for local extraction. A summary model can be assigned separately. Failed summaries preserve the original context; cloud summaries count toward cost.

Full transcripts stay in SQLite. ObservationPack archives large tool results for exact recall; Action Fusion combines file changes with a follow-up check. Both adapt [NVIDIA SoL-Pi](https://github.com/NVlabs/SoL-Pi); see [third-party notices](THIRD_PARTY_NOTICES.md). Measured savings depend on the model and task.

Import local Skills and MCP settings from Codex, Claude Code, pi, OpenCode, OpenClaw, and Hermes formats. Skills support direct invocation, argument substitution, and tool restrictions. Importing a skill does not execute scripts or hooks.

MCP supports stdio, Streamable HTTP, legacy SSE, selected tools, text resources and prompts, JSON Schema validation, OAuth PKCE with optional dynamic registration, Sampling, and Elicitation. Sampling tools are returned to the requesting server, never executed as Lodex tools. Resource subscriptions report changes; refreshing attached content still requires review. Image/audio/binary model input and arbitrary external agent runtimes are not supported.

## Desktop and data

Korean and English interface, light/dark themes, Liquid Glass or classic design, expandable activity, Markdown, context usage, and generation metrics. Integrations live in Settings.

Closing the window keeps Lodex in the tray. Login startup is optional. Use **Quit Lodex** to stop the daemon and background work.

Create, export, preview, and restore secret-free backups. Restore adds missing records and leaves existing ones intact; imported integrations require re-enabling or review. Model files, credentials, ObservationPack raw archives, and worktree folders are not included.

## Development

```sh
npm run check          # Type checks, tests, production build
npm run dev:web        # UI preview with temporary demo data
npm run build:desktop  # Native desktop build
npm run evaluate -- --help
```

The evaluation runner compares baseline/Eco on isolated synthetic projects, with optional timed soak runs. Reports stay in ignored `.local/evaluations`. Cloud evaluation requires explicit opt-in and a cost ceiling.

CI covers Windows x64, macOS ARM/Intel, and Linux x64. The manual **Desktop packages** workflow builds installers and optional signed updater artifacts. Signing requires release credentials; unsigned development builds have updates disabled. Update installation verifies the signature and requires an idle workspace and a backup.

Early development: clean-machine installation, accessibility, and GPU/model benchmarks need separate validation. Memory budgets are reservations, not hardware-enforced limits. No blanket compatibility or performance claim for every model.

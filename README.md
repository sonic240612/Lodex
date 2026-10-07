# Lodex

[English](README.md) · [한국어](README.ko.md)

Desktop agent harness for local LLMs and OpenRouter.

> Early development. Windows x64 is tested locally. Windows, macOS, and Linux builds run in CI.

## Features

- Connect to an external llama-server through localhost, a private LAN, or Tailscale.
- Download public Hugging Face GGUF files with restart-persistent history, verify their hash and metadata, and apply VRAM-aware context, GPU, KV cache, thread, and reservation recommendations.
- Use OpenRouter models with catalog defaults, automatic context/output limits, reported cost, and transient request retries.
- Route Plan, Build, and subagent work to different models. Up to three isolated read-only subagents can run concurrently.
- Switch models and generation settings in the same conversation between requests, keeping history and the saved plan.
- Open local project folders, create Git worktrees, and keep conversations scoped to a project.
- Read one or many project files, find them with recursive globs, and search text with optional case folding; create, move, or delete reviewed paths; apply single or multi-file edits with optional Docker validation; and undo verified text edits.
- Run Docker commands with saved limits. Full Access enables host files, shell commands, environment variables, network access, and selected MCP calls.
- Read known public web URLs with `web_fetch`, including HTML, text, and JSON, with per-URL approval and bounded output.
- Choose **Ask**, **Approve for me**, or **Full Access** per conversation. Plan mode remains read-only.
- Use `/goal` for goal-driven runs, or run saved plan tasks with dependencies, completion criteria, verification commands, and budgets.
- Choose **Simple** in the goal panel to run from a goal alone, or **Advanced** to edit and execute a detailed plan.
- Discover documented user and project skill folders, then import local `SKILL.md` packages using Agent Skills, Codex, Claude Code, pi, OpenCode, OpenClaw, or Hermes metadata, including Hermes operating-system restrictions.
- Connect stdio, Streamable HTTP, and legacy SSE MCP servers; select tools, preview resources and prompts, attach reviewed content, handle Sampling and Elicitation, and sign in with OAuth PKCE.
- Pair a Telegram bot for remote messages, status, plan inspection, cancellation, and approved Build access.
- Keep the daemon, Telegram, and active agent runs alive when the window is closed; reopen or quit Lodex from the system tray.
- Use Eco mode, automatic fast compaction, bounded current-conversation history search, local ObservationPack archives, and on-demand recall for large tool results.
- Choose LLM-based **Context compaction** or deterministic **Quick compaction**. Full transcripts stay in SQLite.
- View Markdown/GFM messages, collapsible thinking and tool activity, active context usage, generation metrics, and a jump-to-latest button.
- Create daily or manual secret-free JSON backups, apply count/age retention, and export them through the native save dialog.

## Quick start

Requires Node 24.11.1, npm 11.19.1, Rust 1.98.0, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/sonic240612/Lodex.git
cd Lodex
npm ci
npm run dev
```

On Windows, double-click `run-lodex.bat`. It installs missing npm packages and starts the development app.

## Models

### Managed local model

Open the model manager to download a public Hugging Face GGUF file or select one already on disk. Lodex reads model architecture, layer and attention dimensions, native context, tokenizer, and embedded default and `tool_use` chat-template metadata. It can fill settings from that metadata and the configured VRAM budget before registration. Download history survives app restarts. VRAM values are scheduler reservations, not hard GPU memory limits.

### External llama-server

Start an OpenAI-compatible llama-server and enter its API URL. The default is `http://127.0.0.1:8080/v1`. Private IPv4, localhost, and approved Tailscale addresses are supported.

When llama.cpp exposes `/props`, Lodex reads the active Chat template's tool-calling, system-role, content, parallel-call, and reasoning-history capabilities. Requests are adapted to those capabilities; an incompatible tool template is rejected before generation with a configuration hint. Older compatible servers remain usable with unknown capability labels.

### OpenRouter

Copy [`.env.example`](.env.example) to `.env`, add the key, and restart Lodex:

```dotenv
OPENROUTER_API_KEY=your-key
```

The desktop app can also store the key in the operating system keychain. `.env`, `.env.mcp`, databases, local runtime files, and credentials are ignored by Git. OpenRouter transmission requires the relevant conversation consent.

## Agent controls

| Control        | Behavior                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Plan           | Read-only inspection and planning                                                                          |
| Build          | Project tools and actions allowed by the selected permission mode                                          |
| Ask            | Reads run directly; writes, commands, and external actions wait for approval                               |
| Approve for me | Normal project edits and limited safe actions are approved by fixed policy rules                           |
| Full Access    | Host paths, shell, network, secrets, and selected MCP actions run without another prompt after the warning |

Full Access is stored per conversation. File hashes, path checks, symlink checks, cancellation, process cleanup, and audit records still apply.

`/goal <goal>` continues until completion, a blocker, or a budget limit. Completion checks successful current-run commands or exact artifact hashes; evidence alone requires user confirmation. Saved plans can use verification commands, file content/hash checks, or user confirmation. Later changes invalidate earlier checks. Manual task checkboxes remain separate.

OpenRouter requests retain their IDs and cost reservations across interruption. Missing cost is checked through [generation metadata](https://openrouter.ai/docs/api/api-reference/generations/get-generation). Use **OpenRouter cost reconciliation** or Telegram `/costs` to query unresolved requests before `/resume`; this never regenerates a response. Requests without an ID retain their reservation.

## Context

- **Context compaction** calls the active model to create a structured handoff with goals, constraints, progress, decisions, files, verification, failures, and next steps.
- **Quick compaction** uses the local deterministic extractor without another model call.
- The latest four complete messages normally remain verbatim. Original messages are not deleted.
- Eco mode compacts earlier and asks the model for shorter answers.
- In Eco mode, ObservationPack archives successful text results larger than 10 KiB. The first two model requests receive the full result; later requests use a stable handle with a 1 KiB head/tail excerpt and exact paged recall. Original session history stays intact. Archive failures keep the original result, and recall verifies its hash.
- The agent can search persisted text from the current conversation when compaction omits an older detail; search results are bounded and never cross conversation boundaries.
- Running tool loops also compact completed exchanges when the input budget is exceeded. The current request and instructions stay intact; saved tool results can be listed and read in exact UTF-8 pages without running the tool again.
- With current llama.cpp servers, the context meter uses the model's applied chat template and tokenizer. Older or remote providers show the conservative estimate or provider-reported usage.

## Projects and execution

Connect a local folder to create a project conversation. File tools stay inside the selected project except in Full Access. Missing project-root `.env` files can be created without exposing existing secret files in lower permission modes.

Path moves and deletions require a fresh content fingerprint. **Approve for me** handles ordinary folder creation and moves, while deletion still waits for review. Path operations never overwrite a destination, and deleted paths do not have automatic undo.

Worktree creation starts from the current commit. Uncommitted changes remain in the original folder; merge and cleanup are manual.

Docker execution is opt-in and uses the configured image, CPU, memory, network, and project access settings. **Action Fusion** accepts `thenRun` or SoL-Pi's `then_run` on a file change, so approval, mutation, and a known follow-up command run in one tool call. It uses Docker when enabled, or the host shell in Full Access. Host writes support the same operation. Conflicts skip the command; failed checks keep the edits. Interactive PTY support is pending.

Action Fusion and ObservationPack adapt [NVIDIA SoL-Pi](https://github.com/NVlabs/SoL-Pi). See [third-party notices](THIRD_PARTY_NOTICES.md). Lodex's permission and execution limits still apply; benchmark savings have not been measured.

`web_fetch` works in Plan and Build. Ask and Approve for me review each URL and redirect; Full Access runs directly. It uses public HTTP(S) default ports without cookies, credentials, or JavaScript. Output is capped at 24 KiB, or 8 KiB in Eco mode. Search and interactive browsing use separately configured MCP tools.

## Skills and MCP

Skill imports read metadata first and load instructions or referenced text only when the model requests them. Importing a skill does not execute hooks, scripts, or dependency installers.

MCP configuration imports Codex TOML, Claude/pi-style `mcpServers` JSON, OpenCode JSONC (`mcp` and `mcp.servers`), and Hermes `mcp_servers` YAML, including legacy `type: "sse"` endpoints. Lodex supports selected tools, static and parameterized text resources, prompts, argument completion, catalog revision checks, secret references, and OAuth for pre-registered public clients. During an agent run, a server that requests roots receives only the selected project folder. Text-only MCP Sampling runs through the selected model with shared model, token, and cost budgets; it receives no Lodex conversation or project context and requires approval unless the conversation uses Full Access. MCP Elicitation shows forms or HTTPS links above the composer while a tool call is running and does not store submitted values in activity history. Forms requesting passwords, tokens, or credentials are blocked. Keep MCP secrets in `.env` with `LODEX_MCP_` names. OAuth tokens are stored in the ignored `.env.mcp` file.

## Telegram

Create a bot with [BotFather](https://core.telegram.org/bots/tutorial#obtain-your-bot-token), enter the token in Telegram settings or set `TELEGRAM_BOT_TOKEN` in `.env`, select a conversation, enable transmission, and approve the pairing IDs.

Commands include `/ask`, `/goal`, `/resume`, `/run`, `/status`, `/plan`, `/todo`, `/autopilot ask|auto|full`, `/approve`, `/deny`, `/answer`, `/decline`, `/cancel-input`, and `/stop`. `/todo` can set the saved goal, add tasks with completion criteria, mark them done, undo them, or remove them by number. Remote Build actions and permission changes require Build access in Telegram settings. Unknown delivery outcomes are recorded and never retried automatically.

Closing the desktop window keeps Lodex running in the system tray. Use **Quit Lodex** from the tray menu to stop the daemon and Telegram connection.

## Data

Data settings can create or export backups containing conversations, projects, plans, model profiles, Skills, and MCP registrations. API keys, OAuth tokens, Telegram bot tokens, and model files are excluded.

## Packages

| Package                                 | Description                                             |
| --------------------------------------- | ------------------------------------------------------- |
| [desktop](apps/desktop)                 | Tauri shell and React interface                         |
| [daemon](apps/daemon)                   | Local API, agent loop, permissions, integrations        |
| [providers](packages/providers)         | llama-server and OpenRouter adapters                    |
| [local-runtime](packages/local-runtime) | Model profiles, processes, and VRAM scheduling          |
| [tools](packages/tools)                 | Project files, changes, undo, Docker and host execution |
| [context](packages/context)             | Request assembly, compaction, and context budgets       |
| [storage](packages/storage)             | SQLite persistence, events, receipts, and recovery      |
| [contracts](packages/contracts)         | Shared protocol types and validation                    |
| [skills](packages/skills)               | Skill metadata, lazy reads, and provenance              |
| [mcp](packages/mcp)                     | MCP transports, tools, content, secrets, and OAuth      |

## Development

```sh
npm run check          # Type checks, tests, and production web build
npm run dev:web        # Browser preview with temporary demo data
npm run build:desktop  # Native desktop build
```

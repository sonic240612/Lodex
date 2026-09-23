# Lodex

[English](README.md) · [한국어](README.ko.md)

Desktop agent harness for local LLMs and OpenRouter.

> Early development. Windows x64 is tested locally. Windows, macOS, and Linux builds run in CI.

## Features

- Connect to an external llama-server through localhost, a private LAN, or Tailscale.
- Run managed GGUF profiles with configurable context size, GPU layers, KV cache, threads, chat template, engine arguments, and VRAM reservations.
- Use OpenRouter models with catalog defaults, automatic context/output limits, reported cost, and transient request retries.
- Route Plan, Build, and subagent work to different models. Up to three isolated read-only subagents can run concurrently.
- Open local project folders, create Git worktrees, and keep conversations scoped to a project.
- Read and search project files, review single or multi-file changes, apply them with an optional Docker validation command, and undo verified edits.
- Run Docker commands with saved limits. Full Access enables host files, shell commands, environment variables, network access, and selected MCP calls.
- Choose **Ask**, **Approve for me**, or **Full Access** per conversation. Plan mode remains read-only.
- Use `/goal` for goal-driven runs, or run saved plan tasks with dependencies, completion criteria, verification commands, and budgets.
- Import local `SKILL.md` folders using standard, Codex, Claude, or pi metadata.
- Connect stdio and Streamable HTTP MCP servers, select tools, preview resources and prompts, attach reviewed content, and sign in with OAuth PKCE.
- Pair a Telegram bot for remote messages, status, plan inspection, cancellation, and approved Build access.
- Use Eco mode, automatic fast compaction, local ObservationPack archives, and on-demand recall for large tool results.
- Choose LLM-based **Context compaction** or deterministic **Quick compaction**. Full transcripts stay in SQLite.
- View Markdown/GFM messages, collapsible thinking and tool activity, active context usage, generation metrics, and a jump-to-latest button.

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

Open the model manager, select a llama-server binary and GGUF file, configure the engine, and save the profile. Lodex starts the server on a private loopback port and releases model leases between calls. VRAM values are scheduler reservations, not hard GPU memory limits.

### External llama-server

Start an OpenAI-compatible llama-server and enter its API URL. The default is `http://127.0.0.1:8080/v1`. Private IPv4, localhost, and approved Tailscale addresses are supported.

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

`/goal <goal>` starts an independent goal run and continues until the model records completion or reaches a blocker or budget. Saved plan execution uses task dependencies and verification evidence. Manual task checkboxes remain separate from verification records.

## Context

- **Context compaction** calls the active model to create a structured handoff with goals, constraints, progress, decisions, files, verification, failures, and next steps.
- **Quick compaction** uses the local deterministic extractor without another model call.
- The latest four complete messages normally remain verbatim. Original messages are not deleted.
- Eco mode compacts earlier and asks the model for shorter answers.
- In Eco mode, ObservationPack stores large tool results locally after two full sends and exposes exact paged recall when needed.
- The context meter shows the latest active input estimate rather than cumulative billing tokens.

## Projects and execution

Connect a local folder to create a project conversation. File tools stay inside the selected project except in Full Access. Missing project-root `.env` files can be created without exposing existing secret files in lower permission modes.

Worktree creation starts from the current commit. Uncommitted changes remain in the original folder; merge and cleanup are manual.

Docker execution is opt-in and uses the configured image, CPU, memory, network, and project access settings. A change proposal can include one validation command so approval, file application, and validation run as one recorded operation. Interactive PTY support is pending.

## Skills and MCP

Skill imports read metadata first and load instructions or referenced text only when the model requests them. Importing a skill does not execute hooks, scripts, or dependency installers.

MCP configuration accepts common `mcpServers` JSON. Lodex supports selected tools, static and parameterized text resources, prompts, catalog revision checks, secret references, and OAuth for pre-registered public clients. Keep MCP secrets in `.env` with `LODEX_MCP_` names. OAuth tokens are stored in the ignored `.env.mcp` file.

## Telegram

Create a bot with [BotFather](https://core.telegram.org/bots/tutorial#obtain-your-bot-token), enter the token in Telegram settings or set `TELEGRAM_BOT_TOKEN` in `.env`, select a conversation, enable transmission, and approve the pairing IDs.

Commands: `/ask`, `/status`, `/plan`, `/approve`, `/deny`, `/stop`. Remote approvals require Build access in Telegram settings. Lodex must remain running. Unknown delivery outcomes are recorded and never retried automatically.

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

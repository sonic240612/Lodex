# Lodex

[English](README.md) · [한국어](README.ko.md)

A desktop agent harness for local LLMs and OpenRouter.

- Connect to llama-server over localhost, LAN, or Tailscale.
- Load GGUF models with your llama-server binary; adjust engine settings and VRAM reservations.
- Read project files, review changes, apply them, and undo them.
- Switch between Plan and Build, review AI plans, and edit task criteria and dependencies.
- Run commands in an opt-in Docker container, with collapsible output and cancellation.
- Run local Autopilot with task dependencies, saved verification commands, and explicit budgets.
- Select local SKILL.md folders per conversation and load instructions only when needed.
- Adjust generation settings and see token usage, generation speed, and prefill speed.

Early development. Windows x64 tested; macOS and Linux builds checked in CI.

## Quick start

Requires Node 24.11.1, npm 11.19.1, Rust 1.98.0, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/sonic240612/Lodex.git
cd Lodex
npm ci
npm run dev
```

## Models

- **Local models:** Open the local model manager, select a llama-server binary and GGUF file, then create a conversation from the saved profile. Context, GPU layers, KV cache, threads, templates, and extra engine arguments are configurable.
- **External llama-server:** Start your server and enter its API URL in settings. Default: `http://127.0.0.1:8080/v1`.
- **OpenRouter:** Copy [`.env.example`](.env.example) to `.env`, set `OPENROUTER_API_KEY`, and restart the app. You can also save a key through the app's OS keychain integration.

`.env` stays out of Git. Managed engines use a private loopback connection. VRAM scheduling uses declared reservations; it does not impose a GPU memory limit.

## Commands

Open a project conversation and expand **Command execution** in the plan panel. Select a local Linux Docker image with `/bin/sh`, check the engine and image, then enable project access. Commands run in Build mode. Network access is off by default; images are never downloaded automatically. Container integration is experimental; host shell and interactive PTY support are pending.

For **Autopilot**, save task criteria and verification commands, enable the plan in model context, and choose the scope and budgets. Passing checks and manual checkboxes have separate records. File proposals pause for review; interrupted runs never restart automatically. Currently local models only.

## Skills

Import a folder containing `SKILL.md`, review its compatibility notes, and select it for the conversation. Standard, Codex, Claude, and pi metadata are supported within the displayed limits. Imports do not run scripts, hooks, or install dependencies. OpenRouter access requires separate consent for skill content.

## Packages

| Package                                 | Description                                         |
| --------------------------------------- | --------------------------------------------------- |
| [desktop](apps/desktop)                 | Tauri app and React interface                       |
| [daemon](apps/daemon)                   | Local API and agent loop                            |
| [providers](packages/providers)         | llama-server and OpenRouter adapters                |
| [local-runtime](packages/local-runtime) | Model profiles, engine processes, VRAM reservations |
| [tools](packages/tools)                 | Project file tools and reviewed changes             |
| [context](packages/context)             | Request assembly and context budgets                |
| [storage](packages/storage)             | SQLite persistence and recovery                     |
| [contracts](packages/contracts)         | Shared types and validation                         |
| [skills](packages/skills)               | Local skill metadata, lazy reads, and provenance    |

## Development

```sh
npm run check    # Type checks, tests, and build
npm run dev:web  # Browser UI preview with demo data
```

# Lodex

[English](README.md) · [한국어](README.ko.md)

A desktop agent harness for local LLMs and OpenRouter.

- Connect to llama-server over localhost, LAN, or Tailscale.
- Read project files, review changes, apply them, and undo them.
- Edit goals and tasks alongside chat, with collapsible thinking and tool logs.
- Adjust generation settings and see token usage, generation speed, and prefill speed.

Early development. Windows x64 tested; macOS and Linux support is in progress.

## Quick start

Requires Node 24.11.1, npm 11.19.1, Rust 1.98.0, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
git clone https://github.com/sonic240612/Lodex.git
cd Lodex
npm ci
npm run dev
```

## Models

- **llama-server:** Start your server and enter its API URL in settings. Default: `http://127.0.0.1:8080/v1`.
- **OpenRouter:** Copy [`.env.example`](.env.example) to `.env`, set `OPENROUTER_API_KEY`, and restart the app. You can also save a key through the app's OS keychain integration.

`.env` stays out of Git. Local model servers are managed separately.

## Packages

| Package                         | Description                             |
| ------------------------------- | --------------------------------------- |
| [desktop](apps/desktop)         | Tauri app and React interface           |
| [daemon](apps/daemon)           | Local API and agent loop                |
| [providers](packages/providers) | llama-server and OpenRouter adapters    |
| [tools](packages/tools)         | Project file tools and reviewed changes |
| [context](packages/context)     | Request assembly and context budgets    |
| [storage](packages/storage)     | SQLite persistence and recovery         |
| [contracts](packages/contracts) | Shared types and validation             |

## Development

```sh
npm run check    # Type checks, tests, and build
npm run dev:web  # Browser UI preview with demo data
```

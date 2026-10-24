# 0003: A daemon with clients, TypeScript on Bun

**Status:** accepted, 2026-10-24

One Bun daemon owns sessions, agents and storage, and serves a localhost HTTP + WebSocket API. The TUI (OpenTUI) and the web dashboard are clients. Sessions survive closing a client. TypeScript keeps one language from daemon to dashboard and has the best AI and MCP SDKs.

# 0010: The TUI uses OpenTUI with its Solid binding

**Status:** accepted, 2026-10-24

The terminal client is built on `@opentui/core` with `@opentui/solid` (Solid 1.9.12, pinned to the binding's peer). opencode ships the same pair in production, Solid's fine-grained signals update one message per token delta without re-rendering the transcript, and the binding has a headless `testRender` for smoke tests. `@opentui/react` was the alternative; it has no Node CI lane and React's reconciler re-renders more per delta.

Consequences: OpenTUI needs Bun 1.3.14 or newer (we require 1.4.4). Solid's JSX compiles through a Bun plugin: `bunfig.toml` preloads it for tests and runs from the repo, and `hamness tui` registers it at runtime before importing any `.tsx`, so the CLI works from any directory. The TUI is a client of the daemon like any other (ADR 0003): it never talks to Pi directly.

# 0011: Claude through an API key only; ChatGPT plan login through Pi

**Status:** accepted, 2026-10-24; partly superseded by ADR 0023 (the ChatGPT plan is the default, `hamness login openai` uses Pi's `openai-codex` flow, and an Anthropic key is optional)

Pi can sign in to Anthropic with a Claude Pro/Max subscription (OAuth) and read `ANTHROPIC_OAUTH_TOKEN`. hamness turns both off: Claude subscriptions are offered for Claude Code and Anthropic's own apps, and using them to power a third-party harness risks breaking Anthropic's terms (and the user's account). hamness calls Claude with an API key only, from `ANTHROPIC_API_KEY` or the key file (`hamness keys set anthropic`). `hamness login anthropic` refuses with that advice, a stored Anthropic OAuth credential stops the daemon from starting a session, and `ANTHROPIC_OAUTH_TOKEN` without an API key is an error.

ChatGPT plan login is allowed, as spec section 5 asks: `hamness login openai` runs Pi's "Sign in with ChatGPT" flow and introduces itself as hamness. Pi keeps the credential in `<dataDir>/pi/auth.json` (mode 0600), never in `~/.pi`.

Keys: an env var wins over `<dataDir>/keys.json`; the file must be mode 0600 and hamness refuses to read or write it otherwise. hamness never prints, logs or stores a key anywhere else, and never reads the macOS Keychain (spec section 5 leaves that for later).

Consequences: a Claude subscriber still needs an API key (or another provider) to use hamness. Revisit if Anthropic offers a sanctioned sign-in for third-party harnesses.

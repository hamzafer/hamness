# hamness

An AI coding harness: a Bun daemon with an OpenTUI terminal client and a local web dashboard, built on Pi. The angle is glass box + proof. Read the spec in `docs/superpowers/specs/` and the ADRs in `docs/adr/` before changing behavior.

## Rules
- TypeScript on Bun. Tests with `bun test`, test-first.
- No personal data in the repo: tests use synthetic fixtures, never real transcripts, home paths or emails.
- Pin GitHub Actions to commit SHAs.
- No AI attribution lines in commits, PRs or docs.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, used through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

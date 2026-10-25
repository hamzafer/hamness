# 0006: Safety is rules, then a judge, with an audit log

**Status:** accepted, 2026-10-24

allow / ask / deny rules decide first. A small judge model (default Haiku, $1/day budget; since ADR 0023 the ChatGPT plan's gpt-5.6-luna with a 500 calls/day cap) decides the rest; any error or doubt means ask, and 3 asks in a row pause the judge. Every decision is stored with its source and reason. An OS sandbox is deferred past v1.

**Amended 2026-10-25 (ADR 0022):** in `yolo` mode the rules still run; deny rules deny, and only questions (ask rules, the judge, the doom loop) are skipped.

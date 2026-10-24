import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests never read the developer's own Claude Code settings (and never run their hooks).
process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "hamness-claude-"));

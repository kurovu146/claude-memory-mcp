// Vitest setup file — runs before test files are imported.
//
// CRITICAL: This file MUST set MEMORY_DB_PATH before any test file's import
// graph evaluates `./db.js`. Do NOT try to set MEMORY_DB_PATH at the top of a
// test file — ES module imports are hoisted, so `import { db } from "./db.js"`
// evaluates db.ts BEFORE top-level assignments run, causing db.ts to fall back
// to the production path `~/.claude/memory.db` and subsequent `DELETE FROM`
// calls in `beforeEach` wipe real user memories. See vitest.config.ts
// `setupFiles` for how this hook is wired in.

import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

process.env.MEMORY_DB_PATH = join(
  tmpdir(),
  `memory-test-${randomUUID()}.db`,
);

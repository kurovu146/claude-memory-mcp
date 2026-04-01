# claude-memory-fts

Long-term memory MCP server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Stores facts in a local SQLite database with hybrid search (FTS5 + semantic vector similarity) and automatic context injection.

## Features

- **Hybrid search** — FTS5 keyword search + semantic vector similarity, merged via Reciprocal Rank Fusion (RRF)
- **Semantic understanding** — find memories by meaning, not just keywords (powered by all-MiniLM-L6-v2 embeddings)
- **Auto context injection** — top 30 most important memories injected into every prompt via hook
- **Importance ranking** — facts ranked by access frequency, recency decay, and category weight
- **Access tracking** — tracks how often each memory is accessed
- **Upsert** — automatically updates existing facts instead of duplicating
- **Categorized** — organize by type: preference, decision, technical, project, workflow, personal, general
- **MCP Resources** — exposes `memory://context` resource for session context
- **Zero config** — works out of the box, stores data in `~/.claude/memory.db`

## Install

```bash
# Add to Claude Code
claude mcp add memory -- npx claude-memory-fts

# Auto-configure context injection hook (recommended)
npx claude-memory-fts --setup-hook
```

The `--setup-hook` command automatically:
1. Creates `~/.claude/scripts/memory-context.sh`
2. Adds a `UserPromptSubmit` hook to `~/.claude/settings.json`
3. Top 30 memories are injected into every prompt automatically

## CLI Commands

| Command | Description |
|---|---|
| `npx claude-memory-fts` | Start MCP server (used by Claude Code) |
| `npx claude-memory-fts --context` | Output top 30 facts (used by hook script) |
| `npx claude-memory-fts --setup-hook` | Auto-configure context injection hook |

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `MEMORY_DB_PATH` | `~/.claude/memory.db` | Path to the SQLite database file |

Example with custom path:

```bash
claude mcp add memory -e MEMORY_DB_PATH=/path/to/my/memory.db -- npx claude-memory-fts
```

## Tools

### `memory_save`

Save a fact to long-term memory.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fact` | string | yes | The information to remember |
| `category` | string | no | One of: `preference`, `decision`, `personal`, `technical`, `project`, `workflow`, `general` |

### `memory_search`

Hybrid search: runs FTS5 and semantic search in parallel, merges results with RRF. Falls back to LIKE for partial matches.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `keyword` | string | yes | Search keyword or phrase |
| `limit` | number | no | Max results (default: 10) |

### `memory_update`

Update a memory's content or category by ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | number | yes | Memory ID |
| `fact` | string | no | New content (omit to keep current) |
| `category` | string | no | New category (omit to keep current) |

### `memory_list`

List all saved memories grouped by category.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | string | no | Filter by category |
| `limit` | number | no | Max results (default: 50) |

### `memory_delete`

Delete a memory by ID.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | number | yes | Memory ID |

## Resources

### `memory://context`

MCP resource exposing top 30 facts ranked by importance score:
- **Access frequency** — frequently accessed facts score higher (capped at 20 points)
- **Recency** — recently updated facts score higher (10 points, decays over 90 days)
- **Category weight** — preference/decision (3), workflow/technical (2), project/personal (1), general (0)

## How It Works

### Search Pipeline

1. **FTS5 + BM25** and **semantic vector similarity** run in parallel
2. Results are merged and deduplicated using **Reciprocal Rank Fusion** (k=60)
3. Facts appearing in both lists get naturally boosted
4. If both return empty, falls back to **LIKE** substring matching
5. Access count is tracked on every search hit

### Embeddings

- Model: [all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) (384 dimensions, ~23MB)
- Generated locally via `@xenova/transformers` — no API calls, no data leaves your machine
- Embeddings are created on save and backfilled on server startup
- Cosine similarity with 0.3 threshold to filter noise

### Storage

- SQLite with WAL mode for fast concurrent reads/writes
- FTS5 virtual table synced via triggers for real-time full-text indexing
- Embeddings stored as BLOB columns alongside facts

## Development

```bash
git clone https://github.com/kurovu146/claude-memory-mcp.git
cd claude-memory-mcp
npm install
npm run build
npm test
```

## License

MIT

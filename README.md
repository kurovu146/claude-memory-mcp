# claude-memory-mcp

Long-term memory MCP server for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Stores facts in a local SQLite database with FTS5 full-text search and BM25 ranking.

## Features

- **Persistent memory** — facts survive across sessions via SQLite
- **Full-text search** — FTS5 with BM25 ranking for relevant results
- **LIKE fallback** — partial matches when FTS5 finds nothing
- **Access tracking** — tracks how often each memory is accessed
- **Upsert** — automatically updates existing facts instead of duplicating
- **Categorized** — organize memories by type (preference, decision, technical, project, workflow, personal, general)
- **Zero config** — works out of the box, stores data in `~/.claude/memory.db`

## Install

```bash
# Add to Claude Code
claude mcp add memory -- npx claude-memory-mcp

# Or run directly
npx claude-memory-mcp
```

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `MEMORY_DB_PATH` | `~/.claude/memory.db` | Path to the SQLite database file |

Example with custom path:

```bash
claude mcp add memory -e MEMORY_DB_PATH=/path/to/my/memory.db -- npx claude-memory-mcp
```

## Tools

### `memory_save`

Save a fact to long-term memory.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fact` | string | yes | The information to remember |
| `category` | string | no | One of: `preference`, `decision`, `personal`, `technical`, `project`, `workflow`, `general` |

### `memory_search`

Search memories by keyword using FTS5 full-text search with BM25 ranking.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `keyword` | string | yes | Search keyword or phrase |
| `limit` | number | no | Max results (default: 10) |

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

## How It Works

- Memories are stored in a SQLite database with WAL mode for fast writes
- FTS5 virtual table mirrors the main table via triggers for real-time full-text indexing
- Search uses BM25 ranking for relevance, with a LIKE fallback for partial matches
- Each search/list call tracks access count and last accessed timestamp
- Duplicate facts are upserted (category and timestamp updated, no new row created)

## Development

```bash
git clone https://github.com/kurovu146/claude-memory-mcp.git
cd claude-memory-mcp
npm install
npm run build
node dist/index.js
```

## License

MIT

#!/usr/bin/env node
// claude-memory-fts — Long-term memory MCP server
// SQLite + FTS5 full-text search + semantic vector search for Claude Code
//
// Install:
//   npx claude-memory-fts
//   claude mcp add memory -- npx claude-memory-fts
//
// CLI commands:
//   npx claude-memory-fts --context       Output top 30 facts for hook injection
//   npx claude-memory-fts --setup-hook    Auto-configure UserPromptSubmit hook

import { getTopFacts, countFacts } from "./repository.js";
import { homedir } from "os";
import { join, dirname } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";

const args = process.argv.slice(2);

if (args.includes("--context")) {
  const facts = getTopFacts(30);
  if (facts.length === 0) process.exit(0);

  const grouped = new Map<string, typeof facts>();
  for (const f of facts) {
    const list = grouped.get(f.category) || [];
    list.push(f);
    grouped.set(f.category, list);
  }
  for (const [, items] of grouped) {
    for (const f of items) {
      const hits = f.accessCount > 0 ? ` [x${f.accessCount}]` : "";
      console.log(`[${f.category}] ${f.fact}${hits}`);
    }
  }
  process.exit(0);
}

if (args.includes("--setup-hook")) {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const scriptsDir = join(homedir(), ".claude", "scripts");

  // 1. Create hook script
  mkdirSync(scriptsDir, { recursive: true });
  const scriptPath = join(scriptsDir, "memory-context.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/bash\nnpx claude-memory-fts --context 2>/dev/null\n`,
    { mode: 0o755 }
  );

  // 2. Add hook to settings.json
  let settings: any = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

  const hookCommand = `bash ${scriptPath}`;
  const alreadyExists = settings.hooks.UserPromptSubmit.some((entry: any) =>
    entry.hooks?.some((h: any) => h.command?.includes("memory-context"))
  );

  if (!alreadyExists) {
    settings.hooks.UserPromptSubmit.push({
      matcher: "",
      hooks: [{ type: "command", command: hookCommand }],
    });
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  console.log("✅ Hook configured:");
  console.log(`   Script: ${scriptPath}`);
  console.log(`   Hook: UserPromptSubmit → memory-context.sh`);
  console.log("\nTop 30 memories will be injected into every prompt.");
  process.exit(0);
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  saveFact,
  searchFacts,
  listFacts,
  updateFact,
  deleteFact,
  backfillEmbeddings,
} from "./repository.js";

const server = new Server(
  { name: "claude-memory-fts", version: "2.0.0" },
  { capabilities: { tools: {}, resources: {} } }
);

// --- List tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_save",
      description:
        "Lưu một fact quan trọng vào long-term memory. Dùng khi user chia sẻ preferences, quyết định kỹ thuật, conventions, thông tin project, hoặc bất cứ điều gì cần nhớ cho các session sau.",
      inputSchema: {
        type: "object" as const,
        properties: {
          fact: {
            type: "string",
            description: "Thông tin cần nhớ (ngắn gọn, cụ thể)",
          },
          category: {
            type: "string",
            enum: [
              "preference",
              "decision",
              "personal",
              "technical",
              "project",
              "workflow",
              "general",
            ],
            default: "general",
            description:
              "Phân loại: preference | decision | personal | technical | project | workflow | general",
          },
        },
        required: ["fact"],
      },
    },
    {
      name: "memory_search",
      description:
        "Tìm kiếm trong long-term memory bằng keyword (FTS5 + BM25) với semantic fallback (vector similarity). Ví dụ: lưu 'tôi thích React' → tìm 'frontend framework preference' vẫn ra kết quả.",
      inputSchema: {
        type: "object" as const,
        properties: {
          keyword: {
            type: "string",
            description: "Từ khóa hoặc câu mô tả ý cần tìm",
          },
          limit: {
            type: "number",
            default: 10,
            description: "Số kết quả tối đa",
          },
        },
        required: ["keyword"],
      },
    },
    {
      name: "memory_list",
      description:
        "Liệt kê tất cả memories theo category. Dùng đầu session để nắm context về user.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: {
            type: "string",
            description: "Lọc theo category (bỏ trống = tất cả)",
          },
          limit: {
            type: "number",
            default: 50,
            description: "Số kết quả tối đa",
          },
        },
      },
    },
    {
      name: "memory_update",
      description:
        "Cập nhật memory theo ID. Dùng khi cần sửa hoặc bổ sung thông tin mà không cần xóa rồi lưu lại.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Memory ID (từ memory_list hoặc memory_search)",
          },
          fact: {
            type: "string",
            description: "Nội dung mới (bỏ trống = giữ nguyên)",
          },
          category: {
            type: "string",
            enum: [
              "preference",
              "decision",
              "personal",
              "technical",
              "project",
              "workflow",
              "general",
            ],
            description: "Category mới (bỏ trống = giữ nguyên)",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "memory_delete",
      description:
        "Xóa memory theo ID. Dùng khi thông tin đã lỗi thời hoặc sai.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description: "Memory ID (từ memory_list hoặc memory_search)",
          },
        },
        required: ["id"],
      },
    },
  ],
}));

// --- Handle tool calls ---

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "memory_save": {
      const fact = args?.fact;
      if (!fact || typeof fact !== "string")
        throw new Error("memory_save requires a non-empty 'fact' string");
      const category = (args?.category as string) || "general";
      const saved = await saveFact(fact, category, "claude-code");
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Saved [${saved.id}] [${category}]: "${fact}"`,
          },
        ],
      };
    }

    case "memory_search": {
      const keyword = args?.keyword;
      if (!keyword || typeof keyword !== "string")
        throw new Error("memory_search requires a non-empty 'keyword' string");
      const limit = (args?.limit as number) || 10;
      const facts = await searchFacts(keyword, limit);

      if (facts.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No memories found for: "${keyword}"`,
            },
          ],
        };
      }

      const text = facts
        .map((f) => {
          const date = new Date(f.updatedAt).toLocaleDateString("en-US");
          const hits = f.accessCount > 0 ? ` [x${f.accessCount}]` : "";
          return `[${f.id}] [${f.category}] ${f.fact} (${date}${hits})`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${facts.length} memories:\n\n${text}`,
          },
        ],
      };
    }

    case "memory_list": {
      const category = args?.category as string | undefined;
      const limit = (args?.limit as number) || 50;
      const facts = listFacts(category, limit);
      const total = countFacts();

      if (facts.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No memories${category ? ` in category "${category}"` : ""}.`,
            },
          ],
        };
      }

      // Group by category
      const grouped = new Map<string, typeof facts>();
      for (const f of facts) {
        const list = grouped.get(f.category) || [];
        list.push(f);
        grouped.set(f.category, list);
      }

      let text = `Total: ${total} memories\n`;
      for (const [cat, items] of grouped) {
        text += `\n[${cat}] (${items.length})\n`;
        for (const f of items) {
          text += `  [${f.id}] ${f.fact}\n`;
        }
      }

      return { content: [{ type: "text" as const, text }] };
    }

    case "memory_update": {
      const id = args?.id;
      if (id == null || typeof id !== "number")
        throw new Error("memory_update requires a numeric 'id'");
      const fact = args?.fact as string | undefined;
      const category = args?.category as string | undefined;
      const updated = await updateFact(id, { fact, category });
      return {
        content: [
          {
            type: "text" as const,
            text: updated
              ? `✅ Updated [${id}] [${updated.category}]: "${updated.fact}"`
              : `Memory [${id}] not found`,
          },
        ],
      };
    }

    case "memory_delete": {
      const id = args?.id;
      if (id == null || typeof id !== "number")
        throw new Error("memory_delete requires a numeric 'id'");
      const deleted = deleteFact(id);
      return {
        content: [
          {
            type: "text" as const,
            text: deleted
              ? `✅ Deleted memory [${id}]`
              : `Memory [${id}] not found`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Resources: auto-load top facts into context ---

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: "memory://context",
      name: "Memory Context",
      description:
        "Top 30 most important memories ranked by access frequency, recency, and category. Read this at session start to have full context about the user.",
      mimeType: "text/plain",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "memory://context" || uri.startsWith("memory://context?")) {
    const facts = getTopFacts(30);
    const total = countFacts();

    if (facts.length === 0) {
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: "No memories stored yet.",
          },
        ],
      };
    }

    // Group by category for readability
    const grouped = new Map<string, typeof facts>();
    for (const f of facts) {
      const list = grouped.get(f.category) || [];
      list.push(f);
      grouped.set(f.category, list);
    }

    let text = `=== Memory Context (${facts.length}/${total} facts) ===\n`;
    for (const [cat, items] of grouped) {
      text += `\n[${cat}] (${items.length})\n`;
      for (const f of items) {
        const hits = f.accessCount > 0 ? ` [x${f.accessCount}]` : "";
        text += `  - [${f.id}] ${f.fact}${hits}\n`;
      }
    }

    return {
      contents: [{ uri, mimeType: "text/plain", text }],
    };
  }

  return {
    contents: [
      {
        uri,
        mimeType: "text/plain",
        text: `Unknown resource: ${uri}. Available: memory://context`,
      },
    ],
  };
});

// --- Start stdio server ---

const transport = new StdioServerTransport();
await server.connect(transport);

// --- Backfill embeddings for existing facts in background ---

backfillEmbeddings().catch((err) => {
  console.error("Embedding backfill failed:", err?.message ?? err);
});

#!/usr/bin/env node
// claude-memory-fts — Long-term memory MCP server
// SQLite + FTS5 full-text search + semantic vector search for Claude Code
//
// Install:
//   npx claude-memory-fts
//   claude mcp add memory -- npx claude-memory-fts

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  saveFact,
  searchFacts,
  semanticSearch,
  listFacts,
  updateFact,
  deleteFact,
  countFacts,
  backfillEmbeddings,
} from "./repository.js";

const server = new Server(
  { name: "claude-memory-fts", version: "2.0.0" },
  { capabilities: { tools: {} } }
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
      const fact = args?.fact as string;
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
      const keyword = args?.keyword as string;
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
      const id = args?.id as number;
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
      const id = args?.id as number;
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

// --- Start stdio server ---

const transport = new StdioServerTransport();
await server.connect(transport);

// --- Backfill embeddings for existing facts in background ---

backfillEmbeddings().catch(() => {
  // Silent fail — embeddings will be generated on next save
});

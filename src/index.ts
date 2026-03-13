#!/usr/bin/env node
// claude-memory-fts — Long-term memory MCP server
// SQLite + FTS5 full-text search for Claude Code
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
  listFacts,
  deleteFact,
  countFacts,
} from "./repository.js";

const server = new Server(
  { name: "claude-memory-fts", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// --- List tools ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "memory_save",
      description:
        "Save an important fact to long-term memory. Use when the user shares preferences, technical decisions, conventions, project info, or anything worth remembering across sessions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          fact: {
            type: "string",
            description: "The information to remember (concise and specific)",
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
            description: "Category for organizing memories",
          },
        },
        required: ["fact"],
      },
    },
    {
      name: "memory_search",
      description:
        "Search long-term memory by keyword using full-text search (FTS5 with BM25 ranking). Use when you need to recall information from previous sessions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          keyword: {
            type: "string",
            description: "Search keyword or phrase",
          },
          limit: {
            type: "number",
            default: 10,
            description: "Maximum number of results",
          },
        },
        required: ["keyword"],
      },
    },
    {
      name: "memory_list",
      description:
        "List all saved memories grouped by category. Use at the start of a session to get an overview of what you know about the user.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: {
            type: "string",
            description: "Filter by category (omit for all)",
          },
          limit: {
            type: "number",
            default: 50,
            description: "Maximum number of results",
          },
        },
      },
    },
    {
      name: "memory_delete",
      description:
        "Delete a memory by ID. Use when information is outdated or incorrect.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: {
            type: "number",
            description:
              "Memory ID (from memory_list or memory_search results)",
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
      const saved = saveFact(fact, category, "claude-code");
      return {
        content: [
          {
            type: "text" as const,
            text: `Saved [${saved.id}] [${category}]: "${fact}"`,
          },
        ],
      };
    }

    case "memory_search": {
      const keyword = args?.keyword as string;
      const limit = (args?.limit as number) || 10;
      const facts = searchFacts(keyword, limit);

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

    case "memory_delete": {
      const id = args?.id as number;
      const deleted = deleteFact(id);
      return {
        content: [
          {
            type: "text" as const,
            text: deleted
              ? `Deleted memory [${id}]`
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

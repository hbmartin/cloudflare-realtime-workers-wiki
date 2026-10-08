import { z } from "zod";
import type { App } from "@modelcontextprotocol/ext-apps";
import {
  MCP_MAX_REQUEST_BYTES,
  documentResultSchema,
  pageMutationResultSchema,
  pagesResultSchema,
  searchResultSchema,
  spacesResultSchema,
  type PluginDocument,
  type PluginPages,
  type PluginSearch,
  type PluginSpaces,
} from "../shared/plugin-contracts";

export type CreateInput = {
  space_id: string;
  parent_id?: string;
  title: string;
  markdown: string;
  operation_id: string;
};
export type SaveInput = {
  page_id: string;
  expected_revision: number;
  expected_content_epoch: number;
  operation_id: string;
  command: { type: "replace_content"; replace_content: { new_str: string } };
};
export interface PluginApi {
  spaces(): Promise<PluginSpaces>;
  pages(space: string, parent?: string, cursor?: string): Promise<PluginPages>;
  search(query: string, cursor?: string): Promise<PluginSearch>;
  document(id: string): Promise<PluginDocument>;
  create(input: CreateInput): Promise<z.infer<typeof pageMutationResultSchema>>;
  save(input: SaveInput): Promise<z.infer<typeof pageMutationResultSchema>>;
  context(page: Pick<PluginDocument, "id" | "title" | "url"> | null, selectedText?: string): Promise<void>;
  link(url: string): Promise<void>;
}
export class PluginToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "PluginToolError";
  }
}

export function requestFits(name: string, args: unknown) {
  // Leave room for the host's protocol metadata as well as the JSON-RPC envelope.
  return (
    new TextEncoder().encode(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    ).length <=
    MCP_MAX_REQUEST_BYTES - 2048
  );
}

export function pluginApi(app: App): PluginApi {
  async function call<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    if (!requestFits(name, args))
      throw new PluginToolError(
        "This document is too large to save here. Open it in NoteFlare.",
        "request_too_large",
        false,
      );
    const response = await app.callServerTool({ name, arguments: args });
    if (response.isError) {
      const error = z
        .object({ error: z.object({ code: z.string(), retryable: z.boolean() }) })
        .safeParse(response.structuredContent);
      const message = response.content.find((item) => item.type === "text");
      throw new PluginToolError(
        message?.type === "text" ? message.text : "NoteFlare could not complete this request.",
        error.success ? error.data.error.code : "tool_failed",
        error.success && error.data.error.retryable,
      );
    }
    return schema.parse(response.structuredContent);
  }
  return {
    spaces: () => call("list_spaces", {}, spacesResultSchema),
    pages: (space_id, parent_id, cursor) =>
      call(
        "list_pages",
        { space_id, ...(parent_id ? { parent_id } : {}), ...(cursor ? { cursor } : {}) },
        pagesResultSchema,
      ),
    search: (query, cursor) => call("search_pages", { query, ...(cursor ? { cursor } : {}) }, searchResultSchema),
    document: (page_id) => call("fetch_page", { page_id }, documentResultSchema),
    create: (input) => call("create_page", input, pageMutationResultSchema),
    save: (input) => call("update_page", input, pageMutationResultSchema),
    context: async (page, selectedText = "") => {
      await app.updateModelContext({
        structuredContent: {
          page: page ? { id: page.id, title: page.title, url: page.url } : null,
          selectedText: selectedText.slice(0, 8000),
        },
      });
    },
    link: async (url) => {
      if (!/^https?:\/\//i.test(url)) return;
      const response = await app.openLink({ url });
      if (response.isError) throw new Error("The link could not be opened.");
    },
  };
}

import { z } from "zod";
import { ID_PATTERN, PAGE_TITLE_MAX } from "./validation.ts";

export const PLUGIN_UI_URI = "ui://noteflare/v1/editor.html";
export const MCP_MAX_REQUEST_BYTES = 64 * 1024;

const pageIdentity = { id: z.string(), title: z.string(), url: z.string().url() };
export const documentResultSchema = z.object({
  ...pageIdentity,
  revision: z.number().int().nonnegative(),
  contentEpoch: z.number().int().nonnegative(),
  spaceId: z.string(),
  parentId: z.string().nullable(),
  markdown: z.string(),
  truncated: z.boolean(),
  unknownBlockIds: z.array(z.string()),
  canEdit: z.boolean(),
});
export type PluginDocument = z.infer<typeof documentResultSchema>;

export const pageMutationResultSchema = z.object({
  ...pageIdentity,
  revision: z.number().int().nonnegative(),
  operationId: z.string(),
});
const commentResultSchema = z.object({
  threadId: z.string(),
  commentId: z.string(),
  pageId: z.string(),
  url: z.string().url(),
});
export const searchResultSchema = z.object({
  pages: z.array(z.object({ ...pageIdentity, kind: z.enum(["document", "diagram", "table"]), snippet: z.string() })),
  nextCursor: z.string().nullable(),
});
export type PluginSearch = z.infer<typeof searchResultSchema>;

export const spacesResultSchema = z.object({
  workspace: z.object({ id: z.string(), name: z.string() }),
  scopes: z.array(z.string()),
  spaces: z.array(z.object({ id: z.string(), name: z.string(), canEdit: z.boolean() })),
});
export type PluginSpaces = z.infer<typeof spacesResultSchema>;
export const pagesResultSchema = z.object({
  pages: z.array(
    z.object({
      ...pageIdentity,
      kind: z.enum(["document", "diagram", "table"]),
      parentId: z.string().nullable(),
      spaceId: z.string(),
      canEdit: z.boolean(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type PluginPages = z.infer<typeof pagesResultSchema>;
export const openResultSchema = z.object({
  workspace: z.object({ id: z.string(), name: z.string() }),
  initialPageId: z.string().nullable(),
  linkedPage: z.object({ ...pageIdentity, kind: z.enum(["diagram", "table"]) }).nullable(),
});

const deletionOption = { allow_deleting_content: z.boolean().optional() };
const markdownCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace_content"),
    replace_content: z.object({ new_str: z.string(), ...deletionOption }),
  }),
  z.object({
    type: z.literal("update_content"),
    update_content: z.object({
      content_updates: z
        .array(
          z.object({
            old_str: z.string().min(1),
            new_str: z.string(),
            replace_all_matches: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(100),
      replace_all_matches: z.boolean().optional(),
      ...deletionOption,
    }),
  }),
  z.object({
    type: z.literal("insert_content"),
    insert_content: z.object({
      content: z.string(),
      after: z.string().min(1).optional(),
      position: z.object({ type: z.enum(["start", "end"]) }).optional(),
      ...deletionOption,
    }),
  }),
  z.object({
    type: z.literal("replace_content_range"),
    replace_content_range: z.object({ content_range: z.string().min(1), content: z.string(), ...deletionOption }),
  }),
]);

const OPERATION_ID = /^[A-Za-z0-9:_-]{1,128}$/;
export const pluginToolContracts = {
  search_pages: {
    description: "Find pages the connected member can read. Use the returned IDs to fetch documents or open NoteFlare.",
    inputSchema: z.object({ query: z.string().trim().min(1).max(200), cursor: z.string().max(512).optional() }),
    outputSchema: searchResultSchema,
  },
  fetch_page: {
    description:
      "Read a document as Markdown. Use its revision and contentEpoch when updating it; diagrams and tables open in NoteFlare.",
    inputSchema: z.object({ page_id: z.string().regex(ID_PATTERN) }),
    outputSchema: documentResultSchema,
  },
  list_spaces: {
    description: "Find accessible spaces and writable destinations before browsing pages or creating a document.",
    inputSchema: z.object({}),
    outputSchema: spacesResultSchema,
  },
  list_pages: {
    description:
      "List up to 50 children in an accessible space. Omit parent_id to list roots; use nextCursor for more pages.",
    inputSchema: z.object({
      space_id: z.string().regex(ID_PATTERN),
      parent_id: z.string().regex(ID_PATTERN).optional(),
      cursor: z.string().max(512).optional(),
    }),
    outputSchema: pagesResultSchema,
  },
  open_noteflare: {
    description:
      "Open the NoteFlare document browser and Markdown editor. Optionally pass a page ID from search or navigation. Data tools remain useful without this UI.",
    inputSchema: z.object({ page_id: z.string().regex(ID_PATTERN).optional() }),
    outputSchema: openResultSchema,
  },
  create_comment: {
    description: "Post a comment as the connected member. Reuse operation_id and identical arguments when retrying.",
    inputSchema: z.object({
      page_id: z.string().regex(ID_PATTERN),
      body: z.string().trim().min(1).max(16_000),
      block_id: z.string().regex(ID_PATTERN).optional(),
      operation_id: z.string().regex(OPERATION_ID),
    }),
    outputSchema: commentResultSchema,
  },
  create_page: {
    description:
      "Create a Markdown document in a writable space discovered with list_spaces. Reuse operation_id and identical arguments when retrying.",
    inputSchema: z.object({
      space_id: z.string().regex(ID_PATTERN),
      parent_id: z.string().regex(ID_PATTERN).nullable().optional(),
      title: z.string().trim().min(1).max(PAGE_TITLE_MAX),
      markdown: z.string().max(64_000),
      operation_id: z.string().regex(OPERATION_ID),
    }),
    outputSchema: pageMutationResultSchema,
  },
  update_page: {
    description:
      "Apply a Markdown command to a writable document. Read it first and pass expected_revision and expected_content_epoch together to prevent stale edits. Reuse operation_id and identical arguments when retrying.",
    inputSchema: z
      .object({
        page_id: z.string().regex(ID_PATTERN),
        command: markdownCommandSchema,
        operation_id: z.string().regex(OPERATION_ID),
        expected_revision: z.number().int().nonnegative().optional(),
        expected_content_epoch: z.number().int().nonnegative().optional(),
      })
      .refine(
        (input) => (input.expected_revision === undefined) === (input.expected_content_epoch === undefined),
        "Provide both expected_revision and expected_content_epoch.",
      ),
    outputSchema: pageMutationResultSchema,
  },
};

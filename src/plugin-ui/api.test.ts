import { describe, expect, it, vi } from "vitest";
import type { App } from "@modelcontextprotocol/ext-apps";
import { pluginApi, requestFits } from "./api";

function bridge() {
  const host = {
    callServerTool: vi.fn().mockResolvedValue({
      content: [],
      structuredContent: { workspace: { id: "wiki", name: "Wiki" }, scopes: ["pages:read"], spaces: [] },
    }),
    updateModelContext: vi.fn().mockResolvedValue({}),
    openLink: vi.fn().mockResolvedValue({}),
  };
  return { host, api: pluginApi(host as unknown as App) };
}
describe("MCP Apps data bridge", () => {
  it("validates structured results and exposes tool errors", async () => {
    const { host, api } = bridge();
    expect((await api.spaces()).workspace.name).toBe("Wiki");
    expect(host.callServerTool).toHaveBeenCalledWith({ name: "list_spaces", arguments: {} });
    host.callServerTool.mockResolvedValueOnce({
      content: [{ type: "text", text: "Draft is stale" }],
      isError: true,
      structuredContent: { error: { code: "page_changed", retryable: false } },
    });
    await expect(api.document("doc")).rejects.toMatchObject({
      code: "page_changed",
      retryable: false,
      message: "Draft is stale",
    });
    host.callServerTool.mockResolvedValueOnce({ content: [], structuredContent: {} });
    await expect(api.spaces()).rejects.toThrow(/Invalid input/);
  });
  it("shares only identity and selected text even if passed a whole draft document", async () => {
    const { host, api } = bridge();
    const page = {
      id: "doc",
      title: "Notes",
      url: "https://notes.example/?page=doc",
      markdown: "Secret unsaved draft",
    };
    await api.context(page, "explicit selection");
    expect(host.updateModelContext).toHaveBeenCalledWith({
      structuredContent: {
        page: { id: page.id, title: page.title, url: page.url },
        selectedText: "explicit selection",
      },
    });
    expect(JSON.stringify(host.updateModelContext.mock.calls)).not.toContain(page.markdown);
    await api.context(null);
    expect(host.updateModelContext).toHaveBeenLastCalledWith({ structuredContent: { page: null, selectedText: "" } });
  });
  it("measures UTF-8 requests and rejects oversized writes before calling the host", async () => {
    const { host, api } = bridge();
    expect(requestFits("create_page", { markdown: "📝".repeat(17_000) })).toBe(false);
    await expect(
      api.create({ space_id: "space", title: "Huge", markdown: "x".repeat(65_536), operation_id: "op" }),
    ).rejects.toMatchObject({ code: "request_too_large" });
    expect(host.callServerTool).not.toHaveBeenCalled();
    await api.link("javascript:alert(1)");
    expect(host.openLink).not.toHaveBeenCalled();
  });
});

import { expect, test } from "@playwright/test";

test("bundled MCP App connects through the host bridge and preserves a conflicted draft", async ({ page, request }) => {
  const resource = await request.get("/plugin-ui/noteflare.html");
  expect(resource.ok()).toBe(true);
  const html = await resource.text();
  expect(html).toContain('name="noteflare-plugin-ui"');
  const externalRequests: string[] = [];
  page.on("request", (req) => {
    if (req.url().startsWith("https://unsafe.example")) externalRequests.push(req.url());
  });
  await page.goto("/api/health");
  await page.setContent('<iframe title="NoteFlare" style="width:100%;height:800px"></iframe>');
  await page.evaluate((bundle) => {
    const iframe = document.querySelector("iframe")!;
    const doc = {
      id: "doc",
      title: "Private test document",
      url: "https://notes.example/?page=doc",
      spaceId: "space",
      parentId: null,
      markdown: "Original\n\n![image](https://unsafe.example/tracker)\n\n<script>alert(1)</script>",
      revision: 7,
      contentEpoch: 2,
      truncated: false,
      unknownBlockIds: [],
      canEdit: true,
    };
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const contexts: unknown[] = [];
    const openedLinks: unknown[] = [];
    // These observable elements keep the test independent of app internals.
    const output = document.createElement("output");
    output.id = "bridge-record";
    document.body.append(output);
    window.addEventListener("message", (event) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data as { jsonrpc: string; id?: number; method: string; params: Record<string, unknown> };
      if (msg.id === undefined) return;
      let result: unknown = {};
      if (msg.method === "ui/initialize")
        result = {
          protocolVersion: msg.params.protocolVersion,
          hostInfo: { name: "Acceptance test host", version: "1.0.0" },
          hostCapabilities: { serverTools: {}, updateModelContext: {}, openLinks: {} },
          hostContext: { theme: "light", displayMode: "inline" },
        };
      else if (msg.method === "tools/call") {
        const input = msg.params as { name: string; arguments: Record<string, unknown> };
        calls.push(input);
        let data: unknown;
        if (input.name === "list_spaces")
          data = {
            workspace: { id: "wiki", name: "Private acceptance wiki" },
            scopes: ["pages:read", "pages:write"],
            spaces: [{ id: "space", name: "Plugin test", canEdit: true }],
          };
        else if (input.name === "list_pages") data = { pages: [{ ...doc, kind: "document" }], nextCursor: null };
        else if (input.name === "fetch_page") data = doc;
        else if (input.name === "update_page")
          result = {
            isError: true,
            content: [{ type: "text", text: "The document changed." }],
            structuredContent: { error: { code: "page_changed", retryable: false } },
          };
        if (data) result = { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } else if (msg.method === "ui/update-model-context") contexts.push(msg.params);
      else if (msg.method === "ui/open-link") openedLinks.push(msg.params.url);
      output.textContent = JSON.stringify({ calls, contexts, openedLinks });
      iframe.contentWindow!.postMessage({ jsonrpc: "2.0", id: msg.id, result }, "*");
    });
    // ChatGPT serves resource HTML in a sandbox. The test imposes a similarly strict CSP.
    iframe.srcdoc = bundle.replace(
      "<head>",
      "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'\">",
    );
  }, html);
  const ui = page.frameLocator('iframe[title="NoteFlare"]');
  await ui.getByRole("button", { name: "Private test document", exact: true }).click();
  await expect(ui.getByRole("heading", { name: "Private test document" })).toBeVisible();
  await expect(ui.locator("script[src],img,iframe")).toHaveCount(0);
  await ui.getByRole("button", { name: "Edit Markdown" }).click();
  await ui.getByLabel("Markdown draft").fill("My local draft");
  await ui.getByRole("button", { name: "Save", exact: true }).click();
  await expect(ui.getByText(/Your draft is preserved/)).toBeVisible();
  await expect(ui.getByLabel("Markdown draft")).toHaveValue("My local draft");
  await expect(ui.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await ui.getByRole("button", { name: "Space roots" }).click();
  await expect(ui.getByRole("dialog")).toBeVisible();
  await ui.getByRole("button", { name: "Keep editing" }).click();
  await expect(ui.getByLabel("Markdown draft")).toHaveValue("My local draft");
  await page.evaluate(() => {
    document.querySelector("iframe")!.contentWindow!.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          content: [],
          structuredContent: {
            workspace: { id: "wiki", name: "Private acceptance wiki" },
            initialPageId: null,
            linkedPage: { id: "table", title: "Table test", kind: "table", url: "https://notes.example/?page=table" },
          },
        },
      },
      "*",
    );
  });
  const linkedPage = ui.locator(".message").filter({ hasText: "Table test is a table" });
  await expect(linkedPage).toBeVisible();
  await linkedPage.getByRole("button", { name: /Open in NoteFlare/ }).click();
  await expect(ui.getByLabel("Markdown draft")).toHaveValue("My local draft");
  const record = JSON.parse(await page.locator("#bridge-record").innerText()) as {
    calls: Array<{ name: string; arguments: Record<string, unknown> }>;
    contexts: unknown[];
    openedLinks: unknown[];
  };
  expect(record.calls.find((call) => call.name === "update_page")?.arguments).toMatchObject({
    expected_revision: 7,
    expected_content_epoch: 2,
  });
  expect(JSON.stringify(record.contexts)).toContain('"id":"doc"');
  expect(JSON.stringify(record.contexts)).not.toContain("My local draft");
  expect(record.openedLinks).toEqual(["https://notes.example/?page=table"]);
  expect(externalRequests).toEqual([]);
});

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

test("native Escape keeps an in-flight create attached to its draft and the next save updates that page", async ({
  page,
  request,
}) => {
  const resource = await request.get("/plugin-ui/noteflare.html");
  expect(resource.ok()).toBe(true);
  await page.goto("/api/health");
  await page.setContent('<iframe title="NoteFlare" style="width:100%;height:800px"></iframe>');
  await page.evaluate(
    (bundle) => {
      const iframe = document.querySelector("iframe")!;
      const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      const contexts: unknown[] = [];
      const output = document.createElement("output");
      output.id = "save-bridge-record";
      const complete = document.createElement("button");
      complete.textContent = "Complete submitted create";
      complete.disabled = true;
      document.body.append(complete, output);
      let submitted: { id: number; input: Record<string, unknown> } | undefined;
      let saved = {
        id: "created",
        title: "Created notes",
        url: "https://notes.example/?page=created",
        spaceId: "space",
        parentId: null,
        markdown: "",
        revision: 1,
        contentEpoch: 1,
        truncated: false,
        unknownBlockIds: [],
        canEdit: true,
      };
      const record = () => {
        output.textContent = JSON.stringify({ calls, contexts });
      };
      const reply = (id: number, data: unknown) =>
        iframe.contentWindow!.postMessage(
          { jsonrpc: "2.0", id, result: { content: [], structuredContent: data } },
          "*",
        );
      complete.addEventListener("click", () => {
        if (!submitted) return;
        saved = { ...saved, title: String(submitted.input.title), markdown: String(submitted.input.markdown) };
        reply(submitted.id, {
          id: saved.id,
          title: saved.title,
          url: saved.url,
          revision: 1,
          operationId: submitted.input.operation_id,
        });
        complete.disabled = true;
      });
      window.addEventListener("message", (event) => {
        if (event.source !== iframe.contentWindow) return;
        const msg = event.data as { id?: number; method: string; params: Record<string, unknown> };
        if (msg.id === undefined) return;
        if (msg.method === "ui/initialize") {
          iframe.contentWindow!.postMessage(
            {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: msg.params.protocolVersion,
                hostInfo: { name: "Acceptance test host", version: "1.0.0" },
                hostCapabilities: { serverTools: {}, updateModelContext: {}, openLinks: {} },
                hostContext: { theme: "light", displayMode: "inline" },
              },
            },
            "*",
          );
          return;
        }
        if (msg.method === "tools/call") {
          const input = msg.params as { name: string; arguments: Record<string, unknown> };
          calls.push(input);
          record();
          if (input.name === "list_spaces")
            reply(msg.id, {
              workspace: { id: "wiki", name: "Acceptance wiki" },
              scopes: ["pages:read", "pages:write"],
              spaces: [{ id: "space", name: "Plugin test", canEdit: true }],
            });
          else if (input.name === "list_pages") reply(msg.id, { pages: [], nextCursor: null });
          else if (input.name === "create_page") {
            submitted = { id: msg.id, input: input.arguments };
            complete.disabled = false;
          } else if (input.name === "fetch_page") reply(msg.id, saved);
          else if (input.name === "update_page") {
            const command = input.arguments.command as { replace_content: { new_str: string } };
            saved = { ...saved, markdown: command.replace_content.new_str, revision: saved.revision + 1 };
            reply(msg.id, {
              id: saved.id,
              title: saved.title,
              url: saved.url,
              revision: saved.revision,
              operationId: input.arguments.operation_id,
            });
          }
        } else {
          if (msg.method === "ui/update-model-context") contexts.push(msg.params);
          record();
          iframe.contentWindow!.postMessage({ jsonrpc: "2.0", id: msg.id, result: {} }, "*");
        }
      });
      iframe.srcdoc = bundle.replace(
        "<head>",
        "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'\">",
      );
    },
    await resource.text(),
  );
  const ui = page.frameLocator('iframe[title="NoteFlare"]');
  await ui.getByRole("button", { name: "New document", exact: true }).click();
  await ui.getByLabel("Title").fill("Created notes");
  await ui.getByLabel("Markdown draft").fill("Submitted text");
  await ui.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Complete submitted create" })).toBeEnabled();
  await page.evaluate(() => {
    document.querySelector("iframe")!.contentWindow!.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: {
          content: [],
          structuredContent: {
            workspace: { id: "wiki", name: "Acceptance wiki" },
            initialPageId: "host-next",
            linkedPage: null,
          },
        },
      },
      "*",
    );
  });
  const dialog = ui.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/cannot undo a save/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Save and continue" })).toBeDisabled();
  await dialog.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(ui.getByLabel("Title")).toBeDisabled();
  await expect(ui.getByLabel("Markdown draft")).toBeEnabled();
  await ui.getByLabel("Markdown draft").fill("Newer text after Escape");
  await expect(ui.getByRole("button", { name: "Retry previous save" })).toBeDisabled();
  await page.getByRole("button", { name: "Complete submitted create" }).click();
  await expect(ui.getByText("Previous save confirmed. Your newer changes are still unsaved.")).toBeVisible();
  await expect(ui.getByLabel("Markdown draft")).toHaveValue("Newer text after Escape");
  await expect(ui.getByRole("heading", { name: "Created notes" })).toBeVisible();
  await ui.getByRole("button", { name: "Save", exact: true }).click();
  await expect(ui.getByText("Document saved.")).toBeVisible();
  const record = JSON.parse(await page.locator("#save-bridge-record").innerText()) as {
    calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  };
  expect(record.calls.filter((call) => call.name === "create_page")).toHaveLength(1);
  const updates = record.calls.filter((call) => call.name === "update_page");
  expect(updates).toHaveLength(1);
  expect(updates[0]!.arguments).toMatchObject({
    page_id: "created",
    expected_revision: 1,
    expected_content_epoch: 1,
    command: { replace_content: { new_str: "Newer text after Escape" } },
  });
  expect(record.calls.some((call) => call.name === "fetch_page" && call.arguments.page_id === "host-next")).toBe(false);
});

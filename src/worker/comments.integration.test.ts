import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { CommentThread, Page, Space } from "../shared/types";

function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

const commentBody = (text: string) => [
  {
    id: crypto.randomUUID(),
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  },
];

async function bootstrap() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Comment Notes",
      name: "Owner",
      email: "comment-owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const me = await (
    await SELF.fetch(request(cookie, "/api/me"))
  ).json<{
    user: { id: string };
    workspace: { id: string };
  }>();
  const pages = await (await SELF.fetch(request(cookie, "/api/pages/tree"))).json<{ pages: Page[] }>();
  return { cookie, userId: me.user.id, workspaceId: me.workspace.id, pageId: pages.pages[0]!.id };
}

async function invite(ownerCookie: string, suffix: string) {
  const invitation = await SELF.fetch(
    request(ownerCookie, "/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "viewer" }),
    }),
  );
  const token = (await invitation.json<{ invite: { token: string } }>()).invite.token;
  const response = await SELF.fetch("http://example.test/api/invites/accept", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      token,
      name: `Viewer ${suffix}`,
      email: `comment-${suffix}@example.test`,
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const me = await (await SELF.fetch(request(cookie, "/api/me"))).json<{ user: { id: string } }>();
  return { cookie, userId: me.user.id };
}

async function createThread(cookie: string, pageId: string, text: string) {
  const response = await SELF.fetch(
    request(cookie, `/api/pages/${pageId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialComment: { body: commentBody(text) } }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json<{ thread: CommentThread }>()).thread;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

afterEach(async () => {
  await abortAllDurableObjects();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM install_state`),
    env.DB.prepare(`DELETE FROM page_search`),
    env.DB.prepare(`DELETE FROM workspaces`),
    env.DB.prepare(`DELETE FROM verification`),
    env.DB.prepare(`DELETE FROM user`),
  ]);
  await reset();
});

describe("server-authoritative comments", () => {
  it("lets readers comment while enforcing author and resolve permissions", async () => {
    const installed = await bootstrap();
    const viewer = await invite(installed.cookie, "viewer");
    const otherViewer = await invite(installed.cookie, "other");
    const thread = await createThread(viewer.cookie, installed.pageId, "Viewer opening note");
    expect(thread).toMatchObject({ createdBy: viewer.userId, canResolve: true, anchored: false });
    expect(thread.comments[0]).toMatchObject({ userId: viewer.userId, plainText: "Viewer opening note" });

    const replyResponse = await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${thread.id}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment: { body: commentBody("Owner reply") } }),
      }),
    );
    expect(replyResponse.status).toBe(201);
    const replied = (await replyResponse.json<{ thread: CommentThread }>()).thread;
    const ownerReply = replied.comments[1]!;
    expect(ownerReply.parentId).toBe(replied.comments[0]!.id);

    const forbiddenEdit = await SELF.fetch(
      request(viewer.cookie, `/api/comment-threads/${thread.id}/comments/${ownerReply.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment: { body: commentBody("Tampered") } }),
      }),
    );
    expect(forbiddenEdit.status).toBe(403);

    const ownComment = thread.comments[0]!;
    const edited = await SELF.fetch(
      request(viewer.cookie, `/api/comments/${ownComment.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: commentBody("Viewer edited note") }),
      }),
    );
    expect(edited.status).toBe(200);

    expect(
      (await SELF.fetch(request(otherViewer.cookie, `/api/comment-threads/${thread.id}/resolve`, { method: "POST" })))
        .status,
    ).toBe(403);
    expect(
      (await SELF.fetch(request(viewer.cookie, `/api/comment-threads/${thread.id}/resolve`, { method: "POST" })))
        .status,
    ).toBe(200);
    const reopened = await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${thread.id}/reopen`, { method: "POST" }),
    );
    expect(reopened.status).toBe(200);
    expect((await reopened.json<{ thread: CommentThread }>()).thread.resolvedAt).toBeNull();

    const deleted = await SELF.fetch(request(viewer.cookie, `/api/comments/${ownComment.id}`, { method: "DELETE" }));
    expect(deleted.status).toBe(200);
    expect((await deleted.json<{ thread: CommentThread }>()).thread.comments[0]).toMatchObject({
      body: null,
      deletedAt: expect.any(Number),
    });

    const subscriptions = await env.DB.prepare(
      `SELECT user_id FROM subscriptions WHERE resource_type = 'page' AND resource_id = ? ORDER BY user_id`,
    )
      .bind(installed.pageId)
      .all<{ user_id: string }>();
    expect(subscriptions.results.map((row) => row.user_id)).toEqual([installed.userId, viewer.userId].toSorted());
    expect(
      (
        await env.DB.prepare(`SELECT comments FROM page_search_v2 WHERE page_id = ?`)
          .bind(installed.pageId)
          .first<{ comments: string }>()
      )?.comments,
    ).toBe("Owner reply");
  });

  it("does not leak comments from private spaces", async () => {
    const installed = await bootstrap();
    const viewer = await invite(installed.cookie, "private");
    const createdSpace = await SELF.fetch(
      request(installed.cookie, "/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Private comments", visibility: "private" }),
      }),
    );
    const space = (await createdSpace.json<{ space: Space }>()).space;
    const createdPage = await SELF.fetch(
      request(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "document", parentId: null, spaceId: space.id }),
      }),
    );
    const page = (await createdPage.json<{ page: Page }>()).page;
    await createThread(installed.cookie, page.id, "Owner private note");
    expect((await SELF.fetch(request(viewer.cookie, `/api/pages/${page.id}/comments`))).status).toBe(404);
  });

  it("applies valid Yjs-relative anchors and degrades drifted selections to page-level", async () => {
    const installed = await bootstrap();
    const thread = await createThread(installed.cookie, installed.pageId, "Anchored note");
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    const selection = await runInDurableObject(stub, async (instance) => {
      const document = (instance as unknown as { document: Y.Doc }).document;
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Anchor this text");
      paragraph.insert(0, [text]);
      document.getXmlFragment("document-store").insert(0, [paragraph]);
      return {
        head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 6)),
        anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 11)),
      };
    });
    const anchored = await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${thread.id}/anchor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: { yjs: selection } }),
      }),
    );
    expect(anchored.status).toBe(200);
    expect(await anchored.json()).toMatchObject({ anchored: true, thread: { anchored: true } });
    const content = await (
      await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}/content`))
    ).text();
    expect(content).toContain(`"threadId":"${thread.id}"`);
    expect(content).toContain(`"type":"comment"`);

    const drifted = await createThread(installed.cookie, installed.pageId, "Drifted note");
    const foreign = new Y.Doc();
    const position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(foreign.getText("missing"), 0));
    const fallback = await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${drifted.id}/anchor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: { yjs: { head: position, anchor: position } } }),
      }),
    );
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({ anchored: false, thread: { anchored: false } });
  });

  it("migrates legacy Yjs thread bodies once while preserving ids and anchors", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(
      new Request("https://document.internal/noop", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    const legacyThreadId = crypto.randomUUID();
    const legacyCommentId = crypto.randomUUID();
    await runInDurableObject(stub, async (instance) => {
      const document = (instance as unknown as { document: Y.Doc }).document;
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Legacy anchor", {
        "comment--abcdef12": { threadId: legacyThreadId, orphan: false },
      });
      paragraph.insert(0, [text]);
      document.getXmlFragment("document-store").insert(0, [paragraph]);

      const comment = new Y.Map<unknown>();
      comment.set("id", legacyCommentId);
      comment.set("userId", installed.userId);
      comment.set("body", commentBody("Legacy body"));
      comment.set("createdAt", 100);
      comment.set("updatedAt", 200);
      comment.set("reactionsByUser", new Y.Map());
      const comments = new Y.Array<Y.Map<unknown>>();
      comments.push([comment]);
      const thread = new Y.Map<unknown>();
      thread.set("id", legacyThreadId);
      thread.set("comments", comments);
      thread.set("createdAt", 100);
      thread.set("updatedAt", 200);
      thread.set("resolved", false);
      document.getMap("comments").set(legacyThreadId, thread);
    });

    const response = await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}/comments`));
    expect(response.status).toBe(200);
    expect((await response.json<{ threads: CommentThread[] }>()).threads).toEqual([
      expect.objectContaining({
        id: legacyThreadId,
        anchored: true,
        comments: [expect.objectContaining({ id: legacyCommentId, plainText: "Legacy body" })],
      }),
    ]);
    expect(
      await env.DB.prepare(`SELECT completed_at FROM comment_migrations WHERE page_id = ?`)
        .bind(installed.pageId)
        .first(),
    ).toBeTruthy();
    expect(
      await runInDurableObject(
        stub,
        async (instance) => (instance as unknown as { document: Y.Doc }).document.getMap("comments").size,
      ),
    ).toBe(0);

    const repeated = await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}/comments`));
    expect((await repeated.json<{ threads: CommentThread[] }>()).threads).toHaveLength(1);
  });
});

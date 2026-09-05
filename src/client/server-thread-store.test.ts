// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThread } from "../shared/types";
import { api } from "./api";
import { ServerThreadStore } from "./server-thread-store";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: vi.fn(),
}));

const mockedApi = vi.mocked(api);

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    spaceId: "space-1",
    pageId: "page-1",
    createdBy: "user-1",
    resolvedAt: null,
    resolvedBy: null,
    anchored: false,
    canResolve: true,
    comments: [
      {
        id: "comment-1",
        threadId: "thread-1",
        parentId: null,
        userId: "user-1",
        user: { id: "user-1", name: "Ada", email: "ada@example.test" },
        body: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
        plainText: "Hello",
        deletedAt: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("ServerThreadStore", () => {
  beforeEach(() => mockedApi.mockReset());

  it("loads D1 threads, resolves identities, and exposes server permissions", async () => {
    mockedApi.mockResolvedValueOnce({ threads: [thread()] });
    const onError = vi.fn();
    const store = new ServerThreadStore("page-1", "user-1", onError);
    const observed = vi.fn();
    store.subscribe(observed);
    await store.refresh();

    expect(store.getThread("thread-1")).toMatchObject({
      id: "thread-1",
      comments: [{ id: "comment-1", userId: "user-1" }],
      metadata: { anchored: false, canResolve: true },
    });
    expect(store.resolveUsers(["user-1", "removed-user"])).toEqual([
      { id: "user-1", username: "Ada", avatarUrl: "" },
      { id: "removed-user", username: "Former collaborator", avatarUrl: "" },
    ]);
    expect(store.auth.canResolveThread(store.getThread("thread-1"))).toBe(true);
    expect(store.auth.canUpdateComment(store.getThread("thread-1").comments[0]!)).toBe(true);
    expect(store.auth.canAddReaction(store.getThread("thread-1").comments[0]!)).toBe(false);
    expect(observed).toHaveBeenLastCalledWith(expect.any(Map));
    expect(onError).toHaveBeenLastCalledWith("");
  });

  it("keeps its local projection synchronized after replies and soft deletion", async () => {
    const replied = thread({
      comments: [
        ...thread().comments,
        {
          ...thread().comments[0]!,
          id: "comment-2",
          parentId: "comment-1",
          body: [{ type: "paragraph", content: [{ type: "text", text: "Reply" }] }],
          plainText: "Reply",
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });
    mockedApi.mockResolvedValueOnce({ thread: replied });
    const store = new ServerThreadStore("page-1", "user-1", vi.fn());
    const added = await store.addComment({ threadId: "thread-1", comment: { body: [] } });
    expect(added.id).toBe("comment-2");

    mockedApi.mockResolvedValueOnce({
      thread: thread({
        comments: [{ ...thread().comments[0]!, body: null, plainText: "", deletedAt: 3, updatedAt: 3 }],
      }),
    });
    await store.deleteComment({ threadId: "thread-1", commentId: "comment-1" });
    expect(store.getThread("thread-1").comments[0]).toMatchObject({ body: undefined, deletedAt: new Date(3) });
  });

  it("reports refresh failures without discarding an already loaded projection", async () => {
    mockedApi.mockResolvedValueOnce({ threads: [thread()] }).mockRejectedValueOnce(new Error("offline"));
    const onError = vi.fn();
    const store = new ServerThreadStore("page-1", "user-1", onError);
    await store.refresh();
    await store.refresh();
    expect(store.getThreads()).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith("Comments could not be loaded. Try again shortly.");
  });
});

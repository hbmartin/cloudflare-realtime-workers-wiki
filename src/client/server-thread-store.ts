import {
  ThreadStore,
  ThreadStoreAuth,
  type CommentBody as BlockNoteCommentBody,
  type CommentData,
  type ThreadData,
} from "@blocknote/core/comments";
import type { BlockNoteEditor } from "@blocknote/core";
import { absolutePositionToRelativePosition, ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import type { CommentThread, SessionUser } from "../shared/types";
import { api, json } from "./api";

type NotesThreadMetadata = {
  pageId: string;
  createdBy: string;
  anchored: boolean;
  canResolve: boolean;
};

class ServerThreadStoreAuth extends ThreadStoreAuth {
  constructor(private readonly userId: string) {
    super();
  }

  canCreateThread() {
    return true;
  }
  canAddComment() {
    return true;
  }
  canUpdateComment(comment: CommentData) {
    return comment.userId === this.userId;
  }
  canDeleteComment(comment: CommentData) {
    return comment.userId === this.userId;
  }
  canDeleteThread() {
    return false;
  }
  canResolveThread(thread: ThreadData) {
    return Boolean((thread.metadata as NotesThreadMetadata | undefined)?.canResolve);
  }
  canUnresolveThread(thread: ThreadData) {
    return this.canResolveThread(thread);
  }
  canAddReaction() {
    return false;
  }
  canDeleteReaction() {
    return false;
  }
}

function blockNoteThread(thread: CommentThread): ThreadData {
  return {
    type: "thread",
    id: thread.id,
    createdAt: new Date(thread.createdAt),
    updatedAt: new Date(thread.updatedAt),
    comments: thread.comments.map((comment) => ({
      type: "comment",
      id: comment.id,
      userId: comment.userId,
      createdAt: new Date(comment.createdAt),
      updatedAt: new Date(comment.updatedAt),
      reactions: [],
      metadata: { parentId: comment.parentId, plainText: comment.plainText },
      ...(comment.deletedAt
        ? { deletedAt: new Date(comment.deletedAt), body: undefined }
        : { body: comment.body as BlockNoteCommentBody }),
    })),
    resolved: thread.resolvedAt !== null,
    ...(thread.resolvedAt !== null && { resolvedUpdatedAt: new Date(thread.resolvedAt) }),
    ...(thread.resolvedBy && { resolvedBy: thread.resolvedBy }),
    metadata: {
      pageId: thread.pageId,
      createdBy: thread.createdBy,
      anchored: thread.anchored,
      canResolve: thread.canResolve,
    } satisfies NotesThreadMetadata,
  };
}

export class ServerThreadStore extends ThreadStore {
  private readonly threads = new Map<string, ThreadData>();
  private readonly users = new Map<string, SessionUser>();
  private readonly listeners = new Set<(threads: Map<string, ThreadData>) => void>();
  private refreshGeneration = 0;

  constructor(
    private readonly pageId: string,
    userId: string,
    private readonly onError: (message: string) => void,
  ) {
    super(new ServerThreadStoreAuth(userId));
  }

  private publish() {
    const snapshot = this.getThreads();
    for (const listener of this.listeners) listener(snapshot);
  }

  private replace(threads: CommentThread[]) {
    this.threads.clear();
    this.users.clear();
    for (const thread of threads) {
      this.threads.set(thread.id, blockNoteThread(thread));
      for (const comment of thread.comments) this.users.set(comment.user.id, comment.user);
    }
    this.publish();
  }

  private upsert(thread: CommentThread) {
    this.threads.set(thread.id, blockNoteThread(thread));
    for (const comment of thread.comments) this.users.set(comment.user.id, comment.user);
    this.publish();
    return this.getThread(thread.id);
  }

  async refresh(_revision?: number) {
    const generation = ++this.refreshGeneration;
    try {
      const data = await api<{ threads: CommentThread[] }>(`/api/pages/${encodeURIComponent(this.pageId)}/comments`);
      if (generation === this.refreshGeneration) {
        this.replace(data.threads);
        this.onError("");
      }
    } catch {
      if (generation === this.refreshGeneration) this.onError("Comments could not be loaded. Try again shortly.");
    }
  }

  resolveUsers(ids: string[]) {
    return ids.map((id) => {
      const user = this.users.get(id);
      return { id, username: user?.name ?? "Former collaborator", avatarUrl: "" };
    });
  }

  async createThread(options: {
    initialComment: { body: BlockNoteCommentBody; metadata?: unknown };
    metadata?: unknown;
  }) {
    const data = await api<{ thread: CommentThread }>(`/api/pages/${encodeURIComponent(this.pageId)}/comments`, {
      method: "POST",
      body: json(options),
    });
    return this.upsert(data.thread);
  }

  // fallow-ignore-next-line unused-class-member -- Invoked dynamically by BlockNote's CommentsExtension contract.
  async addThreadToDocument(options: {
    threadId: string;
    selection: { head: number; anchor: number };
    editor: BlockNoteEditor<any, any, any>;
  }) {
    const binding = ySyncPluginKey.getState(options.editor.prosemirrorState)?.binding;
    const yjsSelection = binding
      ? {
          head: Y.relativePositionToJSON(
            absolutePositionToRelativePosition(options.selection.head, binding.type, binding.mapping),
          ),
          anchor: Y.relativePositionToJSON(
            absolutePositionToRelativePosition(options.selection.anchor, binding.type, binding.mapping),
          ),
        }
      : undefined;
    const data = await api<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/anchor`,
      {
        method: "POST",
        body: json({ selection: { prosemirror: options.selection, yjs: yjsSelection } }),
      },
    );
    this.upsert(data.thread);
  }

  async addComment(options: { comment: { body: BlockNoteCommentBody; metadata?: unknown }; threadId: string }) {
    const data = await api<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/replies`,
      { method: "POST", body: json({ comment: options.comment }) },
    );
    const thread = this.upsert(data.thread);
    return thread.comments.at(-1)!;
  }

  async updateComment(options: {
    comment: { body: BlockNoteCommentBody; metadata?: unknown };
    threadId: string;
    commentId: string;
  }) {
    const data = await api<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/comments/${encodeURIComponent(options.commentId)}`,
      { method: "PUT", body: json({ comment: options.comment }) },
    );
    this.upsert(data.thread);
  }

  async deleteComment(options: { threadId: string; commentId: string }) {
    const data = await api<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/comments/${encodeURIComponent(options.commentId)}`,
      { method: "DELETE" },
    );
    this.upsert(data.thread);
  }

  async deleteThread() {
    throw new Error("Deleting an entire thread is not supported. Delete your own comments instead.");
  }

  async resolveThread(options: { threadId: string }) {
    const data = await api<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/resolve`,
      { method: "POST" },
    );
    this.upsert(data.thread);
  }

  async unresolveThread(options: { threadId: string }) {
    const data = await api<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/reopen`,
      { method: "POST" },
    );
    this.upsert(data.thread);
  }

  async addReaction() {
    throw new Error("Comment reactions are not enabled.");
  }

  async deleteReaction() {
    throw new Error("Comment reactions are not enabled.");
  }

  getThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Thread not found");
    return thread;
  }

  getThreads() {
    return new Map(this.threads);
  }

  subscribe(listener: (threads: Map<string, ThreadData>) => void) {
    this.listeners.add(listener);
    listener(this.getThreads());
    return () => this.listeners.delete(listener);
  }
}

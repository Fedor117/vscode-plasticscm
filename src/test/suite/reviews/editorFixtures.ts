import { BRANCH_REVIEW_ID, ReviewShell, scenarioAnswer, WORKSPACE_ROOT } from "./fixtures";
import {
  Comment,
  CommentThread,
  CommentThreadCollapsibleState,
  EventEmitter,
  OutputChannel,
  Range,
  SecretStorage,
  Uri,
} from "vscode";
import { IReviewEditorContext, ReviewEditors } from "../../../reviews/reviewEditors";
import { IPostingEditors } from "../../../reviews/reviewPosting";
import { IReviewDraft } from "../../../reviews/reviewWriter";
import { ReviewService } from "../../../reviews/reviewService";

const CONFIG = { cmPath: "cm", millisCommandTimeout: 1000, millisToStop: 1000, millisToWaitUntilUp: 1000 };

/** A service over a fake shell; `text` is replaced by `texts` so no test touches getfile. */
export function reviewService(
    channel: OutputChannel,
    texts: (id: number) => string,
    answer: (command: string, args: string[]) => string = scenarioAnswer,
    workspaceId = "wk",
    root = WORKSPACE_ROOT): { service: ReviewService; shell: ReviewShell } {
  const shell = new ReviewShell();
  shell.answer = answer;
  const service = new ReviewService(workspaceId, root, channel, CONFIG, shell);
  service.text = (id: number) => Promise.resolve(id < 0 ? "" : texts(id));
  return { service, shell };
}

/** The active-review context the session would pass for a loaded review. */
export async function loadContext(service: ReviewService, reviewId = BRANCH_REVIEW_ID): Promise<IReviewEditorContext> {
  const review = await service.review(reviewId);
  if (!review) {
    throw new Error(`Review ${reviewId} is not in the fixture.`);
  }
  const files = await service.loadFiles(review);
  const discussions = await service.loadDiscussions(review, files);
  return { files, review, service, threads: discussions.threads };
}

/** `count` distinct lines, so any line maps through `mapReviewLine`'s unique-context check. */
export function numberedText(count: number, prefix = "line", separator = "\n"): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index};`).join(separator);
}

/** Polls until `predicate` holds; editor and tab events arrive asynchronously. */
export async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error("Timed out waiting for the condition.");
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

interface IEditorsHarness {
  threads: Map<string, CommentThread[]>;
  diffs: Map<string, unknown>;
  targets: Map<string, unknown>;
  threadIds: WeakMap<CommentThread, number>;
}

export function harness(editors: ReviewEditors): IEditorsHarness {
  return editors as unknown as IEditorsHarness;
}

export function allThreads(editors: ReviewEditors): CommentThread[] {
  return Array.from(harness(editors).threads.values()).reduce((all, list) => all.concat(list), [] as CommentThread[]);
}

/** The native threads on one document. */
export function threadsOn(editors: ReviewEditors, uri: Uri): CommentThread[] {
  return harness(editors).threads.get(uri.toString()) ?? [];
}

/** The native thread showing review thread `id`. */
export function nativeThread(editors: ReviewEditors, id: number): CommentThread | undefined {
  return allThreads(editors).find(thread => harness(editors).threadIds.get(thread) === id);
}

export interface IFakeThread extends CommentThread {
  disposed: boolean;
}

/** A thread as VS Code hands it to a `comments/commentThread/context` command. */
export function fakeThread(uri: Uri, line = 0, comments: Comment[] = []): IFakeThread {
  const thread: IFakeThread = {
    canReply: true,
    collapsibleState: CommentThreadCollapsibleState.Expanded,
    comments,
    dispose: () => {
      thread.disposed = true;
    },
    disposed: false,
    range: new Range(line, 0, line, 0),
    uri,
  };
  return thread;
}

export interface IFakePostingEditors extends IPostingEditors {
  adopted: CommentThread[];
  disposed: CommentThread[];
  enabled: boolean[];
  replies: Map<CommentThread, IReviewDraft>;
}

/** Stands in for ReviewEditors: fixed drafts, and a record of what posting asked for. */
export function fakePostingEditors(draft: IReviewDraft): IFakePostingEditors {
  const editors: IFakePostingEditors = {
    adopt: thread => {
      editors.adopted.push(thread);
    },
    adopted: [],
    disposeThread: thread => {
      editors.disposed.push(thread);
      thread.dispose();
    },
    disposed: [],
    draftAt: (_uri, line) => Promise.resolve({ ...draft, location: line }),
    enabled: [],
    keepLocalComment: () => true,
    replies: new Map(),
    replyDraft: thread => {
      const target = editors.replies.get(thread);
      return target && { ...target, key: `${target.key}-${editors.replies.size}-${Date.now()}-${Math.random()}` };
    },
    setPostingEnabled: enabled => {
      editors.enabled.push(enabled);
    },
    threadOf: () => undefined,
  };
  return editors;
}

/** SecretStorage in memory. */
export function memorySecrets(initial: Record<string, string> = {}): SecretStorage & { values: Map<string, string> } {
  const values = new Map(Object.keys(initial).map(key => [ key, initial[key] ] as [string, string]));
  const changes = new EventEmitter<{ key: string }>();
  return {
    delete: key => {
      values.delete(key);
      return Promise.resolve();
    },
    get: key => Promise.resolve(values.get(key)),
    onDidChange: changes.event,
    store: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    values,
  };
}

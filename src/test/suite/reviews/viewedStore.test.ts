import { FileChangeStatus, RevisionType } from "../../../models";
import {
  IViewedMemento,
  MAX_VIEWED_REVIEWS,
  repoName,
  reviewKey,
  revisionKey,
  VIEWED_STATE_KEY,
  ViewedStore,
} from "../../../reviews/viewedStore";
import { expect } from "chai";
import { file } from "./fixtures";

interface IFakeMemento extends IViewedMemento {
  values: Map<string, unknown>;
  writes: number;
}

function memento(): IFakeMemento {
  const fake: IFakeMemento = {
    get: <T>(key: string) => fake.values.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      fake.values.set(key, value);
      fake.writes++;
      return Promise.resolve();
    },
    values: new Map<string, unknown>(),
    writes: 0,
  };
  return fake;
}

describe("Viewed store", () => {
  const review = reviewKey("Nimbus/Nimbus@acme-studio@unity", 12831);

  it("keys reviews and revisions by repository name and id", () => {
    expect(review).to.equal("nimbus/nimbus#12831");
    expect(repoName("Nimbus/Nimbus@1234567890123@cloud")).to.equal("nimbus/nimbus");
    expect(revisionKey(file({ repository: "repo@org@cloud", revisionId: 11 }))).to.equal("repo#11");
    // A deletion has no right side; its key is the deleted revision on the left.
    expect(revisionKey(file({ repository: "repo@org@cloud", revisionId: 11, status: FileChangeStatus.Deleted })))
      .to.equal("repo#del:11");
  });

  it("stores viewed revisions in the memento and reads them back in a new store", async () => {
    const state = memento();
    const store = new ViewedStore(state, () => 1000);
    const row = file();
    expect(store.isViewed(review, row)).to.equal(false);
    await store.set(review, [row], true);
    expect(store.isViewed(review, row)).to.equal(true);
    expect(state.values.get(VIEWED_STATE_KEY)).to.deep.equal({ [review]: { revs: ["repo#11"], t: 1000 }});
    expect(new ViewedStore(state).isViewed(review, row)).to.equal(true);
    await store.set(review, [row], false);
    expect(store.isViewed(review, row)).to.equal(false);
    // A review with nothing viewed is dropped, not kept empty.
    expect(state.values.get(VIEWED_STATE_KEY)).to.deep.equal({});
  });

  it("keeps a file viewed under a new path and unviews it for a new revision", async () => {
    const store = new ViewedStore(memento());
    await store.set(review, [file({ path: "/Code/Old.cs", revisionId: 11 })], true);
    expect(store.isViewed(review, file({ oldPath: "/Code/Old.cs", path: "/Code/New.cs", revisionId: 11 })))
      .to.equal(true);
    expect(store.isViewed(review, file({ revisionId: 12 }))).to.equal(false);
    // The same revision in another review is that review's business.
    expect(store.isViewed(reviewKey("repo", 1), file({ revisionId: 11 }))).to.equal(false);
  });

  it("tells a deletion from the revision it deleted", async () => {
    const store = new ViewedStore(memento());
    const deleted = file({ revisionId: 11, status: FileChangeStatus.Deleted });
    await store.set(review, [deleted], true);
    expect(store.isViewed(review, deleted)).to.equal(true);
    expect(store.isViewed(review, file({ revisionId: 11 }))).to.equal(false);
  });

  it("treats one repository under different server aliases and cases as one", async () => {
    const store = new ViewedStore(memento());
    await store.set(reviewKey("repo@a@cloud", 5), [file({ repository: "repo@a@cloud" })], true);
    expect(store.isViewed(reviewKey("Repo@b@unity", 5), file({ repository: "REPO@b@unity" }))).to.equal(true);
  });

  it("never marks directory records and counts viewed files", async () => {
    const store = new ViewedStore(memento());
    const directory = file({ revisionId: 30, revisionType: RevisionType.Directory });
    const files = [ file({ revisionId: 1 }), file({ revisionId: 2 }), directory ];
    await store.set(review, files, true);
    expect(store.isViewed(review, directory)).to.equal(false);
    expect(store.count(review, files)).to.equal(2);
  });

  it("keeps the 100 most recently touched reviews", async () => {
    const state = memento();
    let clock = 0;
    const store = new ViewedStore(state, () => ++clock);
    for (let id = 1; id <= MAX_VIEWED_REVIEWS; id++) {
      await store.set(reviewKey("repo", id), [file()], true);
    }
    // Touching review 1 again makes review 2 the oldest.
    await store.set(reviewKey("repo", 1), [file({ revisionId: 99 })], true);
    await store.set(reviewKey("repo", 2081), [file()], true);
    const kept = Object.keys(state.values.get(VIEWED_STATE_KEY) as object);
    expect(kept).to.have.length(MAX_VIEWED_REVIEWS);
    expect(kept).to.include(reviewKey("repo", 1));
    expect(kept).to.include(reviewKey("repo", 2081));
    expect(kept).to.not.include(reviewKey("repo", 2));
    expect(store.isViewed(reviewKey("repo", 2), file())).to.equal(false);
    expect(store.isViewed(reviewKey("repo", 1), file({ revisionId: 99 }))).to.equal(true);
  });

  it("never changes the object the memento hands out", async () => {
    const state = memento();
    const frozen = Object.freeze({ [review]: Object.freeze({ revs: Object.freeze(["repo#11"]), t: 1 }) });
    state.values.set(VIEWED_STATE_KEY, frozen);
    const store = new ViewedStore(state, () => 2);
    await store.set(review, [file({ revisionId: 12 })], true);
    expect(frozen[review].revs).to.deep.equal(["repo#11"]);
    expect(store.isViewed(review, file({ revisionId: 11 }))).to.equal(true);
    expect(store.isViewed(review, file({ revisionId: 12 }))).to.equal(true);
  });

  it("follows a value another window wrote and ignores malformed state", () => {
    const state = memento();
    const store = new ViewedStore(state);
    expect(store.isViewed(review, file())).to.equal(false);
    state.values.set(VIEWED_STATE_KEY, { [review]: { revs: ["repo#11"], t: 5 }});
    expect(store.isViewed(review, file())).to.equal(true);
    state.values.set(VIEWED_STATE_KEY, "garbage");
    expect(store.isViewed(review, file())).to.equal(false);
    state.values.set(VIEWED_STATE_KEY, { [review]: { revs: "nope", t: 5 }});
    expect(store.isViewed(review, file())).to.equal(false);
  });
});

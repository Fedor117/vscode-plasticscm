import {
  candidateItems,
  formatReviewerNames,
  IReviewerItem,
  parseReviewerNames,
  pickReviewers,
} from "../../commands/reviewerPicker";
import { EventEmitter, QuickPickItemKind, window } from "vscode";
import { expect } from "chai";

/** The reviewers picker, on a stand-in for VS Code's QuickPick. Every name is made up. */

const MEMBERS = [
  { name: "sam.rivera@example.com", type: "user" as const },
  { name: "Dana.Kim@example.com", type: "user" as const },
  { name: "5b0c1e2a-0000-4000-8000-00000000a001-rw", type: "group" as const },
  { name: "Leads", type: "group" as const },
  { name: "Client Engineers", type: "group" as const },
  { name: "odd, name", type: "user" as const },
];

const OPTIONS = { placeHolder: "Reviewers", prompt: "Names", title: "Add Reviewers" };

interface IFakePicker {
  items: readonly IReviewerItem[];
  selectedItems: readonly IReviewerItem[];
  busy: boolean;
  canSelectMany: boolean;
  disposed: boolean;
  show(): void;
  dispose(): void;
  onDidAccept: EventEmitter<void>["event"];
  onDidTriggerButton: EventEmitter<unknown>["event"];
  onDidHide: EventEmitter<void>["event"];
  /** Checks the rows with these labels. */
  check(...labels: string[]): void;
  accept(): void;
  pressButton(): void;
  hide(): void;
}

interface IInputBox {
  value?: string;
  validateInput?: (text: string) => string | undefined;
}

/**
 * Runs `task` with window.createQuickPick answering a fake picker, which `drive`
 * works; the input box answers `typed` and its options are returned.
 */
async function picking<T>(
    task: () => Promise<T>,
    drive: (picker: IFakePicker) => void | Promise<void>,
    typed?: string): Promise<{ result: T; picker: IFakePicker; boxes: IInputBox[] }> {
  const api = window as unknown as {
    createQuickPick: () => unknown;
    showInputBox: (options: IInputBox) => Thenable<string | undefined>;
  };
  const { createQuickPick, showInputBox } = api;
  const boxes: IInputBox[] = [];
  const accepted = new EventEmitter<void>();
  const pressed = new EventEmitter<unknown>();
  const hidden = new EventEmitter<void>();
  const picker: IFakePicker = {
    accept: () => accepted.fire(),
    busy: false,
    canSelectMany: false,
    check: (...labels) => {
      picker.selectedItems = picker.items.filter(item => labels.includes(item.label));
    },
    dispose: () => {
      picker.disposed = true;
    },
    disposed: false,
    hide: () => hidden.fire(),
    items: [],
    onDidAccept: accepted.event,
    onDidHide: hidden.event,
    onDidTriggerButton: pressed.event,
    pressButton: () => pressed.fire(undefined),
    selectedItems: [],
    show: () => undefined,
  };
  api.createQuickPick = () => picker;
  api.showInputBox = options => {
    boxes.push(options);
    return Promise.resolve(typed);
  };
  try {
    const done = task();
    // Lets the rows load, as they would while the user looks at the picker.
    await new Promise(resolve => setTimeout(resolve, 0));
    await drive(picker);
    return { boxes, picker, result: await done };
  } finally {
    api.createQuickPick = createQuickPick;
    api.showInputBox = showInputBox;
    [ accepted, pressed, hidden ].forEach(emitter => emitter.dispose());
  }
}

describe("Reviewer picker", () => {
  describe("candidateItems", () => {
    const labels = (items: IReviewerItem[]) =>
      items.map(item => (item.kind === QuickPickItemKind.Separator ? `-- ${item.label}` : item.label));

    it("lists groups, then users, each by name, without project role groups or names cm cannot take", () => {
      const items = candidateItems(MEMBERS);
      expect(labels(items)).to.eql([
        "-- Groups", "Client Engineers", "Leads", "-- Users", "Dana.Kim@example.com", "sam.rivera@example.com",
      ]);
      expect(items[1]).to.deep.include({ description: "group", reviewer: { name: "Client Engineers", type: "group" }});
      expect(items[4]).to.deep.include({ reviewer: { name: "Dana.Kim@example.com", type: "user" }});
    });

    it("leaves out who is a reviewer already, whatever the case, and a heading with nobody under it", () => {
      expect(labels(candidateItems(MEMBERS, [
        { name: "dana.kim@example.com", type: "user" },
        { name: "Leads", type: "group" },
        { name: "client engineers", type: "group" },
        // A group of a user's name does not take the user out.
        { name: "sam.rivera@example.com", type: "group" },
      ]))).to.eql([ "-- Users", "sam.rivera@example.com" ]);
      expect(candidateItems([])).to.eql([]);
    });
  });

  it("writes names the way the box reads them", () => {
    const names = { groups: [ "Leads", "Client Engineers" ], users: ["dana.kim@example.com"] };
    expect(formatReviewerNames(names)).to.equal("dana.kim@example.com, group:Leads, group:Client Engineers");
    expect(parseReviewerNames(formatReviewerNames(names)).names).to.eql(names);
    expect(formatReviewerNames({})).to.equal("");
  });

  describe("pickReviewers", () => {
    const loaded = () => Promise.resolve(candidateItems(MEMBERS));
    const pick = (optional: boolean, loading: Promise<IReviewerItem[]> = loaded()) =>
      () => pickReviewers(loading, { ...OPTIONS, optional });

    it("answers the checked users and groups", async () => {
      const { boxes, picker, result } = await picking(pick(false), fake => {
        expect(fake.canSelectMany).to.equal(true);
        expect(fake.busy).to.equal(false);
        fake.check("Leads", "sam.rivera@example.com");
        fake.accept();
      });
      expect(result).to.eql({ groups: ["Leads"], users: ["sam.rivera@example.com"] });
      expect(boxes).to.eql([]);
      expect(picker.disposed).to.equal(true);
    });

    it("takes nobody as an answer only when reviewers are optional", async () => {
      expect((await picking(pick(true), fake => fake.accept())).result).to.eql({ groups: [], users: [] });
      expect((await picking(pick(false), fake => fake.accept())).result).to.equal(undefined);
    });

    it("answers nothing when dismissed", async () => {
      const { picker, result } = await picking(pick(true), fake => {
        fake.check("Leads");
        fake.hide();
      });
      expect(result).to.equal(undefined);
      expect(picker.disposed).to.equal(true);
    });

    it("takes typed names from the pencil, starting from the checked rows", async () => {
      const { boxes, result } = await picking(pick(false), fake => {
        fake.check("Leads", "Dana.Kim@example.com");
        fake.pressButton();
      }, "Dana.Kim@example.com, group:Leads, new.hire@example.com");
      expect(boxes.map(box => box.value)).to.eql(["Dana.Kim@example.com, group:Leads"]);
      expect(result).to.eql({ groups: ["Leads"], users: [ "Dana.Kim@example.com", "new.hire@example.com" ] });
    });

    it("asks for typed names when the list is empty or cannot be loaded", async () => {
      for (const loading of [ Promise.resolve([]), Promise.reject(new Error("No such server.")) ]) {
        const { boxes, picker, result } = await picking(pick(false, loading), () => undefined, "group:Leads");
        expect(boxes.map(box => box.value)).to.eql([""]);
        expect(result).to.eql({ groups: ["Leads"], users: [] });
        expect(picker.disposed).to.equal(true);
      }
    });

    it("lets the typed box stay empty only when reviewers are optional", async () => {
      const typing = async (optional: boolean) =>
        picking(pick(optional, Promise.resolve([])), () => undefined, " ");
      const optional = await typing(true);
      expect(optional.boxes[0].validateInput?.(" ")).to.equal(undefined);
      expect(optional.boxes[0].validateInput?.("bad\"name")).to.match(/^bad"name: /);
      expect(optional.result).to.eql({});

      const required = await typing(false);
      expect(required.boxes[0].validateInput?.(" ")).to.equal("Name at least one reviewer.");
      expect(required.result).to.equal(undefined);
    });
  });
});

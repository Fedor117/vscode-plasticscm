import * as fs from "fs";
import * as path from "path";
import {
  AUTHOR,
  BRANCH_ID,
  BRANCH_NAME,
  BRANCH_REVIEW_ID,
  branchRowXml,
  CHANGESET_REVIEW_ID,
  comment,
  commentsXml,
  HEAD,
  ME,
  REPOSITORY,
  ReviewShell,
  reviewsXml,
  SCENARIO_COMMENTS,
  scenarioAnswer,
  WORKSPACE_ROOT,
} from "./fixtures";
import {
  commands,
  ConfigurationTarget,
  env,
  EventEmitter,
  Memento,
  OutputChannel,
  Tab,
  TabInputCustom,
  TabInputText,
  TabInputTextDiff,
  TabInputWebview,
  TreeView,
  Uri,
  ViewColumn,
  window,
  workspace,
} from "vscode";
import { CONSENT_MESSAGE, ITokenCm, tokenKey } from "../../../reviews/reviewTokens";
import { CONTEXT_KEYS, PlasticReviews } from "../../../reviews/plasticReviews";
import { FakeTokenCm, syntheticJwt, tokenId } from "./tokenFixtures";
import {
  isOverviewTab,
  MARKDOWN_PREVIEW_EDITOR,
  overviewTabReview,
  reviewOverviewUri,
  reviewScheme,
} from "../../../reviews/reviewEditors";
import { layoutTarget, REVIEW_COMMAND_PREFIX, REVIEW_COMMANDS, statusItems } from "../../../reviews/reviewActions";
import { memorySecrets, numberedText, until } from "./editorFixtures";
import { ReviewTreeNode, ReviewTreeProvider } from "../../../reviews/reviewTreeProvider";
import { DiscussionsProvider } from "../../../reviews/discussionsProvider";
import { expect } from "chai";
import { FakeRest } from "./restFixtures";
import { fileKey } from "../../../reviews/models";
import { IReviewPickItem } from "../../../reviews/reviewPresentation";
import { IReviewPostingOptions } from "../../../reviews/reviewPosting";
import { OverviewLinkTarget } from "../../../reviews/reviewOverview";
import { review as reviewFixture } from "./viewFixtures";
import { reviewLinkUri } from "../../../reviews/reviewLinks";
import { ReviewService } from "../../../reviews/reviewService";
import { ReviewWriter } from "../../../reviews/reviewWriter";

interface IMenuEntry {
  command: string;
  when?: string;
  group?: string;
}

interface IManifest {
  name: string;
  publisher: string;
  activationEvents: string[];
  contributes: {
    commands: Array<{
      command: string;
      title: string;
      category?: string;
      icon?: string | { light: string; dark: string };
    }>;
    menus: { [menu: string]: IMenuEntry[] };
    views: { [container: string]: Array<{ id: string; when?: string }> };
    viewsWelcome?: Array<{ view: string; when?: string; contents?: string }>;
    keybindings?: Array<{ command: string; when?: string }>;
    configuration: { properties: { [key: string]: unknown } };
    "markdown.previewStyles"?: string[];
  };
}

// out/test/suite/reviews → the extension root.
const manifest = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "..", "package.json"), "utf8")) as IManifest;
const contributes = manifest.contributes;
const reviewCommands = contributes.commands
  .map(entry => entry.command)
  .filter(id => id.startsWith(REVIEW_COMMAND_PREFIX));
const SHELL_CONFIG = { cmPath: "cm", millisCommandTimeout: 1000, millisToStop: 1000, millisToWaitUntilUp: 1000 };
/** The id VS Code gives the extension, and so its context: the authority of the Overview's links. */
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

/** Every `when` clause the manifest has. */
function whenClauses(): string[] {
  const clauses: Array<string | undefined> = [];
  Object.keys(contributes.menus).forEach(menu => contributes.menus[menu].forEach(entry => clauses.push(entry.when)));
  Object.keys(contributes.views).forEach(container =>
    contributes.views[container].forEach(view => clauses.push(view.when)));
  (contributes.viewsWelcome ?? []).forEach(entry => clauses.push(entry.when));
  (contributes.keybindings ?? []).forEach(entry => clauses.push(entry.when));
  return clauses.filter((when): when is string => !!when);
}

/**
 * The context keys a `when` clause reads: every term's left-hand side. Values
 * (the right-hand side of `==`, `!=` and `=~`, such as view ids and regular
 * expressions) are not keys.
 */
function contextKeys(when: string): string[] {
  return when.split(/&&|\|\|/)
    .map(term => term.trim().replace(/^[(!\s]+|[)\s]+$/g, ""))
    .map(term => term.split(/\s*(?:==|!=|=~|<=|>=|<|>)\s*|\s+(?:not\s+)?in\s+/)[0].trim())
    .filter(Boolean);
}

function memento(): Memento {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string, fallback?: T) => (values.has(key) ? values.get(key) as T : fallback),
    keys: () => Array.from(values.keys()),
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  } as Memento;
}

describe("Plastic Reviews contributions", () => {
  it("contributes every command a menu names, and every review command it contributes is registered code", () => {
    const contributed = new Set(contributes.commands.map(entry => entry.command));
    const missing: string[] = [];
    Object.keys(contributes.menus).forEach(menu => contributes.menus[menu].forEach(entry => {
      if (!contributed.has(entry.command)) {
        missing.push(`${menu}: ${entry.command}`);
      }
    }));
    expect(missing).to.deep.equal([]);
    expect(reviewCommands.slice().sort())
      .to.deep.equal(REVIEW_COMMANDS.map(name => REVIEW_COMMAND_PREFIX + name).sort());
  });

  it("uses no plastic-scm.reviews context key in a when clause that CONTEXT_KEYS does not list", () => {
    const known = new Set<string>(Object.values(CONTEXT_KEYS));
    const unknown = whenClauses()
      .reduce((keys, when) => keys.concat(contextKeys(when)), [] as string[])
      .filter(key => key.startsWith(REVIEW_COMMAND_PREFIX) && !known.has(key));
    expect(unknown).to.deep.equal([]);
    // The parser sees keys, not values: a regular expression naming the views is not a key.
    expect(contextKeys("view =~ /^plastic-scm\\.reviews\\./ && !plastic-scm.reviews.hasUpdates"))
      .to.deep.equal([ "view", "plastic-scm.reviews.hasUpdates" ]);
  });

  it("colours the viewed and status icons with files that exist, as the codicons cannot be", () => {
    const root = path.resolve(__dirname, "..", "..", "..", "..");
    const markUnviewed = contributes.commands.find(entry => entry.command === "plastic-scm.reviews.markUnviewed")!;
    expect(markUnviewed.icon).to.deep.equal({
      dark: "images/icons/dark/review-viewed.svg",
      light: "images/icons/light/review-viewed.svg",
    });
    const icon = markUnviewed.icon as { light: string; dark: string };
    expect([ icon.light, icon.dark ].every(file => fs.existsSync(path.join(root, file)))).to.equal(true);
    // The current status sits under a right-aligned "Current" separator; every status has its own coloured icon.
    const items = statusItems("Rework required");
    expect(items.map(item => item.status ?? `[${item.label}]`))
      .to.deep.equal([ "Under review", "[Current]", "Rework required", "Reviewed" ]);
    expect(items.some(item => item.label.includes("$("))).to.equal(false);
    for (const item of items.filter(candidate => candidate.status)) {
      const paths = item.iconPath as { light: { fsPath: string }; dark: { fsPath: string } };
      expect(fs.existsSync(paths.light.fsPath) && fs.existsSync(paths.dark.fsPath), item.label).to.equal(true);
      expect(item.detail).to.equal(undefined);
    }
  });

  it("offers Mark All as Viewed inline on Changes and changesets only, and no layout switch beside updates", () => {
    const markAll = contributes.menus["view/item/context"]
      .filter(entry => entry.command === "plastic-scm.reviews.markAllViewed" && entry.group === "inline@1");
    expect(markAll.map(entry => entry.when))
      .to.deep.equal(["view == plastic-scm.reviews.active && viewItem =~ /^(changes|changeset)(;|$)/"]);
    const title = contributes.menus["view/title"];
    for (const command of [ "plastic-scm.reviews.viewAsList", "plastic-scm.reviews.viewAsTree" ]) {
      expect(title.find(entry => entry.command === command)?.when).to.contain("!plastic-scm.reviews.hasUpdates");
    }
  });

  it("replaces the webview with three tree views and drops the old comment commands", () => {
    expect(contributes.views["plastic-scm-reviews"].map(view => view.id)).to.deep.equal([
      "plastic-scm.reviews.list",
      "plastic-scm.reviews.active",
      "plastic-scm.reviews.discussions",
    ]);
    expect(reviewCommands).to.not.include.members([
      "plastic-scm.reviews.addComment",
      "plastic-scm.reviews.replyToComment",
    ]);
    expect(Object.keys(contributes.configuration.properties)).to.include.members([
      "plastic-scm.reviews.fileLayout",
      "plastic-scm.reviews.experimentalPosting",
    ]);
    const palette = new Map(contributes.menus.commandPalette.map(entry => [ entry.command, entry.when ]));
    // Row commands need their row; the palette must not offer them.
    for (const name of [ "open", "openChanges", "openDiscussion", "postComment", "sendAgain" ]) {
      expect(palette.get(REVIEW_COMMAND_PREFIX + name), name).to.equal("false");
    }
    // Without a Plastic workspace the views are hidden, so the palette hides what would open or fill them.
    for (const name of [ "refresh", "find", "openById", "show" ]) {
      expect(palette.get(REVIEW_COMMAND_PREFIX + name), name).to.equal("plastic-scm.active");
    }
    for (const view of contributes.views["plastic-scm-reviews"]) {
      expect(view.when, view.id).to.equal("plastic-scm.active");
    }
  });

  it("puts Find Review… in the Reviews title bar where Open Review by ID… was, which stays a palette command", () => {
    const find = contributes.commands.find(entry => entry.command === "plastic-scm.reviews.find");
    expect(find).to.deep.equal({
      category: "Plastic Reviews",
      command: "plastic-scm.reviews.find",
      icon: "$(search)",
      title: "Find Review…",
    });
    expect(contributes.commands.find(entry => entry.command === "plastic-scm.reviews.openById")?.title)
      .to.equal("Open Review by ID…");
    const title = contributes.menus["view/title"];
    const inline = title.filter(entry => entry.when?.startsWith("view == plastic-scm.reviews.list") &&
      entry.group?.startsWith("navigation"));
    expect(inline.map(entry => [ entry.command, entry.group ])).to.deep.equal([
      [ "plastic-scm.reviews.find", "navigation@1" ],
      [ "plastic-scm.reviews.refresh", "navigation@2" ],
    ]);
    expect(inline[0].when).to.equal("view == plastic-scm.reviews.list");
    expect(title.some(entry => entry.command === "plastic-scm.reviews.openById")).to.equal(false);
    // With no review open, the Review view points at Find Review… too, which also opens a review by its number.
    const welcome = contributes.viewsWelcome?.find(entry => entry.view === "plastic-scm.reviews.active");
    expect(welcome?.contents).to.contain("[Find Review…](command:plastic-scm.reviews.find)")
      .and.not.contain("plastic-scm.reviews.openById");
  });

  it("activates for a restored review tab, so its content provider exists when VS Code retries", () => {
    expect(manifest.activationEvents).to.include(`onFileSystem:${reviewScheme}`);
  });

  it("contributes Add Me as Reviewer to the Review view's title, the Reviews rows and the palette, all experimental",
    () => {
      const id = "plastic-scm.reviews.addMeAsReviewer";
      expect(contributes.commands.find(entry => entry.command === id)).to.deep.equal({
        category: "Plastic Reviews",
        command: id,
        icon: "$(person-add)",
        title: "Add Me as Reviewer",
      });
      const entries = (menu: string) => contributes.menus[menu].filter(entry => entry.command === id)
        .map(entry => ({ group: entry.group, when: entry.when }));
      const setting = "config.plastic-scm.reviews.experimentalPosting";
      expect(entries("view/title")).to.deep.equal([{
        group: "navigation@2",
        when: `view == plastic-scm.reviews.active && plastic-scm.reviews.hasActiveReview && ${setting} && ` +
          CONTEXT_KEYS.canAddMeAsReviewer,
      }]);
      expect(entries("view/item/context")).to.deep.equal([{
        group: "2_status@2",
        when: `view == plastic-scm.reviews.list && viewItem =~ /^review;/ && ${setting}`,
      }]);
      expect(entries("commandPalette"))
        .to.deep.equal([{ group: undefined, when: `plastic-scm.reviews.hasActiveReview && ${setting}` }]);
      expect(entries("editor/title")).to.deep.equal([]);
    });

  it("offers Open in Unity Version Control whatever the setting, and Revoke Review Access Token only with it", () => {
    const command = (name: string) =>
      contributes.commands.find(entry => entry.command === REVIEW_COMMAND_PREFIX + name);
    expect(command("openInDesktop")).to.deep.equal({
      category: "Plastic Reviews",
      command: "plastic-scm.reviews.openInDesktop",
      icon: "$(link-external)",
      title: "Open in Unity Version Control",
    });
    expect(command("revokeAccessToken")).to.deep.equal({
      category: "Plastic Reviews",
      command: "plastic-scm.reviews.revokeAccessToken",
      title: "Revoke Review Access Token",
    });
    expect([ command("configurePosting"), command("forgetPosting") ]).to.deep.equal([ undefined, undefined ]);
    const entries = (menu: string, name: string) => contributes.menus[menu]
      .filter(entry => entry.command === REVIEW_COMMAND_PREFIX + name)
      .map(entry => ({ group: entry.group, when: entry.when }));
    expect(entries("view/item/context", "openInDesktop"))
      .to.deep.equal([{ group: "1_open@2", when: "view == plastic-scm.reviews.list && viewItem =~ /^review;/" }]);
    expect(entries("view/title", "openInDesktop")).to.deep.equal([{
      group: "1_review@3", when: "view == plastic-scm.reviews.active && plastic-scm.reviews.hasActiveReview",
    }]);
    expect(entries("commandPalette", "openInDesktop"))
      .to.deep.equal([{ group: undefined, when: "plastic-scm.reviews.hasActiveReview" }]);
    const setting = "config.plastic-scm.reviews.experimentalPosting";
    expect(entries("view/title", "revokeAccessToken")).to.deep.equal([{
      group: "8_experimental@1",
      when: `view == plastic-scm.reviews.list && ${setting} && ${CONTEXT_KEYS.hasAccessToken}`,
    }]);
    expect(entries("commandPalette", "revokeAccessToken"))
      .to.deep.equal([{ group: undefined, when: `${setting} && ${CONTEXT_KEYS.hasAccessToken}` }]);
    const posting = contributes.configuration.properties["plastic-scm.reviews.experimentalPosting"] as {
      markdownDescription: string;
    };
    expect(posting.markdownDescription).to.contain("personal access token").and.contain("with cm")
      .and.contain("Unity Version Control Server REST API").and.not.contain("hosted API");
  });

  it("puts the review's actions on the Overview's tab, scoped to the active review's Overview", () => {
    const overview = contributes.menus["editor/title"]
      .filter(entry => entry.when?.includes(CONTEXT_KEYS.activeEditorIsOverview));
    const commandsAndGroups = overview.map(entry =>
      [ entry.command.substring(REVIEW_COMMAND_PREFIX.length), entry.group ]);
    expect(commandsAndGroups).to.deep.equal([
      [ "openNextUnviewed", "navigation@1" ],
      [ "setStatus", "navigation@2" ],
      [ "loadUpdates", "navigation@3" ],
      [ "refreshReview", "navigation@3" ],
    ]);
    // The scheme is that of the editor in their own group; our key says it shows the active review's Overview.
    const scoped = /^resourceScheme == plastic-review && plastic-scm\.reviews\.activeEditorIsOverview\b/;
    for (const entry of overview) {
      expect(entry.when).to.match(scoped);
    }
    expect(overview[2].when).to.match(/ && plastic-scm\.reviews\.hasUpdates$/);
    expect(overview[3].when).to.match(/ && !plastic-scm\.reviews\.hasUpdates$/);
  });

  it("styles the Overview with a shipped stylesheet whose every rule stays inside the Overview's page", () => {
    const root = path.resolve(__dirname, "..", "..", "..", "..");
    expect(contributes["markdown.previewStyles"]).to.deep.equal(["./media/reviews/overview.css"]);
    const css = fs.readFileSync(path.join(root, "media", "reviews", "overview.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Every Markdown preview loads it, so each selector names the page's wrapper.
    const selectors = (css.match(/[^{}]+(?=\{)/g) ?? [])
      .filter(prelude => !prelude.trim().startsWith("@"))
      .reduce<string[]>((all, prelude) => all.concat(prelude.split(",").map(selector => selector.trim())), []);
    expect(selectors.length).to.be.greaterThan(50);
    expect(selectors.filter(selector => !selector.includes(".plastic-review"))).to.deep.equal([]);
    // Theme colours only; the one literal is the avatars' white initials on the colours the page sets.
    expect(css.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi)).to.deep.equal(["#ffffff"]);
    // The package ships it: no exclusion in .vscodeignore covers media/ or the stylesheet.
    const excluded = fs.readFileSync(path.join(root, ".vscodeignore"), "utf8").split("\n")
      .map(line => line.trim()).filter(line => line && !line.startsWith("#") && !line.startsWith("!"));
    expect(excluded.filter(pattern => /^(?:\*\*\/)?media\b|\.css\b/.test(pattern))).to.deep.equal([]);
  });

  it("lays the Overview out as the artboards do, in colours that read in light and dark themes", () => {
    const root = path.resolve(__dirname, "..", "..", "..", "..");
    const css = fs.readFileSync(path.join(root, "media", "reviews", "overview.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
    // One or two reviewer cards share the row; the tiles are four in a row or two by two, never three and one.
    expect(css).to.contain(".plastic-review .people { display: grid; grid-template-columns: repeat(auto-fit,");
    expect(css).to.contain(".plastic-review .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));");
    expect(css).to.contain("@media (max-width: 640px) { .plastic-review .tiles { grid-template-columns: " +
      "repeat(2, minmax(0, 1fr)); } }");
    // Chart colours stay close to themselves on dark themes and go halfway to the editor's text on light ones.
    expect(css).to.contain("--pr-emphasis: var(--vscode-editor-foreground, var(--vscode-foreground));");
    expect(css).to.contain("--pr-orange: color-mix(in srgb, var(--vscode-charts-orange) 85%, var(--pr-emphasis));");
    expect(css).to.contain(".vscode-light .plastic-review, .vscode-high-contrast-light .plastic-review { " +
      "--pr-grey-text: var(--vscode-foreground); --pr-blue: color-mix(in srgb, var(--vscode-charts-blue) 50%,");
    // File letters keep a colour without the Git extension, and a failed stage is not drawn as information.
    for (const [ status, fallback ] of [
      [ "added", "--pr-green" ], [ "modified", "--pr-orange" ], [ "renamed", "--pr-blue" ],
    ]) {
      expect(css).to.contain(`var(--vscode-gitDecoration-${status}ResourceForeground, var(${fallback}))`);
    }
    expect(css).to.contain(".plastic-review .notice.error { border-left-color: var(--vscode-editorError-foreground,");
  });

  it("switches the file layout where the effective value is set", () => {
    expect(layoutTarget({ workspaceValue: "list" })).to.equal(ConfigurationTarget.Workspace);
    expect(layoutTarget({ workspaceValue: undefined })).to.equal(ConfigurationTarget.Global);
    expect(layoutTarget(undefined)).to.equal(ConfigurationTarget.Global);
  });

  it("tells a review's Overview tab by its URI, whatever its title, and no other tab", () => {
    const overview = reviewOverviewUri("wk", 12831);
    const tab = (input: unknown, label = "Review 12831.md") => ({ input, label }) as unknown as Tab;
    const shown = { reviewId: 12831, workspaceId: "wk" };
    expect(overviewTabReview(tab(new TabInputCustom(overview, MARKDOWN_PREVIEW_EDITOR)))).to.deep.equal(shown);
    expect(overviewTabReview(tab(new TabInputText(overview)))).to.deep.equal(shown);
    // A preview of the user's own "Review 5.md", or of any file, is not an Overview.
    const own = new TabInputCustom(Uri.file("/docs/Review 5.md"), MARKDOWN_PREVIEW_EDITOR);
    expect(overviewTabReview(tab(own, "Review 5.md"))).to.equal(undefined);
    const file = Uri.from({ path: "/Foo.cs", query: JSON.stringify({ kind: "file", reviewId: 5, serviceId: "wk" }),
      scheme: reviewScheme });
    expect(overviewTabReview(tab(new TabInputText(file), "Foo.cs"))).to.equal(undefined);
    const webview = new TabInputWebview("mainThreadWebview-markdown.preview");
    expect(overviewTabReview(tab(webview, "[Preview] Review 12831.md"))).to.equal(undefined);
    expect(overviewTabReview(undefined)).to.equal(undefined);
    const custom = tab(new TabInputCustom(overview, MARKDOWN_PREVIEW_EDITOR));
    expect(isOverviewTab(custom, "wk", 12831)).to.equal(true);
    expect(isOverviewTab(custom, "wk2", 12831)).to.equal(false);
    expect(isOverviewTab(custom, "wk", 5)).to.equal(false);
  });

  describe("registered", () => {
    let reviews: PlasticReviews | undefined;
    let shell: ReviewShell;
    const lines: string[] = [];
    /** The links Open in Unity Version Control handed on. */
    const external: string[] = [];
    const channel = { appendLine: (line: string) => lines.push(line) } as unknown as OutputChannel;

    const WORKSPACE = { id: "wk", name: "Nimbus", path: WORKSPACE_ROOT, repository: REPOSITORY };

    /** A PlasticReviews on the fixture shell. A later one can share the mementos, as after a window reload. */
    function create(
        options: {
          workspaces?: Array<typeof WORKSPACE>;
          globalState?: Memento;
          workspaceState?: Memento;
          posting?: IReviewPostingOptions;
          secrets?: ReturnType<typeof memorySecrets>;
          tokenCm?: ITokenCm;
        } = {}) {
      const workspaces = options.workspaces ?? [WORKSPACE];
      return new PlasticReviews({
        channel,
        extensionId: EXTENSION_ID,
        globalState: options.globalState ?? memento(),
        posting: options.posting,
        secrets: options.secrets,
        session: {
          createService: wk => {
            const service = new ReviewService(wk.id, wk.path, channel, SHELL_CONFIG, shell);
            service.text = (id: number) => Promise.resolve(id < 0 ? "" : numberedText(400));
            return service;
          },
          ui: {
            confirm: () => Promise.resolve(false),
            error: message => lines.push(`error: ${message}`),
            openExternal: link => {
              external.push(link);
              return Promise.resolve(true);
            },
            progress: (_viewId, task) => task(),
            status: () => undefined,
          },
        },
        shellConfig: () => SHELL_CONFIG,
        tokenCm: options.tokenCm,
        workspaceState: options.workspaceState ?? memento(),
        workspaces: () => workspaces,
      });
    }
    beforeEach(() => {
      lines.length = 0;
      external.length = 0;
      shell = new ReviewShell();
      shell.answer = scenarioAnswer;
      reviews = create();
    });

    afterEach(async () => {
      await commands.executeCommand("workbench.action.closeAllEditors");
      reviews?.dispose();
      reviews = undefined;
    });

    it("registers every contributed plastic-scm.reviews command, and removes them on dispose", async () => {
      const registered = new Set(await commands.getCommands(true));
      expect(reviewCommands.filter(id => !registered.has(id))).to.deep.equal([]);
      reviews!.dispose();
      reviews = undefined;
      const after = new Set(await commands.getCommands(true));
      expect(reviewCommands.filter(id => after.has(id))).to.deep.equal([]);
    });

    it("ignores and logs a row command run with the wrong argument", async () => {
      await commands.executeCommand("plastic-scm.reviews.openChanges", { kind: "file" });
      await commands.executeCommand("plastic-scm.reviews.retry", 42);
      expect(lines.filter(line => line.includes("ignored"))).to.have.length(2);
    });

    /** The reviews whose Overview a tab shows, in tab order. */
    function overviewTabs(): number[] {
      return window.tabGroups.all.flatMap(group => group.tabs).map(tab => overviewTabReview(tab)?.reviewId)
        .filter((id): id is number => id !== undefined);
    }

    /** Each group's tab labels, in order. */
    function layout(): string[][] {
      return window.tabGroups.all.map(group => group.tabs.map(tab => tab.label));
    }
    /** A Reviews row, as the list hands it to `open`. */
    async function reviewRow(reviewId: number, targetType?: string): Promise<unknown> {
      const review = await reviews!.session.service("wk")!.review(reviewId);
      expect(review, `review ${reviewId}`).not.to.equal(undefined);
      return { kind: "review", review: targetType ? { ...review!, targetType } : review, workspaceId: "wk" };
    }

    interface ICommandCall {
      command: string;
      args: unknown[];
    }
    /** The commands run through `commands.executeCommand` while `task` runs; each one still runs. */
    async function executed(task: () => Thenable<unknown>): Promise<ICommandCall[]> {
      const calls: ICommandCall[] = [];
      const api = commands as unknown as { executeCommand: (command: string, ...rest: unknown[]) => Thenable<unknown> };
      const original = api.executeCommand;
      api.executeCommand = (command, ...rest) => {
        calls.push({ args: rest, command });
        return original.call(commands, command, ...rest);
      };
      try {
        await task();
      } finally {
        api.executeCommand = original;
      }
      return calls;
    }

    /** The options of the Overview opens among `calls`. */
    function openOptions(calls: ICommandCall[]): unknown[] {
      return calls.filter(call => call.command === "vscode.openWith" && call.args[1] === MARKDOWN_PREVIEW_EDITOR)
        .map(call => call.args[2]);
    }
    /** Runs `task` with the input box answering `answer`; the error messages it shows are returned instead. */
    async function answering(answer: string, task: () => Thenable<unknown>): Promise<string[]> {
      const errors: string[] = [];
      const api = window as unknown as {
        showErrorMessage: (message: string) => Thenable<undefined>;
        showInputBox: () => Thenable<string | undefined>;
      };
      const { showErrorMessage, showInputBox } = api;
      api.showInputBox = () => Promise.resolve(answer);
      api.showErrorMessage = message => {
        errors.push(message);
        return Promise.resolve(undefined);
      };
      try {
        await task();
      } finally {
        api.showInputBox = showInputBox;
        api.showErrorMessage = showErrorMessage;
      }
      return errors;
    }

    /** A QuickPick stand-in: it keeps what the command sets, and the test types into it, accepts or hides it. */
    interface IFakePicker {
      items: readonly IReviewPickItem[];
      value: string;
      placeholder: string | undefined;
      busy: boolean;
      matchOnDescription: boolean;
      matchOnDetail: boolean;
      selectedItems: readonly IReviewPickItem[];
      shown: boolean;
      shows: number;
      activeItems?: readonly IReviewPickItem[];
      onDidAccept: EventEmitter<void>["event"];
      onDidChangeValue: EventEmitter<string>["event"];
      onDidHide: EventEmitter<void>["event"];
      show(): void;
      hide(): void;
      dispose(): void;
      type(value: string): void;
      accept(item: IReviewPickItem): void;
    }

    /** Runs `task` with window.createQuickPick answering a fake picker, which `drive` works once it is shown. */
    async function picking(task: () => Thenable<unknown>, drive: (fake: IFakePicker) => Promise<void>): Promise<void> {
      const api = window as unknown as { createQuickPick: () => unknown };
      const { createQuickPick } = api;
      let created: IFakePicker | undefined;
      api.createQuickPick = () => {
        const changed = new EventEmitter<string>();
        const accepted = new EventEmitter<void>();
        const hidden = new EventEmitter<void>();
        const picker: IFakePicker = {
          accept: item => {
            picker.selectedItems = [item];
            accepted.fire();
          },
          busy: false,
          dispose: () => [ changed, accepted, hidden ].forEach(emitter => emitter.dispose()),
          hide: () => {
            if (picker.shown) {
              picker.shown = false;
              // As VS Code does, the hide is reported afterwards.
              void Promise.resolve().then(() => hidden.fire());
            }
          },
          items: [],
          matchOnDescription: false,
          matchOnDetail: false,
          onDidAccept: accepted.event,
          onDidChangeValue: changed.event,
          onDidHide: hidden.event,
          placeholder: undefined,
          selectedItems: [],
          show: () => {
            picker.shown = true;
            picker.shows++;
          },
          shown: false,
          shows: 0,
          type: value => {
            picker.value = value;
            changed.fire(value);
          },
          value: "",
        };
        created = picker;
        return picker;
      };
      try {
        const done = task();
        await until(() => (created?.shows ?? 0) > 0);
        await drive(created!);
        await done;
      } finally {
        api.createQuickPick = createQuickPick;
      }
    }

    const FIND_QUERY = "where id > 0 order by date desc limit 2000";
    /** The Find Review… row that opens a number typed by ID. */
    const OPEN_BY_ID = "$(go-to-file) Open review by ID";

    it("opens a clicked review's Overview in place of the previous review's, keeping the keyboard in the list",
      async function() {
        this.timeout(30000);
        const first = await reviewRow(CHANGESET_REVIEW_ID);
        const calls = await executed(() => commands.executeCommand("plastic-scm.reviews.open", first));
        expect(reviews!.session.active?.review.id).to.equal(CHANGESET_REVIEW_ID);
        // The preview editor has opened when the command returns: no wait.
        expect(overviewTabs()).to.deep.equal([CHANGESET_REVIEW_ID]);
        expect(openOptions(calls)).to.deep.equal([{ preserveFocus: true, preview: false, viewColumn: ViewColumn.One }]);

        await commands.executeCommand("plastic-scm.reviews.open", await reviewRow(BRANCH_REVIEW_ID));
        expect(overviewTabs()).to.deep.equal([BRANCH_REVIEW_ID]);
        await commands.executeCommand("workbench.action.closeAllEditors");
        await until(() => overviewTabs().length === 0);
        await commands.executeCommand("plastic-scm.reviews.open", await reviewRow(BRANCH_REVIEW_ID));
        expect(overviewTabs()).to.deep.equal([BRANCH_REVIEW_ID]);
      });

    it("keeps the Overview in its own editor group, and the group the user reads in active", async function() {
      this.timeout(30000);
      const readme = await workspace.openTextDocument(Uri.file(path.resolve(__dirname, "..", "..", "..", "..",
        "README.md")));
      await window.showTextDocument(readme, { preview: false, viewColumn: ViewColumn.One });
      await commands.executeCommand("vscode.openWith", reviewOverviewUri("wk", CHANGESET_REVIEW_ID),
        MARKDOWN_PREVIEW_EDITOR, { viewColumn: ViewColumn.Two });
      await window.showTextDocument(readme, { preview: false, viewColumn: ViewColumn.One });
      const page = (id: number) => `Review ${id}.md`;
      expect(layout()).to.deep.equal([["README.md"], [page(CHANGESET_REVIEW_ID)]]);

      const activeGroup = () => window.tabGroups.activeTabGroup.viewColumn;
      await commands.executeCommand("plastic-scm.reviews.open", await reviewRow(CHANGESET_REVIEW_ID));
      expect(layout()).to.deep.equal([["README.md"], [page(CHANGESET_REVIEW_ID)]]);
      expect(activeGroup()).to.equal(ViewColumn.One);
      await commands.executeCommand("plastic-scm.reviews.open", await reviewRow(BRANCH_REVIEW_ID));
      expect(layout()).to.deep.equal([["README.md"], [page(BRANCH_REVIEW_ID)]]);
      expect(activeGroup()).to.equal(ViewColumn.One);
      await commands.executeCommand("plastic-scm.reviews.open", await reviewRow(BRANCH_REVIEW_ID));
      expect(layout()).to.deep.equal([["README.md"], [page(BRANCH_REVIEW_ID)]]);
      // The group the user reads in stays active, so the next diff opens there and not over the Overview.
      expect(activeGroup()).to.equal(ViewColumn.One);
    });

    it("opens the Overview from a General thread without taking the keyboard", async function() {
      this.timeout(30000);
      await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
      const discussions = (reviews as unknown as { discussionsProvider: DiscussionsProvider }).discussionsProvider;
      const general = discussions.getChildren().find(node => node.kind === "group" && node.group === "general");
      expect(general, "the General group").not.to.equal(undefined);
      const row = discussions.getChildren(general)[0];
      expect(row.kind === "thread" && row.general).to.equal(true);
      const calls = await executed(() => commands.executeCommand("plastic-scm.reviews.openDiscussion", row));
      expect(openOptions(calls)).to.deep.equal([{ preserveFocus: true, preview: false, viewColumn: ViewColumn.One }]);
      expect(overviewTabs()).to.deep.equal([BRANCH_REVIEW_ID]);
    });

    it("closes the Overview when Switch Workspace leaves its review", async function() {
      this.timeout(30000);
      reviews!.dispose();
      reviews = create({ workspaces: [ WORKSPACE, { ...WORKSPACE, id: "wk2", name: "Other" }] });
      await commands.executeCommand("plastic-scm.reviews.open", await reviewRow(BRANCH_REVIEW_ID));
      expect(overviewTabs()).to.deep.equal([BRANCH_REVIEW_ID]);
      const api = window as unknown as { showQuickPick: (items: Array<{ id: string }>) => Thenable<unknown> };
      const { showQuickPick } = api;
      api.showQuickPick = items => Promise.resolve(items.find(item => item.id === "wk2"));
      try {
        await commands.executeCommand("plastic-scm.reviews.switchWorkspace");
      } finally {
        api.showQuickPick = showQuickPick;
      }
      expect(reviews.session.workspaceId).to.equal("wk2");
      expect(overviewTabs()).to.deep.equal([]);
    });

    it("brings the last review back when VS Code restores its Overview, with no review view shown", async function() {
      this.timeout(30000);
      const globalState = memento();
      const workspaceState = memento();
      reviews!.dispose();
      reviews = create({ globalState, workspaceState });
      await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
      reviews.dispose();
      reviews = create({ globalState, workspaceState });
      expect(reviews.session.active).to.equal(undefined);
      // The tab VS Code brings back after a reload.
      const uri = reviewOverviewUri("wk", BRANCH_REVIEW_ID);
      await commands.executeCommand("vscode.openWith", uri, MARKDOWN_PREVIEW_EDITOR);
      await until(() => reviews!.session.active?.review.id === BRANCH_REVIEW_ID, 10000);
      const document = await workspace.openTextDocument(uri);
      await until(() => !document.getText().includes("Open this review in Plastic Reviews"), 10000);
    });

    it("keeps the review picked last when its row is clicked while Open Review by ID looks up another",
      async function() {
        this.timeout(30000);
        const row = await reviewRow(CHANGESET_REVIEW_ID);
        await commands.executeCommand("plastic-scm.reviews.open", row);
        let release: () => void = () => undefined;
        const held = new Promise<void>(resolve => {
          release = () => resolve();
        });
        let lookingUp = false;
        shell.answer = async (command, args) => {
          if (command === "find" && args[0] === "review" && (args[1] ?? "").includes(`id = ${BRANCH_REVIEW_ID}`)) {
            lookingUp = true;
            await held;
          }
          return scenarioAnswer(command, args);
        };
        try {
          await answering(String(BRANCH_REVIEW_ID), async () => {
            const opened = commands.executeCommand("plastic-scm.reviews.openById");
            await until(() => lookingUp);
            await commands.executeCommand("plastic-scm.reviews.open", row);
            release();
            await opened;
          });
        } finally {
          release();
        }
        expect(reviews!.session.active?.review.id).to.equal(CHANGESET_REVIEW_ID);
        expect(overviewTabs()).to.deep.equal([CHANGESET_REVIEW_ID]);
      });

    it("leaves one Overview, the last review's, after two clicks at once", async function() {
      this.timeout(30000);
      const rows = [ await reviewRow(CHANGESET_REVIEW_ID), await reviewRow(BRANCH_REVIEW_ID) ];
      await Promise.all(rows.map(row => commands.executeCommand("plastic-scm.reviews.open", row)));
      expect(reviews!.session.active?.review.id).to.equal(BRANCH_REVIEW_ID);
      expect(overviewTabs()).to.deep.equal([BRANCH_REVIEW_ID]);
    });

    it("opens the Overview of a review opened by ID while its files still load, and moves the focus to it",
      async function() {
        this.timeout(30000);
        let release: () => void = () => undefined;
        const held = new Promise<void>(resolve => {
          release = () => resolve();
        });
        shell.answer = async (command, args) => {
          if (command === "diff") {
            await held;
          }
          return scenarioAnswer(command, args);
        };
        let whenShown: string | undefined;
        try {
          const calls = await executed(() => answering(String(BRANCH_REVIEW_ID), async () => {
            const opened = commands.executeCommand("plastic-scm.reviews.openById");
            await until(() => overviewTabs().includes(BRANCH_REVIEW_ID), 20000);
            whenShown = reviews!.session.active?.files.state;
            release();
            await opened;
          }));
          expect(whenShown).to.equal("loading");
          expect(reviews!.session.active?.files.state).to.equal("ready");
          expect(openOptions(calls))
            .to.deep.equal([{ preserveFocus: false, preview: false, viewColumn: ViewColumn.One }]);
        } finally {
          release();
        }
      });

    it("opens the Overview from the Review view's row without taking the keyboard, and Close Review closes it",
      async function() {
        this.timeout(30000);
        await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
        const fromRow = await executed(() => commands.executeCommand("plastic-scm.reviews.openOverview",
          { kind: "overview" }));
        const fromTitle = await executed(() => commands.executeCommand("plastic-scm.reviews.openOverview"));
        expect(openOptions(fromRow).concat(openOptions(fromTitle))).to.deep.equal([
          { preserveFocus: true, preview: false, viewColumn: ViewColumn.One },
          { preserveFocus: false, preview: false, viewColumn: ViewColumn.One },
        ]);
        expect(overviewTabs()).to.deep.equal([BRANCH_REVIEW_ID]);
        await commands.executeCommand("plastic-scm.reviews.close");
        expect(reviews!.session.active).to.equal(undefined);
        expect(overviewTabs()).to.deep.equal([]);
      });
    it("opens no Overview for a review it cannot open", async function() {
      this.timeout(20000);
      const calls = await executed(async () => {
        const shown = await informed(async () =>
          commands.executeCommand("plastic-scm.reviews.open", await reviewRow(BRANCH_REVIEW_ID, "label")));
        expect(shown).to.deep.equal(["Reviews of a label are not supported."]);
        const errors = await answering("6251", () => commands.executeCommand("plastic-scm.reviews.openById"));
        expect(errors).to.have.length(1);
        expect(errors[0]).to.contain("#6251");
      });
      expect(openOptions(calls)).to.deep.equal([]);
      expect(reviews!.session.active).to.equal(undefined);
      expect(overviewTabs()).to.deep.equal([]);
    });

    it("finds anyone's review, busy until they load, and opens the one picked with the keyboard in its Overview",
      async function() {
        this.timeout(30000);
        let release: () => void = () => undefined;
        const held = new Promise<void>(resolve => {
          release = () => resolve();
        });
        shell.answer = async (command, args) => {
          if (command === "find" && args[0] === "review" && args[1] === FIND_QUERY) {
            await held;
            return reviewsXml([
              { id: 13141, owner: "j.smith@partner.example.com", title: "Review of branch /main/PartnerDemo" },
              { assignee: ME, id: BRANCH_REVIEW_ID, status: "Rework required",
                title: "Lap Timer Accuracy" },
            ]);
          }
          if (command === "find" && args[0] === "branch" && args[1] === `where (id = ${BRANCH_ID})`) {
            return branchRowXml(BRANCH_ID, BRANCH_NAME, HEAD);
          }
          return scenarioAnswer(command, args);
        };
        try {
          const find = () => commands.executeCommand("plastic-scm.reviews.find");
          const calls = await executed(() => picking(find, async picker => {
            expect(picker.busy).to.equal(true);
            expect(picker.placeholder).to.equal("Loading the reviews in Nimbus…");
            expect(picker.matchOnDescription && picker.matchOnDetail).to.equal(true);
            // A number can be opened by ID before the reviews arrive.
            picker.type("#6251");
            const typedRow = picker.items.map(item => [ item.label, item.description ]);
            expect(typedRow).to.deep.equal([[ OPEN_BY_ID, "#6251" ]]);
            picker.type("Lap");
            expect(picker.items).to.deep.equal([]);
            release();
            await until(() => !picker.busy);
            expect(picker.placeholder).to.equal("Find a review in Nimbus by title, number, person, branch or status");
            expect(picker.items.map(item => item.label))
              .to.deep.equal([ "$(eye) PartnerDemo", "$(request-changes) Lap Timer Accuracy" ]);
            expect(picker.items[0].detail).to.equal("/main/PartnerDemo · Under review");
            expect(picker.items[1].description).to.match(/^#12831 · erin\.author → alex\.reviewer · /);
            // Its title does not name its branch, so the branch was looked up, and typing it finds the review.
            expect(picker.items[1].detail).to.equal(`${BRANCH_NAME} · Rework required`);
            picker.accept(picker.items[1]);
          }));
          expect(reviews!.session.active?.review.id).to.equal(BRANCH_REVIEW_ID);
          expect(overviewTabs()).to.deep.equal([BRANCH_REVIEW_ID]);
          const overview = { preserveFocus: false, preview: false, viewColumn: ViewColumn.One };
          expect(openOptions(calls)).to.deep.equal([overview]);
          // The picked row is the review's header, as a list row's is: it is not looked up again.
          expect(shell.queries("review").filter(where => where === `where id = ${BRANCH_REVIEW_ID}`)).to.deep.equal([]);
        } finally {
          release();
        }
      });

    it("opens a newer number by ID, lists a review it cannot open, does nothing on cancel and shows errors",
      async function() {
        this.timeout(30000);
        let fail = false;
        shell.answer = (command, args) => {
          if (command === "find" && args[0] === "review" && args[1] === FIND_QUERY) {
            if (fail) {
              throw new Error("Error: The server is unreachable");
            }
            return reviewsXml([
              { id: 7400, title: "Lap Timer Accuracy" },
              { id: 6881, target: "3671", targetType: "Changeset", title: "Review of changeset 3671 - Fix" },
              { id: 42, target: "BL042", targetType: "Label", title: "Label review" },
            ]);
          }
          return scenarioAnswer(command, args);
        };
        const find = () => commands.executeCommand("plastic-scm.reviews.find");
        const loaded = (picker: IFakePicker) => until(() => !picker.busy);

        let shown: string[] = [];
        const cancelled = await answering("", async () => {
          shown = await informed(() => picking(find, async picker => {
            await loaded(picker);
            picker.hide();
          }));
        });
        expect(cancelled.concat(shown)).to.deep.equal([]);
        expect(reviews!.session.active).to.equal(undefined);

        shown = await informed(() => picking(find, async picker => {
          await loaded(picker);
          expect(picker.items[2].label).to.equal("$(circle-slash) Label review");
          picker.accept(picker.items[2]);
        }));
        expect(shown).to.deep.equal(["Reviews of a label are not supported."]);
        expect(reviews!.session.active).to.equal(undefined);

        const listed = [ 7400, 6881, 42 ];
        const calls = await executed(() => picking(find, async picker => {
          await loaded(picker);
          // A listed number adds no row: the picker's filter finds the review by its description, and makes it active.
          picker.type("7400");
          expect(picker.items.map(item => item.id)).to.deep.equal(listed);
          expect(picker.activeItems).to.deep.equal([picker.items[0]]);
          // A changeset's number is no review's: Enter opens the review of that changeset, not a missing review.
          picker.type("3671");
          expect(picker.items.map(item => item.id)).to.deep.equal(listed);
          expect(picker.activeItems).to.deep.equal([picker.items[1]]);
          // Neither does a number below the newest review that no listed review has, such as a ticket's.
          picker.type("3981");
          expect(picker.items.map(item => item.id)).to.deep.equal(listed);
          // A number newer than every listed review may be one created since: it comes last, and opens by ID.
          picker.type(` #${CHANGESET_REVIEW_ID}`);
          expect(picker.items.map(item => item.id)).to.deep.equal(listed.concat([CHANGESET_REVIEW_ID]));
          expect(picker.items[3]).to.deep.equal({
            alwaysShow: true,
            description: `#${CHANGESET_REVIEW_ID} · not in this list`,
            id: CHANGESET_REVIEW_ID,
            label: OPEN_BY_ID,
          });
          picker.accept(picker.items[3]);
        }));
        expect(reviews!.session.active?.review.id).to.equal(CHANGESET_REVIEW_ID);
        expect(overviewTabs()).to.deep.equal([CHANGESET_REVIEW_ID]);
        const overview = { preserveFocus: false, preview: false, viewColumn: ViewColumn.One };
        expect(openOptions(calls)).to.deep.equal([overview]);
        const finds = () => shell.queries("review").filter(where => where === FIND_QUERY).length;
        expect(finds(), "one query while the reviews are fresh").to.equal(1);

        fail = true;
        await commands.executeCommand("plastic-scm.reviews.refresh");
        const errors = await answering("", () => picking(find, picker => until(() => !picker.shown)));
        expect(errors).to.deep.equal(["Plastic Reviews: The server is unreachable"]);
        expect(finds()).to.equal(2);
        expect(reviews!.session.active?.review.id).to.equal(CHANGESET_REVIEW_ID);
      });

    it("says when a repository has no reviews, and offers any number once only the newest reviews are listed",
      async function() {
        this.timeout(20000);
        const session = reviews!.session;
        const find = () => commands.executeCommand("plastic-scm.reviews.find");
        session.findReviews = () => Promise.resolve({ branches: new Map<number, string>(), reviews: [] });
        await picking(find, async picker => {
          await until(() => !picker.busy);
          expect(picker.placeholder).to.equal("No reviews in Nimbus");
          expect(picker.items).to.deep.equal([]);
          picker.hide();
        });

        const newest = Array.from({ length: 2000 }, (_, index) => reviewFixture({ id: 9842 - index }));
        session.findReviews = () => Promise.resolve({ branches: new Map<number, string>(), reviews: newest });
        await picking(find, async picker => {
          await until(() => !picker.busy);
          expect(picker.placeholder)
            .to.equal("Only the newest 2,000 reviews are listed; type a number to open an older one");
          picker.type("5");
          expect(picker.items).to.have.length(2001);
          expect(picker.items[2000]).to.include({ description: "#5 · not in this list", id: 5, label: OPEN_BY_ID });
          picker.hide();
        });
        expect(session.active).to.equal(undefined);
      });

    it("activates a review by id without opening an editor, then walks its files from the editor", async () => {
      const session = reviews!.session;
      await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
      expect(session.active?.review.id).to.equal(BRANCH_REVIEW_ID);
      expect(session.active?.files.state).to.equal("ready");
      expect(window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof TabInputTextDiff &&
        tab.input.modified.scheme === "plastic-review"))).to.equal(false);

      const tree = (reviews as unknown as { treeProvider: ReviewTreeProvider }).treeProvider;
      const order = tree.navigationOrder("changes");
      expect(order.length).to.be.greaterThan(2);
      await commands.executeCommand("plastic-scm.reviews.openChanges", tree.fileNode("changes", order[0]));
      await until(() => reviews!.editors.activeFile()?.file === order[0]);

      await commands.executeCommand("plastic-scm.reviews.markViewedAndNext");
      await until(() => reviews!.editors.activeFile()?.file === order[1]);
      expect(session.isViewed(order[0])).to.equal(true);
      expect(session.isViewed(order[1])).to.equal(false);

      await commands.executeCommand("plastic-scm.reviews.previousFile");
      await until(() => reviews!.editors.activeFile()?.file === order[0]);
      await commands.executeCommand("plastic-scm.reviews.markUnviewed");
      expect(session.isViewed(order[0])).to.equal(false);

      // Open Next Unviewed File continues after the last file opened from Changes.
      await commands.executeCommand("plastic-scm.reviews.openNextUnviewed");
      await until(() => reviews!.editors.activeFile()?.file === order[1]);
      expect(lines.filter(line => line.startsWith("error"))).to.deep.equal([]);
    });

    it("selects a file in the Review view only when a different review file becomes active", async () => {
      const session = reviews!.session;
      await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
      const internals = reviews as unknown as { treeProvider: ReviewTreeProvider; treeView: TreeView<ReviewTreeNode> };
      const tree = internals.treeProvider;
      const revealed: ReviewTreeNode[] = [];
      // The test host shows no Plastic views; pretend the Review view is on screen and record its reveals.
      Object.defineProperty(internals.treeView, "visible", { configurable: true, get: () => true });
      internals.treeView.reveal = node => {
        revealed.push(node);
        return Promise.resolve();
      };
      const order = tree.navigationOrder("changes");
      const activeKey = () => {
        const at = reviews!.editors.activeFile();
        return at && fileKey(at.file);
      };
      await commands.executeCommand("plastic-scm.reviews.openChanges", tree.fileNode("changes", order[0]));
      await until(() => activeKey() === fileKey(order[0]) && revealed.length > 0);
      expect(revealed).to.deep.equal([tree.fileNode("changes", order[0])]);

      // Session events leave the selection alone: a changeset's files loading, files marked viewed, a reload.
      expect(session.changesetFiles(3699).state).to.equal("loading");
      await until(() => session.changesetFiles(3699).state === "ready");
      session.setViewed([order[2]], true);
      await commands.executeCommand("plastic-scm.reviews.markViewed", tree.fileNode("changes", order[1]));
      await commands.executeCommand("plastic-scm.reviews.refreshReview");
      expect(revealed).to.have.length(1);

      await commands.executeCommand("plastic-scm.reviews.nextFile");
      await until(() => activeKey() === fileKey(order[1]) && revealed.length === 2);
      expect(revealed[1]).to.equal(tree.fileNode("changes", order[1]));
      expect(lines.filter(line => line.startsWith("error"))).to.deep.equal([]);
    });

    it("opens a discussion from its row with focus kept in the tree", async () => {
      await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
      const calls: Array<{ preserveFocus?: boolean } | undefined> = [];
      reviews!.editors.openComment = (_context, _thread, options) => {
        calls.push(options);
        return Promise.resolve();
      };
      const discussions = (reviews as unknown as { discussionsProvider: DiscussionsProvider }).discussionsProvider;
      const row = discussions.getChildren(discussions.getChildren()[0])[0];
      expect(row.kind).to.equal("thread");
      await commands.executeCommand("plastic-scm.reviews.openDiscussion", row);
      expect(calls).to.deep.equal([{ preserveFocus: true }]);
    });

    /** The information messages shown while `task` runs: ReviewActions shows them through `window`. */
    async function informed(task: () => Thenable<unknown>): Promise<string[]> {
      const shown: string[] = [];
      const api = window as unknown as { showInformationMessage: (message: string) => Thenable<undefined> };
      const original = api.showInformationMessage;
      api.showInformationMessage = message => {
        shown.push(message);
        return Promise.resolve(undefined);
      };
      try {
        await task();
      } finally {
        api.showInformationMessage = original;
      }
      return shown;
    }

    /** A link as the Overview writes it. */
    function linkTo(target: OverviewLinkTarget, reviewId = BRANCH_REVIEW_ID, workspaceId = "wk"): Uri {
      const base = { authority: EXTENSION_ID, scheme: env.uriScheme };
      return Uri.parse(reviewLinkUri(base, { reviewId, target, workspaceId }));
    }

    function reviewDiffOpen(): boolean {
      return window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof TabInputTextDiff &&
        tab.input.modified.scheme === "plastic-review"));
    }

    it("registers the URI handler behind the Overview's links once, and removes it on dispose", () => {
      // VS Code allows one handler per extension: while ours is registered, another is refused.
      expect(() => window.registerUriHandler({ handleUri: () => undefined })).to.throw();
      reviews!.dispose();
      reviews = undefined;
      window.registerUriHandler({ handleUri: () => undefined }).dispose();
    });

    it("opens a discussion link as its Discussions row does, and a file link as its Review row does", async () => {
      await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
      const threads: Array<{ id: number; options?: { preserveFocus?: boolean } }> = [];
      reviews!.editors.openComment = (_context, thread, options) => {
        threads.push({ id: thread.id, options });
        return Promise.resolve();
      };
      const shown = await informed(() => reviews!.actions.handleUri(linkTo({ kind: "thread", threadId: 12915 })));
      expect(threads).to.deep.equal([{ id: 12915, options: { preserveFocus: true }}]);

      const tree = (reviews as unknown as { treeProvider: ReviewTreeProvider }).treeProvider;
      for (const scope of [ "changes", "merged" ] as const) {
        const file = tree.navigationOrder(scope)[scope === "changes" ? 1 : 0];
        const target: OverviewLinkTarget = { fileKey: fileKey(file), kind: "file", scope };
        shown.push(...await informed(() => reviews!.actions.handleUri(linkTo(target))));
        await until(() => reviews!.editors.activeFile()?.file === file);
        expect(reviews!.editors.activeFile()?.scope).to.equal(scope);
      }
      expect(shown).to.deep.equal([]);
      expect(lines.filter(line => line.startsWith("error") || line.includes("failed"))).to.deep.equal([]);
    });

    it("says why a link cannot open, opens nothing, and only logs a path that is not its own", async () => {
      await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
      const opened: number[] = [];
      reviews!.editors.openComment = (_context, thread) => {
        opened.push(thread.id);
        return Promise.resolve();
      };
      const handler = (route: string) => Uri.parse(`${env.uriScheme}://${EXTENSION_ID}/${route}`);
      const gone: OverviewLinkTarget = {
        fileKey: fileKey({ path: "/Assets/Gone.cs", revisionId: 1 }),
        kind: "file",
        scope: "changes",
      };
      const cases: Array<[ Uri, string[] ]> = [
        [
          linkTo({ kind: "thread", threadId: 12915 }, CHANGESET_REVIEW_ID),
          [`Open review #${CHANGESET_REVIEW_ID} in Plastic Reviews first, then follow the link again.`],
        ],
        [
          linkTo({ kind: "thread", threadId: 12915 }, BRANCH_REVIEW_ID, "elsewhere"),
          [`Review #${BRANCH_REVIEW_ID} belongs to a Plastic workspace that is not open in this window.`],
        ],
        [ linkTo({ kind: "thread", threadId: 42 }), [`That discussion is no longer in review #${BRANCH_REVIEW_ID}.`]],
        [ linkTo(gone), [`That file is no longer in Changes of review #${BRANCH_REVIEW_ID}.`]],
        [
          linkTo({
            fileKey: fileKey({ path: "/Assets/Gone.cs", revisionId: 1 }), kind: "file", scope: { changesetId: 99 },
          }),
          [`cs:99 is not part of review #${BRANCH_REVIEW_ID}.`],
        ],
        [
          handler(`thread?workspace=d2s&review=${BRANCH_REVIEW_ID}`),
          ["This link does not name a discussion or a file of a Plastic review."],
        ],
        [ handler("settings?open=1"), []],
      ];
      for (const [ uri, messages ] of cases) {
        expect(await informed(() => reviews!.actions.handleUri(uri)), uri.toString(true)).to.deep.equal(messages);
      }
      expect(opened).to.deep.equal([]);
      expect(reviewDiffOpen()).to.equal(false);
      expect(lines.filter(line => line.includes("link ignored"))).to.have.length(2);
      expect(lines.filter(line => line.startsWith("error") || line.includes("failed"))).to.deep.equal([]);
    });

    it("opens the Overview in the preview editor, which no Markdown file replaces; only its tab sets the title key",
      async function() {
        this.timeout(30000);
        await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
        const keys = (reviews as unknown as { keys: Map<string, unknown> }).keys;
        const overviewTab = () => window.tabGroups.all.flatMap(group => group.tabs)
          .find(tab => isOverviewTab(tab, "wk", BRANCH_REVIEW_ID));
        expect(keys.get(CONTEXT_KEYS.activeEditorIsOverview)).to.equal(false);
        await commands.executeCommand("plastic-scm.reviews.openOverview");
        await until(() => keys.get(CONTEXT_KEYS.activeEditorIsOverview) === true, 20000);
        const input = overviewTab()?.input;
        expect(input).to.be.instanceOf(TabInputCustom);
        expect((input as TabInputCustom).viewType).to.equal(MARKDOWN_PREVIEW_EDITOR);
        const readme = await workspace.openTextDocument(Uri.file(path.resolve(__dirname, "..", "..", "..", "..",
          "README.md")));
        await window.showTextDocument(readme, { preview: false });
        await until(() => keys.get(CONTEXT_KEYS.activeEditorIsOverview) === false);
        expect(overviewTab()?.input).to.equal(input);
      });

    it("draws the open Overview again when files are marked viewed", async () => {
      await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
      const document = await workspace.openTextDocument(reviewOverviewUri("wk", BRANCH_REVIEW_ID));
      const total = (reviews as unknown as { treeProvider: ReviewTreeProvider }).treeProvider.progress()!.total;
      expect(total).to.be.greaterThan(1);
      expect(document.getText()).to.contain(`aria-valuemax="${total}" aria-valuenow="0"`);
      await commands.executeCommand("plastic-scm.reviews.markAllViewed");
      await until(() => document.getText().includes(`aria-valuemax="${total}" aria-valuenow="${total}"`));
    });

    it("receives a link that VS Code itself opens, as a click in the preview hands one on", async function() {
      this.timeout(20000);
      // Skips the "Allow an extension to open this URI?" prompt, which a person answers once.
      const extensions = workspace.getConfiguration("extensions");
      await extensions.update("confirmedUriHandlerExtensionIds", [EXTENSION_ID], ConfigurationTarget.Global);
      try {
        await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
        const threads: number[] = [];
        reviews!.editors.openComment = (_context, thread) => {
          threads.push(thread.id);
          return Promise.resolve();
        };
        expect(await env.openExternal(linkTo({ kind: "thread", threadId: 12915 }))).to.equal(true);
        await until(() => threads.length > 0, 15000);
        expect(threads).to.deep.equal([12915]);
      } finally {
        await extensions.update("confirmedUriHandlerExtensionIds", undefined, ConfigurationTarget.Global);
      }
    });

    describe("Add Me as Reviewer, Open in Unity Version Control and the access token", () => {
      const SAM = "sam.rivera@example.com";
      const SERVER = "acme-studio@unity";
      const REVIEWERS = "/api/v1/organizations/acme-studio/repos/Nimbus%2FNimbus/codereview/12831/reviewers";
      const LINK = "plastic://acme-studio@unity/repos/Nimbus/Nimbus/code-reviews/12831";
      /** The scenario's comment rows without those that request the cm user; their verdicts stay. */
      const UNREQUESTED = SCENARIO_COMMENTS.filter(row => !/^\[requested-review-from/.test(row.text));
      /** The writes the fake REST API received. */
      const requests: Array<{ path: string; body: unknown }> = [];
      /** The cm that makes tokens, and the token saved for the server before the test. */
      let cm: FakeTokenCm;
      let saved: string;
      let comments = UNREQUESTED;
      let people = { assignee: SAM, owner: AUTHOR };
      let setting = true;

      /** The scenario, with the review's people and comment rows as the test sets them. */
      function answer(command: string, args: string[]): string {
        if (args[0] === "review" && (args[1] ?? "").includes(`id = ${BRANCH_REVIEW_ID}`)) {
          return reviewsXml([{ ...people, id: BRANCH_REVIEW_ID, title: "Lap Timer Accuracy" }]);
        }
        return args[0] === "changereviewcomment" ? commentsXml(comments) : scenarioAnswer(command, args);
      }

      function marker(id: number, text: string): (typeof UNREQUESTED)[number] {
        return comment({
          changesetId: -1, date: `2026-09-22T18:0${id % 10}:00+01:00`, id, location: -1, owner: AUTHOR,
          reviewId: BRANCH_REVIEW_ID, revisionId: -1, text: `[${text}]${ME}`, type: "timeline",
        });
      }

      /** What cm was asked about tokens: the `accesstoken` subcommands. */
      const tokenWork = () => cm.calls.filter(call => call[0] === "accesstoken").map(call => call[1]);

      /**
       * A PlasticReviews with experimental posting on a fake cm and a fake REST API, which adds the cm user as the
       * service would; `connected`, a token for the server is saved already. `organization` is what
       * `cm getconfig organization` prints, by default an organization on a documented region.
       */
      function withPosting(connected = true, organization?: string): PlasticReviews {
        reviews?.dispose();
        cm = new FakeTokenCm();
        cm.organization = organization ?? cm.organization;
        const rest = new FakeRest();
        rest.onWrite = () => {
          comments = comments.concat(marker(13001, "requested-review-from"));
        };
        const writer = new ReviewWriter((call, cancel) => {
          if (call.method !== "GET") {
            requests.push({ body: JSON.parse(call.body ?? "null") as unknown, path: call.url.pathname });
          }
          return rest.transport(call, cancel);
        });
        saved = syntheticJwt(Math.floor(Date.now() / 1000) + 60 * 60);
        cm.tokens.set(tokenId(1), 0);
        const secret = JSON.stringify({ expiresAt: Date.now() + 60 * 60 * 1000, id: tokenId(1), token: saved });
        reviews = create({
          posting: { setting: () => setting, trusted: () => true, writer },
          secrets: memorySecrets(connected ? { [tokenKey(SERVER, ME)]: secret } : {}),
          tokenCm: cm,
        });
        return reviews;
      }

      /**
       * Opens review 12831 and waits until its discussions have loaded and, with
       * the setting on (only then is cm asked), until cm has said who the user is.
       */
      async function opened(): Promise<Map<string, unknown>> {
        await commands.executeCommand("plastic-scm.reviews.open", "wk", BRANCH_REVIEW_ID);
        const session = reviews!.session;
        await until(() => session.active?.discussions.state === "ready" &&
          (!setting || session.service("wk")?.knownUser !== undefined));
        await new Promise(resolve => setTimeout(resolve, 0));
        return (reviews as unknown as { keys: Map<string, unknown> }).keys;
      }

      /** The add-me link as the Overview writes it, with this window's key or another. */
      function addMeLink(key: string): Uri {
        const base = { authority: EXTENSION_ID, scheme: env.uriScheme };
        return Uri.parse(reviewLinkUri(base,
          { key, reviewId: BRANCH_REVIEW_ID, target: { kind: "addMeAsReviewer" }, workspaceId: "wk" }));
      }

      /** Runs `task` with the modal warning answering `reply`; the messages it showed are returned. */
      async function warned(reply: string | undefined, task: () => Thenable<unknown>): Promise<string[]> {
        const shown: string[] = [];
        const api = window as unknown as { showWarningMessage: (message: string) => Thenable<string | undefined> };
        const original = api.showWarningMessage;
        api.showWarningMessage = message => {
          shown.push(message);
          return Promise.resolve(reply);
        };
        try {
          await task();
        } finally {
          api.showWarningMessage = original;
        }
        return shown;
      }

      beforeEach(() => {
        requests.length = 0;
        comments = UNREQUESTED;
        people = { assignee: SAM, owner: AUTHOR };
        setting = true;
        shell.answer = answer;
      });

      afterEach(() => {
        expect(shell.calls.filter(call => call.command === "codereview"), "status writes").to.deep.equal([]);
      });

      it("offers itself in the Review view only while the setting is on and the cm user can be added", async () => {
        const removed = UNREQUESTED.concat(marker(13002, "requested-review-from"),
          marker(13003, "removed-requested-review-from"));
        const cases: Array<{ name: string; rows: typeof UNREQUESTED; who?: typeof people; can: boolean }> = [
          { can: false, name: "requested", rows: SCENARIO_COMMENTS },
          { can: false, name: "removed, then requested again",
            rows: removed.concat(marker(13004, "re-requested-review-from")) },
          { can: true, name: "removed", rows: removed },
          { can: true, name: "a verdict nobody asked for", rows: UNREQUESTED },
          { can: true, name: "no row at all", rows: UNREQUESTED.filter(row => row.owner !== ME) },
          { can: false, name: "the assignee", rows: UNREQUESTED, who: { assignee: ME, owner: AUTHOR }},
          { can: false, name: "the author", rows: UNREQUESTED, who: { assignee: SAM, owner: ME }},
        ];
        for (const entry of cases) {
          comments = entry.rows;
          people = entry.who ?? { assignee: SAM, owner: AUTHOR };
          withPosting();
          const keys = await opened();
          if (entry.can) {
            await until(() => keys.get(CONTEXT_KEYS.canAddMeAsReviewer) === true);
          }
          expect(keys.get(CONTEXT_KEYS.canAddMeAsReviewer), entry.name).to.equal(entry.can);
          expect(reviews!.session.canAddMe(), entry.name).to.equal(entry.can);
        }

        // With the setting off it is never offered, even once the session knows the user could be added.
        comments = UNREQUESTED;
        people = { assignee: SAM, owner: AUTHOR };
        setting = false;
        withPosting();
        const keys = await opened();
        await until(() => reviews!.session.canAddMe());
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(keys.get(CONTEXT_KEYS.canAddMeAsReviewer)).to.equal(false);
        expect(requests).to.deep.equal([]);
      });

      it("adds the cm user to the active review once with the saved token, then shows them and stops offering itself",
        async () => {
          withPosting();
          const keys = await opened();
          await until(() => keys.get(CONTEXT_KEYS.canAddMeAsReviewer) === true);
          await commands.executeCommand("plastic-scm.reviews.addMeAsReviewer");
          expect(requests).to.deep.equal([{ body: { reviewers: [ME] }, path: REVIEWERS }]);
          await until(() => keys.get(CONTEXT_KEYS.canAddMeAsReviewer) === false);
          const active = reviews!.session.active!;
          expect(active.discussions.state === "ready" && active.discussions.value.reviewers).to.include(ME);
          expect(lines.filter(line => line.startsWith("error"))).to.deep.equal([]);
          expect(lines.join("\n")).to.not.contain(saved);
          expect(tokenWork()).to.deep.equal([]);
        });

      it("adds the cm user to a Reviews row's review, which need not be open", async () => {
        withPosting();
        await commands.executeCommand("plastic-scm.reviews.addMeAsReviewer", await reviewRow(BRANCH_REVIEW_ID));
        expect(requests.map(request => request.path.replace(/^.*\/codereview\//, "")))
          .to.deep.equal(["12831/reviewers"]);
        expect(lines.filter(line => line.startsWith("error"))).to.deep.equal([]);
      });

      it("offers the setting while it is off, asks before creating a token, and sends nothing", async () => {
        setting = false;
        withPosting();
        await opened();
        const settingOff = await informed(() => commands.executeCommand("plastic-scm.reviews.addMeAsReviewer"));
        expect(settingOff).to.deep.equal([
          "Add Me as Reviewer is experimental. Turn on the plastic-scm.reviews.experimentalPosting setting to use it.",
        ]);
        setting = true;
        withPosting(false);
        await opened();
        expect(await warned(undefined, () => commands.executeCommand("plastic-scm.reviews.addMeAsReviewer")))
          .to.deep.equal([CONSENT_MESSAGE]);
        expect(requests).to.deep.equal([]);
        expect(tokenWork()).to.deep.equal([]);
        // Declining either offer stops there: nothing fails for want of a token.
        expect(lines.filter(line => line.startsWith("error"))).to.deep.equal([]);
      });

      it("says why Add Me as Reviewer can't work where the region is not a documented server, and sends nothing",
        async () => {
          withPosting(true, "acme-studio|unity|-1|plastic.example.test");
          await opened();
          const shown = await informed(() => commands.executeCommand("plastic-scm.reviews.addMeAsReviewer"));
          expect(shown).to.deep.equal(["The Unity Version Control Server REST API documents no server for " +
            "acme-studio@unity, whose region is \"plastic.example.test\"."]);
          expect(requests).to.deep.equal([]);
          expect(tokenWork()).to.deep.equal([]);
          expect(lines.filter(line => line.startsWith("error"))).to.deep.equal([]);
        });

      it("creates a token with cm once the user agrees, adds, and offers Revoke Review Access Token", async () => {
        withPosting(false);
        const keys = await opened();
        expect(keys.get(CONTEXT_KEYS.hasAccessToken)).to.equal(false);
        const shown = await warned("Create Token and Add",
          () => commands.executeCommand("plastic-scm.reviews.addMeAsReviewer"));
        expect(shown).to.deep.equal([CONSENT_MESSAGE]);
        expect(tokenWork()).to.deep.equal([ "create", "reveal" ]);
        expect(requests.map(request => request.path)).to.deep.equal([REVIEWERS]);
        await until(() => keys.get(CONTEXT_KEYS.hasAccessToken) === true);
        expect(lines.filter(line => line.startsWith("error"))).to.deep.equal([]);
      });

      it("revokes the saved token with cm, and then stops offering Revoke Review Access Token", async () => {
        withPosting();
        const keys = await opened();
        await until(() => keys.get(CONTEXT_KEYS.hasAccessToken) === true);
        const shown = await informed(() => commands.executeCommand("plastic-scm.reviews.revokeAccessToken"));
        expect(shown).to.deep.equal(["Revoked the review access token for acme-studio@unity."]);
        expect(cm.calls[cm.calls.length - 1]).to.deep.equal([ "accesstoken", "revoke", tokenId(1), SERVER ]);
        await until(() => keys.get(CONTEXT_KEYS.hasAccessToken) === false);
        expect(requests).to.deep.equal([]);
      });

      it("opens a review in Unity Version Control from its row or the Review view, with the setting off", async () => {
        setting = false;
        withPosting();
        await opened();
        await commands.executeCommand("plastic-scm.reviews.openInDesktop", await reviewRow(BRANCH_REVIEW_ID));
        await commands.executeCommand("plastic-scm.reviews.openInDesktop");
        expect(external).to.deep.equal([ LINK, LINK ]);
        expect(requests).to.deep.equal([]);
        expect(tokenWork()).to.deep.equal([]);
      });

      it("starts Set Review Status…'s picker from the user's own verdict, then adds them and sends it", async () => {
        withPosting();
        await opened();
        let placeholder: string | undefined;
        let labels: string[] = [];
        await picking(() => commands.executeCommand("plastic-scm.reviews.setStatus"), fake => {
          placeholder = fake.placeholder;
          labels = fake.items.map(item => item.label);
          fake.accept(fake.items[0]);
          return Promise.resolve();
        });
        // The scenario's last verdict of the cm user is Rework required; the review itself is Under review.
        expect(placeholder).to.equal("Set your status on review #12831 (currently Rework required)");
        expect(labels).to.deep.equal([ "Under review", "Current", "Rework required", "Reviewed" ]);
        expect(requests).to.deep.equal([
          { body: { reviewers: [ME] }, path: REVIEWERS },
          { body: { status: "Under review" }, path: `${REVIEWERS}/${encodeURIComponent(ME)}/status` },
        ]);
        expect(lines.filter(line => line.startsWith("error"))).to.deep.equal([]);
      });

      it("follows the Overview's link, and asks first when the link lacks this window's key", async () => {
        withPosting();
        const keys = await opened();
        const addMe = "plastic-scm.reviews.addMeAsReviewer";
        const ran = (calls: ICommandCall[]) => calls.filter(call => call.command === addMe).length;
        let calls: ICommandCall[] = [];
        const foreign = await warned(undefined, async () => {
          calls = await executed(() => reviews!.actions.handleUri(addMeLink("c29tZW9uZSBlbHNl")));
        });
        expect(foreign).to.deep.equal([`Add yourself as a reviewer on review #${BRANCH_REVIEW_ID}?`]);
        expect([ ran(calls), requests.length ]).to.deep.equal([ 0, 0 ]);

        await warned("Add Me as Reviewer", async () => {
          calls = await executed(() => reviews!.actions.handleUri(addMeLink("c29tZW9uZSBlbHNl")));
        });
        expect([ ran(calls), requests.length ]).to.deep.equal([ 1, 1 ]);
        await until(() => keys.get(CONTEXT_KEYS.canAddMeAsReviewer) === false);

        // This window's own link asks nothing; the user is a reviewer now, so it says so and sends nothing.
        let shown: string[] = [];
        const own = await warned(undefined, async () => {
          shown = await informed(async () => {
            calls = await executed(() => reviews!.actions.handleUri(addMeLink(reviews!.session.linkKey)));
          });
        });
        expect(own).to.deep.equal([]);
        expect([ ran(calls), requests.length ]).to.deep.equal([ 1, 1 ]);
        expect(shown).to.deep.equal([`You're already a reviewer on review #${BRANCH_REVIEW_ID}.`]);
      });
    });
  });
});

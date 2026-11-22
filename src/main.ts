import {
  App,
  Editor,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  debounce,
} from "obsidian";
import { Pending, Place, Store } from "./comments";
import { markers } from "./markers";
import { Panel, VIEW_TYPE } from "./panel";

interface Settings {
  /** The agent that Herdr starts with the comments when no agent works in the folder of the note. */
  agent: string;
  /** The Herdr mod that shows the new agent as a chat. */
  chat: string;
}

const DEFAULTS: Settings = { agent: "claude", chat: "chat" };

interface Data extends Settings {
  comments: Pending[];
}

export default class HerdrCommentsPlugin extends Plugin {
  settings: Settings = DEFAULTS;
  store!: Store;
  private readonly save = debounce(() => void this.saveData(this.data()), 500, true);

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<Data>;
    this.settings = {
      agent: data.agent ?? DEFAULTS.agent,
      chat: data.chat ?? DEFAULTS.chat,
    };
    this.store = new Store(data.comments ?? [], () => this.save());

    this.registerView(VIEW_TYPE, (leaf) => new Panel(leaf, this));
    const { editor, reading } = markers(this.store, (id) => void this.select(id));
    this.registerEditorExtension(editor);
    this.registerMarkdownPostProcessor(reading);
    // The reading view puts the markers when it renders: render the notes whose comments changed.
    const stale = new Set<string>();
    const rerender = debounce(
      () => {
        for (const path of stale) {
          this.rerenderReading(path);
        }
        stale.clear();
      },
      300,
      true,
    );
    const changed = (path: string) => {
      stale.add(path);
      rerender();
    };
    this.register(this.store.onChange(changed));
    this.register(this.store.onMove(changed));

    this.addCommand({
      id: "add",
      name: "Add comment",
      editorCallback: (editor, ctx) => {
        if (ctx.file) {
          void this.add(editor, ctx.file);
        }
      },
    });
    this.addCommand({
      id: "submit",
      name: "Submit comments",
      callback: async () => (await this.panel()).submit(),
    });
    this.addCommand({
      id: "choose-agent",
      name: "Choose the agent",
      callback: async () => (await this.panel()).chooseAgent(),
    });
    this.addCommand({
      id: "show",
      name: "Show comments",
      callback: () => void this.panel(),
    });

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => this.store.renamePath(oldPath, file.path)),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.store.deletePath(file.path)),
    );
    // An open editor moves the comments itself; a change on disk to a closed note does not.
    this.registerEvent(
      this.app.vault.on("modify", async (file) => {
        if (
          file instanceof TFile &&
          this.store.notes().has(file.path) &&
          !this.views(file.path).length
        ) {
          this.store.findAgain(file.path, await this.app.vault.cachedRead(file));
        }
      }),
    );

    this.addSettingTab(new SettingTab(this.app, this));
  }

  onunload(): void {
    this.save.run();
  }

  private data(): Data {
    return { ...this.settings, comments: this.store.all() };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.data());
  }

  /** The folder of the vault on disk. */
  vaultPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
  }

  /** The editors and reading views of a note. */
  private views(path: string): MarkdownView[] {
    return this.app.workspace
      .getLeavesOfType("markdown")
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === path);
  }

  private rerenderReading(path: string): void {
    for (const view of this.views(path)) {
      if (view.getMode() === "preview") {
        view.previewMode.rerender(true);
      }
    }
  }

  /** The side panel, opened in the right sidebar when it is not open. */
  async panel(): Promise<Panel> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE, active: false });
    }
    await workspace.revealLeaf(leaf);
    return leaf.view as Panel;
  }

  /** Starts a comment on the selected text, else on the line of the cursor. */
  private async add(editor: Editor, file: TFile): Promise<void> {
    const start = editor.getCursor("from");
    const end = editor.getCursor("to");
    const empty = start.line === end.line && start.ch === end.ch;
    const from = editor.posToOffset(empty ? { line: start.line, ch: 0 } : start);
    let to = editor.posToOffset(
      empty ? { line: start.line, ch: editor.getLine(start.line).length } : end,
    );
    const content = editor.getValue();
    // A selection that ends at the start of a line does not include that line.
    while (to > from && content[to - 1] === "\n") {
      to--;
    }
    if (from === to) {
      new Notice("Select some text to comment on.");
      return;
    }
    const place: Place = {
      from,
      to,
      fromLine: editor.offsetToPos(from).line,
      toLine: editor.offsetToPos(to).line,
      anchor: content.slice(from, to),
    };
    (await this.panel()).startDraft(file, place);
  }

  /** Selects a comment in the side panel. */
  private async select(id: string): Promise<void> {
    (await this.panel()).select(id);
  }

  /** Gives the focus back to the editor of a note, after the person wrote a comment. */
  focusNote(path: string): void {
    const view = this.views(path).find((v) => v.getMode() === "source");
    if (view) {
      this.app.workspace.setActiveLeaf(view.leaf, { focus: true });
    }
  }

  /** Opens the note of a comment and selects its text. */
  async reveal(p: Pending): Promise<void> {
    const file = this.app.vault.getFileByPath(p.path);
    if (!file) {
      return;
    }
    let view = this.views(p.path)[0];
    if (!view) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      view = leaf.view as MarkdownView;
    }
    this.app.workspace.setActiveLeaf(view.leaf, { focus: !p.orphan });
    if (view.getMode() === "source" && !p.orphan) {
      const { editor } = view;
      const range = { from: editor.offsetToPos(p.from), to: editor.offsetToPos(p.to) };
      editor.setSelection(range.from, range.to);
      editor.scrollIntoView(range, true);
    }
  }
}

class SettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: HerdrCommentsPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Agent")
      .setDesc(
        "The agent that Herdr starts with the comments when no agent works in the folder of the note, as a command (for example claude or codex).",
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.agent).onChange(async (value) => {
          this.plugin.settings.agent = value.trim() || DEFAULTS.agent;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Chat")
      .setDesc(
        "The Herdr mod that shows the new agent as a chat: chat of herdr-chat, or the name of a fork of it. The agent starts in a terminal when this mod is not installed, when the agent is not claude, codex, or pi, or when this setting is empty.",
      )
      .addText((text) =>
        text.setValue(this.plugin.settings.chat).onChange(async (value) => {
          this.plugin.settings.chat = value.trim();
          await this.plugin.saveSettings();
        }),
      );
  }
}

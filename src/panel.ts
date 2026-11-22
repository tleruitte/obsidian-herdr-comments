import * as path from "node:path";
import { ItemView, Notice, SuggestModal, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { Pending, Place, reviewMessage, spanLabel } from "./comments";
import * as herdr from "./herdr";
import type HerdrCommentsPlugin from "./main";

export const VIEW_TYPE = "herdr-comments";

/** How often the panel checks the agents while it shows. */
const REFRESH_MS = 3_000;

/** A key that changes when the target changes, so Submit never goes to an agent the person did not see. */
function targetKey(target: herdr.Target): string {
  return target.kind === "agent" ? target.agent.address : `start:${target.folder}`;
}

/** A comment that the person writes, before it is saved. */
interface Draft {
  path: string;
  place: Place;
}

class AgentModal extends SuggestModal<herdr.Agent> {
  constructor(
    panel: Panel,
    private readonly candidates: herdr.Agent[],
    private readonly current: string | undefined,
    private readonly pick: (agent: herdr.Agent) => void,
  ) {
    super(panel.app);
    this.setPlaceholder("The agent that gets the comments");
  }

  getSuggestions(query: string): herdr.Agent[] {
    const q = query.toLowerCase();
    return this.candidates.filter((a) => herdr.describeAgent(a).toLowerCase().includes(q));
  }

  renderSuggestion(agent: herdr.Agent, el: HTMLElement): void {
    el.createDiv({ text: herdr.describeAgent(agent) });
    el.createEl("small", {
      text: agent.address === this.current ? `${agent.status} · current` : agent.status,
    });
  }

  onChooseSuggestion(agent: herdr.Agent): void {
    this.pick(agent);
  }
}

/**
 * The side panel: the comments of the open note. Its top says where the
 * comments go, and has the Submit button and the agent choice.
 */
export class Panel extends ItemView {
  /** The note that the panel shows. */
  private note: TFile | null = null;
  private lookup: herdr.Lookup | undefined;
  private unavailable: string | undefined;
  private error: string | undefined;
  /** The agent the person picked for each note. */
  private readonly chosen = new Map<string, string>();
  /** The target that the panel shows now. */
  private shown: string | undefined;
  private refreshing: Promise<void> | undefined;
  private sending = false;
  private draft: Draft | undefined;
  /** The comment that the person edits, and the text in its box. */
  private editing: string | undefined;
  private boxText = "";
  private selected: string | undefined;
  private headerEl!: HTMLElement;
  private listEl!: HTMLElement;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: HerdrCommentsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Herdr Comments";
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass("herdr-comments-panel");
    this.headerEl = this.contentEl.createDiv({ cls: "herdr-comments-header" });
    this.listEl = this.contentEl.createDiv({ cls: "herdr-comments-list" });
    const { store } = this.plugin;
    const offChange = store.onChange(() => {
      this.error = undefined;
      this.render();
      void this.refresh();
    });
    const offMove = store.onMove((p) => {
      if (p === this.note?.path) {
        this.render();
      }
    });
    this.register(offChange);
    this.register(offMove);
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.follow()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.follow()));
    this.registerInterval(
      window.setInterval(() => {
        if (this.contentEl.isShown()) {
          void this.refresh();
        }
      }, REFRESH_MS),
    );
    this.follow();
  }

  /** Shows the note that is open in the editor. */
  private follow(): void {
    const file = this.app.workspace.getActiveFile();
    const note = file?.extension === "md" ? file : null;
    if (note?.path === this.note?.path) {
      return;
    }
    this.note = note;
    this.editing = undefined;
    this.lookup = undefined;
    this.shown = undefined;
    this.error = undefined;
    this.render();
    void this.refresh();
  }

  /** Opens a box for a new comment on the text. */
  startDraft(note: TFile, place: Place): void {
    this.note = note;
    this.draft = { path: note.path, place };
    this.editing = undefined;
    this.boxText = "";
    this.render();
    this.listEl.querySelector("textarea")?.focus();
    void this.refresh();
  }

  /** Selects a comment, for example after a click on its marker. */
  select(id: string): void {
    const p = this.plugin.store.get(id);
    if (!p) {
      return;
    }
    if (p.path !== this.note?.path) {
      const file = this.app.vault.getFileByPath(p.path);
      if (file) {
        this.note = file;
      }
    }
    this.selected = id;
    this.render();
    this.listEl.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  }

  private render(): void {
    if (!this.listEl) {
      return;
    }
    this.renderHeader();
    const box = this.listEl.querySelector("textarea");
    const focused = box !== null && box === document.activeElement;
    this.listEl.empty();
    const note = this.note;
    if (!note) {
      this.listEl.createDiv({ cls: "herdr-comments-empty", text: "Open a note to see its comments." });
      return;
    }
    if (this.draft?.path !== note.path) {
      this.draft = undefined;
    }
    if (this.draft) {
      this.renderDraft(this.draft);
    }
    const list = this.plugin.store.forNote(note.path);
    for (const p of list) {
      this.renderComment(p);
    }
    if (!list.length && !this.draft) {
      this.listEl.createDiv({
        cls: "herdr-comments-empty",
        text: "No comments on this note. Select some text, then run Herdr Comments: Add comment.",
      });
    }
    const others = [...this.plugin.store.notes()].filter((n) => n !== note.path).length;
    if (others) {
      this.listEl.createDiv({
        cls: "herdr-comments-others",
        text: `${others} other note${others > 1 ? "s have" : " has"} pending comments.`,
      });
    }
    // A change of the comments must not take the box from the person.
    const next = this.listEl.querySelector("textarea");
    if (next && focused) {
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    }
  }

  private renderHeader(): void {
    const el = this.headerEl;
    el.empty();
    if (!this.note) {
      return;
    }
    const row = el.createDiv({ cls: "herdr-comments-target" });
    row.createDiv({ cls: "herdr-comments-to", text: this.describe() });
    const lookup = this.lookup;
    if (lookup?.candidates.length) {
      const choose = row.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Choose the agent" } });
      setIcon(choose, "user");
      choose.addEventListener("click", () => void this.chooseAgent());
    }
    const starts = lookup?.target.kind === "start";
    const submit = row.createDiv({
      cls: "clickable-icon",
      attr: { "aria-label": starts ? "Start an agent with these comments" : "Submit comments" },
    });
    setIcon(submit, starts ? "rocket" : "send");
    if (this.canSubmit()) {
      submit.addEventListener("click", () => void this.submit());
    } else {
      submit.addClass("is-disabled");
    }
    if (this.error) {
      el.createDiv({ cls: "herdr-comments-error", text: this.error });
    }
  }

  private renderQuote(parent: HTMLElement, text: string): void {
    parent.createDiv({ cls: "herdr-comments-quote", text });
  }

  /** A box for the text of a comment: Enter saves, Shift+Enter or Cmd+Enter starts a new line, Escape cancels. */
  private renderBox(parent: HTMLElement, save: (text: string) => void, cancel: () => void): void {
    const box = parent.createEl("textarea", {
      cls: "herdr-comments-box",
      attr: { placeholder: "Comment for the agent", rows: "3" },
    });
    box.value = this.boxText;
    box.addEventListener("input", () => {
      this.boxText = box.value;
    });
    box.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        box.setRangeText("\n", box.selectionStart, box.selectionEnd, "end");
        this.boxText = box.value;
      } else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        save(box.value.trim());
      }
    });
  }

  private renderDraft(draft: Draft): void {
    const el = this.listEl.createDiv({ cls: "herdr-comments-item is-draft" });
    el.createDiv({
      cls: "herdr-comments-span",
      text: `New comment · ${spanLabel(draft.place)}`,
    });
    this.renderQuote(el, draft.place.anchor);
    this.renderBox(
      el,
      (text) => {
        if (!text) {
          return;
        }
        this.draft = undefined;
        this.boxText = "";
        this.plugin.store.add(draft.path, draft.place, text);
        this.plugin.focusNote(draft.path);
      },
      () => {
        this.draft = undefined;
        this.boxText = "";
        this.render();
        this.plugin.focusNote(draft.path);
      },
    );
  }

  private renderComment(p: Pending): void {
    const el = this.listEl.createDiv({
      cls: "herdr-comments-item",
      attr: { "data-id": p.id },
    });
    el.toggleClass("is-selected", p.id === this.selected);
    el.toggleClass("is-orphan", p.orphan);
    const top = el.createDiv({ cls: "herdr-comments-item-top" });
    top.createDiv({
      cls: "herdr-comments-span",
      text: p.orphan ? `${spanLabel(p)} · its text was deleted` : spanLabel(p),
    });
    const edit = top.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Edit" } });
    setIcon(edit, "pencil");
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      this.editing = p.id;
      this.boxText = p.text;
      this.render();
      this.listEl.querySelector("textarea")?.focus();
    });
    const del = top.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Delete" } });
    setIcon(del, "trash-2");
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      this.plugin.store.delete(p.id);
    });
    this.renderQuote(el, p.quote);
    if (this.editing === p.id) {
      this.renderBox(
        el,
        (text) => {
          this.editing = undefined;
          if (text) {
            this.plugin.store.edit(p.id, text);
          } else {
            this.render();
          }
        },
        () => {
          this.editing = undefined;
          this.render();
        },
      );
    } else {
      el.createDiv({ cls: "herdr-comments-text", text: p.text });
      el.addEventListener("click", () => {
        this.selected = p.id;
        this.render();
        void this.plugin.reveal(p);
      });
    }
  }

  private describe(): string {
    const lookup = this.lookup;
    if (!lookup) {
      return this.unavailable ?? "Looking for the agent…";
    }
    const { target } = lookup;
    if (target.kind === "start") {
      const folder = path.basename(target.folder);
      return lookup.windowOpen
        ? `To: a new ${herdr.programName(this.plugin.settings.agent)} agent in ${folder}.`
        : `No agent works in ${folder}. Open the Herdr window to start one.`;
    }
    const to = `To: ${herdr.describeAgent(target.agent)}.`;
    return target.agent.status === "blocked"
      ? `${to} It waits for your answer in Herdr: answer it there, then submit.`
      : to;
  }

  private canSubmit(): boolean {
    const lookup = this.lookup;
    const target = lookup?.target;
    const blocked = target?.kind === "agent" && target.agent.status === "blocked";
    const canStart = target?.kind === "start" && lookup?.windowOpen === true;
    return (
      !this.sending &&
      !!this.note &&
      this.plugin.store.forNote(this.note.path).length > 0 &&
      ((target?.kind === "agent" && !blocked) || canStart)
    );
  }

  private notePath(note: TFile): string {
    return path.join(this.plugin.vaultPath(), note.path);
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.lookUp().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async lookUp(): Promise<void> {
    const note = this.note;
    if (!note) {
      this.lookup = undefined;
      this.unavailable = undefined;
    } else {
      try {
        const lookup = await herdr.lookUp(
          this.notePath(note),
          this.plugin.vaultPath(),
          this.chosen.get(note.path),
        );
        // The person opened another note in the meantime.
        if (note !== this.note) {
          return;
        }
        this.lookup = lookup;
        this.unavailable = undefined;
      } catch (e) {
        this.lookup = undefined;
        this.unavailable =
          e instanceof herdr.HerdrError && e.message.startsWith("Herdr is not available")
            ? e.message
            : `Herdr is not available: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    this.shown = this.lookup ? targetKey(this.lookup.target) : undefined;
    this.renderHeader();
  }

  async chooseAgent(): Promise<void> {
    const note = this.note;
    await this.refresh();
    const lookup = this.lookup;
    if (!note || !lookup?.candidates.length) {
      return;
    }
    const current = lookup.target.kind === "agent" ? lookup.target.agent.address : undefined;
    new AgentModal(this, lookup.candidates, current, (agent) => {
      this.chosen.set(note.path, agent.address);
      void this.refresh();
    }).open();
  }

  /** Sends the comments of the note, or starts an agent with them when no agent works in its folder. */
  async submit(): Promise<void> {
    const note = this.note;
    if (!note || this.sending) {
      return;
    }
    const list = this.plugin.store.forNote(note.path);
    if (!list.length) {
      return;
    }
    const before = this.shown;
    this.error = undefined;
    await this.refresh();
    const target = this.lookup?.target;
    if (!target || note !== this.note) {
      return;
    }
    // The agent left or another one took its place: show the new one first.
    if (targetKey(target) !== before) {
      new Notice("The agent that gets the comments changed. Look at the panel, then submit again.");
      return;
    }
    if (target.kind === "agent" && target.agent.status === "blocked") {
      return;
    }
    const { agent: program, chat } = this.plugin.settings;
    const n = `${list.length} comment${list.length > 1 ? "s" : ""}`;
    this.sending = true;
    this.renderHeader();
    try {
      if (target.kind === "agent") {
        const text = reviewMessage(path.relative(target.agent.cwd, this.notePath(note)), list);
        await herdr.send(target.agent, text);
        new Notice(`Sent ${n} to ${herdr.describeAgent(target.agent)}.`);
      } else {
        const text = reviewMessage(path.basename(note.path), list);
        await herdr.start(target.folder, program, text, chat);
        new Notice(`Started ${herdr.programName(program)} in Herdr with ${n}.`);
      }
      this.sending = false;
      this.plugin.store.clearNote(note.path);
    } catch (e) {
      this.sending = false;
      this.error = `Send failed: ${e instanceof Error ? e.message : String(e)}`;
      new Notice(this.error);
      this.renderHeader();
    }
  }
}

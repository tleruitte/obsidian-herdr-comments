import * as path from "node:path";
import { Notice } from "obsidian";
import { reviewMessage } from "./comments";
import * as herdr from "./herdr";
import type HerdrCommentsPlugin from "./main";

/** After a start, how long the next comments wait for the new agent before another agent can start. */
const START_GRACE_MS = 60_000;

/** What asks for a send: Submit, a save with the preference on, or the check of waiting comments. */
type Cause = "submit" | "save" | "wait";

/** A key that changes when the target changes, so Submit never goes to an agent the person did not see. */
export function targetKey(target: herdr.Target): string {
  return target.kind === "agent" ? target.agent.address : `start:${target.folder}`;
}

/** `null` when all notes changed. */
type Listener = (note: string | null) => void;

/**
 * Sends the comments of a note to its agent. It is part of the plugin, not of
 * the panel, so that comments that wait for the agent go also when the panel
 * is closed or their note is not open.
 */
export class Sender {
  /** The agent the person picked for each note. */
  private readonly chosen = new Map<string, string>();
  private readonly sending = new Set<string>();
  /** With the preference on, the notes whose comments wait for the agent, and go when it can get them. */
  private readonly waiting = new Set<string>();
  private readonly errors = new Map<string, string>();
  /** When the last start of an agent in each folder ended, so that the next comments go to that agent. */
  private readonly startedAt = new Map<string, number>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly plugin: HerdrCommentsPlugin) {
    plugin.store.onChange((note) => {
      if (this.errors.delete(note)) {
        this.changed(note);
      }
    });
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  chosenFor(note: string): string | undefined {
    return this.chosen.get(note);
  }

  choose(note: string, address: string): void {
    this.chosen.set(note, address);
    this.changed(note);
  }

  isSending(note: string): boolean {
    return this.sending.has(note);
  }

  error(note: string): string | undefined {
    return this.errors.get(note);
  }

  private immediately(): boolean {
    return this.plugin.settings.sendImmediately;
  }

  /** The preference changed. Turned off, the waiting comments wait for Submit. Turned on, nothing goes before the next save. */
  preferenceChanged(): void {
    this.waiting.clear();
    this.changed(null);
  }

  /** Sends the waiting comments of the notes whose agent can get them now. */
  tick(): void {
    if (!this.immediately()) {
      return;
    }
    for (const note of this.waiting) {
      void this.deliver(note, "wait");
    }
  }

  /** With the preference on, sends the comments of the note after a save, or waits for the agent. */
  async saved(note: string): Promise<void> {
    if (this.immediately()) {
      await this.deliver(note, "save");
    }
  }

  /** Sends the comments of the note. With the preference off, only to the agent `shown` in the panel. */
  submit(note: string, shown: string | undefined): Promise<void> {
    return this.deliver(note, "submit", shown);
  }

  private wait(note: string, on: boolean): void {
    if (on !== this.waiting.has(note)) {
      if (on) {
        this.waiting.add(note);
      } else {
        this.waiting.delete(note);
      }
      this.changed(note);
    }
  }

  /**
   * Sends the comments of a note, or starts an agent with them when no agent
   * works in its folder. With the preference on, they go to the agent that is
   * the default now, in the order they were written; when that agent waits
   * for an answer, or a new agent starts, they wait. With the preference off,
   * they go only to the agent that the panel showed.
   */
  private async deliver(note: string, cause: Cause, shown?: string): Promise<void> {
    const { store } = this.plugin;
    // A comment saved during a send goes after it, to the same agent.
    if (this.sending.has(note)) {
      return;
    }
    if (!store.forNote(note).length) {
      this.wait(note, false);
      return;
    }
    const auto = this.immediately();
    const vault = this.plugin.vaultPath();
    const notePath = path.join(vault, note);
    let lookup: herdr.Lookup;
    try {
      lookup = await herdr.lookUp(notePath, vault, this.chosen.get(note));
    } catch (e) {
      if (cause !== "submit") {
        this.fail(
          note,
          e instanceof herdr.HerdrError && e.message.startsWith("Herdr is not available")
            ? e.message
            : `Herdr is not available: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return;
    }
    if (this.sending.has(note)) {
      return;
    }
    const { target } = lookup;
    // The agent left or another one took its place: show the new one first.
    if (!auto && targetKey(target) !== shown) {
      new Notice("The agent that gets the comments changed. Look at the panel, then submit again.");
      this.changed(note);
      return;
    }
    // A comment would answer the prompt of the agent.
    if (target.kind === "agent" && target.agent.status === "blocked") {
      if (auto) {
        this.wait(note, true);
      }
      return;
    }
    if (target.kind === "start") {
      // The agent that started last does not show yet: the comments go to it when it does.
      const started = this.startedAt.get(target.folder);
      if (auto && started !== undefined && Date.now() - started < START_GRACE_MS) {
        this.wait(note, true);
        return;
      }
      if (!lookup.windowOpen) {
        if (cause !== "submit") {
          this.fail(note, `No agent works in ${path.basename(target.folder)}. Open the Herdr window to start one.`);
        }
        return;
      }
    }
    const list = auto ? store.inOrder(note) : store.forNote(note);
    const { agent: program, chat } = this.plugin.settings;
    const n = `${list.length} comment${list.length > 1 ? "s" : ""}`;
    const tell = (message: string): void => {
      new Notice(message, auto ? 2_000 : undefined);
    };
    this.sending.add(note);
    this.errors.delete(note);
    this.changed(note);
    try {
      if (target.kind === "agent") {
        await herdr.send(target.agent, reviewMessage(herdr.notePathFor(target.agent.cwd, notePath), list));
        tell(`Sent ${n} to ${herdr.describeAgent(target.agent)}.`);
      } else {
        await herdr.start(target.folder, program, reviewMessage(herdr.notePathFor(target.folder, notePath), list), chat);
        this.startedAt.set(target.folder, Date.now());
        tell(`Started ${herdr.programName(program)} in Herdr with ${n}.`);
      }
    } catch (e) {
      this.sending.delete(note);
      this.fail(note, `Send failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.sending.delete(note);
    this.waiting.delete(note);
    store.remove(note, list.map((p) => p.id));
    if (auto && store.forNote(note).length) {
      await this.deliver(note, "save");
    }
  }

  /** The comments stay, with the error. Submit or the next save tries again. */
  private fail(note: string, message: string): void {
    this.waiting.delete(note);
    this.errors.set(note, message);
    new Notice(message);
    this.changed(note);
  }

  private changed(note: string | null): void {
    for (const listener of this.listeners) {
      listener(note);
    }
  }
}

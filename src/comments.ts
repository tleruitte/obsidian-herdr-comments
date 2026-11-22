import { randomUUID } from "node:crypto";

/**
 * A pending comment, as kept in the data of the plugin. The comment follows
 * its text when the note changes, but the quote stays as it was when the
 * comment was written, so the agent gets the text that the person saw.
 */
export interface Pending {
  id: string;
  /** The path of the note in the vault. */
  path: string;
  /** Where the text is now, as offsets in the note. */
  from: number;
  to: number;
  /** The lines (0-based) of the text now. */
  fromLine: number;
  toLine: number;
  /** The selected text, as it was when the comment was written. */
  quote: string;
  /** The text at `from`-`to` now, to find it again after a change outside the editor. */
  anchor: string;
  text: string;
  /** The text of the comment was deleted. */
  orphan: boolean;
}

/** Where a comment is now. */
export interface Place {
  from: number;
  to: number;
  fromLine: number;
  toLine: number;
  anchor: string;
}

/** The new place of a comment, or `null` when its text was deleted. */
export type Moved = { id: string; place: Place | null };

type Listener = (path: string) => void;

/** Whether a path is `path`, or in the folder `path`. */
function isIn(path: string, p: string): boolean {
  return p === path || p.startsWith(`${path}/`);
}

/** The 0-based line of an offset in a text. */
function lineOf(content: string, offset: number): number {
  let line = 0;
  for (let i = content.indexOf("\n"); i !== -1 && i < offset; i = content.indexOf("\n", i + 1)) {
    line++;
  }
  return line;
}

/** The place of `from`-`to` in a text. */
export function placeIn(content: string, from: number, to: number): Place {
  return {
    from,
    to,
    fromLine: lineOf(content, from),
    toLine: lineOf(content, to),
    anchor: content.slice(from, to),
  };
}

/** The place of the text of a comment, found again near where it was, or `null`. */
export function findAgain(content: string, p: Pending): Place | null {
  if (!p.anchor) {
    return null;
  }
  let best = -1;
  for (let i = content.indexOf(p.anchor); i !== -1; i = content.indexOf(p.anchor, i + 1)) {
    if (best === -1 || Math.abs(i - p.from) < Math.abs(best - p.from)) {
      best = i;
    }
  }
  return best === -1 ? null : placeIn(content, best, best + p.anchor.length);
}

/**
 * The pending comments of all notes. A change tells the listeners which note
 * changed: `onChange` when comments come, go, or lose their text, `onMove`
 * when they only move.
 */
export class Store {
  private readonly changeListeners = new Set<Listener>();
  private readonly moveListeners = new Set<Listener>();

  constructor(
    private pending: Pending[],
    private readonly persist: () => void,
  ) {}

  onChange(listener: Listener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onMove(listener: Listener): () => void {
    this.moveListeners.add(listener);
    return () => this.moveListeners.delete(listener);
  }

  all(): Pending[] {
    return this.pending;
  }

  /** The comments of a note, in the order of the text. */
  forNote(path: string): Pending[] {
    return this.pending
      .filter((p) => p.path === path)
      .sort((a, b) => a.fromLine - b.fromLine || a.from - b.from);
  }

  /** The notes that have pending comments. */
  notes(): Set<string> {
    return new Set(this.pending.map((p) => p.path));
  }

  get(id: string): Pending | undefined {
    return this.pending.find((p) => p.id === id);
  }

  add(path: string, place: Place, text: string): Pending {
    const p: Pending = {
      id: randomUUID(),
      path,
      ...place,
      quote: place.anchor,
      text,
      orphan: false,
    };
    this.pending.push(p);
    this.changed(path);
    return p;
  }

  edit(id: string, text: string): void {
    const p = this.get(id);
    if (p) {
      p.text = text;
      this.changed(p.path);
    }
  }

  delete(id: string): void {
    const p = this.get(id);
    if (p) {
      this.pending = this.pending.filter((q) => q !== p);
      this.changed(p.path);
    }
  }

  clearNote(path: string): void {
    this.pending = this.pending.filter((p) => p.path !== path);
    this.changed(path);
  }

  /** Deletes the comments of a note, or of the notes in a folder. */
  deletePath(path: string): void {
    for (const note of this.notes()) {
      if (isIn(path, note)) {
        this.clearNote(note);
      }
    }
  }

  /** Gives the comments of a note, or of the notes in a folder, their new path. */
  renamePath(from: string, to: string): void {
    for (const note of this.notes()) {
      if (isIn(from, note)) {
        const moved = to + note.slice(from.length);
        for (const p of this.pending) {
          if (p.path === note) {
            p.path = moved;
          }
        }
        this.changed(note);
        this.changed(moved);
      }
    }
  }

  /** Writes where the comments of a note are now. */
  move(path: string, moved: Moved[]): void {
    let lost = false;
    let changed = false;
    for (const { id, place } of moved) {
      const p = this.get(id);
      if (!p || p.orphan) {
        continue;
      }
      if (place) {
        changed ||= p.from !== place.from || p.to !== place.to || p.anchor !== place.anchor;
        Object.assign(p, place);
      } else {
        p.orphan = true;
        lost = true;
      }
    }
    if (lost) {
      this.changed(path);
    } else if (changed) {
      this.persist();
      for (const listener of this.moveListeners) {
        listener(path);
      }
    }
  }

  /** Finds the comments of a note again in its new content, after a change outside the editor. */
  findAgain(path: string, content: string): void {
    this.move(
      path,
      this.forNote(path)
        .filter((p) => !p.orphan)
        .map((p) => ({
          id: p.id,
          place:
            content.slice(p.from, p.to) === p.anchor
              ? placeIn(content, p.from, p.to)
              : findAgain(content, p),
        })),
    );
  }

  private changed(path: string): void {
    this.persist();
    for (const listener of this.changeListeners) {
      listener(path);
    }
  }
}

type Span = Pick<Pending, "fromLine" | "toLine">;

function span(p: Span): string {
  return p.fromLine === p.toLine
    ? `line ${p.fromLine + 1}`
    : `lines ${p.fromLine + 1}-${p.toLine + 1}`;
}

/** "Line 12", or "Lines 12-14". */
export function spanLabel(p: Span): string {
  const s = span(p);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The comments of a note as one review message, in the shape of the Herdr reviewer. */
export function reviewMessage(note: string, list: Pending[]): string {
  const n = list.length;
  const parts = list.map((p) => {
    const where = p.orphan
      ? `${spanLabel(p)}, where the text was before it was deleted`
      : spanLabel(p);
    const quote = p.quote
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `### ${where}\n${quote}\n\nComment: ${p.text}`;
  });
  return `Review of ${note}: ${n} comment${n > 1 ? "s" : ""}. The quoted text is as it was when each comment was written; the line numbers are where that text is now.\n\n${parts.join("\n\n")}`;
}

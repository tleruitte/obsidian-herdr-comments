import { Extension, RangeSet, StateEffect, StateField, Text } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  PluginValue,
  ViewPlugin,
  ViewUpdate,
  gutter,
} from "@codemirror/view";
import { MarkdownPostProcessor, editorInfoField, setIcon } from "obsidian";
import { Moved, Place, Store, findAgain } from "./comments";

/** A comment in an editor: the editor moves it when its text moves. */
interface Mark {
  id: string;
  from: number;
  to: number;
}

const setMarks = StateEffect.define<Mark[]>();

const marksField = StateField.define<Mark[]>({
  create: () => [],
  update(marks, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMarks)) {
        return effect.value;
      }
    }
    if (!tr.docChanged) {
      return marks;
    }
    // Text typed at an end of the commented text stays out of it.
    return marks.map((m) => ({
      id: m.id,
      from: tr.changes.mapPos(m.from, 1),
      to: tr.changes.mapPos(m.to, -1),
    }));
  },
  provide: (field) =>
    EditorView.decorations.from(field, (marks) =>
      Decoration.set(
        marks
          .filter((m) => m.from < m.to)
          .map((m) =>
            Decoration.mark({
              class: "herdr-comments-highlight",
              attributes: { "data-herdr-comment": m.id },
            }).range(m.from, m.to),
          ),
        true,
      ),
    ),
});

class CommentMarker extends GutterMarker {
  constructor(readonly id: string) {
    super();
  }

  eq(other: CommentMarker): boolean {
    return other.id === this.id;
  }

  toDOM(): Node {
    const el = document.createElement("div");
    el.className = "herdr-comments-gutter-mark";
    setIcon(el, "message-square");
    return el;
  }
}

function placeIn(doc: Text, from: number, to: number): Place {
  return {
    from,
    to,
    fromLine: doc.lineAt(from).number - 1,
    toLine: doc.lineAt(to).number - 1,
    anchor: doc.sliceString(from, to),
  };
}

/**
 * The markers of the comments in the editor, and the reading view. A click
 * on a marker selects its comment in the side panel.
 */
export function markers(
  store: Store,
  select: (id: string) => void,
): { editor: Extension; reading: MarkdownPostProcessor } {
  const syncs = new Set<Sync>();

  /** Gives the comments of the note to the editor, and gives their moves back to the store. */
  class Sync implements PluginValue {
    /** The note that the comments in the editor are of. */
    path: string | undefined;
    private timer = 0;

    constructor(private readonly view: EditorView) {
      syncs.add(this);
      this.schedule();
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) {
        this.schedule();
      }
    }

    destroy(): void {
      syncs.delete(this);
      window.clearTimeout(this.timer);
    }

    /**
     * The editor can show another note in a change of the whole text. Wait
     * until that change is done, to know which note the text is of.
     */
    schedule(): void {
      this.timer ||= window.setTimeout(() => {
        this.timer = 0;
        this.sync();
      }, 0);
    }

    load(): void {
      const path = this.view.state.field(editorInfoField, false)?.file?.path;
      this.path = path;
      const doc = this.view.state.doc;
      const list = path ? store.forNote(path).filter((p) => !p.orphan) : [];
      // The note can have changed since the comments last saw it.
      const stale = list.filter(
        (p) => p.to > doc.length || doc.sliceString(p.from, p.to) !== p.anchor,
      );
      if (path && stale.length) {
        const content = doc.toString();
        store.move(
          path,
          stale.map((p) => ({ id: p.id, place: findAgain(content, p) })),
        );
      }
      this.view.dispatch({
        effects: setMarks.of(
          list.filter((p) => !p.orphan).map(({ id, from, to }) => ({ id, from, to })),
        ),
      });
    }

    private sync(): void {
      const path = this.view.state.field(editorInfoField, false)?.file?.path;
      if (path !== this.path) {
        this.load();
        return;
      }
      if (!path) {
        return;
      }
      const doc = this.view.state.doc;
      let content: string | undefined;
      const moved: Moved[] = this.view.state.field(marksField).map((m) => {
        if (m.from < m.to) {
          return { id: m.id, place: placeIn(doc, m.from, m.to) };
        }
        // The text went away: it can be somewhere else, when the whole note changed.
        const p = store.get(m.id);
        content ??= doc.toString();
        return { id: m.id, place: p ? findAgain(content, p) : null };
      });
      store.move(path, moved);
    }
  }

  store.onChange((path) => {
    for (const sync of syncs) {
      if (sync.path === path) {
        sync.load();
      }
    }
  });

  const markAt = (view: EditorView, pos: number): Mark | undefined => {
    const line = view.state.doc.lineAt(pos);
    return view.state
      .field(marksField)
      .find((m) => m.from < m.to && m.from >= line.from && m.from <= line.to);
  };

  const editor: Extension = [
    marksField,
    ViewPlugin.define((view) => new Sync(view)),
    gutter({
      class: "herdr-comments-gutter",
      markers: (view) =>
        RangeSet.of(
          view.state
            .field(marksField)
            .filter((m) => m.from < m.to)
            .map((m) => new CommentMarker(m.id).range(view.state.doc.lineAt(m.from).from)),
          true,
        ),
      lineMarkerChange: (update) =>
        update.startState.field(marksField) !== update.state.field(marksField),
      domEventHandlers: {
        mousedown: (view, line) => {
          const mark = markAt(view, line.from);
          if (mark) {
            select(mark.id);
          }
          return !!mark;
        },
      },
    }),
    EditorView.domEventHandlers({
      click: (event) => {
        const el = (event.target as HTMLElement).closest("[data-herdr-comment]");
        const id = el?.getAttribute("data-herdr-comment");
        if (id) {
          select(id);
        }
        return false;
      },
    }),
  ];

  // The reading view shows blocks, not lines: it marks the blocks that have a comment.
  const reading: MarkdownPostProcessor = (el, ctx) => {
    const list = store.forNote(ctx.sourcePath).filter((p) => !p.orphan);
    const info = list.length ? ctx.getSectionInfo(el) : null;
    const hit =
      info && list.find((p) => p.fromLine <= info.lineEnd && p.toLine >= info.lineStart);
    if (!hit) {
      return;
    }
    el.addClass("herdr-comments-block");
    const mark = el.createDiv({ cls: "herdr-comments-block-mark" });
    setIcon(mark, "message-square");
    mark.addEventListener("click", (event) => {
      event.preventDefault();
      select(hit.id);
    });
  };

  return { editor, reading };
}

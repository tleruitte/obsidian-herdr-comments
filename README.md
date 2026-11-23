# Herdr Comments for Obsidian

Obsidian plugin that sends your comments on the text of a note to the coding agent that works on the note in [Herdr](https://herdr.dev). It is the Obsidian version of [Herdr Comments for VS Code and Cursor](https://github.com/tleruitte/vscode-extensions/tree/main/herdr-comments).

The plugin works only on the desktop. Herdr must run on the same computer.

## Install

1. Build the plugin:

   ```sh
   npm install
   npm run build
   ```

2. Link the folder into the plugins of your vault, then turn on **Herdr Comments** in **Settings → Community plugins**:

   ```sh
   ln -s "$PWD" <vault>/.obsidian/plugins/herdr-comments
   ```

3. Set the shortcuts in **Settings → Hotkeys**. The plugin has none of its own. We suggest:
   - `⌘I` for **Herdr Comments: Add comment**. This replaces **Toggle italics**.
   - `⌘⇧I` for **Herdr Comments: Submit comments**. With the **Send immediately** setting on (the default), you need Submit only to try a failed send again.

## How to use

1. Open a note in the editing view (Source or Live Preview). Select some text, or put the cursor on a line, and run **Add comment**.

2. The side panel opens with a box for the comment. Write the comment and press `Enter`. `⇧Enter` or `⌘Enter` starts a new line, and `Esc` cancels. The comment goes to the agent at once (see step 5). Add more comments in the same note.

3. The side panel shows the pending comments of the open note: the comments that did not go to the agent yet. In the note, the commented text has a highlight and a mark in the margin. The reading view marks each block that has a comment. Click a mark to select its comment in the panel. Click a comment in the panel to go to its text. Edit or delete it in the panel.

   When the note changes, a comment follows its text. When its text is deleted, the panel says so; the comment still goes, with the text as it was.

4. The top of the panel says which agent gets the comments, for example `To: Claude · setup / fix login`:
   - The candidates are the agents in Herdr whose folder holds the note and is in the vault.
   - The default is the agent that has the focus in Herdr, else an idle one, else the first. Click the person icon to choose another candidate.
   - With no candidate, a new agent starts with the first comment, in the folder of the note, and the next comments go to it: in a new tab of the Herdr space of that folder, else in a new space. The **Agent** setting says which agent (`claude` by default).
   - When [herdr-chat](https://github.com/ChmaraX/herdr-chat) is installed, the new agent is a chat. The **Chat** setting says which chat mod (`chat` by default). Without that mod, or for an agent other than `claude`, `codex`, or `pi`, the agent starts in a terminal.

5. Each comment goes to the agent when you save it, to the agent that the top of the panel shows then. The agent gets the path of the note, the line, the text as it was when you wrote the comment, and the comment. A working agent gets it during its turn.
   - When the agent waits for your answer to a prompt in Herdr, the comment waits in the panel, and goes after you answer, also when the note is not open or the panel is closed. Choose another candidate to send it there now.
   - When a send fails, the comment stays in the panel with the error. Click the send icon, or run **Submit comments**, to try again; the next comment you save in the same note also tries again. Comments that go together are one message, the oldest first.
   - A sent comment goes away: to correct it, write a new comment. You can edit or delete a comment while it is in the panel.

### Send the comments as one review

Up to version 0.1.0, the comments of a note stayed pending until you submitted them. To work in that way, turn off the **Send immediately** setting. Then:

- Click the send icon, or run **Submit comments**. The agent gets the comments of the note as one message: the path of the note, then for each comment the line, the text as it was when you wrote the comment, and the comment. When the agent waits for your answer to a prompt in Herdr, Submit is off until you answer.
- After a successful send, the comments of the note go away. If the agent changed since the panel showed it, Submit does not send: look at the new agent and submit again. The other notes keep their comments; the panel says how many notes have pending comments.

## Development

`npm run dev` builds the plugin again at each change. Reload Obsidian, or turn the plugin off and on, to load the new build.

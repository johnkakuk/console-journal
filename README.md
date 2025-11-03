# 🧠 Console Journal

A retro console journal built with Node.js, CodeMirror 6, and SQLite — blending 80s hacker aesthetics with modern usability. Packaged with Electron.

Type, reflect, and organize your thoughts in a glowing green terminal that feels alive.

---- 

## ✨ Features
- Retro Console Interface
	- A black-and-green terminal-style shell with blinking cursor and command-based navigation.
- Journal Command
	- Opens a daily entry by date (YYYY-MM-DD)
	- Auto-creates entries if they don’t exist
	- Supports flags:
		- -y → yesterday
		- -t → tomorrow
		- -help → usage guide
		- MM-DD → opens the most recent past occurrence of that month/day
- Writer Workspace
	- Launch with the `write` command
	- Dual-pane retro UI with file selector and live editor
	- Create, duplicate, delete, and export documents to PDF
	- Editable document titles with folder-ready storage model
- Journal Markdown Editor
	- Built with CodeMirror 6
	- Basic Markdown highlighting
	- To-do list support (- [ ]() and - [x]() with clickable toggles)
	- Persistent save to SQLite (for now)
	- Typewriter mode with adaptive scroll anchoring
	- ⌘+S / CTRL+S to save, ⌘+Q / CTRL+Q to quit
	- Unsaved change indicator (\* in banner)
	- Animated save notification (toast in bottom-right corner)
	- Undo-aware save indicator — removes * when state matches last save
	- Smooth typewriter scroll — keeps active line centered dynamically during typing
	- Built-in search (CMD+F, Enter/Shift+Enter to navigate)
- Entry Management
	- view → browse latest 15 entries with arrow-key navigation, open/delete options
	- delete YYYY-MM-DD, -t → deletes specific entries
	- Deletes also available within view mode (arrow navigate + DEL with confirmation)
	- search "term" → find entries by keyword
	- Smooth keyboard-driven navigation between results
	- Interactive lists remain navigable after delete operations
	- SQLite Integration
		- All journal entries are stored locally in a fast, file-based database located at:  
			\~/Library/Application Support/console-journal/app.db
- Command History
	- Recall previous commands using the ↑ / ↓ arrow keys.
- Exporting
	- Export entries in bulk or individually
	- Export to .txt or .pdf
	- Supports flags:
		- -a → all entries
		- YYYY → all entries from a given year
		- YYYY-MM → all entries from a given month
		- YYYY-MM-DD → the entry from a given day
		- ... -pdf → export as .pdf instead of .txt
		- Theme can be edited in css/pdf.css
- Theme Editor — Modify fonts and colors live inside the app, with restore-to-default option.
- Browser-based web app
	- Saves to local storage
	- Automatic save and load from IndexedDB (Web) or SQLite (Desktop).
	- Quit confirmation when unsaved changes are present.

---- 

## 🧩 Upcoming Features
- Projects System — For long-form or creative writing:
	- Nested folder structure (e.g., Book \> Drafts \> Manuscript)
	- Chronological indexing for journal entries (YYYY/MM/entry.md)
- Windows/Linux ports




---- 

## ⚙️ Tech Stack

| Layer    | Tech                            |
| -------- | ------------------------------- |
| Frontend | CodeMirror 6, JavaScript, CSS   |
| Backend  | Electron (IPC + better-sqlite3) |
| Storage  | SQLite (Local)                  |
| Bundler  | Native ES Modules               |
| Platform | macOS                           |


---- 

## 🚀 Getting Started

### 1. Clone the repo
```cs
git clone https://github.com/yourusername/console-journal.git
cd console-journal
```

### 2. Install dependencies
```cs
npm install
```

### 3. Run the app
```cs
npm run bundle
npm run start:web:https
```


---- 

## 🧠 Philosophy

“I want the journaling app that I haven’t been able to find.”

Console Journal is the minimalist, keyboard-first journaling environment I’ve always wanted. For hackers, writers, and thinkers who want to stay close to the metal.

---- 

## 🧰 Keyboard Shortcuts

| Shortcut              | Action                          |
| --------------------- | ------------------------------- |
| ⌘ + S                 | Save entry                      |
| ⌘ + Q / CTRL + Q      | Quit editor                     |
| ⌘ + Shift + N / CTRL + Shift + N | New writer document     |
| ⌘ + F                 | Open search panel               |
| Enter / Shift + Enter | Next / Previous match           |
| ↑ / ↓                 | Navigate command history        |
| ESC                   | Exit subprogram / cancel search |
| DEL                   | Delete entry (in view mode)     |
| Y / N                 | Confirm / Cancel actions        |


---- 

## 🧑‍💻 Author

John Kakuk

# 🧠 Console Journal

A distraction-free journaling built with Node.js, CodeMirror 6, and SQLite — blending retro hacker aesthetics with modern usability. Packaged with Electron.

Type, reflect, and organize your thoughts in a terminal setting that feels alive.


---- 


## ✨ Features

### ✍️ Journal Workspace
- Runs through pseudo console for full keyboard control
- "journal" creates a daily entry
- Supports flags:
	- -y → yesterday
	- -t → tomorrow
	- -help → usage guide
	- MM-DD → opens the most recent past occurrence of that month/day
- Entry Management
	- view → browse latest 15 entries with arrow-key navigation, open/delete options
	- delete → deletes specific entries
	- Deletes also available within view mode (arrow navigate + DEL with confirmation)
	- search "term" → find entries by keyword
	- Smooth keyboard-driven navigation between results (mouse works too)
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

### 💻 Writer Workspace
- For non-journal writing projects
- Launch with the `write` command
- Responsive GUI with file selector and live editor
- Supports right click with contextual menus
- Create, duplicate, delete, and export documents to PDF
- Editable document titles with folder-ready storage model

### 🔠 Markdown Editor Details
- Built with CodeMirror 6
- Basic Markdown highlighting
- Clickable to-do list support
- Persistent local save
- Typewriter mode with adaptive scroll anchoring
- ⌘+S / CTRL+S to save, ⌘+Q / CTRL+Q to quit
- Animated save notification (toast in bottom-right corner)
- Undo-aware save indicator — removes * when state matches last save
- Built-in search (CMD+F, Enter/Shift+Enter to navigate)

## ⚙️ Theme Editor
- Modify fonts and colors live inside the app
- Choose your own width for the editor (default 80 characters)
- Restore to defaults at any time
- Changes persist


Try the browser-based web app at https://console-journal-api.onrender.com


---- 

## 🧩 Upcoming Features
- Nested folder structure for Writer Workspace (e.g., Book \> Drafts \> Manuscript)
- Mac/Windows/Linux desktop apps


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

### 2. Set up
```cs
npm install
npx electron-rebuild -f -w better-sqlite3
```

### 3. Run the app
```cs
npm run bundle
npm run start:web:https
```

Or:

```cs
npm run bundle
npm run start:desktop
```


---- 


## 🧠 Philosophy

“I want the journaling app that I haven’t been able to find.”

Console Journal is the minimalist, keyboard-first journaling environment I’ve always wanted. For writers who want to stay close to the metal.
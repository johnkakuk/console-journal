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
- Markdown Editor (Writer)
	- Built with CodeMirror 6
	- Basic Markdown highlighting
	- To-do list support (- [ ](#) and - [x](#) with clickable toggles)
	- Persistent save to SQLite (for now)
	- Typewriter mode (centered active line)
	- CMD+S to save, CTRL+X to exit
	- Unsaved change indicator (\* in banner)
	- Built-in search (CMD+F, Enter/Shift+Enter to navigate)
- Entry Management
	- view → browse latest 15 entries with arrow-key navigation
	- search "term" → find entries by keyword
	- Smooth keyboard-driven navigation between results
	- Non-interactive frozen views remain visible in the console
	- SQLite Integration
		- All journal entries are stored locally in a fast, file-based database located at:  
			~/Library/Application Support/console-journal/app.db
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
- Theme can be edited in css/theme.css

---- 

## 🧩 Upcoming Features
- Projects System — For long-form or creative writing:
	- Nested folder structure (e.g., Book \> Drafts \> Manuscript)
	- Chronological indexing for journal entries (YYYY/MM/entry.md)
- Theme Engine
	- Switch between retro CRT themes and modern minimal aesthetics.
- Browser-based web app
	- Saves to local storage
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
git clone https://github.com/yourusername/console-journal.git`
cd console-journal
```

### 2. Install dependencies
```cs
npm install
```

### 3. Run the app
```cs
npm run start
```

### 4. Package it
```cs
npm run build
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
| CTRL + X              | Exit editor                     |
| ⌘ + F                 | Open search panel               |
| Enter / Shift + Enter | Next / Previous match           |
| ↑ / ↓                 | Navigate command history        |
| ESC                   | Exit subprogram / cancel search |


---- 

## 🧑‍💻 Author

John Kakuk
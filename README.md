# Pipenv Helper for VS Code 🐍

Bring **PyCharm-like Pipenv support** to Visual Studio Code.

**Pipenv Helper** detects `Pipfile` projects, manages Pipenv virtual environments, keeps your environment in sync with `Pipfile.lock`, and integrates cleanly with the VS Code Python extension — without shell hacks or surprises.

---

## 📦 Requirements

- pipenv available on PATH
- VS Code Python extension recommended

## ✨ Features

### 🔍 Automatic Pipenv Detection

- Activates when a `Pipfile` is present
- Detects whether a Pipenv virtual environment exists
- Offers to create one if missing

---

### 🧠 Smart Environment Sync

- Detects when `Pipfile.lock` changes
- Tracks lockfile hashes to prevent repeated prompts
- Clearly shows when your environment is:
  - **Synced**
  - **Out of sync**
  - **Missing a lockfile**

---

### 📊 Status Bar Integration

A persistent status indicator appears in the VS Code status bar: **Pipenv: my-project   ✔ synced**

Click it to access quick actions:

- Activate environment in terminal
- Sync environment
- Lock dependencies
- Recreate environment
- Use Pipenv interpreter

---

### 🖥️ Activate Virtualenv in Terminal (One Click)

Activate the Pipenv virtual environment **in your current terminal** with a single click.

- Uses standard virtualenv activation
- No `pipenv shell`
- No subshells
- No surprise behavior

This matches how **PyCharm** and the **VS Code Python extension** work internally.

---

### 🐍 Python Interpreter Auto-Configuration

- Automatically sets `python.defaultInterpreterPath`
- Works with:
  - Linting
  - Debugging
  - Testing
  - Tasks
- New terminals activate the environment automatically (via VS Code Python extension)

---

## 🚀 How It Works

| Action                    | Who Handles It           |
|---------------------------|--------------------------|
| Create virtualenv         | Pipenv                   |
| Select Python interpreter | Pipenv Helper            |
| Activate terminal         | VS Code Python extension |
| Dependency locking        | Pipenv                   |
| Sync enforcement          | Pipenv Helper            |

No shell hijacking. No opinionated workflows.

---

## ⚙️ Commands

Available via Command Palette or Status Bar:

- **Pipenv: Setup Environment**
- **Pipenv: Sync Environment**
- **Pipenv: Lock Dependencies**
- **Pipenv: Select Interpreter**
- **Pipenv: Activate Environment in Terminal**

---

## ⚡ Configuration

```json
{
  "pipenvHelper.preferLockfile": true,
  "pipenvHelper.autoPromptOnOpen": true,
  "pipenvHelper.autoPromptOnChange": true
}
```

## Settings Explained

| Setting              | Description                          |
|----------------------|--------------------------------------|
| `preferLockfile`     | Prefer syncing from `Pipfile.lock`   |
| `autoPromptOnOpen`   | Prompt on workspace open             |
| `autoPromptOnChange` | Prompt when `Pipfile` / lock changes |



## Run locally

1. `npm install`
2. `npm run compile`
3. Open this folder in VS Code
4. Press `F5` to launch Extension Development Host

## Testing

- `npm test` to run tests once
- `npm run test:watch` for watch mode

## Commands

- Pipenv: Activate environment in terminal
- Pipenv: Setup (Create/Select Env + Sync)
- Pipenv: Lock Dependencies
- Pipenv: Sync Environment (Install from Lock)
- Pipenv: Use Pipenv Interpreter

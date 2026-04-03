# Pipenv Helper for VS Code

Bring **PyCharm-like Pipenv support** to Visual Studio Code.

Detects `Pipfile` projects, manages virtual environments, keeps your environment in sync with `Pipfile.lock`, and integrates cleanly with the VS Code Python extension.

---

## Requirements

- [pipenv](https://pipenv.pypa.io) installed on your system
- VS Code Python extension (recommended, for interpreter integration)

---

## Features

### Status Bar

A persistent indicator in the status bar shows your environment state at a glance:

| State | Display |
|---|---|
| In sync | `✔ Pipenv 3.11  synced` |
| Out of sync | `⚠ Pipenv 3.11  out of sync` |
| No lockfile | `⚠ Pipenv  no lock` |
| Busy | `↻ Pipenv  syncing…` |

Click it to open the quick-action menu.

---

### Packages Sidebar

A **Pipenv Packages** panel appears in the Explorer sidebar showing your direct dependencies (from `Pipfile`) with their installed versions (from `Pipfile.lock`), grouped by regular and dev.

```
PIPENV PACKAGES
  ▾ Packages  (3)
      flask      3.0.3
      numpy      1.26.4
      requests   2.31.0
  ▾ Dev Packages  (2)
      black      24.4.2
      pytest      8.2.0
```

- **+** button — add a package (prompts for name, then Regular or Dev)
- **Hover** over a package — trash icon appears to uninstall it
- **Refresh** button — reload from disk
- Auto-refreshes whenever `Pipfile.lock` changes

---

### Smart Sync Detection

- Tracks `Pipfile.lock` via SHA-256 hash
- Prompts to sync when the lockfile changes
- Avoids duplicate prompts for the same lockfile state
- Auto-prompts on workspace open (configurable)

---

### Python Interpreter Integration

- Automatically sets `python.defaultInterpreterPath` to the Pipenv venv
- Works with linting, debugging, testing, and tasks
- Python version shown in the status bar once detected

---

### Terminal Activation

Activates the Pipenv environment in your current terminal with one click — using standard `source .../bin/activate`, not `pipenv shell`. No subshells, no surprises.

---

## Commands

Available via the Command Palette (`Cmd+Shift+P`) — type `Pipenv:`:

| Command | Description |
|---|---|
| `Pipenv: Setup` | Create env, set interpreter, lock & sync |
| `Pipenv: Sync Environment` | Run `pipenv sync --dev` |
| `Pipenv: Lock Dependencies` | Run `pipenv lock` |
| `Pipenv: Update Packages` | Run `pipenv update --dev` |
| `Pipenv: Check Vulnerabilities` | Run `pipenv check` |
| `Pipenv: Clean Unused Packages` | Run `pipenv clean` |
| `Pipenv: Export requirements.txt` | Export via `pipenv requirements` |
| `Pipenv: Open Pipfile` | Open `Pipfile` in the editor |
| `Pipenv: Environment Info` | Show Python version, venv path, package count |
| `Pipenv: Use Pipenv Interpreter` | Set the Pipenv Python as the workspace interpreter |
| `Pipenv: Activate Environment in Terminal` | Source the venv in the active terminal |
| `Pipenv: Status Actions` | Open the quick-action menu (same as clicking the status bar) |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `pipenvHelper.autoPromptOnOpen` | `true` | Prompt to setup when a Pipfile workspace is opened |
| `pipenvHelper.autoPromptOnChange` | `true` | Prompt to lock/sync when `Pipfile` or `Pipfile.lock` changes |
| `pipenvHelper.preferLockfile` | `true` | Prefer `pipenv sync` over `pipenv install` during setup |
| `pipenvHelper.showPythonVersion` | `true` | Show Python version in the status bar |
| `pipenvHelper.autoLockOnPipfileSave` | `false` | Automatically run `pipenv lock` when `Pipfile` is saved |
| `pipenvHelper.pipenvPath` | `""` | Absolute path to pipenv executable — set this if pipenv is not found |

---

## Troubleshooting

### pipenv not found

VS Code launches in a limited environment that may not include paths set up in your shell config (`.zshrc`, `.zprofile`, etc.).

The extension automatically checks common locations:
- `/opt/homebrew/bin` (Apple Silicon Homebrew)
- `/usr/local/bin` (Intel Homebrew)
- `~/.local/bin` (pip install --user)
- `~/.pyenv/shims` (pyenv)
- `~/.asdf/shims` (asdf)

If pipenv is still not found, run `which pipenv` in your terminal and set the result in settings:

```json
{
  "pipenvHelper.pipenvPath": "/opt/homebrew/bin/pipenv"
}
```

Or open the error notification and click **Set Path** to jump directly to the setting.

---

## Development

```bash
npm install
npm run bundle     # build once
npm run watch      # rebuild on save
npm test           # run tests
npm run test:watch # watch mode
```

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded. Open a folder containing a `Pipfile` to activate it.

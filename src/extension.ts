import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs";

type ExecResult = { code: number; stdout: string; stderr: string };

const STATE_LOCK_HASH = "pipenv.lockHash";
const STATE_LAST_PROMPTED_HASH = "pipenv.lastPromptedHash";

function hashFile(filePath: string): string | undefined {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return undefined;
  }
}

function execCmd(
  cmd: string,
  args: string[],
  cwd: string,
  output?: vscode.OutputChannel
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // On macOS/Linux, run through a login shell so that PATH shims (pyenv, asdf,
    // pipx, etc.) set in .zprofile / .bash_profile are visible to the process.
    let child;
    if (isWindows()) {
      child = spawn(cmd, args, { cwd, shell: true, env: process.env });
    } else {
      const shell = process.env.SHELL || "/bin/sh";
      const quotedArgs = [cmd, ...args]
        .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
        .join(" ");
      child = spawn(shell, ["-l", "-c", quotedArgs], { cwd, env: process.env });
    }

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      output?.append(s);
    });

    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      output?.append(s);
    });

    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return folders[0].uri.fsPath;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function pythonPathFromVenv(venvPath: string): string {
  return isWindows()
    ? path.join(venvPath, "Scripts", "python.exe")
    : path.join(venvPath, "bin", "python");
}

function activateVenvInTerminal(venvPath: string) {
  let terminal = vscode.window.activeTerminal;
  if (!terminal) {
    terminal = vscode.window.createTerminal("Pipenv Env");
  }

  const isWindows = process.platform === "win32";

  const activateCmd = isWindows
    ? `"${path.join(venvPath, "Scripts", "activate")}"`
    : `source "${path.join(venvPath, "bin", "activate")}"`;

  terminal.show();
  terminal.sendText(activateCmd);
}

async function pipenvExists(cwd: string, out: vscode.OutputChannel): Promise<boolean> {
  const r = await execCmd("pipenv", ["--version"], cwd, out);
  return r.code === 0;
}

async function getPipenvVenvPath(cwd: string, out: vscode.OutputChannel): Promise<string | undefined> {
  const r = await execCmd("pipenv", ["--venv"], cwd, out);
  if (r.code !== 0) return undefined;
  const venv = r.stdout.trim().split(/\r?\n/).pop()?.trim();
  return venv && venv.length > 0 ? venv : undefined;
}

async function ensurePipenvEnvCreated(cwd: string, out: vscode.OutputChannel): Promise<boolean> {
  const venv = await getPipenvVenvPath(cwd, out);
  if (venv) return true;

  const pick = await vscode.window.showInformationMessage(
    "Pipfile detected, but no Pipenv environment found. Create one now?",
    "Create (pipenv install --dev)",
    "Cancel"
  );
  if (pick !== "Create (pipenv install --dev)") return false;

  const r = await execCmd("pipenv", ["install", "--dev"], cwd, out);
  return r.code === 0;
}

async function setWorkspaceInterpreter(pythonPath: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration();
  await cfg.update(
    "python.defaultInterpreterPath",
    pythonPath,
    vscode.ConfigurationTarget.Workspace
  );
}

async function selectInterpreterFlow(cwd: string, out: vscode.OutputChannel): Promise<void> {
  const ok = await ensurePipenvEnvCreated(cwd, out);
  if (!ok) return;

  const venv = await getPipenvVenvPath(cwd, out);
  if (!venv) {
    vscode.window.showErrorMessage("Could not determine Pipenv venv path (pipenv --venv).");
    return;
  }

  const py = pythonPathFromVenv(venv);
  await setWorkspaceInterpreter(py);

  vscode.window.showInformationMessage(`Using Pipenv interpreter: ${py}`);
}

async function lockDeps(cwd: string, out: vscode.OutputChannel): Promise<boolean> {
  const r = await execCmd("pipenv", ["lock"], cwd, out);
  if (r.code !== 0) {
    vscode.window.showErrorMessage("pipenv lock failed. Check output for details.");
    return false;
  }
  vscode.window.showInformationMessage("Pipfile.lock updated.");
  return true;
}

async function syncEnv(
  cwd: string,
  out: vscode.OutputChannel,
  context: vscode.ExtensionContext
): Promise<boolean> {
  const r = await execCmd("pipenv", ["sync", "--dev"], cwd, out);
  if (r.code !== 0) {
    vscode.window.showErrorMessage("pipenv sync failed.");
    return false;
  }

  const lockPath = path.join(cwd, "Pipfile.lock");
  const hash = hashFile(lockPath);
  if (hash) {
    await context.workspaceState.update(STATE_LOCK_HASH, hash);
  }

  vscode.window.showInformationMessage("Environment synced.");
  return true;
}

function updateStatusBar(
  statusBar: vscode.StatusBarItem,
  cwd: string,
  context: vscode.ExtensionContext
) {
  const lockPath = path.join(cwd, "Pipfile.lock");
  const currentHash = hashFile(lockPath);
  const storedHash = context.workspaceState.get<string>(STATE_LOCK_HASH);

  const project = path.basename(cwd);

  if (!currentHash) {
    statusBar.text = `Pipenv: ${project}   ⚠ no lock`;
    statusBar.tooltip = "No Pipfile.lock found";
    return;
  }

  if (storedHash !== currentHash) {
    statusBar.text = `Pipenv: ${project}   ⚠ out of sync`;
    statusBar.tooltip = "Environment does not match Pipfile.lock";
  } else {
    statusBar.text = `Pipenv: ${project}   ✔ synced`;
    statusBar.tooltip = "Environment is in sync with Pipfile.lock";
  }
}

async function setupFlow(
  cwd: string,
  out: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  statusBar: vscode.StatusBarItem
): Promise<void> {
  const ok = await ensurePipenvEnvCreated(cwd, out);
  if (!ok) return;

  await selectInterpreterFlow(cwd, out);

  const preferLock = vscode.workspace
    .getConfiguration()
    .get<boolean>("pipenvHelper.preferLockfile", true);

  const lockPath = path.join(cwd, "Pipfile.lock");
  const lockHashBefore = hashFile(lockPath);

  // Detect lock existence
  let lockExists = true;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(lockPath));
  } catch {
    lockExists = false;
  }

  if (preferLock) {
    if (!lockExists) {
      const pick = await vscode.window.showInformationMessage(
        "No Pipfile.lock found. Generate lock file and sync?",
        "Lock + Sync",
        "Skip"
      );
      if (pick === "Lock + Sync") {
        const locked = await lockDeps(cwd, out);
        if (locked) {
          const synced = await syncEnv(cwd, out, context);
          if (synced) {
            updateStatusBar(statusBar, cwd, context);
            return;
          }
        }
      }
    } else {
      const pick = await vscode.window.showInformationMessage(
        "Pipfile.lock found. Sync environment to lock?",
        "Sync",
        "Skip"
      );
      if (pick === "Sync") {
        const synced = await syncEnv(cwd, out, context);
        if (synced) {
          updateStatusBar(statusBar, cwd, context);
          return;
        }
      }
    }
  } else {
    const pick = await vscode.window.showInformationMessage(
      "Install dependencies from Pipfile (pipenv install --dev)?",
      "Install",
      "Skip"
    );
    if (pick === "Install") {
      const r = await execCmd("pipenv", ["install", "--dev"], cwd, out);
      if (r.code === 0) vscode.window.showInformationMessage("Dependencies installed from Pipfile.");
      else vscode.window.showErrorMessage("pipenv install failed. Check output for details.");
    }
  }

  // If lock was created/changed by setup steps and we haven't synced, keep status fresh
  const lockHashAfter = hashFile(lockPath);
  if (lockHashAfter && lockHashAfter !== lockHashBefore) {
    // If lock changed, we haven't necessarily synced; status bar will show out-of-sync.
    updateStatusBar(statusBar, cwd, context);
  } else {
    updateStatusBar(statusBar, cwd, context);
  }
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | undefined;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

export function activate(context: vscode.ExtensionContext) {
  const cwd = getWorkspaceRoot();
  const out = vscode.window.createOutputChannel("Pipenv Helper");
  context.subscriptions.push(out);

  if (!cwd) return;

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBar.text = `Pipenv: ${path.basename(cwd)}   …`;
  statusBar.command = "pipenvHelper.statusActions";
  statusBar.show();
  context.subscriptions.push(statusBar);

  const autoPromptOnOpen = vscode.workspace
    .getConfiguration()
    .get<boolean>("pipenvHelper.autoPromptOnOpen", true);
  const autoPromptOnChange = vscode.workspace
    .getConfiguration()
    .get<boolean>("pipenvHelper.autoPromptOnChange", true);

  const runIfPipenv = async (fn: () => Promise<void>) => {
    out.show(true);
    out.appendLine(`\n--- Pipenv Helper @ ${new Date().toISOString()} ---\n`);

    const ok = await pipenvExists(cwd, out);
    if (!ok) {
      vscode.window.showErrorMessage(
        "pipenv not found on PATH. Install pipenv first (pip install pipenv)."
      );
      return;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Pipenv Helper",
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Running…" });
        await fn();
      }
    );
  };

  // Status bar actions (click)
  context.subscriptions.push(
    vscode.commands.registerCommand("pipenvHelper.statusActions", async () => {
      await runIfPipenv(async () => {
        const pick = await vscode.window.showQuickPick(
          [
            "Activate environment in terminal",
            "Sync Environment",
            "Lock Dependencies",
            "Recreate Env",
            "Use Pipenv Interpreter"
          ],
          { placeHolder: "Pipenv actions" }
        );
        if (!pick) return;

        if (pick === "Use Pipenv Interpreter") {
          await selectInterpreterFlow(cwd, out);
          updateStatusBar(statusBar, cwd, context);
          return;
        }

        if (pick === "Lock Dependencies") {
          const ok = await lockDeps(cwd, out);
          if (ok) updateStatusBar(statusBar, cwd, context);
          return;
        }

        if (pick === "Sync Environment") {
          const ok = await syncEnv(cwd, out, context);
          if (ok) updateStatusBar(statusBar, cwd, context);
          return;
        }

        if (pick === "Recreate Env") {
          const confirm = await vscode.window.showWarningMessage(
            "This will remove the Pipenv virtualenv (pipenv --rm) and recreate it. Continue?",
            "Yes",
            "No"
          );
          if (confirm !== "Yes") return;

          await execCmd("pipenv", ["--rm"], cwd, out);
          await setupFlow(cwd, out, context, statusBar);
          updateStatusBar(statusBar, cwd, context);
        }

        if (pick === "Activate environment in terminal") {
          const venv = await getPipenvVenvPath(cwd, out);
          if (!venv) {
            vscode.window.showErrorMessage("Pipenv environment not found.");
            return;
          }
          activateVenvInTerminal(venv);
          return;
        }
      });
    }),

    vscode.commands.registerCommand("pipenvHelper.setup", () =>
      runIfPipenv(() => setupFlow(cwd, out, context, statusBar))
    ),

    vscode.commands.registerCommand("pipenvHelper.lock", () =>
      runIfPipenv(async () => {
        const ok = await lockDeps(cwd, out);
        if (ok) updateStatusBar(statusBar, cwd, context);
      })
    ),

    vscode.commands.registerCommand("pipenvHelper.sync", () =>
      runIfPipenv(async () => {
        const ok = await syncEnv(cwd, out, context);
        if (ok) updateStatusBar(statusBar, cwd, context);
      })
    ),

    vscode.commands.registerCommand("pipenvHelper.selectInterpreter", () =>
      runIfPipenv(async () => {
        await selectInterpreterFlow(cwd, out);
        updateStatusBar(statusBar, cwd, context);
      })
    ),

    vscode.commands.registerCommand("pipenvHelper.activateVenv", async () => {
      await runIfPipenv(async () => {
        const venv = await getPipenvVenvPath(cwd, out);
        if (!venv) {
          vscode.window.showErrorMessage("Pipenv environment not found.");
          return;
        }

        activateVenvInTerminal(venv);
        vscode.window.showInformationMessage("Pipenv environment activated in terminal.");
      });
    })
  );

  // Initial status update
  updateStatusBar(statusBar, cwd, context);

  // Auto prompt on open (don’t nag if user said Later repeatedly—simple approach)
  if (autoPromptOnOpen) {
    vscode.window
      .showInformationMessage(
        "Pipfile detected. Setup Pipenv environment for this workspace?",
        "Setup",
        "Later"
      )
      .then((choice) => {
        if (choice === "Setup") {
          runIfPipenv(() => setupFlow(cwd, out, context, statusBar));
        }
      });
  }

  if (!autoPromptOnChange) return;

  const pipfileWatcher = vscode.workspace.createFileSystemWatcher("**/Pipfile");
  const lockWatcher = vscode.workspace.createFileSystemWatcher("**/Pipfile.lock");
  context.subscriptions.push(pipfileWatcher, lockWatcher);

  const onPipfileChanged = debounce(async () => {
    await runIfPipenv(async () => {
      const pick = await vscode.window.showInformationMessage(
        "Pipfile changed. Update lock file and sync environment?",
        "Lock + Sync",
        "Only Lock",
        "Ignore"
      );

      if (pick === "Only Lock") {
        const ok = await lockDeps(cwd, out);
        if (ok) updateStatusBar(statusBar, cwd, context);
        return;
      }

      if (pick === "Lock + Sync") {
        const locked = await lockDeps(cwd, out);
        if (locked) {
          const synced = await syncEnv(cwd, out, context);
          if (synced) updateStatusBar(statusBar, cwd, context);
        } else {
          updateStatusBar(statusBar, cwd, context);
        }
      }
    });
  }, 1200);

  const onLockChanged = debounce(async () => {
    await runIfPipenv(async () => {
      const lockPath = path.join(cwd, "Pipfile.lock");
      const hash = hashFile(lockPath);
      const lastPrompted = context.workspaceState.get<string>(STATE_LAST_PROMPTED_HASH);

      // Only prompt once per distinct lock hash
      if (!hash || hash === lastPrompted) {
        updateStatusBar(statusBar, cwd, context);
        return;
      }

      const pick = await vscode.window.showInformationMessage(
        "Pipfile.lock changed. Sync environment?",
        "Sync",
        "Ignore"
      );

      await context.workspaceState.update(STATE_LAST_PROMPTED_HASH, hash);

      if (pick === "Sync") {
        const ok = await syncEnv(cwd, out, context);
        if (ok) updateStatusBar(statusBar, cwd, context);
      } else {
        updateStatusBar(statusBar, cwd, context);
      }
    });
  }, 1200);

  pipfileWatcher.onDidChange(onPipfileChanged, null, context.subscriptions);
  pipfileWatcher.onDidCreate(onPipfileChanged, null, context.subscriptions);

  lockWatcher.onDidChange(onLockChanged, null, context.subscriptions);
  lockWatcher.onDidCreate(onLockChanged, null, context.subscriptions);
}

export function deactivate() {}

export const __test__ = {
  hashFile,
  execCmd,
  getWorkspaceRoot,
  pythonPathFromVenv,
  activateVenvInTerminal,
  pipenvExists,
  getPipenvVenvPath,
  updateStatusBar,
  debounce,
};

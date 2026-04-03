import * as vscode from "vscode";
import { spawn } from "child_process";
import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";

type ExecResult = { code: number; stdout: string; stderr: string };

// Common locations where pipenv/python tools live that may not be on VS Code's PATH
const EXTRA_PATH_DIRS = [
  "/opt/homebrew/bin",                          // Apple Silicon Homebrew
  "/usr/local/bin",                             // Intel Homebrew / manual installs
  path.join(os.homedir(), ".local", "bin"),     // pip install --user (Linux/macOS)
  path.join(os.homedir(), ".pyenv", "shims"),   // pyenv
  path.join(os.homedir(), ".asdf", "shims"),    // asdf
  path.join(os.homedir(), ".cargo", "bin"),     // occasionally used
];

function buildEnv(): NodeJS.ProcessEnv {
  const extra = EXTRA_PATH_DIRS.join(":");
  return { ...process.env, PATH: `${extra}:${process.env.PATH ?? ""}` };
}

function getPipenvCmd(): string {
  const configured = vscode.workspace
    .getConfiguration()
    .get<string>("pipenvHelper.pipenvPath", "")
    .trim();
  return configured || "pipenv";
}

const STATE_LOCK_HASH = "pipenv.lockHash";
const STATE_LAST_PROMPTED_HASH = "pipenv.lastPromptedHash";
const STATE_PYTHON_VERSION = "pipenv.pythonVersion";

// ── Utilities ─────────────────────────────────────────────────────────────────

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
    const env = buildEnv();
    if (isWindows()) {
      child = spawn(cmd, args, { cwd, shell: true, env });
    } else {
      const shell = process.env.SHELL || "/bin/zsh";
      const quotedArgs = [cmd, ...args]
        .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
        .join(" ");
      child = spawn(shell, ["-l", "-c", quotedArgs], { cwd, env });
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

  const activateCmd = isWindows()
    ? `"${path.join(venvPath, "Scripts", "activate")}"`
    : `source "${path.join(venvPath, "bin", "activate")}"`;

  terminal.show();
  terminal.sendText(activateCmd);
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | undefined;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}

// ── Pipenv commands ───────────────────────────────────────────────────────────

async function pipenvExists(cwd: string, out: vscode.OutputChannel): Promise<boolean> {
  const r = await execCmd(getPipenvCmd(), ["--version"], cwd, out);
  return r.code === 0;
}

async function getPipenvVenvPath(cwd: string, out: vscode.OutputChannel): Promise<string | undefined> {
  const r = await execCmd(getPipenvCmd(), ["--venv"], cwd, out);
  if (r.code !== 0) return undefined;
  const venv = r.stdout.trim().split(/\r?\n/).pop()?.trim();
  return venv && venv.length > 0 ? venv : undefined;
}

async function getPythonVersion(
  venvPath: string,
  cwd: string,
  out: vscode.OutputChannel
): Promise<string | undefined> {
  const pyBin = pythonPathFromVenv(venvPath);
  const r = await execCmd(pyBin, ["--version"], cwd, out);
  const raw = (r.stdout + r.stderr).trim();
  const match = raw.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/);
  return match ? match[1] : undefined;
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

  const r = await execCmd(getPipenvCmd(), ["install", "--dev"], cwd, out);
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

async function selectInterpreterFlow(
  cwd: string,
  out: vscode.OutputChannel,
  context: vscode.ExtensionContext
): Promise<void> {
  const ok = await ensurePipenvEnvCreated(cwd, out);
  if (!ok) return;

  const venv = await getPipenvVenvPath(cwd, out);
  if (!venv) {
    vscode.window.showErrorMessage("Could not determine Pipenv venv path (pipenv --venv).");
    return;
  }

  const py = pythonPathFromVenv(venv);
  await setWorkspaceInterpreter(py);

  // Cache Python version for the status bar
  const ver = await getPythonVersion(venv, cwd, out);
  if (ver) {
    await context.workspaceState.update(STATE_PYTHON_VERSION, ver);
  }

  vscode.window.showInformationMessage(
    `$(check) Using Pipenv interpreter: Python ${ver ?? py}`
  );
}

async function lockDeps(cwd: string, out: vscode.OutputChannel): Promise<boolean> {
  const r = await execCmd(getPipenvCmd(), ["lock"], cwd, out);
  if (r.code !== 0) {
    vscode.window
      .showErrorMessage("pipenv lock failed. Check output for details.", "Show Output")
      .then((v) => { if (v === "Show Output") out.show(true); });
    return false;
  }
  vscode.window.showInformationMessage("$(lock) Pipfile.lock updated.");
  return true;
}

async function syncEnv(
  cwd: string,
  out: vscode.OutputChannel,
  context: vscode.ExtensionContext
): Promise<boolean> {
  const r = await execCmd(getPipenvCmd(), ["sync", "--dev"], cwd, out);
  if (r.code !== 0) {
    vscode.window
      .showErrorMessage("pipenv sync failed. Check output for details.", "Show Output")
      .then((v) => { if (v === "Show Output") out.show(true); });
    return false;
  }

  const lockPath = path.join(cwd, "Pipfile.lock");
  const hash = hashFile(lockPath);
  if (hash) {
    await context.workspaceState.update(STATE_LOCK_HASH, hash);
  }

  vscode.window.showInformationMessage("$(check) Environment synced successfully.");
  return true;
}

async function checkVulnerabilities(cwd: string, out: vscode.OutputChannel): Promise<void> {
  out.appendLine("\n--- pipenv check ---\n");
  const r = await execCmd(getPipenvCmd(), ["check"], cwd, out);
  if (r.code !== 0) {
    vscode.window
      .showWarningMessage(
        "$(shield) Vulnerabilities found. Check output for details.",
        "Show Output"
      )
      .then((v) => { if (v === "Show Output") out.show(true); });
  } else {
    vscode.window.showInformationMessage("$(shield) No security vulnerabilities found!");
  }
}

async function updatePackages(
  cwd: string,
  out: vscode.OutputChannel,
  context: vscode.ExtensionContext
): Promise<boolean> {
  const r = await execCmd(getPipenvCmd(), ["update", "--dev"], cwd, out);
  if (r.code !== 0) {
    vscode.window
      .showErrorMessage("pipenv update failed. Check output for details.", "Show Output")
      .then((v) => { if (v === "Show Output") out.show(true); });
    return false;
  }
  const lockPath = path.join(cwd, "Pipfile.lock");
  const hash = hashFile(lockPath);
  if (hash) await context.workspaceState.update(STATE_LOCK_HASH, hash);
  vscode.window.showInformationMessage("$(arrow-up) Packages updated successfully.");
  return true;
}

async function cleanEnv(cwd: string, out: vscode.OutputChannel): Promise<void> {
  const r = await execCmd(getPipenvCmd(), ["clean"], cwd, out);
  if (r.code !== 0) {
    vscode.window.showErrorMessage("pipenv clean failed. Check output for details.");
    return;
  }
  vscode.window.showInformationMessage("$(trash) Unused packages removed.");
}

async function exportRequirements(cwd: string, out: vscode.OutputChannel): Promise<void> {
  const r = await execCmd(getPipenvCmd(), ["requirements"], cwd, out);
  if (r.code !== 0) {
    vscode.window.showErrorMessage("pipenv requirements failed. Check output for details.");
    return;
  }
  const reqPath = path.join(cwd, "requirements.txt");
  try {
    fs.writeFileSync(reqPath, r.stdout);
    vscode.window
      .showInformationMessage("$(export) requirements.txt exported.", "Open File")
      .then((v) => {
        if (v === "Open File") {
          vscode.workspace
            .openTextDocument(reqPath)
            .then((doc) => vscode.window.showTextDocument(doc));
        }
      });
  } catch {
    vscode.window.showErrorMessage("Failed to write requirements.txt.");
  }
}

async function openPipfile(cwd: string): Promise<void> {
  const pipfilePath = path.join(cwd, "Pipfile");
  try {
    const doc = await vscode.workspace.openTextDocument(pipfilePath);
    await vscode.window.showTextDocument(doc);
  } catch {
    vscode.window.showErrorMessage("Could not open Pipfile.");
  }
}

async function showEnvInfo(
  cwd: string,
  out: vscode.OutputChannel,
  context: vscode.ExtensionContext
): Promise<void> {
  const venv = await getPipenvVenvPath(cwd, out);
  if (!venv) {
    vscode.window.showErrorMessage("No Pipenv environment found. Run setup first.");
    return;
  }

  const pyVersion =
    context.workspaceState.get<string>(STATE_PYTHON_VERSION) ??
    (await getPythonVersion(venv, cwd, out));

  const listR = await execCmd(
    getPipenvCmd(),
    ["run", "pip", "list", "--format=columns"],
    cwd,
    out
  );
  let pkgCount: number | string = "?";
  if (listR.code === 0) {
    const lines = listR.stdout.trim().split("\n").filter((l) => l.trim());
    pkgCount = Math.max(0, lines.length - 2); // subtract header lines
  }

  const project = path.basename(cwd);
  const msg = `${project}  ·  Python ${pyVersion ?? "?"}  ·  ${pkgCount} packages`;

  vscode.window
    .showInformationMessage(msg, "Open Pipfile", "Copy Venv Path")
    .then((v) => {
      if (v === "Open Pipfile") openPipfile(cwd);
      if (v === "Copy Venv Path") {
        vscode.env.clipboard
          .writeText(venv)
          .then(() => vscode.window.showInformationMessage("Venv path copied to clipboard."));
      }
    });
}

// ── Status bar ────────────────────────────────────────────────────────────────

function setStatusBarBusy(statusBar: vscode.StatusBarItem, message?: string) {
  statusBar.text = `$(sync~spin) Pipenv${message ? `  ${message}` : ""}`;
  statusBar.backgroundColor = undefined;
  statusBar.tooltip = "Pipenv operation in progress…";
}

function updateStatusBar(
  statusBar: vscode.StatusBarItem,
  cwd: string,
  context: vscode.ExtensionContext
) {
  const lockPath = path.join(cwd, "Pipfile.lock");
  const currentHash = hashFile(lockPath);
  const storedHash = context.workspaceState.get<string>(STATE_LOCK_HASH);
  const pyVersion = context.workspaceState.get<string>(STATE_PYTHON_VERSION);

  const cfg = vscode.workspace.getConfiguration();
  const showPyVer = cfg.get<boolean>("pipenvHelper.showPythonVersion", true);
  const verLabel = showPyVer && pyVersion ? ` ${pyVersion}` : "";

  if (!currentHash) {
    statusBar.text = `$(warning) Pipenv${verLabel}  no lock`;
    statusBar.tooltip = "No Pipfile.lock found — click to run setup";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    return;
  }

  if (storedHash !== currentHash) {
    statusBar.text = `$(warning) Pipenv${verLabel}  out of sync`;
    statusBar.tooltip = "Environment does not match Pipfile.lock — click to sync";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    statusBar.text = `$(check) Pipenv${verLabel}  synced`;
    statusBar.tooltip = pyVersion
      ? `Python ${pyVersion} · Environment in sync with Pipfile.lock`
      : "Environment is in sync with Pipfile.lock";
    statusBar.backgroundColor = undefined;
  }
}

// ── Packages tree view ────────────────────────────────────────────────────────

interface PackageInfo {
  name: string;
  version: string;
  isDev: boolean;
}

function parsePipfileDeps(content: string, section: "packages" | "dev-packages"): string[] {
  const sectionRegex = new RegExp(`\\[${section}\\]([^[]*)`);
  const match = content.match(sectionRegex);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((l) => l.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)?.[1])
    .filter((n): n is string => !!n);
}

function readPipenvPackages(cwd: string): PackageInfo[] {
  const pipfilePath = path.join(cwd, "Pipfile");
  const lockPath = path.join(cwd, "Pipfile.lock");

  let regularNames: string[] = [];
  let devNames: string[] = [];

  try {
    const pipfile = fs.readFileSync(pipfilePath, "utf8");
    regularNames = parsePipfileDeps(pipfile, "packages");
    devNames = parsePipfileDeps(pipfile, "dev-packages");
  } catch {
    return [];
  }

  let lockDefault: Record<string, any> = {};
  let lockDevelop: Record<string, any> = {};
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lockDefault = lock.default ?? {};
    lockDevelop = lock.develop ?? {};
  } catch {
    // lock may not exist yet — show packages without versions
  }

  const getVersion = (name: string, section: Record<string, any>): string => {
    // Pipfile.lock keys may use - or _ interchangeably
    const entry =
      section[name] ??
      section[name.replace(/-/g, "_")] ??
      section[name.replace(/_/g, "-")] ??
      section[name.toLowerCase()];
    const ver = entry?.version as string | undefined;
    return ver ? ver.replace("==", "") : "—";
  };

  return [
    ...regularNames.map((name) => ({ name, version: getVersion(name, lockDefault), isDev: false })),
    ...devNames.map((name) => ({ name, version: getVersion(name, lockDevelop), isDev: true })),
  ];
}

class CategoryItem extends vscode.TreeItem {
  constructor(
    public readonly isDev: boolean,
    count: number
  ) {
    super(
      isDev ? `Dev Packages  (${count})` : `Packages  (${count})`,
      vscode.TreeItemCollapsibleState.Expanded
    );
    this.contextValue = "category";
    this.iconPath = new vscode.ThemeIcon(isDev ? "tools" : "package");
  }
}

class PipenvPackageItem extends vscode.TreeItem {
  constructor(
    public readonly pkgName: string,
    public readonly version: string,
    public readonly isDev: boolean
  ) {
    super(pkgName, vscode.TreeItemCollapsibleState.None);
    this.description = version;
    this.tooltip = `${pkgName} ${version}`;
    this.contextValue = isDev ? "devPackage" : "package";
    this.iconPath = new vscode.ThemeIcon("circle-small-filled");
  }
}

type PipenvTreeNode = CategoryItem | PipenvPackageItem;

class PipenvPackagesProvider implements vscode.TreeDataProvider<PipenvTreeNode> {
  private _onDidChangeTreeData =
    new vscode.EventEmitter<PipenvTreeNode | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private packages: PackageInfo[] = [];

  constructor(private cwd: string) {
    this.packages = readPipenvPackages(cwd);
  }

  refresh(): void {
    this.packages = readPipenvPackages(this.cwd);
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: PipenvTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PipenvTreeNode): PipenvTreeNode[] {
    if (!element) {
      const regular = this.packages.filter((p) => !p.isDev);
      const dev = this.packages.filter((p) => p.isDev);
      const nodes: PipenvTreeNode[] = [];
      if (regular.length > 0) nodes.push(new CategoryItem(false, regular.length));
      if (dev.length > 0) nodes.push(new CategoryItem(true, dev.length));
      return nodes;
    }

    if (element instanceof CategoryItem) {
      return this.packages
        .filter((p) => p.isDev === element.isDev)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => new PipenvPackageItem(p.name, p.version, p.isDev));
    }

    return [];
  }
}

// ── Setup flow ────────────────────────────────────────────────────────────────

async function setupFlow(
  cwd: string,
  out: vscode.OutputChannel,
  context: vscode.ExtensionContext,
  statusBar: vscode.StatusBarItem
): Promise<void> {
  const ok = await ensurePipenvEnvCreated(cwd, out);
  if (!ok) return;

  await selectInterpreterFlow(cwd, out, context);

  const preferLock = vscode.workspace
    .getConfiguration()
    .get<boolean>("pipenvHelper.preferLockfile", true);

  const lockPath = path.join(cwd, "Pipfile.lock");

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
        if (locked) await syncEnv(cwd, out, context);
      }
    } else {
      const pick = await vscode.window.showInformationMessage(
        "Pipfile.lock found. Sync environment to lock?",
        "Sync",
        "Skip"
      );
      if (pick === "Sync") await syncEnv(cwd, out, context);
    }
  } else {
    const pick = await vscode.window.showInformationMessage(
      "Install dependencies from Pipfile (pipenv install --dev)?",
      "Install",
      "Skip"
    );
    if (pick === "Install") {
      const r = await execCmd(getPipenvCmd(), ["install", "--dev"], cwd, out);
      if (r.code === 0)
        vscode.window.showInformationMessage("$(check) Dependencies installed from Pipfile.");
      else
        vscode.window.showErrorMessage("pipenv install failed. Check output for details.");
    }
  }

  updateStatusBar(statusBar, cwd, context);
}

// ── Activate ──────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  const cwd = getWorkspaceRoot();
  const out = vscode.window.createOutputChannel("Pipenv Helper");
  context.subscriptions.push(out);

  if (!cwd) return;

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = `$(sync~spin) Pipenv  loading…`;
  statusBar.command = "pipenvHelper.statusActions";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Packages sidebar
  const packagesProvider = new PipenvPackagesProvider(cwd);
  const treeView = vscode.window.createTreeView("pipenvPackages", {
    treeDataProvider: packagesProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const cfg = vscode.workspace.getConfiguration();
  const autoPromptOnOpen = cfg.get<boolean>("pipenvHelper.autoPromptOnOpen", true);
  const autoPromptOnChange = cfg.get<boolean>("pipenvHelper.autoPromptOnChange", true);

  const runIfPipenv = async (msg: string, fn: () => Promise<void>) => {
    setStatusBarBusy(statusBar, msg);
    out.show(true);
    out.appendLine(`\n--- Pipenv Helper @ ${new Date().toISOString()} ---\n`);

    const ok = await pipenvExists(cwd, out);
    if (!ok) {
      updateStatusBar(statusBar, cwd, context);
      vscode.window
        .showErrorMessage(
          "pipenv not found. Try setting 'pipenvHelper.pipenvPath' to its absolute path (run: which pipenv).",
          "Set Path",
          "How to Install"
        )
        .then((v) => {
          if (v === "How to Install") {
            vscode.env.openExternal(
              vscode.Uri.parse("https://pipenv.pypa.io/en/latest/installation/")
            );
          }
          if (v === "Set Path") {
            vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "pipenvHelper.pipenvPath"
            );
          }
        });
      return;
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Pipenv", cancellable: false },
      async (progress) => {
        progress.report({ message: msg });
        await fn();
      }
    );

    updateStatusBar(statusBar, cwd, context);
    packagesProvider.refresh();
  };

  // ── Commands ────────────────────────────────────────────────────────────────

  context.subscriptions.push(
    // Status bar click — quick-pick menu
    vscode.commands.registerCommand("pipenvHelper.statusActions", async () => {
      const pick = await vscode.window.showQuickPick(
        [
          "$(terminal) Activate environment in terminal",
          "$(sync) Sync Environment",
          "$(lock) Lock Dependencies",
          "$(arrow-up) Update Packages",
          "$(shield) Check Vulnerabilities",
          "$(trash) Clean Unused Packages",
          "$(export) Export requirements.txt",
          "$(file-text) Open Pipfile",
          "$(info) Environment Info",
          "$(refresh) Recreate Environment",
          "$(python) Use Pipenv Interpreter",
        ],
        { placeHolder: "Pipenv: choose an action" }
      );
      if (!pick) return;

      if (pick.includes("Activate environment in terminal")) {
        await runIfPipenv("Activating…", async () => {
          const venv = await getPipenvVenvPath(cwd, out);
          if (!venv) { vscode.window.showErrorMessage("Pipenv environment not found."); return; }
          activateVenvInTerminal(venv);
          vscode.window.showInformationMessage("$(terminal) Pipenv environment activated.");
        });
      } else if (pick.includes("Sync Environment")) {
        await runIfPipenv("Syncing environment…", async () => { await syncEnv(cwd, out, context); });
      } else if (pick.includes("Lock Dependencies")) {
        await runIfPipenv("Locking dependencies…", async () => { await lockDeps(cwd, out); });
      } else if (pick.includes("Update Packages")) {
        await runIfPipenv("Updating packages…", async () => { await updatePackages(cwd, out, context); });
      } else if (pick.includes("Check Vulnerabilities")) {
        await runIfPipenv("Checking vulnerabilities…", async () => { await checkVulnerabilities(cwd, out); });
      } else if (pick.includes("Clean Unused Packages")) {
        await runIfPipenv("Cleaning unused packages…", async () => { await cleanEnv(cwd, out); });
      } else if (pick.includes("Export requirements.txt")) {
        await runIfPipenv("Exporting requirements…", async () => { await exportRequirements(cwd, out); });
      } else if (pick.includes("Open Pipfile")) {
        await openPipfile(cwd);
      } else if (pick.includes("Environment Info")) {
        await runIfPipenv("Fetching info…", async () => { await showEnvInfo(cwd, out, context); });
      } else if (pick.includes("Recreate Environment")) {
        const confirm = await vscode.window.showWarningMessage(
          "Remove and recreate the Pipenv virtualenv?",
          "Yes, Recreate", "Cancel"
        );
        if (confirm !== "Yes, Recreate") return;
        await runIfPipenv("Recreating environment…", async () => {
          await execCmd(getPipenvCmd(), ["--rm"], cwd, out);
          await setupFlow(cwd, out, context, statusBar);
        });
      } else if (pick.includes("Use Pipenv Interpreter")) {
        await runIfPipenv("Setting interpreter…", async () => {
          await selectInterpreterFlow(cwd, out, context);
        });
      }
    }),

    vscode.commands.registerCommand("pipenvHelper.setup", () =>
      runIfPipenv("Setting up…", () => setupFlow(cwd, out, context, statusBar))
    ),

    vscode.commands.registerCommand("pipenvHelper.lock", () =>
      runIfPipenv("Locking dependencies…", async () => { await lockDeps(cwd, out); })
    ),

    vscode.commands.registerCommand("pipenvHelper.sync", () =>
      runIfPipenv("Syncing environment…", async () => { await syncEnv(cwd, out, context); })
    ),

    vscode.commands.registerCommand("pipenvHelper.selectInterpreter", () =>
      runIfPipenv("Setting interpreter…", async () => {
        await selectInterpreterFlow(cwd, out, context);
      })
    ),

    vscode.commands.registerCommand("pipenvHelper.activateVenv", () =>
      runIfPipenv("Activating…", async () => {
        const venv = await getPipenvVenvPath(cwd, out);
        if (!venv) { vscode.window.showErrorMessage("Pipenv environment not found."); return; }
        activateVenvInTerminal(venv);
        vscode.window.showInformationMessage("$(terminal) Pipenv environment activated.");
      })
    ),

    vscode.commands.registerCommand("pipenvHelper.check", () =>
      runIfPipenv("Checking vulnerabilities…", async () => { await checkVulnerabilities(cwd, out); })
    ),

    vscode.commands.registerCommand("pipenvHelper.update", () =>
      runIfPipenv("Updating packages…", async () => { await updatePackages(cwd, out, context); })
    ),

    vscode.commands.registerCommand("pipenvHelper.clean", () =>
      runIfPipenv("Cleaning unused packages…", async () => { await cleanEnv(cwd, out); })
    ),

    vscode.commands.registerCommand("pipenvHelper.exportRequirements", () =>
      runIfPipenv("Exporting requirements…", async () => { await exportRequirements(cwd, out); })
    ),

    vscode.commands.registerCommand("pipenvHelper.openPipfile", () => openPipfile(cwd)),

    vscode.commands.registerCommand("pipenvHelper.showInfo", () =>
      runIfPipenv("Fetching info…", async () => { await showEnvInfo(cwd, out, context); })
    ),

    // Packages sidebar commands
    vscode.commands.registerCommand("pipenvHelper.refreshPackages", () => {
      packagesProvider.refresh();
    }),

    vscode.commands.registerCommand(
      "pipenvHelper.addPackage",
      async (item?: CategoryItem) => {
        const pkgInput = await vscode.window.showInputBox({
          prompt: "Package name (optionally with version specifier)",
          placeHolder: "e.g.  requests  or  flask>=2.0",
          validateInput: (v) => (v.trim() ? null : "Enter a package name"),
        });
        if (!pkgInput?.trim()) return;

        let isDev = item instanceof CategoryItem ? item.isDev : false;
        if (!(item instanceof CategoryItem)) {
          const type = await vscode.window.showQuickPick(["Regular", "Dev"], {
            placeHolder: "Add as regular or dev dependency?",
          });
          if (!type) return;
          isDev = type === "Dev";
        }

        await runIfPipenv(`Installing ${pkgInput.trim()}…`, async () => {
          const args = isDev
            ? ["install", "--dev", pkgInput.trim()]
            : ["install", pkgInput.trim()];
          const r = await execCmd(getPipenvCmd(), args, cwd, out);
          if (r.code !== 0) {
            vscode.window
              .showErrorMessage(`Failed to install ${pkgInput.trim()}.`, "Show Output")
              .then((v) => { if (v === "Show Output") out.show(true); });
          } else {
            vscode.window.showInformationMessage(`$(check) ${pkgInput.trim()} installed.`);
          }
        });
      }
    ),

    vscode.commands.registerCommand(
      "pipenvHelper.uninstallPackage",
      async (item: PipenvPackageItem) => {
        const confirm = await vscode.window.showWarningMessage(
          `Uninstall "${item.pkgName}"?`,
          "Uninstall",
          "Cancel"
        );
        if (confirm !== "Uninstall") return;

        await runIfPipenv(`Uninstalling ${item.pkgName}…`, async () => {
          const args = item.isDev
            ? ["uninstall", "--dev", item.pkgName]
            : ["uninstall", item.pkgName];
          const r = await execCmd(getPipenvCmd(), args, cwd, out);
          if (r.code !== 0) {
            vscode.window
              .showErrorMessage(`Failed to uninstall ${item.pkgName}.`, "Show Output")
              .then((v) => { if (v === "Show Output") out.show(true); });
          } else {
            vscode.window.showInformationMessage(`$(check) ${item.pkgName} uninstalled.`);
          }
        });
      }
    )
  );

  // Initial status update
  updateStatusBar(statusBar, cwd, context);

  // Auto-prompt on open
  if (autoPromptOnOpen) {
    vscode.window
      .showInformationMessage(
        "$(package) Pipfile detected. Setup Pipenv environment for this workspace?",
        "Setup",
        "Later"
      )
      .then((choice) => {
        if (choice === "Setup") {
          runIfPipenv("Setting up…", () => setupFlow(cwd, out, context, statusBar));
        }
      });
  }

  if (!autoPromptOnChange) return;

  // ── File watchers ────────────────────────────────────────────────────────────

  const pipfileWatcher = vscode.workspace.createFileSystemWatcher("**/Pipfile");
  const lockWatcher = vscode.workspace.createFileSystemWatcher("**/Pipfile.lock");
  context.subscriptions.push(pipfileWatcher, lockWatcher);

  const onPipfileChanged = debounce(async () => {
    const autoLock = vscode.workspace
      .getConfiguration()
      .get<boolean>("pipenvHelper.autoLockOnPipfileSave", false);

    if (autoLock) {
      await runIfPipenv("Auto-locking…", async () => { await lockDeps(cwd, out); });
      return;
    }

    await runIfPipenv("Pipfile changed", async () => {
      const pick = await vscode.window.showInformationMessage(
        "Pipfile changed. Update lock file and sync environment?",
        "Lock + Sync",
        "Only Lock",
        "Ignore"
      );
      if (pick === "Only Lock") {
        await lockDeps(cwd, out);
      } else if (pick === "Lock + Sync") {
        const locked = await lockDeps(cwd, out);
        if (locked) await syncEnv(cwd, out, context);
      }
    });
  }, 1200);

  const onLockChanged = debounce(async () => {
    const lockPath = path.join(cwd, "Pipfile.lock");
    const hash = hashFile(lockPath);
    const lastPrompted = context.workspaceState.get<string>(STATE_LAST_PROMPTED_HASH);

    // Always refresh the tree on lock changes (even if we don't prompt)
    packagesProvider.refresh();

    if (!hash || hash === lastPrompted) {
      updateStatusBar(statusBar, cwd, context);
      return;
    }

    await runIfPipenv("Lock changed", async () => {
      const pick = await vscode.window.showInformationMessage(
        "Pipfile.lock changed. Sync environment?",
        "Sync",
        "Ignore"
      );
      await context.workspaceState.update(STATE_LAST_PROMPTED_HASH, hash);
      if (pick === "Sync") await syncEnv(cwd, out, context);
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
  parsePipfileDeps,
  readPipenvPackages,
};

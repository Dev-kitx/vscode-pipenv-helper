import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// --- Mock vscode BEFORE importing extension.ts ---
vi.mock("vscode", () => {
  const activeTerminal = {
    show: vi.fn(),
    sendText: vi.fn(),
  };

  return {
    window: {
      activeTerminal: activeTerminal,
      createTerminal: vi.fn(() => activeTerminal),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showQuickPick: vi.fn(),
      showInputBox: vi.fn(),
      createOutputChannel: vi.fn(() => ({
        append: vi.fn(),
        appendLine: vi.fn(),
        show: vi.fn(),
      })),
      createTreeView: vi.fn(() => ({ dispose: vi.fn() })),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/fake/workspace" } }],
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_k: string, def: any) => def),
        update: vi.fn(),
      })),
      fs: { stat: vi.fn() },
      createFileSystemWatcher: vi.fn(() => ({
        onDidChange: vi.fn(),
        onDidCreate: vi.fn(),
        dispose: vi.fn(),
      })),
      openTextDocument: vi.fn(),
    },
    Uri: {
      file: (p: string) => ({ fsPath: p }),
      parse: (s: string) => ({ toString: () => s }),
    },
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Workspace: 1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItem: class TreeItem {
      label: string;
      collapsibleState: number;
      contextValue?: string;
      iconPath?: unknown;
      description?: string;
      tooltip?: string;
      constructor(label: string, collapsibleState = 0) {
        this.label = label;
        this.collapsibleState = collapsibleState;
      }
    },
    EventEmitter: class EventEmitter {
      fire = vi.fn();
      event = vi.fn();
      dispose = vi.fn();
    },
    ThemeColor: class ThemeColor {
      constructor(public id: string) {}
    },
    ThemeIcon: class ThemeIcon {
      constructor(public id: string) {}
    },
    commands: { registerCommand: vi.fn() },
    env: { clipboard: { writeText: vi.fn() }, openExternal: vi.fn() },
    ProgressLocation: { Notification: 15 },
  };
});

import { __test__ } from "../src/extension";

describe("Pipenv Helper - unit tests", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  // ── hashFile ───────────────────────────────────────────────────────────────

  it("hashFile() returns sha256 for a real file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-"));
    const file = path.join(dir, "Pipfile.lock");
    fs.writeFileSync(file, "hello");

    const h = __test__.hashFile(file);
    expect(h).toBeTypeOf("string");
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("hashFile() returns undefined when file missing", () => {
    expect(__test__.hashFile("/definitely/does/not/exist.lock")).toBeUndefined();
  });

  // ── pythonPathFromVenv ─────────────────────────────────────────────────────

  it("pythonPathFromVenv() uses unix bin/python on mac/linux", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(__test__.pythonPathFromVenv("/venv")).toBe(path.join("/venv", "bin", "python"));
  });

  it("pythonPathFromVenv() uses Windows Scripts/python.exe on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(__test__.pythonPathFromVenv("C:\\venv")).toBe(
      path.join("C:\\venv", "Scripts", "python.exe")
    );
  });

  // ── activateVenvInTerminal ─────────────────────────────────────────────────

  it("activateVenvInTerminal() uses active terminal and sends correct command (unix)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const vscode = await import("vscode");
    const term = vscode.window.activeTerminal!;

    __test__.activateVenvInTerminal("/tmp/venv");

    expect(term.show).toHaveBeenCalledTimes(1);
    expect(term.sendText).toHaveBeenCalledWith(
      `source "${path.join("/tmp/venv", "bin", "activate")}"`
    );
  });

  it("activateVenvInTerminal() creates terminal if none active", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const vscode = await import("vscode");
    (vscode.window as any).activeTerminal = undefined;

    __test__.activateVenvInTerminal("/tmp/venv");

    expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1);
  });

  // ── updateStatusBar ────────────────────────────────────────────────────────

  it("updateStatusBar() shows 'no lock' when Pipfile.lock is missing", () => {
    const statusBar: any = { text: "", tooltip: "", backgroundColor: undefined };
    const context: any = {
      workspaceState: {
        get: vi.fn((key: string) => (key === "pipenv.lockHash" ? undefined : undefined)),
      },
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-nolock-"));

    __test__.updateStatusBar(statusBar, dir, context);

    expect(statusBar.text).toContain("no lock");
    expect(statusBar.tooltip).toContain("No Pipfile.lock");
    expect(statusBar.backgroundColor).toBeDefined();
  });

  it("updateStatusBar() shows 'out of sync' when stored hash differs", () => {
    const statusBar: any = { text: "", tooltip: "", backgroundColor: undefined };
    const context: any = {
      workspaceState: {
        get: vi.fn((key: string) => (key === "pipenv.lockHash" ? "storedhash" : undefined)),
      },
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-"));
    fs.writeFileSync(path.join(dir, "Pipfile.lock"), "current");

    __test__.updateStatusBar(statusBar, dir, context);

    expect(statusBar.text).toContain("out of sync");
    expect(statusBar.tooltip).toContain("does not match");
    expect(statusBar.backgroundColor).toBeDefined();
  });

  it("updateStatusBar() shows 'synced' when stored hash matches", () => {
    const statusBar: any = { text: "", tooltip: "", backgroundColor: undefined };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-"));
    const lock = path.join(dir, "Pipfile.lock");
    fs.writeFileSync(lock, "same");

    const currentHash = __test__.hashFile(lock);
    const context: any = {
      workspaceState: {
        get: vi.fn((key: string) => (key === "pipenv.lockHash" ? currentHash : undefined)),
      },
    };

    __test__.updateStatusBar(statusBar, dir, context);

    expect(statusBar.text).toContain("synced");
    expect(statusBar.tooltip).toContain("in sync");
    expect(statusBar.backgroundColor).toBeUndefined();
  });

  it("updateStatusBar() shows Python version when cached", () => {
    const statusBar: any = { text: "", tooltip: "", backgroundColor: undefined };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-"));
    const lock = path.join(dir, "Pipfile.lock");
    fs.writeFileSync(lock, "same");

    const currentHash = __test__.hashFile(lock);
    const context: any = {
      workspaceState: {
        get: vi.fn((key: string) => {
          if (key === "pipenv.lockHash") return currentHash;
          if (key === "pipenv.pythonVersion") return "3.11.9";
          return undefined;
        }),
      },
    };

    __test__.updateStatusBar(statusBar, dir, context);

    expect(statusBar.text).toContain("3.11.9");
    expect(statusBar.text).toContain("synced");
    expect(statusBar.tooltip).toContain("Python 3.11.9");
  });

  // ── parsePipfileDeps ───────────────────────────────────────────────────────

  it("parsePipfileDeps() extracts regular package names", () => {
    const pipfile = `
[packages]
requests = "*"
flask = ">=2.0"
numpy = {version = ">=1.0"}

[dev-packages]
pytest = "*"
`;
    const deps = __test__.parsePipfileDeps(pipfile, "packages");
    expect(deps).toContain("requests");
    expect(deps).toContain("flask");
    expect(deps).toContain("numpy");
    expect(deps).not.toContain("pytest");
  });

  it("parsePipfileDeps() extracts dev package names", () => {
    const pipfile = `
[packages]
requests = "*"

[dev-packages]
pytest = "*"
black = ">=23.0"
`;
    const deps = __test__.parsePipfileDeps(pipfile, "dev-packages");
    expect(deps).toContain("pytest");
    expect(deps).toContain("black");
    expect(deps).not.toContain("requests");
  });

  it("parsePipfileDeps() returns empty array when section missing", () => {
    const pipfile = `[packages]\nrequests = "*"\n`;
    const deps = __test__.parsePipfileDeps(pipfile, "dev-packages");
    expect(deps).toEqual([]);
  });

  // ── readPipenvPackages ─────────────────────────────────────────────────────

  it("readPipenvPackages() reads packages from Pipfile and versions from lock", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-"));

    fs.writeFileSync(
      path.join(dir, "Pipfile"),
      `[packages]\nrequests = "*"\n\n[dev-packages]\npytest = "*"\n`
    );

    fs.writeFileSync(
      path.join(dir, "Pipfile.lock"),
      JSON.stringify({
        default: { requests: { version: "==2.31.0" } },
        develop: { pytest: { version: "==7.4.3" } },
      })
    );

    const pkgs = __test__.readPipenvPackages(dir);

    const requests = pkgs.find((p) => p.name === "requests");
    const pytest = pkgs.find((p) => p.name === "pytest");

    expect(requests).toBeDefined();
    expect(requests?.version).toBe("2.31.0");
    expect(requests?.isDev).toBe(false);

    expect(pytest).toBeDefined();
    expect(pytest?.version).toBe("7.4.3");
    expect(pytest?.isDev).toBe(true);
  });

  it("readPipenvPackages() shows '—' version when lock is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-"));
    fs.writeFileSync(path.join(dir, "Pipfile"), `[packages]\nrequests = "*"\n`);

    const pkgs = __test__.readPipenvPackages(dir);
    const requests = pkgs.find((p) => p.name === "requests");

    expect(requests).toBeDefined();
    expect(requests?.version).toBe("—");
  });

  it("readPipenvPackages() returns empty when Pipfile missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-"));
    expect(__test__.readPipenvPackages(dir)).toEqual([]);
  });

  // ── debounce ───────────────────────────────────────────────────────────────

  it("debounce() only runs once for multiple rapid calls", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = __test__.debounce(fn, 200);

    d(); d(); d();
    expect(fn).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(199);
    expect(fn).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

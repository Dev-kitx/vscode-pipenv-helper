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
      createOutputChannel: vi.fn(() => ({
        append: vi.fn(),
        appendLine: vi.fn(),
        show: vi.fn(),
      })),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: "/fake/workspace" } }],
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_k: string, def: any) => def),
        update: vi.fn(),
      })),
      fs: {
        stat: vi.fn(),
      },
      createFileSystemWatcher: vi.fn(() => ({
        onDidChange: vi.fn(),
        onDidCreate: vi.fn(),
        dispose: vi.fn(),
      })),
    },
    Uri: {
      file: (p: string) => ({ fsPath: p }),
    },
    StatusBarAlignment: { Left: 1 },
    ConfigurationTarget: { Workspace: 1 },
    commands: {
      registerCommand: vi.fn(),
    },
  };
});

import { __test__ } from "../src/extension";

describe("Pipenv Helper - unit tests", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // restore platform if we changed it
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("hashFile() returns sha256 for a real file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-"));
    const file = path.join(dir, "Pipfile.lock");
    fs.writeFileSync(file, "hello");

    const h = __test__.hashFile(file);
    expect(h).toBeTypeOf("string");
    // known sha256("hello")
    expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });

  it("hashFile() returns undefined when file missing", () => {
    const h = __test__.hashFile("/definitely/does/not/exist.lock");
    expect(h).toBeUndefined();
  });

  it("pythonPathFromVenv() uses unix bin/python on mac/linux", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    const py = __test__.pythonPathFromVenv("/venv");
    expect(py).toBe(path.join("/venv", "bin", "python"));
  });

  it("pythonPathFromVenv() uses Windows Scripts/python.exe on win32", () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const py = __test__.pythonPathFromVenv("C:\\venv");
    expect(py).toBe(path.join("C:\\venv", "Scripts", "python.exe"));
  });

  it("activateVenvInTerminal() uses active terminal and sends correct command (unix)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    // get mocked vscode
    const vscode = await import("vscode");
    const term = vscode.window.activeTerminal!;

    __test__.activateVenvInTerminal("/tmp/venv");

    expect(term.show).toHaveBeenCalledTimes(1);
    expect(term.sendText).toHaveBeenCalledTimes(1);
    expect(term.sendText).toHaveBeenCalledWith(`source "${path.join("/tmp/venv", "bin", "activate")}"`);
  });

  it("activateVenvInTerminal() creates terminal if none active", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });

    const vscode = await import("vscode");
    // simulate no active terminal
    (vscode.window as any).activeTerminal = undefined;

    __test__.activateVenvInTerminal("/tmp/venv");

    expect(vscode.window.createTerminal).toHaveBeenCalledTimes(1);
  });

  it("updateStatusBar() shows 'no lock' when Pipfile.lock is missing", () => {
    const statusBar: any = { text: "", tooltip: "" };
    const context: any = { workspaceState: { get: vi.fn(() => undefined) } };

    // Create a temp dir WITHOUT Pipfile.lock
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-nolock-"));

    __test__.updateStatusBar(statusBar, dir, context);

    expect(statusBar.text).toContain("⚠ no lock");
    expect(statusBar.tooltip).toContain("No Pipfile.lock");
  });

  it("updateStatusBar() shows 'out of sync' when stored hash differs", () => {
    const statusBar: any = { text: "", tooltip: "" };
    const context: any = { workspaceState: { get: vi.fn(() => "storedhash") } };

    // make hashFile return "currenthash" by controlling file contents
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-"));
    const lock = path.join(dir, "Pipfile.lock");
    fs.writeFileSync(lock, "current");

    // call with cwd = dir so it reads our lock
    __test__.updateStatusBar(statusBar, dir, context);

    expect(statusBar.text).toContain("⚠ out of sync");
    expect(statusBar.tooltip).toContain("does not match");
  });

  it("updateStatusBar() shows 'synced' when stored hash matches", () => {
    const statusBar: any = { text: "", tooltip: "" };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipenv-helper-"));
    const lock = path.join(dir, "Pipfile.lock");
    fs.writeFileSync(lock, "same");

    const currentHash = __test__.hashFile(lock);
    const context: any = { workspaceState: { get: vi.fn(() => currentHash) } };

    __test__.updateStatusBar(statusBar, dir, context);

    expect(statusBar.text).toContain("✔ synced");
    expect(statusBar.tooltip).toContain("in sync");
  });

  it("debounce() only runs once for multiple rapid calls", async () => {
    vi.useFakeTimers();

    const fn = vi.fn();
    const d = __test__.debounce(fn, 200);

    d();
    d();
    d();

    expect(fn).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(199);
    expect(fn).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});

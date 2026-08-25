/**
 * pi-webui extension — install, update, and launch the pi-webui web UI.
 *
 * The factory only registers commands and never performs network or process
 * work. Downloads happen only when the user explicitly runs `/pi-webui install`
 * or `/pi-webui update`.
 *
 * All subprocess work is async (spawn + await) so the TUI never blocks, and
 * child output is surfaced via ctx.ui widgets/notifications instead of raw
 * terminal writes (which would corrupt the TUI screen).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_VERSION_FILE = join(EXT_DIR, "version.txt");
const GITHUB_REPO = process.env.PI_WEBUI_REPO ?? "pi-webui/pi-webui";
const WIDGET_KEY = "pi-webui";

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function agentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  return join(homedir(), ".pi", "agent");
}

function installDir(): string {
  return join(agentDir(), "extensions", "pi-webui");
}

function binaryPath(): string {
  return join(installDir(), process.platform === "win32" ? "pi-webui.exe" : "pi-webui");
}

function installedVersionPath(): string {
  return join(installDir(), "version");
}

function repoVersion(): string {
  try {
    return readFileSync(REPO_VERSION_FILE, "utf8").trim();
  } catch {
    return "0.0.0";
  }
}

function installedVersion(): string {
  try {
    return readFileSync(installedVersionPath(), "utf8").trim();
  } catch {
    return "";
  }
}

function platformAsset(): string {
  const platform = process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch;
  let os = platform;
  if (platform === "win32") os = "windows";
  if (platform === "darwin") os = "macos";
  return `pi-webui-${os}-${arch}.tar.gz`;
}

function downloadUrl(): string {
  // Assets are published without a version so releases/latest/download works.
  return `https://github.com/${GITHUB_REPO}/releases/latest/download/${platformAsset()}`;
}

function ensureInstallDir(): void {
  mkdirSync(installDir(), { recursive: true });
}

/**
 * Run a child process asynchronously. stdin is ignored (nothing in this
 * extension may read from the TUI stdin), stdout/stderr are captured.
 */
function runProcess(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Start the web service detached in the background (no pipe handles held). */
function startDetached(args: string[]): void {
  const child = spawn(binaryPath(), args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

/** Show child output inside the TUI (widget above the editor). */
function showOutput(ctx: ExtensionContext, text: string): void {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-12);
  if (lines.length > 0) ctx.ui.setWidget(WIDGET_KEY, lines);
}

/** Trim a message for use in a toast notification. */
function shortMessage(text: string, max = 240): string {
  const t = text.trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

async function downloadAndExtract(ctx: ExtensionContext): Promise<void> {
  ensureInstallDir();
  const url = downloadUrl();
  const tmp = join(installDir(), `.pi-webui-download-${Date.now()}.tar.gz`);
  ctx.ui.notify("正在下载 pi-webui ...", "info");
  try {
    const curl = await runProcess("curl", [
      "-fL",
      "--connect-timeout",
      "15",
      "--max-time",
      "600",
      "-o",
      tmp,
      url,
    ]);
    if (curl.code !== 0 || !existsSync(tmp)) {
      // curl missing or failed: fall back to Node fetch in a child process.
      const script = `
        const { writeFileSync } = require('node:fs');
        fetch(${JSON.stringify(url)}, { redirect: 'follow' })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
          .then(b => { writeFileSync(${JSON.stringify(tmp)}, Buffer.from(b)); })
          .catch(e => { console.error(e.message); process.exit(1); });
      `;
      const node = await runProcess(process.execPath, ["-e", script]);
      if (node.code !== 0 || !existsSync(tmp)) {
        const detail =
          (node.stderr || node.stdout || "").trim() || (curl.stderr || curl.stdout || "").trim();
        throw new Error(`下载失败: ${url}${detail ? `\n${shortMessage(detail)}` : ""}`);
      }
    }
    const tar = await runProcess("tar", ["-xzf", tmp, "-C", installDir()]);
    if (tar.code !== 0) {
      const detail = (tar.stderr || tar.stdout || "").trim();
      throw new Error(`解压失败${detail ? `: ${shortMessage(detail)}` : "，请确认系统已安装 tar"}`);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Ensure config.yaml exists and (re)generate the login password. The binary
 * prints the random password on stdout; surface it in the TUI instead of
 * writing to the terminal.
 */
async function ensureConfigAndPrintPassword(ctx: ExtensionContext): Promise<void> {
  const bin = binaryPath();
  if (!existsSync(bin)) return;
  const { code, stdout, stderr } = await runProcess(bin, ["set-password", "--generate"]);
  const out = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join("\n");
  if (code !== 0) {
    throw new Error(shortMessage(out || `set-password 退出码 ${code}`));
  }
  if (out) showOutput(ctx, out);
}

function maybeSymlink(ctx: ExtensionContext): void {
  if (process.platform === "win32") return;
  const localBin = join(homedir(), ".local", "bin");
  const link = join(localBin, "pi-webui");
  if (!existsSync(localBin)) {
    ctx.ui.notify(`提示: ${localBin} 不存在，跳过 symlink。可手动将 ${binaryPath()} 加入 PATH。`, "warning");
    return;
  }
  if (!process.env.PATH?.split(":").includes(localBin)) {
    ctx.ui.notify(`提示: ${localBin} 不在 PATH 中，请自行添加后使用 pi-webui 命令。`, "warning");
  }
  try {
    rmSync(link, { force: true });
    symlinkSync(binaryPath(), link);
    ctx.ui.notify(`已创建 symlink: ${link} -> ${binaryPath()}`, "info");
  } catch (err) {
    ctx.ui.notify(
      `提示: 创建 symlink 失败（${err instanceof Error ? err.message : String(err)}），可手动链接。`,
      "warning",
    );
  }
}

function writeInstalledVersion(version: string): void {
  writeFileSync(installedVersionPath(), `${version}\n`);
}

async function doInstall(ctx: ExtensionContext): Promise<void> {
  const version = repoVersion();
  ctx.ui.notify(`正在从 GitHub Releases 下载 pi-webui ${version || "latest"} ...`, "info");
  await downloadAndExtract(ctx);
  await ensureConfigAndPrintPassword(ctx);
  maybeSymlink(ctx);
  writeInstalledVersion(version);
  ctx.ui.notify(`pi-webui ${version} 已安装到 ${installDir()}`, "info");
}

async function doUpdate(ctx: ExtensionContext): Promise<void> {
  const latest = repoVersion();
  const current = installedVersion();
  if (!current) {
    ctx.ui.notify("尚未安装，请先执行 /pi-webui install", "warning");
    return;
  }
  if (latest === current) {
    ctx.ui.notify(`pi-webui 已是最新版本 ${current}`, "info");
    return;
  }
  ctx.ui.notify(`发现新版本: ${latest}（当前 ${current}），正在更新...`, "info");
  await downloadAndExtract(ctx);
  await ensureConfigAndPrintPassword(ctx);
  maybeSymlink(ctx);
  writeInstalledVersion(latest);
  ctx.ui.notify(`pi-webui 已更新到 ${latest}`, "info");
}

function showVersion(ctx: ExtensionContext): void {
  showOutput(ctx, [
    `repo version:    ${repoVersion()}`,
    `installed version: ${installedVersion() || "(未安装)"}`,
    `install path:    ${installDir()}`,
  ].join("\n"));
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("pi-webui", {
    description: "Install, update, start and manage the pi-webui browser UI",
    handler: async (args, ctx) => {
      const [cmd, ...rest] = (args ?? "").split(/\s+/).filter(Boolean);
      if (cmd === "install") {
        await doInstall(ctx);
        return;
      }
      if (cmd === "update") {
        await doUpdate(ctx);
        return;
      }
      if (cmd === "version") {
        showVersion(ctx);
        return;
      }

      const bin = binaryPath();
      if (!existsSync(bin)) {
        ctx.ui.notify("请先执行 /pi-webui install", "warning");
        return;
      }

      // Interactive `set-password` (no --generate, no password argument) must
      // not let the child read TUI stdin; ask via the TUI dialog and pass the
      // password as a positional argument instead.
      if (
        cmd === "set-password" &&
        !rest.includes("--generate") &&
        !rest.some((a) => !a.startsWith("--"))
      ) {
        const password = await ctx.ui.input(
          "设置 pi-webui 登录密码（留空取消）",
          "新密码",
        );
        if (password === undefined || password === "") {
          ctx.ui.notify("已取消", "info");
          return;
        }
        rest.push(password);
      }

      try {
        if (cmd === "start" || (cmd === "daemon" && rest[0] === "start")) {
          startDetached([cmd, ...rest]);
          ctx.ui.notify(`pi-webui ${cmd} 已在后台启动`, "info");
        } else {
          const { code, stdout, stderr } = await runProcess(bin, [cmd, ...rest]);
          const out = [stdout, stderr].map((s) => s.trim()).filter(Boolean).join("\n");
          if (out) showOutput(ctx, out);
          if (code !== 0) {
            const detail = out ? `: ${shortMessage(out)}` : "";
            ctx.ui.notify(`pi-webui ${cmd} 执行失败 (exit ${code ?? "?"})${detail}`, "error");
          }
        }
      } catch (err) {
        ctx.ui.notify(
          `pi-webui ${cmd} 执行失败: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}

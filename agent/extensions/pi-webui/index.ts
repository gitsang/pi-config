/**
 * pi-webui extension — install, update, and launch the pi-webui web UI.
 *
 * The factory only registers commands and never performs network or process
 * work. Downloads happen only when the user explicitly runs `/pi-webui install`
 * or `/pi-webui update`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_VERSION_FILE = join(EXT_DIR, "version.txt");
const GITHUB_REPO = process.env.PI_WEBUI_REPO ?? "pi-webui/pi-webui";

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

function runBinary(args: string[], opts: { detached?: boolean } = {}): void {
  const bin = binaryPath();
  if (!existsSync(bin)) {
    throw new Error("pi-webui 二进制不存在，请先执行 /pi-webui install");
  }
  if (opts.detached) {
    const child = spawn(bin, args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    return;
  }
  const result = spawnSync(bin, args, { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} exited with ${result.status}`);
  }
}

function downloadAndExtract(): void {
  ensureInstallDir();
  const url = downloadUrl();
  const tmp = join(installDir(), `.pi-webui-download-${Date.now()}.tar.gz`);
  try {
    // Prefer curl on Linux/macOS; Node fetch is the fallback.
    const curl = spawnSync("curl", ["-fL", "--connect-timeout", "15", "-o", tmp, url], {
      stdio: "inherit",
    });
    if (curl.status !== 0 || !existsSync(tmp)) {
      // Synchronous fetch is not available; use a blocking child process that
      // performs the fetch, so this function stays synchronous.
      const script = `
        const { writeFileSync } = require('node:fs');
        fetch(${JSON.stringify(url)}, { redirect: 'follow' })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
          .then(b => { writeFileSync(${JSON.stringify(tmp)}, Buffer.from(b)); })
          .catch(e => { console.error(e.message); process.exit(1); });
      `;
      const node = spawnSync(process.execPath, ["-e", script], { stdio: "inherit" });
      if (node.status !== 0 || !existsSync(tmp)) {
        throw new Error(`下载失败: ${url}`);
      }
    }
    const tar = spawnSync("tar", ["-xzf", tmp, "-C", installDir()], { stdio: "inherit" });
    if (tar.status !== 0) {
      throw new Error("解压失败，请确认系统已安装 tar");
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}

function writeInstalledVersion(version: string): void {
  writeFileSync(installedVersionPath(), `${version}\n`);
}

function ensureConfigAndPrintPassword(): void {
  const bin = binaryPath();
  if (!existsSync(bin)) return;
  const result = spawnSync(bin, ["set-password", "--generate"], {
    encoding: "utf8",
    env: process.env,
  });
  // The binary prints the generated password to stdout; surface it.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function maybeSymlink(): void {
  if (process.platform === "win32") return;
  const localBin = join(homedir(), ".local", "bin");
  const link = join(localBin, "pi-webui");
  if (!existsSync(localBin)) {
    console.log(`提示: ${localBin} 不存在，跳过 symlink。可手动将 ${binaryPath()} 加入 PATH。`);
    return;
  }
  if (!process.env.PATH?.split(":").includes(localBin)) {
    console.log(`提示: ${localBin} 不在 PATH 中，请自行添加后使用 pi-webui 命令。`);
  }
  try {
    rmSync(link, { force: true });
    symlinkSync(binaryPath(), link);
    console.log(`已创建 symlink: ${link} -> ${binaryPath()}`);
  } catch (err) {
    console.log(`提示: 创建 symlink 失败（${err instanceof Error ? err.message : String(err)}），可手动链接。`);
  }
}

function doInstall(): void {
  const version = repoVersion();
  console.log(`正在从 GitHub Releases 下载 pi-webui ${version || "latest"} ...`);
  downloadAndExtract();
  ensureConfigAndPrintPassword();
  maybeSymlink();
  writeInstalledVersion(version);
  console.log(`pi-webui ${version} 已安装到 ${installDir()}`);
}

function doUpdate(): void {
  const latest = repoVersion();
  const current = installedVersion();
  if (!current) {
    console.log("尚未安装，请先执行 /pi-webui install");
    return;
  }
  if (latest === current) {
    console.log(`pi-webui 已是最新版本 ${current}`);
    return;
  }
  console.log(`发现新版本: ${latest}（当前 ${current}），正在更新...`);
  downloadAndExtract();
  ensureConfigAndPrintPassword();
  maybeSymlink();
  writeInstalledVersion(latest);
  console.log(`pi-webui 已更新到 ${latest}`);
}

function showVersion(): void {
  console.log(`repo version:    ${repoVersion()}`);
  console.log(`installed version: ${installedVersion() || "(未安装)"}`);
  console.log(`install path:    ${installDir()}`);
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("pi-webui", {
    description: "Install, update, start and manage the pi-webui browser UI",
    handler: async (args, ctx) => {
      const [cmd, ...rest] = args.split(/\s+/).filter(Boolean);
      if (cmd === "install") {
        doInstall();
        return;
      }
      if (cmd === "update") {
        doUpdate();
        return;
      }
      if (cmd === "version") {
        showVersion();
        return;
      }

      const bin = binaryPath();
      if (!existsSync(bin)) {
        ctx.ui.notify("请先执行 /pi-webui install", "warning");
        return;
      }

      try {
        if (cmd === "start" || (cmd === "daemon" && rest[0] === "start")) {
          runBinary([cmd, ...rest], { detached: true });
          ctx.ui.notify(`pi-webui ${cmd} 已在后台启动`, "info");
        } else {
          runBinary([cmd, ...rest]);
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

/**
 * pi-trigger — systemd user unit 生成 + sync。
 *
 * 用户只写 trigger.yaml，unit 由这里生成；sync 负责 enable/disable 与清理失效单元。
 * 不写 trigger.service：声明文件是唯一真源。
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Manifest } from "./manifest.ts";
import { loadAll, isError } from "./manifest.ts";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EMIT_BIN = path.join(EXT_DIR, "bin", "emit");

export const DATA_DIR = process.env.PI_TRIGGER_DIR ?? path.join(homedir(), ".pi", "trigger");
const UNITS_DIR = path.join(homedir(), ".config", "systemd", "user");
const UNIT_PREFIX = "pi-trigger-";

function sh(cmd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000 });
  return { code: r.status ?? (r.error ? 1 : 0), out: (r.stdout ?? "").toString(), err: (r.stderr ?? "").toString() };
}
function systemctl(args: string[]): { code: number; err: string } {
  const r = sh("systemctl", ["--user", ...args]);
  return { code: r.code, err: (r.err + r.out).trim() };
}

/**
 * 从 pi-scheduler 的 env 取它写好的 PATH（含 node / pi 的 bin 目录）。
 * trigger 守护进程通常要 exec pi CLI，必须能解析 pi 与 node。
 */
function schedulerPath(schedulerDir: string): string {
  try {
    const env = fs.readFileSync(path.join(schedulerDir, "env"), "utf8");
    const m = /export PI_SCHEDULER_PATH="([^"]*)"/.exec(env);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return "";
}

export function serviceUnit(m: Manifest, schedulerDir: string): string {
  const cwd = m.service.cwd ? path.resolve(m.dir, m.service.cwd) : m.dir;
  const envFile = path.join(m.dir, "env");
  const extraPath = path.dirname(EMIT_BIN);
  const sp = schedulerPath(schedulerDir);
  // 只保留必要项：emit 所在目录 + pi-scheduler 写好的 PATH（含 node/pi bin）+ 系统目录。
  // 不继承交互式 shell 的完整 PATH（几十项、随会话变化），保证 unit 稳定可复现。
  const pathValue = [extraPath, sp, "/usr/local/bin:/usr/bin:/bin"].filter(Boolean).join(":");

  const lines = [
    "[Unit]",
    `Description=pi-trigger: ${m.name}${m.description ? ` — ${m.description}` : ""}`,
    ...(m.service.after ?? []).map((a) => `After=${a}`),
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${m.service.exec}`,
    `WorkingDirectory=${cwd}`,
    `Restart=${m.service.restart ?? "on-failure"}`,
    `RestartSec=${m.service.restartSec ?? 5}`,
    `KillMode=${m.service.killMode ?? "control-group"}`,
    `TimeoutStopSec=${m.service.stopTimeoutSec ?? 30}`,
    "",
    `Environment=PI_SCHEDULER_DIR=${schedulerDir}`,
    `Environment=PI_TRIGGER_NAME=${m.name}`,
    `Environment=PI_TRIGGER_DIR=${m.dir}`,
    `Environment=PI_TRIGGER_JOB=${m.emit.job}`,
    `Environment=PI_TRIGGER_EMIT=${EMIT_BIN}`,
    "Environment=HOME=%h",
    "Environment=XDG_RUNTIME_DIR=/run/user/%U",
    `Environment=PATH=${pathValue}`,
  ];
  for (const [k, v] of Object.entries(m.env)) {
    // systemd 的 Environment= 支持引号包裹含空格的值
    lines.push(`Environment=${k}=${/[\s"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v}`);
  }
  if (fs.existsSync(envFile)) lines.push(`EnvironmentFile=${envFile}`);
  if (m.service.memoryMax) lines.push(`MemoryMax=${m.service.memoryMax}`);
  lines.push(
    "StandardOutput=journal",
    "StandardError=journal",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  );
  return lines.join("\n");
}

export interface SyncResult {
  ok: boolean;
  lines: string[];
  errors: string[];
}

/** 读全部 manifest → 生成 units → 清理失效 → reload → enable。 */
export function syncNow(opts: { schedulerDir?: string; quiet?: boolean } = {}): SyncResult {
  const schedulerDir = opts.schedulerDir ?? path.join(homedir(), ".pi", "scheduler");
  const lines: string[] = [];
  const errors: string[] = [];
  const manifests = loadAll(DATA_DIR);

  const desired = new Set<string>();
  for (const m of manifests) {
    if (isError(m)) {
      errors.push(`trigger ${m.name}: ${m.errors.join("; ")}`);
      continue;
    }
    desired.add(m.name);
    fs.mkdirSync(UNITS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UNITS_DIR, `${UNIT_PREFIX}${m.name}.service`), serviceUnit(m, schedulerDir), "utf8");
    lines.push(`trigger ${m.name}: exec=${m.service.exec} → job ${m.emit.job}${m.description ? ` (${m.description})` : ""}`);
  }

  // 清理失效单元（trigger 目录没了 / 被删 / 解析失败）
  fs.mkdirSync(UNITS_DIR, { recursive: true });
  const stale: string[] = [];
  for (const f of fs.readdirSync(UNITS_DIR)) {
    const mm = new RegExp(`^${UNIT_PREFIX}(.+)\\.service$`).exec(f);
    if (mm && !desired.has(mm[1])) stale.push(f);
  }
  for (const f of stale) {
    systemctl(["disable", "--now", f]);
    fs.rmSync(path.join(UNITS_DIR, f), { force: true });
  }
  if (stale.length) lines.push(`removed stale units: ${stale.join(", ")}`);

  const rl = systemctl(["daemon-reload"]);
  if (rl.code !== 0) errors.push(`daemon-reload failed: ${rl.err}`);
  for (const name of desired) {
    const en = systemctl(["enable", "--now", `${UNIT_PREFIX}${name}.service`]);
    if (en.code !== 0) errors.push(`enable ${name} failed: ${en.err}`);
  }
  lines.push(`enabled ${desired.size} trigger service(s)`);
  return { ok: errors.length === 0, lines, errors };
}

export function unitName(name: string): string {
  return `${UNIT_PREFIX}${name}`;
}

export { UNITS_DIR, UNIT_PREFIX, systemctl, sh };

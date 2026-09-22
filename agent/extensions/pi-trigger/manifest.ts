/**
 * pi-trigger — trigger.yaml 声明文件的解析与校验。
 *
 * 一个 trigger 就是一个「事件源守护进程」：它跑起来、监听外部事件，
 * 事件到达时调用 pi-trigger 注入的 $PI_TRIGGER_EMIT 触发某个 pi-scheduler job。
 *
 * pi-trigger 只负责：按声明把守护进程交给 systemd 托管、把事件转发给 run-job。
 * 它不读 job 的定义、不碰 pi 的执行 —— 那条边界在 bin/emit → bin/run-job。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

export const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const JOB_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const DUR_RE = /^\d+(s|min|h|ms)?$/;
const SIZE_RE = /^\d+(%|K|M|G|T|K|KB|MB|GB|TB)?$/i;

export type RestartPolicy = "no" | "on-failure" | "always";
export type KillMode = "control-group" | "process" | "mixed" | "none";

export interface ServiceSpec {
  /** 要跑的命令行，原样作为 systemd ExecStart。 */
  exec: string;
  /** 工作目录，相对 trigger 目录；默认 = trigger 目录本身。 */
  cwd?: string;
  /** 重启策略，默认 on-failure。 */
  restart?: RestartPolicy;
  /** RestartSec，默认 5。 */
  restartSec?: number;
  /** TimeoutStopSec（停止时先 TERM 再 KILL 的宽限），默认 30。 */
  stopTimeoutSec?: number;
  /** KillMode，默认 control-group（收整棵进程树）。 */
  killMode?: KillMode;
  /** 可选 MemoryMax（如 6G / 512M）。 */
  memoryMax?: string;
  /** 可选：追加 After=（额外等待的 unit，如 network-online.target）。 */
  after?: string[];
}

export interface EmitSpec {
  /** 事件触发的目标 pi-scheduler job 名（一个 trigger 只 emit 一个 job）。 */
  job: string;
  /** 期望的上下文 key 列表；emit 时会校验（缺失/多余只告警，不阻断）。 */
  context?: string[];
}

export interface Manifest {
  name: string;
  dir: string;
  description?: string;
  service: ServiceSpec;
  emit: EmitSpec;
  /** 额外注入守护进程的环境变量（写进 unit 的 Environment=）。 */
  env: Record<string, string>;
}

export interface ManifestError {
  name: string;
  errors: string[];
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter((x): x is string => !!x);
  const s = asString(v);
  return s ? [s] : undefined;
}

/** 解析单个 trigger.yaml；返回 manifest 或错误列表。 */
export function parseManifest(name: string, dir: string, text: string): Manifest | ManifestError {
  const errors: string[] = [];
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return { name, errors: [`YAML 解析失败: ${(e as Error).message}`] };
  }
  if (raw === null || raw === undefined) return { name, errors: ["trigger.yaml 为空"] };
  if (typeof raw !== "object" || Array.isArray(raw)) return { name, errors: ["trigger.yaml 顶层必须是映射（key: value）"] };
  const m = raw as Record<string, unknown>;

  const svcRaw = m.service;
  if (svcRaw === undefined) errors.push("缺少 service 段");
  if (svcRaw !== undefined && (typeof svcRaw !== "object" || svcRaw === null || Array.isArray(svcRaw))) {
    errors.push("service 必须是映射");
  }
  const svc = (typeof svcRaw === "object" && svcRaw !== null && !Array.isArray(svcRaw) ? svcRaw : {}) as Record<string, unknown>;

  const exec = asString(svc.exec);
  if (!exec?.trim()) errors.push("service.exec 必填（要跑的命令行）");

  const emitRaw = m.emit;
  if (emitRaw === undefined) errors.push("缺少 emit 段");
  if (emitRaw !== undefined && (typeof emitRaw !== "object" || emitRaw === null || Array.isArray(emitRaw))) {
    errors.push("emit 必须是映射");
  }
  const emit = (typeof emitRaw === "object" && emitRaw !== null && !Array.isArray(emitRaw) ? emitRaw : {}) as Record<string, unknown>;
  const job = asString(emit.job);
  if (!job?.trim()) errors.push("emit.job 必填（目标 pi-scheduler job 名）");
  else if (!JOB_NAME_RE.test(job)) errors.push(`emit.job "${job}" 不合法（仅字母/数字/_/-，≤40）`);

  const restart = asString(svc.restart) ?? "on-failure";
  if (!["no", "on-failure", "always"].includes(restart)) {
    errors.push(`service.restart 只接受 no|on-failure|always（得到 "${restart}"）`);
  }
  const killMode = asString(svc.killMode) ?? "control-group";
  if (!["control-group", "process", "mixed", "none"].includes(killMode)) {
    errors.push(`service.killMode 只接受 control-group|process|mixed|none（得到 "${killMode}"）`);
  }

  let restartSec = 5;
  if (svc.restartSec !== undefined) {
    const n = Number(svc.restartSec);
    if (!Number.isFinite(n) || n < 0) errors.push(`service.restartSec 必须是非负数（得到 "${String(svc.restartSec)}"）`);
    else restartSec = n;
  }
  let stopTimeoutSec = 30;
  if (svc.stopTimeoutSec !== undefined) {
    const n = Number(svc.stopTimeoutSec);
    if (!Number.isFinite(n) || n <= 0) errors.push(`service.stopTimeoutSec 必须是正数（得到 "${String(svc.stopTimeoutSec)}"）`);
    else stopTimeoutSec = n;
  }
  const memoryMax = asString(svc.memoryMax);
  if (memoryMax !== undefined && !SIZE_RE.test(memoryMax)) {
    errors.push(`service.memoryMax 格式可疑（如 6G / 512M）："${memoryMax}"`);
  }
  const after = asStringArray(svc.after);

  const cwd = asString(svc.cwd);
  if (cwd !== undefined && !fs.existsSync(path.resolve(dir, cwd))) {
    errors.push(`service.cwd 不存在: ${path.resolve(dir, cwd)}`);
  }

  const env: Record<string, string> = {};
  if (m.env !== undefined) {
    if (typeof m.env !== "object" || m.env === null || Array.isArray(m.env)) {
      errors.push("env 必须是映射（KEY: value）");
    } else {
      for (const [k, v] of Object.entries(m.env as Record<string, unknown>)) {
        const s = asString(v);
        if (s === undefined) errors.push(`env.${k} 必须是标量`);
        else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) errors.push(`env.${k} 不是合法环境变量名`);
        else env[k] = s;
      }
    }
  }

  if (errors.length) return { name, errors };

  return {
    name,
    dir,
    description: asString(m.description),
    service: {
      exec: exec!.trim(),
      cwd,
      restart: restart as RestartPolicy,
      restartSec,
      stopTimeoutSec,
      killMode: killMode as KillMode,
      memoryMax,
      after,
    },
    emit: { job: job!.trim(), context: asStringArray(emit.context) },
    env,
  };
}

export function isError(x: Manifest | ManifestError): x is ManifestError {
  return (x as ManifestError).errors !== undefined;
}

/** 扫描 trigger 根目录下所有含 trigger.yaml 的子目录。 */
export function listTriggerDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NAME_RE.test(d.name))
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(root, n, "trigger.yaml")))
    .sort();
}

export function loadManifest(root: string, name: string): Manifest | ManifestError {
  const dir = path.join(root, name);
  const file = path.join(dir, "trigger.yaml");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { name, errors: [`读取 ${file} 失败: ${(e as Error).message}`] };
  }
  return parseManifest(name, dir, text);
}

export function loadAll(root: string): Array<Manifest | ManifestError> {
  return listTriggerDirs(root).map((n) => loadManifest(root, n));
}

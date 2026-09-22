#!/usr/bin/env python3
"""把 `pi --mode json` 的事件流实时渲染成人可读日志。

为什么需要它：pi 默认的 text 模式（`--mode text`）会把整段输出**缓冲到进程
退出**才一次性写出，所以一个跑 15~20 分钟的 job，在 `journalctl -f` 和
`tail -f last-<job>.out` 里全程是空的 —— 只能等结束才看到全部。
json 模式是**逐事件**输出的（实测运行中 1.7s / 11.6s 就有事件），本脚本把
它转回人类可读的行，并且每行都 flush。

粒度按「事件」而非「token」：token 级的 delta 会在几秒内把 journald 刷爆
（默认 RateLimitBurst=10000/30s，超限的日志会被**直接丢弃**）。所以文本和
思考是「按行」输出，工具输出按增量输出。

用法：
    pi -p --mode json ... | render-events.py

非 JSON 行（pi 写给 stderr 的告警等）原样透传，不会中断渲染。
"""
import json
import sys
import time

T0 = time.monotonic()
OUT = sys.stdout


def emit(line: str = "") -> None:
    OUT.write(line + "\n")
    OUT.flush()


def stamp() -> str:
    s = int(time.monotonic() - T0)
    return "[%02d:%02d]" % (s // 60, s % 60)


class LineStream:
    """按行聚合增量 delta —— 攒够一整行才输出，避免每 token 一行。"""

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix
        self.buf = ""

    def feed(self, delta: str) -> None:
        self.buf += delta
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            if line.strip():
                emit("%s %s%s" % (stamp(), self.prefix, line))

    def close(self) -> None:
        if self.buf.strip():
            emit("%s %s%s" % (stamp(), self.prefix, self.buf))
        self.buf = ""


def tool_text(payload) -> str:
    """从 tool result / partialResult 里抽出纯文本内容。"""
    if not isinstance(payload, dict):
        return ""
    content = payload.get("content")
    if not isinstance(content, list):
        return ""
    return "".join(
        c.get("text") or ""
        for c in content
        if isinstance(c, dict) and c.get("type") == "text"
    )


def clip(text: str, limit: int = 2000) -> str:
    text = text.rstrip("\n")
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…（其余 %d 字符省略）" % (len(text) - limit)


def indent(text: str) -> None:
    for line in clip(text).split("\n"):
        emit("%s   │ %s" % (stamp(), line))


def summarize_args(name: str, args) -> str:
    if not isinstance(args, dict):
        return ""
    for key in ("command", "path", "file_path", "pattern", "query", "url"):
        v = args.get(key)
        if isinstance(v, str) and v.strip():
            one = v.strip().replace("\n", " ")
            return one if len(one) <= 160 else one[:160] + "…"
    if not args:
        return ""
    s = json.dumps(args, ensure_ascii=False)
    return s if len(s) <= 160 else s[:160] + "…"


def main() -> int:
    thinking = LineStream("[think] ")
    answer = LineStream("")
    emitted: dict[str, int] = {}   # toolCallId -> 已输出的字符数
    usage: dict = {}
    turns = 0

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        if not line.startswith("{"):
            emit(line)          # pi 写到 stderr 的告警等，原样透传
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            emit(line)
            continue

        kind = ev.get("type")

        if kind == "session":
            emit("%s ── session %s" % (stamp(), ev.get("id", "?")))
        elif kind == "turn_start":
            turns += 1
            emit("%s ──── turn %d ────" % (stamp(), turns))
        elif kind == "message_update":
            if ev.get("usage") and ev["usage"].get("totalTokens"):
                usage = ev["usage"]
            aev = ev.get("assistantMessageEvent") or {}
            at = aev.get("type")
            if at == "thinking_delta":
                thinking.feed(aev.get("delta") or "")
            elif at == "thinking_end":
                thinking.close()
            elif at == "text_delta":
                answer.feed(aev.get("delta") or "")
            elif at == "text_end":
                answer.close()
        elif kind == "tool_execution_start":
            summary = summarize_args(ev.get("toolName", "?"), ev.get("args"))
            emit("%s → %s%s" % (stamp(), ev.get("toolName", "?"),
                                (": " + summary) if summary else ""))
        elif kind == "tool_execution_update":
            cid = ev.get("toolCallId", "")
            text = tool_text(ev.get("partialResult"))
            prev = emitted.get(cid, 0)
            if len(text) > prev:
                indent(text[prev:])
                emitted[cid] = len(text)
        elif kind == "tool_execution_end":
            cid = ev.get("toolCallId", "")
            text = tool_text(ev.get("result"))
            prev = emitted.get(cid, 0)
            if len(text) > prev:
                indent(text[prev:])
            elif not prev and text:
                indent(text)
            emitted[cid] = len(text)
            if ev.get("isError"):
                emit("%s ✗ %s 失败" % (stamp(), ev.get("toolName", "")))
        elif kind == "agent_end":
            thinking.close()
            answer.close()
            if usage:
                emit("%s ── tokens in=%s out=%s total=%s cost=%s" % (
                    stamp(), usage.get("input"), usage.get("output"),
                    usage.get("totalTokens"),
                    (usage.get("cost") or {}).get("total")))

    thinking.close()
    answer.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:      # 下游（tee/journald）先关掉，不算错误
        sys.exit(0)

#!/usr/bin/env python3
"""把「事件上下文」渲染进 job 的 prompt 正文。

用法: render-prompt.py <body-file> <context-json-file> <out-file>

渲染规则（按优先级）:
  1. 正文含 {{context}}  → 整块替换成 "- key: value" 多行文本
  2. 否则含 {{key}}      → 逐个替换该 key 的值
  3. 两者都没有          → 在正文最前插入「本次触发上下文」小节

context JSON 为空对象 {} 时不注入任何东西（正文原样输出），
这样「无事件的全量扫描」与「带事件的精准触发」可以共用同一份 prompt。

退出码: 0 正常 / 2 context JSON 非法
"""

import json
import sys


def fmt(v) -> str:
    if isinstance(v, str):
        return v
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    # list / dict 等：紧凑 JSON，保证单行
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def main() -> int:
    if len(sys.argv) != 4:
        print("usage: render-prompt.py <body-file> <context-json-file> <out-file>", file=sys.stderr)
        return 2

    body_path, ctx_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(body_path, encoding="utf-8") as f:
        body = f.read()

    raw = ""
    try:
        with open(ctx_path, encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        print(f"render-prompt: 读取 context 失败: {e}", file=sys.stderr)
        return 2

    try:
        ctx = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        print(f"render-prompt: context JSON 非法: {e}", file=sys.stderr)
        return 2
    if not isinstance(ctx, dict):
        print("render-prompt: context 必须是 JSON 对象 {..}", file=sys.stderr)
        return 2

    items = [(str(k), fmt(v)) for k, v in ctx.items()]
    if not items:
        out = body  # 空 context：不注入
    else:
        block = "\n".join(f"- {k}: {v}" for k, v in items)
        if "{{context}}" in body:
            out = body.replace("{{context}}", block)
        else:
            out, used = body, False
            for k, v in items:
                token = "{{" + k + "}}"
                if token in out:
                    out = out.replace(token, v)
                    used = True
            if not used:
                out = f"## 本次触发上下文\n\n{block}\n\n---\n\n{body}"
            else:
                # 用户用了 {{key}} 但有些 key 没提供：提示一下，不阻断
                import re

                for m in re.findall(r"\{\{([A-Za-z0-9_.-]+)\}\}", out):
                    if m != "context" and m not in dict(items):
                        print(f"render-prompt: 正文引用了未提供的 key {{{{{m}}}}}，保留原样", file=sys.stderr)

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())

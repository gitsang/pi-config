# pi-prompt

自定义常用提示词的 pi 扩展。把提示词写成文件放进 `prompts/` 目录，然后用 slash command 触发，内容会**自动填入输入框**，你可以先检查/修改再回车发送。

和 skill 的区别：skill 会被 agent 按需主动读取；这里的提示词**永远不会被 agent 主动读取**，只有你主动通过 `/prompt:xxx` 触发时才会进到输入框，且只有你按回车后才会真正发给 agent。

## 安装

本扩展已放在全局扩展目录 `~/.pi/agent/extensions/pi-prompt/`，pi 启动时自动加载。

如果改了代码或新增了提示词文件，运行 `/reload` 重新加载。

## 用法

### 触发已配置的提示词

```
/prompt:commit-and-push
```

命令执行后，`prompts/commit-and-push.md` 的内容会被填入输入框，光标就位，你可以编辑后回车发送。

| 命令 | 行为 |
|------|------|
| `/prompt:<name>` | 把对应提示词填入输入框（输入框为空时直接填充；若有残留内容则追加在后面） |
| `/prompt` | 弹出列表，选择要插入的提示词 |
| `/prompt <name>` | 直接插入指定提示词 |

输入 `/prompt` 后按 Tab 或空格，会自动补全已配置的提示词名称；`/prompt:xxx` 也会出现在 `/` 命令自动补全里。

### 配置提示词

在 `~/.pi/agent/extensions/pi-prompt/prompts/` 目录下新建文件即可，一个文件 = 一个提示词：

- 支持扩展名：`.md`、`.txt`、`.prompt`
- 文件名（去掉扩展名）就是命令名，例如 `commit-and-push.md` → `/prompt:commit-and-push`
- 文件内容就是插入到输入框的提示词原文
- 可选：第一行写 `description: 描述文字`，会显示在命令自动补全里

示例 `prompts/commit-and-push.md`：

```
description: Git commit and push the changes from this session

Commit and push the changes made in this session:

1. Run `git status`, `git diff`, and `git diff --staged` to review what changed.
2. Group the changes into logical commits with clear conventional messages
   (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`).
3. Stage only the files relevant to each commit — do not blindly `git add -A`.
4. Push the commits to the current branch's upstream with `git push`.
5. Verify the push succeeded and report the commit hash(es) and branch.
```

### 常用命令速查

| 命令 | 作用 |
|------|------|
| `/prompt:commit-and-push` | git 提交并推送本次修改 |
| `/prompt:review-diff` | 审查当前未提交的 diff |
| `/prompt:summarize-changes` | 总结本次会话的改动 |

## 工作原理

- 扩展加载时（以及 `/reload` 后）扫描 `prompts/` 目录，为每个提示词注册一个 `prompt:<name>` 命令。
- 命令处理函数把提示词文本通过 `ctx.ui.setEditorText()` 填入输入框，并给出提示。
- 未注册的 `/prompt:<name>` 会被拦截并提示可用列表，不会误发给 agent。

## 常见问题

- **改了提示词文件没生效？** 运行 `/reload`。
- **提示词不想用了？** 直接删除对应文件，再 `/reload`。
- **想在某条提示词后面追加内容？** 先复制提示词到输入框，再直接编辑，或把想要追加的部分直接写在提示词文件里。
- **非交互模式（`pi -p` / RPC）下无效？** 插入输入框只在 TUI 交互模式可用，其他模式会提示。

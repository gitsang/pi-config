import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, UnauthorizedError } from "./api";
import type { ChatMessage, PiModel, PiState, SessionSummary, ToolCard } from "./types";

interface AssistantEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  kind?: string;
  toolCall?: unknown;
  messageId?: string;
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [cwdFilter, setCwdFilter] = useState("");
  const [newCwd, setNewCwd] = useState("");
  const [activeBsid, setActiveBsid] = useState<string | null>(null);
  const [activeCwd, setActiveCwd] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [toolCards, setToolCards] = useState<ToolCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<PiModel[]>([]);
  const [thinkingLevels, setThinkingLevels] = useState<string[]>([]);
  const [piState, setPiState] = useState<PiState>({});
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedThinking, setSelectedThinking] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sseRef = useRef<EventSource | null>(null);
  const openedOnceRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api
      .me()
      .then(() => {
        setAuthenticated(true);
        void refreshSessions();
      })
      .catch((err) => {
        if (err instanceof UnauthorizedError) setAuthenticated(false);
        else setAuthenticated(false);
      });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, toolCards]);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.listSessions(cwdFilter);
      setSessions(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [cwdFilter]);

  useEffect(() => {
    if (authenticated) void refreshSessions();
  }, [authenticated, refreshSessions]);

  function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    api
      .login(loginPassword)
      .then(() => {
        setAuthenticated(true);
        void refreshSessions();
      })
      .catch((err) => {
        setLoginError(err instanceof Error ? err.message : "登录失败");
      });
  }

  function handleLogout() {
    closeSse();
    api.logout().finally(() => {
      setAuthenticated(false);
      setActiveBsid(null);
      setMessages([]);
      setToolCards([]);
    });
  }

  function closeSse() {
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
  }

  function openSession(bsid: string, cwd: string) {
    const prev = activeBsid;
    if (prev && prev !== bsid) {
      api.closeSession(prev).catch(() => {
        // ignore close errors when switching sessions
      });
    }
    closeSse();
    openedOnceRef.current = false;
    setActiveBsid(bsid);
    setActiveCwd(cwd);
    setMessages([]);
    setToolCards([]);
    setBusy(false);
    setError("");
    setSelectedModel("");
    setSelectedThinking("");
    setPiState({});

    const es = new EventSource(`/api/sessions/${bsid}/events`);
    sseRef.current = es;

    es.onopen = () => {
      if (openedOnceRef.current) {
        void loadMessages(bsid);
      } else {
        openedOnceRef.current = true;
        void loadSessionData(bsid);
      }
    };
    es.addEventListener("hello", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        if (data.piState) {
          setPiState(data.piState);
          setBusy(Boolean(data.piState.isStreaming));
          if (data.piState.model) {
            setSelectedModel(`${data.piState.model.provider}/${data.piState.model.id}`);
          }
          if (data.piState.thinkingLevel) setSelectedThinking(data.piState.thinkingLevel);
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener("message_start", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        handleMessageStart(data.message);
      } catch {
        // ignore
      }
    });
    es.addEventListener("message_update", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        handleMessageUpdate(data as { assistantMessageEvent?: AssistantEvent } & AssistantEvent);
      } catch {
        // ignore
      }
    });
    es.addEventListener("message_end", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        handleMessageEnd(data.message);
      } catch {
        // ignore
      }
    });
    es.addEventListener("tool_execution_start", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        addToolCard({ ...data, status: "running", startedAt: Date.now() });
      } catch {
        // ignore
      }
    });
    es.addEventListener("tool_execution_update", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        updateToolCard(data.toolCallId, { partialResult: data.partialResult });
      } catch {
        // ignore
      }
    });
    es.addEventListener("tool_execution_end", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        updateToolCard(data.toolCallId, {
          result: data.result,
          isError: data.isError,
          status: "done",
        });
      } catch {
        // ignore
      }
    });
    es.addEventListener("agent_start", () => setBusy(true));
    es.addEventListener("agent_settled", () => {
      setBusy(false);
      void loadSessionState(bsid);
    });
    es.addEventListener("process_exit", () => {
      setBusy(false);
      setError("pi 子进程已退出。会话文件仍在磁盘上，可重新导入恢复。");
    });
    es.addEventListener("error", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data);
        setError(data.message ?? "后端错误");
      } catch {
        // ignore
      }
    });
  }

  function handleMessageStart(message: ChatMessage) {
    if (!message) return;
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.timestamp && message.timestamp && m.timestamp === message.timestamp);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = message;
        return next;
      }
      return [...prev, message];
    });
  }

  function handleMessageEnd(message: ChatMessage) {
    if (!message) return;
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.timestamp && message.timestamp && m.timestamp === message.timestamp);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = message;
        return next;
      }
      const lastAssistant = [...prev].reverse().findIndex((m) => m.role === "assistant");
      if (message.role === "assistant" && lastAssistant >= 0) {
        const next = [...prev];
        next[prev.length - 1 - lastAssistant] = message;
        return next;
      }
      return [...prev, message];
    });
  }

  function handleMessageUpdate(data: { assistantMessageEvent?: AssistantEvent } & AssistantEvent) {
    const ae = data.assistantMessageEvent ?? data;
    if (!ae || typeof ae !== "object") return;
    setMessages((prev) => {
      let idx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === "assistant") {
          idx = i;
          break;
        }
      }
      const msgs = [...prev];
      if (idx < 0) {
        msgs.push({ role: "assistant", content: [] });
        idx = msgs.length - 1;
      }
      const msg = msgs[idx];
      const content = [...msg.content];
      const ci = ae.contentIndex ?? 0;
      applyAssistantEvent(content, ae, ci);
      msgs[idx] = { ...msg, content };
      return msgs;
    });
  }

  function applyAssistantEvent(content: ChatMessage["content"], ae: AssistantEvent, ci: number) {
    const t = ae.type;
    while (content.length <= ci) content.push({ type: "text", text: "" });
    const part = content[ci];

    if (t === "thinking_start" || ae.kind === "thinking" && t === "message_update") {
      content[ci] = { type: "thinking", thinking: "" };
    } else if (t === "thinking_delta" || (ae.kind === "thinking" && ae.delta)) {
      const thinking = typeof part.thinking === "string" ? part.thinking : "";
      content[ci] = { ...part, type: "thinking", thinking: thinking + (ae.delta ?? "") };
    } else if (t === "thinking_end") {
      content[ci] = { ...part, type: "thinking", thinking: ae.content ?? part.thinking ?? "" };
    } else if (t === "text_start") {
      content[ci] = { type: "text", text: "" };
    } else if (t === "text_delta" || (ae.kind === "text" && ae.delta)) {
      const text = typeof part.text === "string" ? part.text : "";
      content[ci] = { ...part, type: "text", text: text + (ae.delta ?? "") };
    } else if (t === "text_end") {
      content[ci] = { ...part, type: "text", text: ae.content ?? part.text ?? "" };
    } else if (t === "toolcall_start") {
      content[ci] = { type: "toolCall", input: "" };
    } else if (t === "toolcall_delta" || (ae.kind === "toolCall" && ae.delta)) {
      const existing = typeof part.input === "string" ? part.input : "";
      content[ci] = { ...part, type: "toolCall", input: existing + (ae.delta ?? "") };
    } else if (t === "toolcall_end") {
      content[ci] = { ...part, type: "toolCall", toolCall: ae.toolCall, input: JSON.stringify(ae.toolCall ?? part.input ?? "") };
    } else if (ae.delta) {
      const text = typeof part.text === "string" ? part.text : "";
      content[ci] = { ...part, type: "text", text: text + ae.delta };
    }
  }

  function addToolCard(card: ToolCard) {
    setToolCards((prev) => {
      if (prev.some((c) => c.toolCallId === card.toolCallId)) return prev;
      return [...prev, card];
    });
  }

  function updateToolCard(id: string, patch: Partial<ToolCard>) {
    setToolCards((prev) => prev.map((c) => (c.toolCallId === id ? { ...c, ...patch } : c)));
  }

  async function loadMessages(bsid: string) {
    try {
      const resp = await api.getMessages(bsid);
      const data = resp as { data?: { messages?: ChatMessage[] } };
      const list = data.data?.messages ?? [];
      setMessages(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadSessionState(bsid: string) {
    try {
      const stateResp = await api.getState(bsid);
      setPiState(stateResp.state);
      setBusy(Boolean(stateResp.state.isStreaming));
      if (stateResp.state.model) {
        setSelectedModel(`${stateResp.state.model.provider}/${stateResp.state.model.id}`);
      }
      if (stateResp.state.thinkingLevel) setSelectedThinking(stateResp.state.thinkingLevel);
    } catch {
      // ignore state errors
    }
  }

  async function loadSessionData(bsid: string) {
    await Promise.all([loadMessages(bsid), loadSessionState(bsid), loadModels(bsid), loadThinkingLevels(bsid)]);
  }

  async function loadModels(bsid: string) {
    try {
      const list = await api.getAvailableModels(bsid);
      setModels(list);
    } catch {
      // ignore
    }
  }

  async function loadThinkingLevels(bsid: string) {
    try {
      const levels = await api.getAvailableThinkingLevels(bsid);
      setThinkingLevels(levels);
    } catch {
      // ignore
    }
  }

  async function handleNewSession() {
    try {
      const res = await api.createSession(newCwd);
      openSession(res.browserSessionId, res.cwd);
      setNotice(`已创建会话 ${res.browserSessionId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleImport(sessionFile: string) {
    try {
      const res = await api.importSession(sessionFile);
      openSession(res.browserSessionId, res.cwd);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleCloseActive() {
    if (!activeBsid) return;
    try {
      await api.closeSession(activeBsid);
    } catch {
      // ignore
    }
    closeSse();
    setActiveBsid(null);
    setMessages([]);
    setToolCards([]);
    setBusy(false);
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || !activeBsid) return;
    setInput("");
    const command: Record<string, unknown> = { type: "prompt", message: text };
    if (busy) command.streamingBehavior = "steer";
    try {
      await api.sendCommand(activeBsid, command);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleAbort() {
    if (!activeBsid) return;
    try {
      await api.sendCommand(activeBsid, { type: "abort" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleModelChange(providerModel: string) {
    if (!activeBsid || !providerModel) return;
    const [provider, modelId] = providerModel.split("/");
    setSelectedModel(providerModel);
    try {
      await api.sendCommand(activeBsid, { type: "set_model", provider, modelId });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleThinkingChange(level: string) {
    if (!activeBsid) return;
    setSelectedThinking(level);
    try {
      await api.sendCommand(activeBsid, { type: "set_thinking_level", level });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRename() {
    if (!activeBsid) return;
    const name = window.prompt("会话名称", piState.sessionName ?? "");
    if (name === null) return;
    try {
      await api.sendCommand(activeBsid, { type: "set_session_name", name: name.trim() });
      setPiState((s) => ({ ...s, sessionName: name.trim() }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  if (authenticated === null) {
    return <div className="page-center">加载中…</div>;
  }

  if (authenticated === false) {
    return (
      <div className="page-center">
        <form className="login-card" onSubmit={handleLogin}>
          <h1>pi-webui</h1>
          <p>请输入登录密码</p>
          <input
            type="password"
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            placeholder="密码"
            autoFocus
          />
          {loginError && <div className="error">{loginError}</div>}
          <button type="submit">登录</button>
        </form>
      </div>
    );
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-header">
          <h1>pi-webui</h1>
          <button onClick={handleLogout} className="link">
            退出
          </button>
        </div>
        <div className="new-session">
          <input
            value={newCwd}
            onChange={(e) => setNewCwd(e.target.value)}
            placeholder="cwd（留空=服务器当前目录）"
          />
          <button onClick={handleNewSession}>新建会话</button>
        </div>
        <div className="filter">
          <input
            value={cwdFilter}
            onChange={(e) => setCwdFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void refreshSessions();
            }}
            placeholder="按 cwd 过滤会话列表"
          />
          <button onClick={() => void refreshSessions()}>刷新</button>
        </div>
        <div className="session-list">
          {sessions.map((s) => (
            <div
              key={s.sessionFile}
              className={`session-item ${activeBsid && activeCwd === s.cwd ? "active" : ""}`}
              onClick={() => void handleImport(s.sessionFile)}
              title={s.sessionFile}
            >
              <div className="session-title">{s.title || s.sessionId}</div>
              <div className="session-meta">{s.cwd || "全局"}</div>
            </div>
          ))}
          {sessions.length === 0 && <div className="muted">暂无会话</div>}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            {activeBsid ? (
              <>
                <strong>{piState.sessionName ?? "会话"}</strong>
                <span className="muted">
                  {" "}
                  {activeCwd} · {activeBsid.slice(0, 8)}
                </span>
              </>
            ) : (
              <span className="muted">请新建或导入会话</span>
            )}
          </div>
          <div className="topbar-controls">
            <select value={selectedModel} onChange={(e) => void handleModelChange(e.target.value)}>
              <option value="">选择模型</option>
              {models.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.name ?? m.id} ({m.provider})
                </option>
              ))}
            </select>
            <select value={selectedThinking} onChange={(e) => void handleThinkingChange(e.target.value)}>
              <option value="">thinking</option>
              {thinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
            {activeBsid && (
              <>
                <button onClick={handleRename} title="重命名会话">
                  重命名
                </button>
                <button onClick={handleAbort} disabled={!busy}>
                  中止
                </button>
                <button onClick={handleCloseActive}>关闭</button>
              </>
            )}
          </div>
        </header>

        <div className="transcript">
          {messages.map((msg, i) => (
            <MessageView key={msg.id ?? msg.timestamp ?? i} message={msg} />
          ))}
          {toolCards.map((card) => (
            <ToolCardView key={card.toolCallId} card={card} />
          ))}
          {busy && <div className="busy">正在思考…</div>}
          <div ref={messagesEndRef} />
        </div>

        {(error || notice) && (
          <div className="banner">
            {error && <span className="error">{error}</span>}
            {notice && <span className="notice">{notice}</span>}
          </div>
        )}

        <footer className="composer">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            placeholder={busy ? "流式中：Enter 发送 steering 消息" : "输入消息（Enter 发送，Shift+Enter 换行）"}
            rows={3}
          />
          <button onClick={handleSend} disabled={!activeBsid || !input.trim()}>
            发送
          </button>
        </footer>
      </main>
    </div>
  );
}

function MessageView({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    const text = message.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .filter(Boolean)
      .join("\n");
    return <div className="msg user">{text}</div>;
  }

  if (message.role === "assistant") {
    return (
      <div className="msg assistant">
        {message.content.map((part, i) => {
          if (part.type === "thinking") {
            const thinking = part.thinking ?? "";
            if (!thinking) return null;
            return (
              <details key={i} className="thinking">
                <summary>thinking</summary>
                <div className="thinking-body">{thinking}</div>
              </details>
            );
          }
          if (part.type === "text") {
            return (
              <div key={i} className="markdown">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text ?? ""}</ReactMarkdown>
              </div>
            );
          }
          if (part.type === "toolCall") {
            const input = typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {});
            return (
              <div key={i} className="tool-call">
                <strong>tool_call</strong>
                <pre>{input}</pre>
              </div>
            );
          }
          return <pre key={i}>{JSON.stringify(part, null, 2)}</pre>;
        })}
      </div>
    );
  }

  return (
    <div className="msg system">
      <pre>{JSON.stringify(message, null, 2)}</pre>
    </div>
  );
}

function ToolCardView({ card }: { card: ToolCard }) {
  const output = card.status === "done" ? stringifyResult(card.result) : card.partialResult ?? "";
  return (
    <div className={`tool-card ${card.isError ? "error" : ""}`}>
      <div className="tool-card-header">
        <strong>{card.toolName}</strong>
        <span className="muted">{card.status === "done" ? "完成" : "执行中…"}</span>
      </div>
      {card.args != null && <pre>{JSON.stringify(card.args, null, 2)}</pre>}
      {output && <pre className="tool-output">{output}</pre>}
    </div>
  );
}

function stringifyResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export default App;

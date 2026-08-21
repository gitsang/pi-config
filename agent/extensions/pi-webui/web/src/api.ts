import type { PiModel, PiState, SessionSummary } from "./types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    credentials: "same-origin",
    headers: options?.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  if (resp.status === 401) {
    throw new UnauthorizedError();
  }
  if (!resp.ok) {
    let message = resp.statusText;
    try {
      const data = await resp.json();
      if (data?.error) message = data.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await resp.json()) as T;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

export const api = {
  login(password: string) {
    return request<{ authenticated: boolean }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },
  logout() {
    return request<{ authenticated: boolean }>("/api/logout", { method: "POST" });
  },
  me() {
    return request<{ authenticated: boolean }>("/api/me");
  },
  listSessions(cwd: string, limit = 50) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cwd) params.set("cwd", cwd);
    return request<SessionSummary[]>(`/api/sessions?${params}`);
  },
  createSession(cwd: string) {
    return request<{ browserSessionId: string; state: string; cwd: string }>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd }),
    });
  },
  importSession(sessionFile: string) {
    return request<{ browserSessionId: string; state: string; cwd: string }>("/api/sessions/import", {
      method: "POST",
      body: JSON.stringify({ sessionFile }),
    });
  },
  closeSession(bsid: string) {
    return request<{ closed: boolean }>(`/api/sessions/${bsid}/close`, { method: "POST" });
  },
  getMessages(bsid: string) {
    return request<{ type?: string; success?: boolean; data?: { messages: unknown[] } }>(
      `/api/sessions/${bsid}/messages`,
    );
  },
  getState(bsid: string) {
    return request<{ state: PiState; stats: unknown }>(`/api/sessions/${bsid}/state`);
  },
  async sendCommand(bsid: string, command: Record<string, unknown>) {
    const resp = await fetch(`/api/sessions/${bsid}/command`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    if (resp.status === 401) throw new UnauthorizedError();
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error((data as { error?: string }).error ?? resp.statusText);
    }
    return data;
  },
  async getAvailableModels(bsid: string): Promise<PiModel[]> {
    const resp = await api.sendCommand(bsid, { type: "get_available_models" });
    return (resp as { data?: { models?: PiModel[] } }).data?.models ?? [];
  },
  async getAvailableThinkingLevels(bsid: string): Promise<string[]> {
    const resp = await api.sendCommand(bsid, { type: "get_available_thinking_levels" });
    return (resp as { data?: { levels?: string[] } }).data?.levels ?? [];
  },
};

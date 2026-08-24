export interface SessionSummary {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  title: string;
  timestamp: string;
}

export interface PiModel {
  id: string;
  name?: string;
  provider: string;
  [key: string]: unknown;
}

export interface PiState {
  model?: PiModel;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  messageCount?: number;
  pendingMessageCount?: number;
  [key: string]: unknown;
}

export interface ChatContentPart {
  type: string;
  text?: string;
  thinking?: string;
  input?: unknown;
  toolCall?: unknown;
  [key: string]: unknown;
}

export interface ChatMessage {
  id?: string;
  role: string;
  content: ChatContentPart[];
  timestamp?: number;
  model?: string;
  provider?: string;
  [key: string]: unknown;
}

export interface ToolCard {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  partialResult?: string;
  result?: unknown;
  isError?: boolean;
  status: "running" | "done";
  startedAt: number;
}

export interface SessionInfo {
  browserSessionId: string;
  cwd: string;
  state?: string;
}

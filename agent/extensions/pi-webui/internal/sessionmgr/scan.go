package sessionmgr

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// SessionSummary is the API representation of a recent pi session.
type SessionSummary struct {
	SessionFile string `json:"sessionFile"`
	SessionID   string `json:"sessionId"`
	Cwd         string `json:"cwd"`
	Title       string `json:"title"`
	Timestamp   string `json:"timestamp"`
}

// sessionDirName maps a cwd to pi's on-disk session directory name:
// /home/sang -> --home-sang--, / -> ----.
func sessionDirName(cwd string) string {
	c := filepath.ToSlash(filepath.Clean(cwd))
	c = strings.TrimPrefix(c, "/")
	c = strings.TrimSuffix(c, "/")
	if c == "" {
		return "----"
	}
	return "--" + strings.ReplaceAll(c, "/", "-") + "--"
}

// ListSessions scans the session directory for recent sessions, optionally
// filtered by cwd. Results are sorted by header timestamp descending.
func (m *Manager) ListSessions(cwd string, limit int) ([]SessionSummary, error) {
	if limit <= 0 {
		limit = 50
	}
	dir := m.SessionDir()
	var files []string

	if cwd == "" {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if os.IsNotExist(err) {
				return []SessionSummary{}, nil
			}
			return nil, err
		}
		for _, e := range entries {
			if !e.IsDir() || !strings.HasPrefix(e.Name(), "--") || !strings.HasSuffix(e.Name(), "--") {
				continue
			}
			glob := filepath.Join(dir, e.Name(), "*.jsonl")
			matches, _ := filepath.Glob(glob)
			files = append(files, matches...)
		}
	} else {
		glob := filepath.Join(dir, sessionDirName(cwd), "*.jsonl")
		matches, _ := filepath.Glob(glob)
		files = append(files, matches...)
	}

	summaries := make([]SessionSummary, 0, len(files))
	for _, file := range files {
		sum := summarizeFile(file)
		if sum != nil {
			summaries = append(summaries, *sum)
		}
	}
	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].Timestamp > summaries[j].Timestamp
	})
	if len(summaries) > limit {
		summaries = summaries[:limit]
	}
	return summaries, nil
}

// summarizeFile extracts title metadata from one session file. It reads the
// header from the beginning and scans the tail for the latest session_info.
func summarizeFile(path string) *SessionSummary {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()

	reader := bufio.NewReaderSize(f, 1024*1024)

	// Header must be the first line.
	firstLine, err := reader.ReadBytes('\n')
	if err != nil && len(firstLine) == 0 {
		return nil
	}
	firstLine = trimLineEnding(firstLine)
	var header SessionHeader
	if err := json.Unmarshal(firstLine, &header); err != nil || header.Type != "session" {
		return nil
	}
	if header.Timestamp == "" {
		// Fall back to the filename timestamp prefix.
		base := filepath.Base(path)
		if idx := strings.Index(base, "_"); idx > 0 {
			header.Timestamp = base[:idx]
		}
	}

	title := ""
	var firstUserText string

	// Scan the beginning of the file for the first user message.
	scanned := 0
	for scanned < 200 {
		line, err := reader.ReadBytes('\n')
		if len(line) == 0 {
			break
		}
		scanned++
		if firstUserText == "" {
			if text := extractUserText(line); text != "" {
				firstUserText = text
			}
		}
		if err != nil {
			break
		}
	}

	// Scan the last 256 KiB for the latest session_info entry.
	const tailSize = 256 * 1024
	info, err := f.Stat()
	if err == nil && info.Size() > tailSize {
		if _, err := f.Seek(info.Size()-tailSize, 0); err == nil {
			tailReader := bufio.NewReaderSize(f, 1024*1024)
			for {
				line, err := tailReader.ReadBytes('\n')
				if len(line) > 0 {
					if name := extractSessionInfoName(line); name != "" {
						title = name
					}
				}
				if err != nil {
					break
				}
			}
		}
	} else {
		// Small file: continue reading the same file from the start.
		// Reopen to keep the logic simple.
		if f2, err := os.Open(path); err == nil {
			defer f2.Close()
			rd := bufio.NewReaderSize(f2, 1024*1024)
			for {
				line, err := rd.ReadBytes('\n')
				if len(line) > 0 {
					if name := extractSessionInfoName(line); name != "" {
						title = name
					}
				}
				if err != nil {
					break
				}
			}
		}
	}

	if title == "" {
		title = truncateText(firstUserText, 40)
	}
	if title == "" {
		title = header.Timestamp
	}

	return &SessionSummary{
		SessionFile: path,
		SessionID:   header.ID,
		Cwd:         header.Cwd,
		Title:       title,
		Timestamp:   header.Timestamp,
	}
}

func trimLineEnding(b []byte) []byte {
	return []byte(strings.TrimRight(string(b), "\r\n"))
}

func extractUserText(line []byte) string {
	var entry struct {
		Type    string `json:"type"`
		Message struct {
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(trimLineEnding(line), &entry); err != nil {
		return ""
	}
	if entry.Type != "message" || entry.Message.Role != "user" {
		return ""
	}
	var sb strings.Builder
	for _, c := range entry.Message.Content {
		if c.Type == "text" {
			sb.WriteString(c.Text)
		}
	}
	return strings.TrimSpace(sb.String())
}

func extractSessionInfoName(line []byte) string {
	var entry struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(trimLineEnding(line), &entry); err != nil {
		return ""
	}
	if entry.Type != "session_info" || strings.TrimSpace(entry.Name) == "" {
		return ""
	}
	return strings.TrimSpace(entry.Name)
}

func truncateText(s string, max int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// ParseTimestamp is a helper for callers that need a comparable time.
func ParseTimestamp(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

// Package api implements the pi-webui HTTP API and static file serving.
package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"pi-webui/internal/auth"
	"pi-webui/internal/config"
	"pi-webui/internal/logging"
	"pi-webui/internal/sessionmgr"
)

// Server is the pi-webui HTTP server.
type Server struct {
	cfg     *config.Config
	logger  *logging.Logger
	mgr     *sessionmgr.Manager
	cookies *auth.CookieManager
	mux     *http.ServeMux
}

// New creates the HTTP handler.
func New(cfg *config.Config, logger *logging.Logger, mgr *sessionmgr.Manager) *Server {
	s := &Server{
		cfg:    cfg,
		logger: logger,
		mgr:    mgr,
		cookies: auth.NewCookieManager(cfg.Auth.PasswordHash, auth.CookieConfig{
			Name:          "pi_webui_session",
			HttpOnly:      cfg.Auth.Cookie.HTTPOnly,
			SameSite:      cfg.Auth.Cookie.SameSite,
			Secure:        cfg.Auth.Cookie.Secure,
			MaxAgeSeconds: cfg.Auth.Cookie.MaxAgeSeconds,
			Sliding:       cfg.Auth.Cookie.Sliding,
		}),
		mux: http.NewServeMux(),
	}
	s.routes()
	return s
}

// Handler returns the root HTTP handler.
func (s *Server) Handler() http.Handler {
	return s.mux
}

func (s *Server) routes() {
	// Public auth endpoints.
	s.mux.HandleFunc("/api/login", s.handleLogin)
	// Protected API.
	s.mux.Handle("/api/logout", s.cookies.AuthMiddleware(http.HandlerFunc(s.handleLogout)))
	s.mux.Handle("/api/me", s.cookies.AuthMiddleware(http.HandlerFunc(s.handleMe)))
	s.mux.Handle("/api/sessions", s.cookies.AuthMiddleware(http.HandlerFunc(s.handleSessions)))
	s.mux.Handle("/api/sessions/", s.cookies.AuthMiddleware(http.HandlerFunc(s.handleSessionAction)))
	// Static files.
	s.mux.HandleFunc("/", s.handleStatic)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 4*1024*1024))
	return dec.Decode(v)
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	var body struct {
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
		return
	}
	if !auth.VerifyPassword(body.Password, s.cfg.Auth.PasswordHash) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid password"})
		return
	}
	s.cookies.SetAuthCookie(w, r)
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.cookies.ClearAuthCookie(w)
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true})
}

func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		q := r.URL.Query()
		cwd := q.Get("cwd")
		limit, _ := strconv.Atoi(q.Get("limit"))
		if limit <= 0 {
			limit = 50
		}
		sessions, err := s.mgr.ListSessions(cwd, limit)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, sessions)
	case http.MethodPost:
		var body struct {
			Cwd string `json:"cwd"`
		}
		if err := readJSON(r, &body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json"})
			return
		}
		bs, err := s.mgr.NewSession(context.Background(), body.Cwd)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"browserSessionId": bs.ID,
			"state":            "starting",
			"cwd":              bs.Cwd,
		})
	default:
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
	}
}

// handleSessionAction routes /api/sessions/<bsid>/<action>.
func (s *Server) handleSessionAction(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/api/sessions/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	bsid := parts[0]
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}

	// /api/sessions/import is handled before the bsid parser by checking path.
	if bsid == "import" {
		s.handleImportSession(w, r)
		return
	}

	bs, err := s.mgr.Get(bsid)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}

	switch {
	case action == "events" && r.Method == http.MethodGet:
		s.handleEvents(w, r, bs)
	case action == "command" && r.Method == http.MethodPost:
		s.handleCommand(w, r, bs)
	case action == "messages" && r.Method == http.MethodGet:
		s.forwardCommand(w, r, bs, map[string]any{"type": "get_messages"})
	case action == "state" && r.Method == http.MethodGet:
		s.handleState(w, r, bs)
	case action == "close" && r.Method == http.MethodPost:
		if err := s.mgr.Close(bsid); err != nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"closed": true})
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
	}
}

func (s *Server) handleImportSession(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	var body struct {
		SessionFile string `json:"sessionFile"`
	}
	if err := readJSON(r, &body); err != nil || body.SessionFile == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "sessionFile is required"})
		return
	}
	bs, err := s.mgr.ImportSession(context.Background(), body.SessionFile)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"browserSessionId": bs.ID,
		"state":            "starting",
		"cwd":              bs.Cwd,
	})
}

func (s *Server) forwardCommand(w http.ResponseWriter, r *http.Request, bs *sessionmgr.BrowserSession, command map[string]any) {
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	resp, err := bs.Client.SendCommand(ctx, command)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if len(resp.Raw) > 0 {
		_, _ = w.Write(resp.Raw)
	} else {
		_ = json.NewEncoder(w).Encode(resp)
	}
}

func (s *Server) handleCommand(w http.ResponseWriter, r *http.Request, bs *sessionmgr.BrowserSession) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4*1024*1024))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "read body"})
		return
	}
	var command map[string]any
	if err := json.Unmarshal(raw, &command); err != nil || len(command) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json command"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	resp, err := bs.Client.SendCommand(ctx, command)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if len(resp.Raw) > 0 {
		_, _ = w.Write(resp.Raw)
	} else {
		_ = json.NewEncoder(w).Encode(resp)
	}
}

func (s *Server) handleState(w http.ResponseWriter, r *http.Request, bs *sessionmgr.BrowserSession) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	stateResp, err := bs.Client.SendCommand(ctx, map[string]any{"type": "get_state"})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	ctx2, cancel2 := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel2()
	statsResp, err := bs.Client.SendCommand(ctx2, map[string]any{"type": "get_session_stats"})
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"state": json.RawMessage(stateResp.Data),
		"stats": json.RawMessage(statsResp.Data),
	})
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request, bs *sessionmgr.BrowserSession) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	events, unsub := bs.Client.Subscribe()
	defer unsub()

	// Send hello with current pi state.
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	stateData := json.RawMessage("null")
	if resp, err := bs.Client.SendCommand(ctx, map[string]any{"type": "get_state"}); err == nil && resp.Success {
		stateData = resp.Data
	}
	cancel()
	hello, _ := json.Marshal(map[string]any{
		"browserSessionId": bs.ID,
		"piState":          json.RawMessage(stateData),
	})
	fmt.Fprintf(w, "event: hello\ndata: %s\n\n", hello)
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case ev := <-events:
			data := ev.Data
			if len(data) == 0 {
				data = json.RawMessage("null")
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", sanitizeEventName(ev.Type), data)
			flusher.Flush()
		case <-bs.Client.Exited():
			fmt.Fprint(w, "event: process_exit\ndata: {}\n\n")
			flusher.Flush()
			return
		}
	}
}

func sanitizeEventName(s string) string {
	if s == "" {
		return "message"
	}
	var sb strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' {
			sb.WriteRune(r)
		} else {
			sb.WriteByte('_')
		}
	}
	return sb.String()
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	distDir := s.cfg.DistDir
	clean := filepath.Clean(r.URL.Path)
	if clean == "." {
		clean = "/"
	}
	requested := filepath.Join(distDir, filepath.FromSlash(clean))
	// Prevent path traversal.
	if !strings.HasPrefix(requested, filepath.Clean(distDir)+string(os.PathSeparator)) && requested != filepath.Clean(distDir) {
		http.NotFound(w, r)
		return
	}
	if info, err := os.Stat(requested); err == nil && !info.IsDir() {
		http.ServeFile(w, r, requested)
		return
	}
	index := filepath.Join(distDir, "index.html")
	if info, err := os.Stat(index); err == nil && !info.IsDir() {
		http.ServeFile(w, r, index)
		return
	}
	http.Error(w, "pi-webui frontend not found; run `make build` or install the dist/ directory", http.StatusNotFound)
}

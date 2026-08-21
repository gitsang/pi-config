// Package sessionmgr maps browser sessions to pi subprocesses and scans pi
// session files.
package sessionmgr

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"pi-webui/internal/config"
	"pi-webui/internal/logging"
	"pi-webui/internal/rpc"
)

// BrowserSession is a 1:1 browser-session to pi-process mapping.
type BrowserSession struct {
	ID          string
	Cwd         string
	PiSessionID string
	SessionFile string
	Client      *rpc.Client
	CreatedAt   time.Time
}

// Manager owns all live browser sessions.
type Manager struct {
	cfg    *config.Config
	logger *logging.Logger
	mu     sync.Mutex
	active map[string]*BrowserSession
}

// New creates a Manager.
func New(cfg *config.Config, logger *logging.Logger) *Manager {
	return &Manager{
		cfg:    cfg,
		logger: logger,
		active: make(map[string]*BrowserSession),
	}
}

// SessionDir returns the effective session directory.
func (m *Manager) SessionDir() string {
	return m.cfg.SessionDir
}

// NewSession spawns a fresh pi process for a new pi session.
func (m *Manager) NewSession(ctx context.Context, cwd string) (*BrowserSession, error) {
	if cwd == "" {
		wd, err := os.Getwd()
		if err != nil {
			wd = "."
		}
		cwd = wd
	}
	absCwd, err := filepath.Abs(cwd)
	if err != nil {
		absCwd = cwd
	}
	bsid, err := newUUID()
	if err != nil {
		return nil, err
	}
	bs := &BrowserSession{ID: bsid, Cwd: absCwd, CreatedAt: time.Now()}
	if err := m.spawn(ctx, bs, ""); err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.active[bsid] = bs
	m.mu.Unlock()
	m.logger.Infof("session %s: spawned pi (new, cwd=%s)", bsid, absCwd)
	return bs, nil
}

// ImportSession spawns pi with --session <piSessionId> restored from a
// session file. The session file remains the source of truth on disk.
func (m *Manager) ImportSession(ctx context.Context, sessionFile string) (*BrowserSession, error) {
	header, err := ParseSessionHeader(sessionFile)
	if err != nil {
		return nil, err
	}
	if header.ID == "" {
		return nil, errors.New("session file has no session id")
	}
	absSession, err := filepath.Abs(sessionFile)
	if err != nil {
		absSession = sessionFile
	}
	sessionFile = absSession
	cwd := header.Cwd
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	absCwd, err := filepath.Abs(cwd)
	if err != nil {
		absCwd = cwd
	}
	bsid, err := newUUID()
	if err != nil {
		return nil, err
	}
	bs := &BrowserSession{
		ID:          bsid,
		Cwd:         absCwd,
		PiSessionID: header.ID,
		SessionFile: sessionFile,
		CreatedAt:   time.Now(),
	}
	// pi reliably restores an absolute session-file path. A bare session id
	// does not resolve in all session-dir layouts, so prefer the file path.
	if err := m.spawn(ctx, bs, sessionFile); err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.active[bsid] = bs
	m.mu.Unlock()
	m.logger.Infof("session %s: spawned pi (import %s, cwd=%s)", bsid, header.ID, absCwd)
	return bs, nil
}

func (m *Manager) spawn(ctx context.Context, bs *BrowserSession, piSessionID string) error {
	logPath := filepath.Join(m.cfg.LogsDir, "sessions", bs.ID+".log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return fmt.Errorf("sessionmgr: create session log dir: %w", err)
	}
	stderr, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("sessionmgr: open session log: %w", err)
	}
	client, err := rpc.Spawn(ctx, rpc.Options{
		PiPath:      m.cfg.PiPath,
		SessionDir:  m.cfg.SessionDir,
		PiSessionID: piSessionID,
		Cwd:         bs.Cwd,
		Stderr:      stderr,
	})
	if err != nil {
		stderr.Close()
		return fmt.Errorf("sessionmgr: spawn pi: %w", err)
	}
	bs.Client = client
	go m.watch(bs)
	return nil
}

func (m *Manager) watch(bs *BrowserSession) {
	select {
	case err := <-bs.Client.Exited():
		m.logger.Warnf("session %s: pi exited: %v", bs.ID, err)
	}
}

// Get returns a live browser session.
func (m *Manager) Get(bsid string) (*BrowserSession, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	bs := m.active[bsid]
	if bs == nil {
		return nil, fmt.Errorf("browser session %s not found", bsid)
	}
	return bs, nil
}

// Close aborts and kills the pi process and removes the mapping.
func (m *Manager) Close(bsid string) error {
	m.mu.Lock()
	bs := m.active[bsid]
	delete(m.active, bsid)
	m.mu.Unlock()
	if bs == nil {
		return fmt.Errorf("browser session %s not found", bsid)
	}
	if bs.Client != nil {
		bs.Client.Close()
	}
	m.logger.Infof("session %s: closed", bsid)
	return nil
}

// CloseAll closes every live session. Used on server shutdown.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	sessions := make([]*BrowserSession, 0, len(m.active))
	for _, bs := range m.active {
		sessions = append(sessions, bs)
	}
	m.active = make(map[string]*BrowserSession)
	m.mu.Unlock()
	for _, bs := range sessions {
		if bs.Client != nil {
			bs.Client.Close()
		}
	}
}

// ActiveCount returns the number of live browser sessions.
func (m *Manager) ActiveCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.active)
}

// ParseSessionHeader reads the first line of a pi session JSONL file.
type SessionHeader struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Cwd       string `json:"cwd"`
}

// ParseSessionHeader reads and parses a session file header.
func ParseSessionHeader(path string) (*SessionHeader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("sessionmgr: open session file: %w", err)
	}
	defer f.Close()
	dec := json.NewDecoder(f)
	var header SessionHeader
	if err := dec.Decode(&header); err != nil {
		return nil, fmt.Errorf("sessionmgr: parse session header: %w", err)
	}
	if header.Type != "session" {
		return nil, fmt.Errorf("sessionmgr: %s is not a pi session file", path)
	}
	return &header, nil
}

func newUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

var _ io.Writer = io.Discard

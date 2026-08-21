// Package rpc implements the pi --mode rpc JSONL subprocess client.
package rpc

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

const maxLineSize = 64 * 1024 * 1024 // tool output can be many MB

// Event is a non-response JSONL object emitted by pi on stdout.
type Event struct {
	Type string
	Data json.RawMessage
}

// Response is the parsed pi response for a command.
type Response struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Command string          `json:"command"`
	Success bool            `json:"success"`
	Data    json.RawMessage `json:"data"`
	Error   string          `json:"error"`
	Raw     json.RawMessage `json:"-"`
}

// Client owns a single pi --mode rpc subprocess.
type Client struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	piPath    string
	Args      []string
	Cwd       string
	Stderr    io.Writer
	exited    chan error
	closeOnce sync.Once
	stdinOnce sync.Once

	writeMu sync.Mutex

	pendingMu sync.Mutex
	pending   map[string]chan *Response

	subMu  sync.Mutex
	subs   map[int]chan Event
	nextID int
}

// Options configures a spawned pi RPC client.
type Options struct {
	PiPath      string // empty means exec.LookPath("pi")
	SessionDir  string
	PiSessionID string // empty means a new session
	Cwd         string // empty inherits parent cwd
	Stderr      io.Writer
}

// Spawn starts pi --mode rpc and returns a client.
func Spawn(ctx context.Context, opts Options) (*Client, error) {
	piPath := opts.PiPath
	if piPath == "" {
		var err error
		piPath, err = exec.LookPath("pi")
		if err != nil {
			return nil, fmt.Errorf("rpc: pi executable not found: %w", err)
		}
	}
	if opts.SessionDir == "" {
		return nil, errors.New("rpc: session dir is required")
	}
	args := []string{"--mode", "rpc", "--session-dir", opts.SessionDir}
	if opts.PiSessionID != "" {
		args = append(args, "--session", opts.PiSessionID)
	}
	cmd := exec.CommandContext(ctx, piPath, args...)
	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("rpc: stdout pipe: %w", err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("rpc: stdin pipe: %w", err)
	}
	if opts.Stderr != nil {
		cmd.Stderr = opts.Stderr
	} else {
		cmd.Stderr = io.Discard
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("rpc: start pi: %w", err)
	}

	c := &Client{
		cmd:     cmd,
		stdin:   stdin,
		piPath:  piPath,
		Args:    args,
		Cwd:     opts.Cwd,
		Stderr:  opts.Stderr,
		exited:  make(chan error, 1),
		pending: make(map[string]chan *Response),
		subs:    make(map[int]chan Event),
	}
	go c.readLoop(stdout)
	go func() {
		err := cmd.Wait()
		c.stdinOnce.Do(func() {
			if stdin != nil {
				stdin.Close()
			}
		})
		c.exited <- err
		close(c.exited)
		c.failAllPending(err)
	}()
	return c, nil
}

// readLoop consumes pi stdout. stdout is protocol and must never be logged.
func (c *Client) readLoop(stdout io.Reader) {
	reader := bufio.NewReaderSize(stdout, maxLineSize)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			line = bytes.TrimSuffix(line, []byte("\n"))
			line = bytes.TrimSuffix(line, []byte("\r"))
			if len(line) > 0 {
				c.processLine(line)
			}
		}
		if err != nil {
			return
		}
	}
}

func (c *Client) processLine(raw []byte) {
	var wire struct {
		Type    string          `json:"type"`
		ID      string          `json:"id"`
		Command string          `json:"command"`
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
		Error   string          `json:"error"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		// A malformed line is still an event for the frontend to surface.
		c.broadcast(Event{Type: "error", Data: raw})
		return
	}
	if wire.Type == "response" {
		resp := &Response{
			ID:      wire.ID,
			Type:    wire.Type,
			Command: wire.Command,
			Success: wire.Success,
			Data:    wire.Data,
			Error:   wire.Error,
			Raw:     append(json.RawMessage(nil), raw...),
		}
		c.pendingMu.Lock()
		ch := c.pending[wire.ID]
		if ch != nil {
			delete(c.pending, wire.ID)
		}
		c.pendingMu.Unlock()
		if ch != nil {
			select {
			case ch <- resp:
			default:
			}
		}
		return
	}
	c.broadcast(Event{Type: wire.Type, Data: append(json.RawMessage(nil), raw...)})
}

// SendCommand serializes a command write to pi stdin and waits for the
// correlated response. The command is mutated: an id is added when missing.
func (c *Client) SendCommand(ctx context.Context, command map[string]any) (*Response, error) {
	select {
	case <-c.exited:
		return nil, errors.New("rpc: pi process has exited")
	default:
	}

	id, _ := command["id"].(string)
	if id == "" {
		id = newUUID()
		command["id"] = id
	}
	raw, err := json.Marshal(command)
	if err != nil {
		return nil, fmt.Errorf("rpc: marshal command: %w", err)
	}

	ch := make(chan *Response, 1)
	c.pendingMu.Lock()
	c.pending[id] = ch
	c.pendingMu.Unlock()

	c.writeMu.Lock()
	_, err = c.stdin.Write(append(raw, '\n'))
	c.writeMu.Unlock()
	if err != nil {
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, fmt.Errorf("rpc: write command: %w", err)
	}

	select {
	case resp := <-ch:
		return resp, nil
	case <-ctx.Done():
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, ctx.Err()
	case <-c.exited:
		return nil, errors.New("rpc: pi process exited before responding")
	case <-time.After(120 * time.Second):
		c.pendingMu.Lock()
		delete(c.pending, id)
		c.pendingMu.Unlock()
		return nil, errors.New("rpc: timed out waiting for pi response")
	}
}

// Subscribe returns a buffered channel that receives non-response events.
func (c *Client) Subscribe() (chan Event, func()) {
	ch := make(chan Event, 4096)
	c.subMu.Lock()
	id := c.nextID
	c.nextID++
	c.subs[id] = ch
	c.subMu.Unlock()
	unsub := func() {
		c.subMu.Lock()
		delete(c.subs, id)
		c.subMu.Unlock()
	}
	return ch, unsub
}

func (c *Client) broadcast(ev Event) {
	c.subMu.Lock()
	subs := make([]chan Event, 0, len(c.subs))
	for _, ch := range c.subs {
		subs = append(subs, ch)
	}
	c.subMu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- ev:
		default:
			// Drop for slow/disconnected SSE consumers. The frontend
			// rebuilds history on reconnect via get_messages.
		}
	}
}

// Exited returns a channel that receives the pi exit error exactly once.
func (c *Client) Exited() <-chan error {
	return c.exited
}

func (c *Client) failAllPending(err error) {
	c.pendingMu.Lock()
	pending := c.pending
	c.pending = make(map[string]chan *Response)
	c.pendingMu.Unlock()
	for _, ch := range pending {
		close(ch)
	}
}

// Close sends abort (best effort), closes stdin, and kills the process if it
// is still running after a short grace period.
func (c *Client) Close() {
	c.closeOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _ = c.SendCommand(ctx, map[string]any{"type": "abort"})
		c.stdinOnce.Do(func() {
			if c.stdin != nil {
				c.stdin.Close()
			}
		})
		select {
		case <-c.exited:
		case <-time.After(3 * time.Second):
			if c.cmd.Process != nil {
				_ = c.cmd.Process.Kill()
			}
		}
	})
}

// newUUID returns a random UUID v4 string.
func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

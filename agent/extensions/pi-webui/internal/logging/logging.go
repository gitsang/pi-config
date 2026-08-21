// Package logging implements the small rotating file logger used by pi-webui.
package logging

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Level is a log severity.
type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

// ParseLevel converts a string to a Level (default info).
func ParseLevel(s string) Level {
	switch strings.ToLower(s) {
	case "debug":
		return LevelDebug
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

// Logger is a small leveled logger with size-based rotation.
type Logger struct {
	mu         sync.Mutex
	path       string
	level      Level
	maxSize    int64
	maxFiles   int
	file       *os.File
	size       int64
	alsoStderr bool
	std        *log.Logger
}

// New creates a logger. If path is empty, logs only go to stderr.
func New(path string, level Level, alsoStderr bool) (*Logger, error) {
	l := &Logger{
		path:       path,
		level:      level,
		maxSize:    10 * 1024 * 1024,
		maxFiles:   3,
		alsoStderr: alsoStderr,
	}
	if path != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
		if err := l.open(); err != nil {
			return nil, err
		}
	}
	writers := []io.Writer{}
	if l.file != nil {
		writers = append(writers, l.file)
	}
	if alsoStderr {
		writers = append(writers, os.Stderr)
	}
	l.std = log.New(io.MultiWriter(writers...), "", log.LstdFlags)
	return l, nil
}

func (l *Logger) open() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	l.file = f
	l.size = info.Size()
	return nil
}

// rotate closes the current file, shifts .1/.2, and reopens.
func (l *Logger) rotate() error {
	if l.file != nil {
		l.file.Close()
		l.file = nil
	}
	for i := l.maxFiles - 1; i >= 1; i-- {
		old := fmt.Sprintf("%s.%d", l.path, i-1)
		new := fmt.Sprintf("%s.%d", l.path, i)
		os.Rename(old, new)
	}
	if err := os.Rename(l.path, l.path+".1"); err != nil && !os.IsNotExist(err) {
		// If rename failed, still try to reopen the original.
		_ = err
	}
	return l.open()
}

// write handles rotation and writes to file plus optional stderr.
func (l *Logger) write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		if l.size+int64(len(p)) > l.maxSize {
			if err := l.rotate(); err != nil {
				return 0, err
			}
		}
		n, err := l.file.Write(p)
		l.size += int64(n)
		if err != nil {
			return n, err
		}
		if l.alsoStderr {
			os.Stderr.Write(p)
		}
		return len(p), nil
	}
	if l.alsoStderr {
		return os.Stderr.Write(p)
	}
	return len(p), nil
}

func (l *Logger) logf(level Level, format string, args ...any) {
	if level < l.level {
		return
	}
	prefix := map[Level]string{
		LevelDebug: "DEBUG ",
		LevelInfo:  "INFO  ",
		LevelWarn:  "WARN  ",
		LevelError: "ERROR ",
	}[level]
	l.write([]byte(fmt.Sprintf("%s%s\n", prefix, fmt.Sprintf(format, args...))))
}

// Debugf logs at debug level.
func (l *Logger) Debugf(format string, args ...any) { l.logf(LevelDebug, format, args...) }

// Infof logs at info level.
func (l *Logger) Infof(format string, args ...any) { l.logf(LevelInfo, format, args...) }

// Warnf logs at warn level.
func (l *Logger) Warnf(format string, args ...any) { l.logf(LevelWarn, format, args...) }

// Errorf logs at error level.
func (l *Logger) Errorf(format string, args ...any) { l.logf(LevelError, format, args...) }

// Close closes the underlying file.
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		err := l.file.Close()
		l.file = nil
		return err
	}
	return nil
}

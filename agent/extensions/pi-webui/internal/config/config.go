// Package config loads and generates the pi-webui YAML configuration.
package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"pi-webui/internal/auth"
)

// Config is the pi-webui runtime configuration.
type Config struct {
	Listen     string     `yaml:"listen" json:"listen"`
	SessionDir string     `yaml:"sessionDir" json:"sessionDir"`
	DistDir    string     `yaml:"distDir" json:"distDir"`
	PiPath     string     `yaml:"piPath" json:"piPath"`
	LogsDir    string     `yaml:"logsDir" json:"logsDir"`
	LogLevel   string     `yaml:"logLevel" json:"logLevel"`
	Auth       AuthConfig `yaml:"auth" json:"auth"`
}

// AuthConfig holds the password hash and cookie settings.
type AuthConfig struct {
	PasswordHash string       `yaml:"passwordHash" json:"-"`
	Cookie       CookieConfig `yaml:"cookie" json:"cookie"`
}

// CookieConfig mirrors auth.CookieConfig in YAML-friendly form.
type CookieConfig struct {
	HTTPOnly      bool   `yaml:"httpOnly" json:"httpOnly"`
	SameSite      string `yaml:"sameSite" json:"sameSite"`
	Secure        string `yaml:"secure" json:"secure"`
	MaxAgeSeconds int    `yaml:"maxAgeSeconds" json:"maxAgeSeconds"`
	Sliding       bool   `yaml:"sliding" json:"sliding"`
}

// Default returns the default configuration (without a password hash).
func Default() *Config {
	return &Config{
		Listen:   "0.0.0.0:8080",
		LogLevel: "info",
		Auth: AuthConfig{
			Cookie: CookieConfig{
				HTTPOnly:      true,
				SameSite:      "lax",
				Secure:        "auto",
				MaxAgeSeconds: 86400,
				Sliding:       true,
			},
		},
	}
}

// AgentDir returns the pi agent directory, respecting PI_CODING_AGENT_DIR.
func AgentDir() string {
	if d := os.Getenv("PI_CODING_AGENT_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return filepath.Join(home, ".pi", "agent")
}

// InstallDir returns the pi-webui installation directory. It is the binary
// directory unless PI_WEBUI_INSTALL_DIR is set (useful for development).
func InstallDir() string {
	if d := os.Getenv("PI_WEBUI_INSTALL_DIR"); d != "" {
		return d
	}
	exe, err := os.Executable()
	if err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		return filepath.Dir(exe)
	}
	wd, _ := os.Getwd()
	return wd
}

// DefaultPath returns the config file path.
func DefaultPath() string {
	if d := os.Getenv("PI_WEBUI_CONFIG"); d != "" {
		return d
	}
	return filepath.Join(AgentDir(), "extensions", "pi-webui", "config.yaml")
}

// DefaultSessionDir returns the effective pi session directory.
func DefaultSessionDir() string {
	if d := os.Getenv("PI_CODING_AGENT_SESSION_DIR"); d != "" {
		return d
	}
	return filepath.Join(AgentDir(), "sessions")
}

// FillDefaults applies defaults to empty fields and resolves install-relative
// directories. It is safe to call on a default config that was not loaded.
func (c *Config) FillDefaults() {
	c.fillDefaults()
}

func (c *Config) fillDefaults() {
	installDir := InstallDir()
	if c.Listen == "" {
		c.Listen = "0.0.0.0:8080"
	}
	if c.SessionDir == "" {
		c.SessionDir = DefaultSessionDir()
	}
	if c.DistDir == "" {
		c.DistDir = filepath.Join(installDir, "dist")
	}
	if c.PiPath == "" {
		c.PiPath = "" // resolved lazily with exec.LookPath
	}
	if c.LogsDir == "" {
		c.LogsDir = filepath.Join(installDir, "logs")
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}
	if c.Auth.Cookie.SameSite == "" {
		c.Auth.Cookie.SameSite = "lax"
	}
	if c.Auth.Cookie.Secure == "" {
		c.Auth.Cookie.Secure = "auto"
	}
	if c.Auth.Cookie.MaxAgeSeconds == 0 {
		c.Auth.Cookie.MaxAgeSeconds = 86400
	}
}

// Sanitized returns a copy safe for display (password hash redacted).
func (c *Config) Sanitized() *Config {
	cp := *c
	cp.Auth = c.Auth
	cp.Auth.PasswordHash = "<redacted>"
	return &cp
}

// Load reads the config from path. If the file does not exist, it generates a
// default config with a random password and returns the generated password so
// callers can print it exactly once.
func Load(path string) (*Config, string, error) {
	if path == "" {
		path = DefaultPath()
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return createDefault(path)
	}
	if err != nil {
		return nil, "", fmt.Errorf("config: read %s: %w", path, err)
	}
	cfg := Default()
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, "", fmt.Errorf("config: parse %s: %w", path, err)
	}
	cfg.fillDefaults()
	if cfg.Auth.PasswordHash == "" {
		// First run after manual file creation but before password set.
		generated := auth.RandomPassword(16)
		hash, err := auth.HashPassword(generated)
		if err != nil {
			return nil, "", err
		}
		cfg.Auth.PasswordHash = hash
		if err := Save(path, cfg); err != nil {
			return nil, "", err
		}
		return cfg, generated, nil
	}
	return cfg, "", nil
}

// createDefault writes a fresh config with a random password.
func createDefault(path string) (*Config, string, error) {
	cfg := Default()
	cfg.fillDefaults()
	password := auth.RandomPassword(16)
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, "", err
	}
	cfg.Auth.PasswordHash = hash
	if err := Save(path, cfg); err != nil {
		return nil, "", err
	}
	return cfg, password, nil
}

// Save writes the config to path with 0600 permissions.
func Save(path string, cfg *Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("config: mkdir %s: %w", filepath.Dir(path), err)
	}
	cfg.fillDefaults()
	out, err := yaml.Marshal(cfg)
	if err != nil {
		return fmt.Errorf("config: marshal: %w", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return fmt.Errorf("config: write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return fmt.Errorf("config: replace %s: %w", path, err)
	}
	return nil
}

// SetPassword sets a new password hash and saves the config. The config file
// is created first if it does not exist.
func SetPassword(path, password string) (*Config, error) {
	cfg, _, err := Load(path)
	if err != nil {
		return nil, err
	}
	if password == "" {
		return nil, errors.New("password cannot be empty")
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, err
	}
	cfg.Auth.PasswordHash = hash
	if err := Save(path, cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// Validate performs basic sanity checks.
func (c *Config) Validate() error {
	if c.Listen == "" {
		return errors.New("listen address cannot be empty")
	}
	if c.Auth.PasswordHash == "" {
		return errors.New("auth.passwordHash cannot be empty")
	}
	if c.DistDir == "" {
		return errors.New("distDir cannot be empty")
	}
	if !strings.HasPrefix(c.Auth.Cookie.SameSite, "lax") &&
		!strings.HasPrefix(c.Auth.Cookie.SameSite, "strict") &&
		!strings.HasPrefix(c.Auth.Cookie.SameSite, "none") {
		return fmt.Errorf("invalid cookie.sameSite %q", c.Auth.Cookie.SameSite)
	}
	return nil
}

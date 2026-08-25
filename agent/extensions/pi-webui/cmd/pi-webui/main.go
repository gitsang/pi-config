// Command pi-webui is the pi-webui web service binary.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"gopkg.in/yaml.v3"

	"pi-webui/internal/api"
	"pi-webui/internal/auth"
	"pi-webui/internal/config"
	"pi-webui/internal/logging"
	"pi-webui/internal/sessionmgr"
)

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		os.Exit(2)
	}
	cmd := args[0]
	rest := args[1:]
	var err error
	switch cmd {
	case "start":
		err = cmdStart(rest)
	case "stop":
		err = cmdStop(rest)
	case "status":
		err = cmdStatus(rest)
	case "daemon":
		err = cmdDaemon(rest)
	case "set-password":
		err = cmdSetPassword(rest)
	case "config":
		err = cmdConfig(rest)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "pi-webui: unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "pi-webui: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Print(`pi-webui - browser UI for pi

Usage:
  pi-webui start [--config <path>] [--log-stderr]
  pi-webui stop
  pi-webui status
  pi-webui daemon install|uninstall|start|stop|status
  pi-webui set-password [--generate] [<new-password>]
  pi-webui config

Commands:
  start                 Run the web service in the foreground
  stop                  Stop a running instance (by pid file)
  status                Show pid and port health status
  daemon install        Install a systemd user service
  daemon uninstall      Remove the systemd user service
  daemon start|stop|status
                        Control the systemd user service
  set-password          Set or reset the login password (argon2id)
  config                Print the config path and effective config
`)
}

func cmdStart(args []string) error {
	fs := flag.NewFlagSet("start", flag.ContinueOnError)
	configPath := fs.String("config", "", "config file path")
	logStderr := fs.Bool("log-stderr", false, "also write logs to stderr")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, generatedPassword, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	if generatedPassword != "" {
		fmt.Printf("pi-webui: generated login password: %s\n", generatedPassword)
	}
	if err := cfg.Validate(); err != nil {
		return err
	}

	logger, err := logging.New(filepath.Join(cfg.LogsDir, "webui.log"), logging.ParseLevel(cfg.LogLevel), *logStderr)
	if err != nil {
		return err
	}
	defer logger.Close()

	pidFile := filepath.Join(cfg.LogsDir, "webui.pid")
	if err := writePidFile(pidFile); err != nil {
		return err
	}
	defer os.Remove(pidFile)

	mgr := sessionmgr.New(cfg, logger)
	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           api.New(cfg, logger, mgr).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen %s: %w", cfg.Listen, err)
	}
	logger.Infof("pi-webui listening on http://%s (config: %s)", ln.Addr(), configPathOr(cfg))
	fmt.Printf("pi-webui listening on http://%s\n", ln.Addr())

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.Serve(ln)
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-sigCh:
		logger.Infof("received signal %s, shutting down", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		mgr.CloseAll()
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		mgr.CloseAll()
		return err
	}
}

func configPathOr(cfg *config.Config) string {
	return config.DefaultPath()
}

func cmdStop(args []string) error {
	cfg := config.Default()
	cfgPath := config.DefaultPath()
	if _, err := os.Stat(cfgPath); err == nil {
		if loaded, _, err := config.Load(cfgPath); err == nil {
			cfg = loaded
		}
	}
	cfg.FillDefaults()
	pidFile := filepath.Join(cfg.LogsDir, "webui.pid")
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return fmt.Errorf("not running (pid file %s not found)", pidFile)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 {
		return fmt.Errorf("invalid pid file %s", pidFile)
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		os.Remove(pidFile)
		return fmt.Errorf("process %d is not running", pid)
	}
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		return err
	}
	for i := 0; i < 100; i++ {
		time.Sleep(100 * time.Millisecond)
		if _, err := os.Stat(pidFile); os.IsNotExist(err) {
			fmt.Printf("pi-webui stopped (pid %d)\n", pid)
			return nil
		}
	}
	return fmt.Errorf("pid %d did not stop in time", pid)
}

func cmdStatus(args []string) error {
	cfg := config.Default()
	cfgPath := config.DefaultPath()
	if _, err := os.Stat(cfgPath); err == nil {
		if loaded, _, err := config.Load(cfgPath); err == nil {
			cfg = loaded
		}
	}
	cfg.FillDefaults()
	pidFile := filepath.Join(cfg.LogsDir, "webui.pid")
	data, err := os.ReadFile(pidFile)
	if err != nil {
		fmt.Println("pi-webui: not running")
		return nil
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
	procAlive := false
	if pid > 0 {
		if proc, err := os.FindProcess(pid); err == nil {
			procAlive = proc.Signal(syscall.Signal(0)) == nil
		}
	}
	health := "unreachable"
	hostPort := cfg.Listen
	if strings.HasPrefix(hostPort, "0.0.0.0:") {
		hostPort = "127.0.0.1:" + strings.TrimPrefix(hostPort, "0.0.0.0:")
	}
	client := http.Client{Timeout: 2 * time.Second}
	if resp, err := client.Get("http://" + hostPort + "/api/me"); err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusUnauthorized {
			health = "ok"
		}
	}
	fmt.Printf("pi-webui: pid=%s alive=%v health=%s listen=%s\n", strings.TrimSpace(string(data)), procAlive, health, cfg.Listen)
	return nil
}

func cmdDaemon(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: pi-webui daemon install|uninstall|start|stop|status")
	}
	action := args[0]
	unitPath, err := systemdUnitPath()
	if err != nil {
		return err
	}
	switch action {
	case "install":
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		unit := fmt.Sprintf(`[Unit]
Description=pi-webui (browser UI for pi)
After=network.target

[Service]
Type=simple
ExecStart=%s start
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`, exe)
		if err := os.MkdirAll(filepath.Dir(unitPath), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(unitPath, []byte(unit), 0o600); err != nil {
			return err
		}
		if err := systemctl("daemon-reload"); err != nil {
			return err
		}
		fmt.Printf("pi-webui systemd user service installed: %s\n", unitPath)
		return nil
	case "uninstall":
		_ = systemctl("--user", "stop", "pi-webui.service")
		_ = systemctl("--user", "disable", "pi-webui.service")
		os.Remove(unitPath)
		_ = systemctl("daemon-reload")
		fmt.Println("pi-webui systemd user service uninstalled")
		return nil
	case "start", "stop", "status":
		return systemctl("--user", action, "pi-webui.service")
	default:
		return fmt.Errorf("unknown daemon command %q", action)
	}
}

func systemdUnitPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "systemd", "user", "pi-webui.service"), nil
}

func systemctl(args ...string) error {
	cmd := exec.Command("systemctl", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}

func stdinIsTerminal() bool {
	var st syscall.Stat_t
	if err := syscall.Fstat(int(os.Stdin.Fd()), &st); err != nil {
		return false
	}
	return (st.Mode & syscall.S_IFMT) == syscall.S_IFCHR
}

func cmdSetPassword(args []string) error {
	fs := flag.NewFlagSet("set-password", flag.ContinueOnError)
	generate := fs.Bool("generate", false, "generate a random password and print it")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfgPath := config.DefaultPath()
	password := ""
	if *generate {
		password = auth.RandomPassword(16)
		fmt.Println(password)
	} else if fs.NArg() > 0 {
		password = fs.Arg(0)
	} else if stdinIsTerminal() {
		fmt.Fprint(os.Stderr, "New password: ")
		reader := bufio.NewReader(os.Stdin)
		line, err := reader.ReadString('\n')
		if err != nil && line == "" {
			return err
		}
		password = strings.TrimRight(line, "\r\n")
	} else {
		// No password provided and stdin is not a terminal (e.g. invoked from
		// the pi extension or a script): reading would block forever, so fail
		// fast with a clear hint.
		return errors.New("未提供密码且 stdin 不是终端，请在 shell 中交互运行，或使用 set-password --generate / set-password <密码>")
	}
	if _, err := config.SetPassword(cfgPath, password); err != nil {
		return err
	}
	fmt.Printf("pi-webui password updated in %s\n", cfgPath)
	return nil
}

func cmdConfig(args []string) error {
	cfgPath := config.DefaultPath()
	cfg, _, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	fmt.Printf("config: %s\n", cfgPath)
	cfg = cfg.Sanitized()
	out, err := yaml.Marshal(cfg)
	if err != nil {
		return err
	}
	fmt.Print(string(out))
	return nil
}

func writePidFile(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if data, err := os.ReadFile(path); err == nil {
		pid, _ := strconv.Atoi(strings.TrimSpace(string(data)))
		if pid > 0 {
			if proc, err := os.FindProcess(pid); err == nil && proc.Signal(syscall.Signal(0)) == nil {
				return fmt.Errorf("already running (pid %d)", pid)
			}
		}
	}
	return os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600)
}

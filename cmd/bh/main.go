package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

var Version = "dev"

const (
	colorReset = "\033[0m"
	colorRed   = "\033[31m"
	colorGreen = "\033[32m"
	colorCyan  = "\033[36m"
	colorBold  = "\033[1m"
)

var errHelp = errors.New("help requested")

func main() {
	os.Exit(run())
}

func run() int {
	if err := runCmd(os.Args[1:]); err != nil {
		if errors.Is(err, errHelp) {
			return 0
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode()
		}
		errorf("%v", err)
		return 1
	}
	return 0
}

func runCmd(args []string) error {
	projectDir, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("get working directory: %w", err)
	}

	if len(args) == 0 {
		printUsage()
		return errHelp
	}

	switch args[0] {
	case "create", "run", "connect", "sync", "list", "status", "rename", "move", "destroy":
		return runRemote(args, projectDir)
	case "ssh-config":
		return runSSHConfig(args[1:])
	case "image":
		return runImage(args[1:], projectDir)
	case "team":
		return runTeam(args[1:], projectDir)
	case "login":
		return runLogin(args[1:])
	case "logout":
		return runLogout(args[1:])
	case "config":
		cfg, err := loadConfig(projectDir)
		if err != nil {
			return err
		}
		return printConfig(cfg)
	case "version":
		printVersion()
		return nil
	case "help", "-h", "--help":
		printUsage()
		return errHelp
	default:
		return fmt.Errorf("unknown command: %s (try 'bh help')", args[0])
	}
}

func printUsage() {
	fmt.Fprintf(os.Stderr, "%sBoxHaven%s %s\n\n", colorBold, colorReset, Version)
	fmt.Fprintf(os.Stderr, "%sUSAGE:%s\n", colorBold, colorReset)
	fmt.Fprintln(os.Stderr, "  bh create <name> [--provider <name>] [--tier small|medium|large] [--region <region>] [--image <image>] [--team <team>] [--no-sync]")
	fmt.Fprintln(os.Stderr, "  bh list")
	fmt.Fprintln(os.Stderr, "  bh destroy <name> [--force]")
	fmt.Fprintln(os.Stderr, "  bh rename <old-name> <new-name>")
	fmt.Fprintln(os.Stderr, "  bh move <name> <team>")
	fmt.Fprintln(os.Stderr, "  bh connect <name>")
	fmt.Fprintln(os.Stderr, "  bh run <name> <cmd...>")
	fmt.Fprintln(os.Stderr, "  bh sync up <name>")
	fmt.Fprintln(os.Stderr, "  bh sync down <name> --force")
	fmt.Fprintln(os.Stderr, "  bh status <name>")
	fmt.Fprintln(os.Stderr, "  bh ssh-config install|refresh|uninstall")
	fmt.Fprintln(os.Stderr, "  bh image ls|create|rm [...]")
	fmt.Fprintln(os.Stderr, "  bh team list|create|switch|status|members|invite|boxes [...]")
	fmt.Fprintln(os.Stderr, "  bh login [--backend-url <url>] [--no-open]")
	fmt.Fprintln(os.Stderr, "  bh logout")
	fmt.Fprintln(os.Stderr, "  bh config")
	fmt.Fprintln(os.Stderr, "  bh version")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintf(os.Stderr, "%sCONFIG:%s\n", colorBold, colorReset)
	fmt.Fprintln(os.Stderr, "  Global:  ~/.config/boxhaven/config.toml")
	fmt.Fprintln(os.Stderr, "  Project: .boxhaven.toml")
	fmt.Fprintln(os.Stderr, "  Env:     BOXHAVEN_BACKEND_URL, BOXHAVEN_TOKEN, GH_TOKEN, GITHUB_TOKEN")
	fmt.Fprintln(os.Stderr, "  GitHub:  GH_TOKEN/GITHUB_TOKEN or local `gh auth login` for HTTPS repo pushes")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintf(os.Stderr, "%sSYNC:%s\n", colorBold, colorReset)
	fmt.Fprintln(os.Stderr, "  Excludes dependency/cache directories by default, reads .boxhavenignore, and reports elapsed transfer stats")
}

func printVersion() {
	fmt.Printf("bh %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
}

func success(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, colorGreen+"✓ "+format+colorReset+"\n", args...)
}

func info(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, colorCyan+"→ "+format+colorReset+"\n", args...)
}

func link(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, colorCyan+"→ "+format+colorReset+"\n", args...)
}

func warn(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "warning: "+format+"\n", args...)
}

func errorf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, colorRed+"error: "+format+colorReset+"\n", args...)
}

func configValueOrNotSet(value string) string {
	if strings.TrimSpace(value) == "" {
		return "(not set)"
	}
	return value
}

func valueOrDash(value string) string {
	if strings.TrimSpace(value) == "" {
		return "-"
	}
	return value
}

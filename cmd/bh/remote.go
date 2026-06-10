package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"golang.org/x/term"
)

const (
	remoteDefaultSessionName = "boxhaven"
	remoteDefaultSSHUser     = "boxhaven"
	remoteProjectRoot        = "/opt/boxhaven/project"
	remoteKnownHostsFileName = "remote_known_hosts"
	remoteSessionEnvFile     = "/run/boxhaven/session.env"
	maxRemoteAuthFileBytes   = 1024 * 1024
)

type remoteMachine struct {
	Name               string    `json:"name"`
	UserID             string    `json:"user_id,omitempty"`
	TeamID             string    `json:"team_id,omitempty"`
	TeamSlug           string    `json:"team_slug,omitempty"`
	TeamName           string    `json:"team_name,omitempty"`
	Provider           string    `json:"provider,omitempty"`
	ProviderID         string    `json:"provider_id,omitempty"`
	PublicIPv4         string    `json:"public_ipv4,omitempty"`
	Region             string    `json:"region,omitempty"`
	Size               string    `json:"size,omitempty"`
	Image              string    `json:"image,omitempty"`
	SSHUser            string    `json:"ssh_user,omitempty"`
	PreviewHostname    string    `json:"preview_hostname,omitempty"`
	PreviewURL         string    `json:"preview_url,omitempty"`
	SourcePath         string    `json:"source_path,omitempty"`
	ProjectPath        string    `json:"project_path,omitempty"`
	RepoURL            string    `json:"repo_url,omitempty"`
	Branch             string    `json:"branch,omitempty"`
	LastCommand        []string  `json:"last_command,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
	LastSyncedAt       time.Time `json:"last_synced_at,omitempty"`
	AgentLastSeenAt    time.Time `json:"agent_last_seen_at,omitempty"`
	BootstrapComplete  bool      `json:"bootstrap_complete,omitempty"`
	SSHKeyPath         string    `json:"-"`
	SSHCertificatePath string    `json:"-"`
	SSHHost            string    `json:"-"`
	SSHPort            int       `json:"-"`
}

type remoteProvisionOptions struct {
	Name       string
	SSHUser    string
	BackendURL string
	Tier       string
	Provider   string
	Region     string
	Image      string
	Team       string
}

func runRemote(args []string, projectDir string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		printRemoteUsage()
		return errHelp
	}

	switch args[0] {
	case "create":
		return runRemoteCreate(args[1:], projectDir)
	case "run":
		return runRemoteRun(args[1:], projectDir)
	case "connect":
		return runRemoteConnect(args[1:], projectDir)
	case "sync":
		return runRemoteSync(args[1:], projectDir)
	case "list":
		return runRemoteList(args[1:], projectDir)
	case "status":
		return runRemoteStatus(args[1:], projectDir)
	case "rename":
		return runRemoteRename(args[1:], projectDir)
	case "move":
		return runRemoteMove(args[1:], projectDir)
	case "destroy":
		return runRemoteDestroy(args[1:], projectDir)
	default:
		return fmt.Errorf("unknown command: %s (try 'bh help')", args[0])
	}
}

func printRemoteUsage() {
	fmt.Fprintln(os.Stderr, "USAGE:")
	fmt.Fprintln(os.Stderr, "  bh dev [options] [cmd...]")
	fmt.Fprintln(os.Stderr, "  bh create <name> [--provider <name>] [--tier <tier>] [--region <region>] [--image <image>] [--team <team>] [--no-sync]")
	fmt.Fprintln(os.Stderr, "  bh run <name> [--no-sync] <cmd...>")
	fmt.Fprintln(os.Stderr, "  bh connect <name>")
	fmt.Fprintln(os.Stderr, "  bh sync up <name>")
	fmt.Fprintln(os.Stderr, "  bh sync down <name> --force")
	fmt.Fprintln(os.Stderr, "  bh list")
	fmt.Fprintln(os.Stderr, "  bh status <name>")
	fmt.Fprintln(os.Stderr, "  bh rename <old-name> <new-name>")
	fmt.Fprintln(os.Stderr, "  bh move <name> <team>")
	fmt.Fprintln(os.Stderr, "  bh destroy <name>")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "OPTIONS:")
	fmt.Fprintln(os.Stderr, "  --no-sync            Skip the project sync (create: initial sync; run/dev: keep remote edits)")
	fmt.Fprintln(os.Stderr, "  --provider <name>    Cloud provider for create (defaults to config or backend default)")
	fmt.Fprintln(os.Stderr, "  --tier <tier>        Machine size tier for create: small, medium, or large")
	fmt.Fprintln(os.Stderr, "  --region <region>    Provider region for create")
	fmt.Fprintln(os.Stderr, "  --image <image>      Provider image ID or slug for create")
	fmt.Fprintln(os.Stderr, "  --team <team>        Team that owns the new box (defaults to your active team)")
	fmt.Fprintln(os.Stderr, "  --ssh-user <user>    SSH user for create")
	fmt.Fprintln(os.Stderr, "  --backend-url <url>  Remote backend API URL for create")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "EXAMPLES:")
	fmt.Fprintln(os.Stderr, "  bh login")
	fmt.Fprintln(os.Stderr, "  bh dev claude        # box named after this project, created on first use")
	fmt.Fprintln(os.Stderr, "  bh create foo")
	fmt.Fprintln(os.Stderr, "  bh run foo codex")
	fmt.Fprintln(os.Stderr, "  bh connect foo")
	fmt.Fprintln(os.Stderr, "  bh sync up foo")
}

func runRemoteCreate(args []string, projectDir string) error {
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}

	opts, noSync, err := parseRemoteCreateArgs(args, cfg)
	if err != nil {
		return err
	}
	cfg, err = remoteConfigForProvision(cfg, opts)
	if err != nil {
		return err
	}

	_, err = createRemoteMachine(cfg, projectDir, opts, !noSync)
	return err
}

func runRemoteRun(args []string, projectDir string) error {
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	name, commandArgs, err := parseRemoteNameAndCommand("run", args)
	if err != nil {
		return err
	}
	syncProject := true
	for len(commandArgs) > 0 && commandArgs[0] == "--no-sync" {
		syncProject = false
		commandArgs = commandArgs[1:]
	}
	if len(commandArgs) == 0 {
		return fmt.Errorf("bh run requires a command")
	}
	machine, cleanup, err := readyExistingRemoteMachine(cfg, projectDir, name, syncProject)
	if err != nil {
		return err
	}
	defer cleanup()
	return runRemoteMachineCommand(cfg, machine, commandArgs, projectDir)
}

func parseRemoteCreateArgs(args []string, cfg Config) (remoteProvisionOptions, bool, error) {
	opts := remoteProvisionOptions{
		SSHUser:    cfg.Remote.SSHUser,
		BackendURL: remoteBackendURL(cfg),
		Provider:   cfg.Remote.Provider,
	}
	noSync := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--no-sync":
			noSync = true
		case arg == "--ssh-user":
			i++
			if i >= len(args) {
				return opts, noSync, fmt.Errorf("bh create --ssh-user requires a value")
			}
			opts.SSHUser = args[i]
		case strings.HasPrefix(arg, "--ssh-user="):
			opts.SSHUser = strings.TrimPrefix(arg, "--ssh-user=")
		case arg == "--tier":
			i++
			if i >= len(args) {
				return opts, noSync, fmt.Errorf("bh create --tier requires a value")
			}
			opts.Tier = args[i]
		case strings.HasPrefix(arg, "--tier="):
			opts.Tier = strings.TrimPrefix(arg, "--tier=")
		case arg == "--provider":
			i++
			if i >= len(args) {
				return opts, noSync, fmt.Errorf("bh create --provider requires a value")
			}
			opts.Provider = args[i]
		case strings.HasPrefix(arg, "--provider="):
			opts.Provider = strings.TrimPrefix(arg, "--provider=")
		case arg == "--region":
			i++
			if i >= len(args) {
				return opts, noSync, fmt.Errorf("bh create --region requires a value")
			}
			opts.Region = args[i]
		case strings.HasPrefix(arg, "--region="):
			opts.Region = strings.TrimPrefix(arg, "--region=")
		case arg == "--image":
			i++
			if i >= len(args) {
				return opts, noSync, fmt.Errorf("bh create --image requires a value")
			}
			opts.Image = args[i]
		case strings.HasPrefix(arg, "--image="):
			opts.Image = strings.TrimPrefix(arg, "--image=")
		case arg == "--team":
			i++
			if i >= len(args) {
				return opts, noSync, fmt.Errorf("bh create --team requires a value")
			}
			opts.Team = args[i]
		case strings.HasPrefix(arg, "--team="):
			opts.Team = strings.TrimPrefix(arg, "--team=")
		case arg == "--backend-url":
			i++
			if i >= len(args) {
				return opts, noSync, fmt.Errorf("bh create --backend-url requires a value")
			}
			opts.BackendURL = args[i]
		case strings.HasPrefix(arg, "--backend-url="):
			opts.BackendURL = strings.TrimPrefix(arg, "--backend-url=")
		case strings.HasPrefix(arg, "-"):
			return opts, noSync, fmt.Errorf("unknown bh create option: %s", arg)
		default:
			if opts.Name != "" {
				return opts, noSync, fmt.Errorf("unexpected bh create argument: %s", arg)
			}
			opts.Name = arg
		}
	}
	opts.Name = strings.ToLower(strings.TrimSpace(opts.Name))
	opts.SSHUser = strings.TrimSpace(opts.SSHUser)
	tier, err := normalizeRemoteMachineTier(opts.Tier)
	if err != nil {
		return opts, noSync, err
	}
	opts.Tier = tier
	opts.Provider = strings.ToLower(strings.TrimSpace(opts.Provider))
	opts.Region = strings.TrimSpace(opts.Region)
	opts.Image = strings.TrimSpace(opts.Image)
	opts.Team = strings.TrimSpace(opts.Team)
	opts.BackendURL = strings.TrimRight(strings.TrimSpace(opts.BackendURL), "/")
	if opts.Name == "" {
		return opts, noSync, fmt.Errorf("bh create requires a remote name")
	}
	if err := validateRemoteName(opts.Name); err != nil {
		return opts, noSync, err
	}
	return opts, noSync, nil
}

func normalizeRemoteMachineTier(tier string) (string, error) {
	tier = strings.ToLower(strings.TrimSpace(tier))
	if tier == "" {
		return "", nil
	}
	switch tier {
	case "small", "medium", "large":
		return tier, nil
	default:
		return "", fmt.Errorf("invalid remote machine tier %q; expected small, medium, or large", tier)
	}
}

func remoteConfigForProvision(cfg Config, opts remoteProvisionOptions) (Config, error) {
	if opts.BackendURL != "" {
		if err := validateRemoteBackendURL(opts.BackendURL); err != nil {
			return cfg, fmt.Errorf("invalid --backend-url: %w", err)
		}
		cfg.Remote.BackendURL = opts.BackendURL
	}
	if opts.SSHUser != "" {
		cfg.Remote.SSHUser = opts.SSHUser
	}
	return cfg, nil
}

func runRemoteConnect(args []string, projectDir string) error {
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	name, rest, err := parseRemoteNameAndCommand("connect", args)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return fmt.Errorf("unexpected bh connect args: %v", rest)
	}
	machine, _, err := getRemoteBackendMachine(cfg, name)
	if err != nil {
		return err
	}
	if err := requireRemoteMachineBootstrapped(machine); err != nil {
		return err
	}
	cleanup, err := attachRemoteSSHCertificate(cfg, &machine)
	if err != nil {
		return err
	}
	defer cleanup()
	return runRemoteMachineCommand(cfg, machine, []string{"shell"}, projectDir)
}

func runRemoteSync(args []string, projectDir string) error {
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}

	if len(args) == 0 {
		return fmt.Errorf("bh sync requires direction: up or down")
	}
	direction := args[0]
	if direction != "up" && direction != "down" {
		return fmt.Errorf("unknown bh sync direction %q", direction)
	}
	args = args[1:]
	force := false
	filtered := make([]string, 0, len(args))
	for _, arg := range args {
		if arg == "--force" {
			force = true
			continue
		}
		filtered = append(filtered, arg)
	}

	name, rest, err := parseRemoteNameAndCommand("sync "+direction, filtered)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return fmt.Errorf("unexpected bh sync args: %v", rest)
	}
	if direction == "down" && !force {
		return fmt.Errorf("bh sync down overwrites the local folder; pass --force to continue")
	}
	machine, _, err := getRemoteBackendMachine(cfg, name)
	if err != nil {
		return err
	}
	if err := requireRemoteMachineBootstrapped(machine); err != nil {
		return err
	}
	cleanup, err := attachRemoteSSHCertificate(cfg, &machine)
	if err != nil {
		return err
	}
	defer cleanup()

	switch direction {
	case "up":
		if err := syncRemoteProject(&machine, cfg, projectDir); err != nil {
			return err
		}
	case "down":
		if err := syncRemoteProjectDown(machine, projectDir); err != nil {
			return err
		}
	}

	success("Synced remote %s %s", machine.Name, direction)
	return nil
}

func runRemoteList(args []string, projectDir string) error {
	if len(args) != 0 {
		return fmt.Errorf("unexpected bh list args: %v", args)
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	machines, err := listRemoteBackendMachines(cfg)
	if err != nil {
		return err
	}
	if len(machines) == 0 {
		if _, err := fmt.Fprintln(os.Stdout, "No remote machines."); err != nil {
			return err
		}
		return nil
	}
	sort.Slice(machines, func(i, j int) bool {
		return machines[i].Name < machines[j].Name
	})
	table := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	if _, err := fmt.Fprintln(table, "NAME\tSTATUS\tTEAM\tPROVIDER\tSIZE\tURL"); err != nil {
		return err
	}
	now := time.Now()
	for _, m := range machines {
		if _, err := fmt.Fprintf(table, "%s\t%s\t%s\t%s\t%s\t%s\n", m.Name, remoteMachineStatusLabel(m, now), remoteMachineTeamLabel(m), valueOrDash(m.Provider), configValueOrNotSet(m.Size), remoteListURL(m)); err != nil {
			return err
		}
	}
	return table.Flush()
}

func remoteMachineTeamLabel(machine remoteMachine) string {
	return valueOrDash(firstNonEmpty(machine.TeamSlug, machine.TeamName))
}

// remoteMachineStatusLabel reports box liveness from the machine agent's
// last heartbeat; the agent pings continuously while the box is up.
func remoteMachineStatusLabel(machine remoteMachine, now time.Time) string {
	if !machine.BootstrapComplete {
		return "creating"
	}
	if machine.AgentLastSeenAt.IsZero() {
		return "-"
	}
	if now.Sub(machine.AgentLastSeenAt) <= 5*time.Minute {
		return "online"
	}
	return "offline"
}

func remoteListURL(machine remoteMachine) string {
	if machine.PreviewURL != "" {
		return machine.PreviewURL
	}
	if machine.PreviewHostname != "" {
		return "https://" + machine.PreviewHostname
	}
	return "-"
}

func runRemoteStatus(args []string, projectDir string) error {
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	name, rest, err := parseRemoteNameAndCommand("status", args)
	if err != nil {
		return err
	}
	if len(rest) != 0 {
		return fmt.Errorf("unexpected bh status args: %v", rest)
	}
	machine, status, err := getRemoteBackendMachine(cfg, name)
	if err != nil {
		return err
	}

	fmt.Printf("%sname:%s %s\n", colorBold, colorReset, machine.Name)
	fmt.Printf("%sbackend_url:%s %s\n", colorBold, colorReset, remoteBackendURL(cfg))
	fmt.Printf("%sbackend_status:%s %s\n", colorBold, colorReset, configValueOrNotSet(status))
	fmt.Printf("%steam:%s %s\n", colorBold, colorReset, remoteMachineTeamLabel(machine))
	fmt.Printf("%sprovider:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.Provider))
	fmt.Printf("%sprovider_id:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.ProviderID))
	fmt.Printf("%spublic_ipv4:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.PublicIPv4))
	fmt.Printf("%ssize:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.Size))
	fmt.Printf("%sregion:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.Region))
	fmt.Printf("%simage:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.Image))
	fmt.Printf("%sssh_user:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.SSHUser))
	fmt.Printf("%spreview_url:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.PreviewURL))
	fmt.Printf("%ssource_path:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.SourcePath))
	fmt.Printf("%srepo:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.RepoURL))
	fmt.Printf("%sbranch:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.Branch))
	fmt.Printf("%sproject_path:%s %s\n", colorBold, colorReset, configValueOrNotSet(machine.ProjectPath))
	fmt.Printf("%swork_path:%s %s\n", colorBold, colorReset, configValueOrNotSet(remoteWorkPath(machine)))
	fmt.Printf("%slast_synced_at:%s %s\n", colorBold, colorReset, displayTime(machine.LastSyncedAt))
	fmt.Printf("%sagent_last_seen:%s %s (%s)\n", colorBold, colorReset, displayTime(machine.AgentLastSeenAt), remoteMachineStatusLabel(machine, time.Now()))
	fmt.Printf("%sbootstrap_complete:%s %t\n", colorBold, colorReset, machine.BootstrapComplete)
	return nil
}

func runRemoteDestroy(args []string, projectDir string) error {
	if len(args) == 0 {
		return fmt.Errorf("bh destroy requires a remote name")
	}
	name := ""
	for _, arg := range args {
		switch arg {
		case "--force":
			continue
		default:
			if name != "" {
				return fmt.Errorf("unexpected destroy argument: %s", arg)
			}
			name = strings.ToLower(strings.TrimSpace(arg))
		}
	}
	if name == "" {
		return fmt.Errorf("bh destroy requires a remote name")
	}
	if err := validateRemoteName(name); err != nil {
		return err
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	if err := releaseRemoteBackendMachine(cfg, name); err != nil {
		return err
	}
	success("Destroyed remote %s", name)
	return nil
}

func runRemoteRename(args []string, projectDir string) error {
	if len(args) != 2 {
		return fmt.Errorf("bh rename requires an old remote name and a new remote name")
	}
	fromName := strings.ToLower(strings.TrimSpace(args[0]))
	toName := strings.ToLower(strings.TrimSpace(args[1]))
	if err := validateRemoteName(fromName); err != nil {
		return err
	}
	if err := validateRemoteName(toName); err != nil {
		return err
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	machine, err := renameRemoteBackendMachine(cfg, fromName, toName)
	if err != nil {
		return err
	}
	success("Renamed remote %s to %s", fromName, machine.Name)
	return nil
}

func runRemoteMove(args []string, projectDir string) error {
	if len(args) != 2 {
		return fmt.Errorf("bh move requires a remote name and a target team")
	}
	name := strings.ToLower(strings.TrimSpace(args[0]))
	if err := validateRemoteName(name); err != nil {
		return err
	}
	team := strings.TrimSpace(args[1])
	if team == "" {
		return fmt.Errorf("bh move requires a target team")
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	machine, err := moveRemoteBackendMachine(cfg, name, team)
	if err != nil {
		return err
	}
	success("Moved remote %s to team %s", machine.Name, firstNonEmpty(machine.TeamSlug, machine.TeamName, team))
	return nil
}

func parseRemoteNameAndCommand(command string, args []string) (string, []string, error) {
	if len(args) == 0 {
		return "", nil, fmt.Errorf("bh %s requires a remote name", command)
	}
	name := strings.ToLower(strings.TrimSpace(args[0]))
	if err := validateRemoteName(name); err != nil {
		return "", nil, err
	}
	return name, args[1:], nil
}

func createRemoteMachine(cfg Config, projectDir string, opts remoteProvisionOptions, syncProject bool) (remoteMachine, error) {
	opts.Name = strings.ToLower(strings.TrimSpace(opts.Name))
	if err := validateRemoteName(opts.Name); err != nil {
		return remoteMachine{}, err
	}
	if opts.BackendURL != "" {
		cfg.Remote.BackendURL = strings.TrimRight(strings.TrimSpace(opts.BackendURL), "/")
	}
	var machine remoteMachine
	if err := runWithSpinner(
		fmt.Sprintf("Creating remote %s via backend", opts.Name),
		fmt.Sprintf("Remote %s created", opts.Name),
		func() error {
			var err error
			machine, err = createRemoteBackendMachine(cfg, projectDir, opts)
			return err
		},
	); err != nil {
		return remoteMachine{}, err
	}
	if syncProject {
		cleanup, err := attachRemoteSSHCertificate(cfg, &machine)
		if err != nil {
			return machine, err
		}
		defer cleanup()
		if err := syncRemoteProject(&machine, cfg, projectDir); err != nil {
			return machine, err
		}
	}
	printRemoteReady(machine)
	return machine, nil
}

func readyExistingRemoteMachine(cfg Config, projectDir string, name string, syncProject bool) (remoteMachine, func(), error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if err := validateRemoteName(name); err != nil {
		return remoteMachine{}, func() {}, err
	}
	machine, _, err := getRemoteBackendMachine(cfg, name)
	if err != nil {
		return remoteMachine{}, func() {}, err
	}
	if err := requireRemoteMachineBootstrapped(machine); err != nil {
		return machine, func() {}, err
	}
	cleanup, err := attachRemoteSSHCertificate(cfg, &machine)
	if err != nil {
		return machine, func() {}, err
	}
	if syncProject {
		if err := syncRemoteProject(&machine, cfg, projectDir); err != nil {
			cleanup()
			return machine, func() {}, err
		}
	}
	return machine, cleanup, nil
}

func attachRemoteSSHCertificate(cfg Config, machine *remoteMachine) (func(), error) {
	if err := requireRemoteClientTools("ssh", "ssh-keygen"); err != nil {
		return func() {}, err
	}
	dir, err := os.MkdirTemp("", "boxhaven-remote-ssh-*")
	if err != nil {
		return func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	keyPath := filepath.Join(dir, "id_ed25519")
	keygen := exec.Command("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "boxhaven-"+machine.Name, "-f", keyPath)
	if output, err := keygen.CombinedOutput(); err != nil {
		cleanup()
		return func() {}, fmt.Errorf("generate temporary remote SSH key: %w: %s", err, strings.TrimSpace(string(output)))
	}
	publicKey, err := os.ReadFile(keyPath + ".pub")
	if err != nil {
		cleanup()
		return func() {}, fmt.Errorf("read temporary remote SSH public key: %w", err)
	}
	cert, err := getRemoteBackendSSHCertificate(cfg, machine.Name, strings.TrimSpace(string(publicKey)))
	if err != nil {
		cleanup()
		return func() {}, err
	}
	if strings.TrimSpace(cert.Certificate) == "" {
		cleanup()
		return func() {}, fmt.Errorf("remote backend returned no SSH certificate for %s", machine.Name)
	}
	certPath := keyPath + "-cert.pub"
	if err := os.WriteFile(certPath, []byte(strings.TrimSpace(cert.Certificate)+"\n"), 0600); err != nil {
		cleanup()
		return func() {}, fmt.Errorf("write temporary remote SSH certificate: %w", err)
	}
	machine.SSHKeyPath = keyPath
	machine.SSHCertificatePath = certPath
	machine.SSHHost = strings.TrimSpace(cert.Host)
	machine.SSHPort = cert.Port
	if strings.TrimSpace(cert.SSHUser) != "" {
		machine.SSHUser = strings.TrimSpace(cert.SSHUser)
	}
	return cleanup, nil
}

func requireRemoteMachineBootstrapped(machine remoteMachine) error {
	if machine.BootstrapComplete {
		return nil
	}
	return fmt.Errorf("remote %s is not bootstrapped; backend setup has not completed for this machine", machine.Name)
}

func printRemoteReady(machine remoteMachine) {
	success("Remote %s is ready", machine.Name)
	if previewURL := strings.TrimSpace(machine.PreviewURL); previewURL != "" {
		link("Preview: %s", previewURL)
	}
}

type gitRepoInfo struct {
	URL    string
	Branch string
}

type gitIdentity struct {
	Name  string
	Email string
}

func currentGitRepo(projectDir string) gitRepoInfo {
	url, err := gitOutput(projectDir, "config", "--get", "remote.origin.url")
	if err != nil || strings.TrimSpace(url) == "" {
		return gitRepoInfo{}
	}
	branch, err := gitOutput(projectDir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		branch = ""
	}
	branch = strings.TrimSpace(branch)
	if branch == "HEAD" {
		branch = ""
	}
	return gitRepoInfo{URL: strings.TrimSpace(url), Branch: branch}
}

func currentGitIdentity(projectDir string) gitIdentity {
	name, _ := gitOutput(projectDir, "config", "--get", "user.name")
	email, _ := gitOutput(projectDir, "config", "--get", "user.email")
	return gitIdentity{
		Name:  strings.TrimSpace(name),
		Email: strings.TrimSpace(email),
	}
}

func gitOutput(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func syncRemoteProject(machine *remoteMachine, cfg Config, projectDir string) error {
	if err := requireRemoteClientTools("ssh", "rsync"); err != nil {
		return err
	}
	sourcePath, err := normalizedProjectPath(projectDir)
	if err != nil {
		return err
	}
	repo := currentGitRepo(sourcePath)
	machine.SourcePath = sourcePath
	machine.RepoURL = repo.URL
	machine.Branch = repo.Branch
	if machine.ProjectPath == "" {
		machine.ProjectPath = remoteProjectPath()
	}
	if err := syncRemoteAuthState(*machine, sourcePath); err != nil {
		return err
	}

	info("Copying %s to %s:%s...", sourcePath, machine.Name, machine.ProjectPath)
	if err := rsyncPathToRemote(*machine, machine.ProjectPath, sourcePath); err != nil {
		return err
	}
	if err := runRemoteBackendSetup(cfg, *machine, cfg.Remote.Setup); err != nil {
		return err
	}
	machine.LastSyncedAt = time.Now().UTC()
	machine.UpdatedAt = machine.LastSyncedAt
	*machine, err = completeRemoteBackendSync(cfg, *machine)
	return err
}

func syncRemoteProjectDown(machine remoteMachine, projectDir string) error {
	if err := requireRemoteClientTools("ssh", "rsync"); err != nil {
		return err
	}
	sourcePath, err := normalizedProjectPath(projectDir)
	if err != nil {
		return err
	}
	if machine.ProjectPath == "" {
		machine.ProjectPath = remoteProjectPath()
	}
	info("Copying %s:%s back to %s...", machine.Name, machine.ProjectPath, sourcePath)
	return rsyncPathFromRemote(machine, machine.ProjectPath, sourcePath)
}

func normalizedProjectPath(projectDir string) (string, error) {
	abs, err := filepath.Abs(projectDir)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved, nil
	}
	return abs, nil
}

func remoteProjectPath() string {
	return remoteProjectRoot
}

func remoteWorkPath(machine remoteMachine) string {
	projectPath := strings.TrimSpace(machine.ProjectPath)
	if projectPath == "" {
		return remoteProjectPath()
	}
	cleaned := filepath.Clean(projectPath)
	if cleaned == "." || !filepath.IsAbs(cleaned) {
		return remoteProjectPath()
	}
	return cleaned
}

func rsyncPathToRemote(machine remoteMachine, projectPath string, sourcePath string) error {
	source := sourcePath + string(os.PathSeparator)
	target := machine.sshTarget() + ":" + projectPath + "/"
	args := []string{
		"-az",
		"--delete",
		"--human-readable",
		source,
		target,
	}
	sshCommand, err := remoteSSHCommand(machine, false)
	if err != nil {
		return err
	}
	args = append(args[:3], append([]string{"-e", sshCommand}, args[3:]...)...)
	cmd := exec.Command("rsync", args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func rsyncPathFromRemote(machine remoteMachine, projectPath string, destinationPath string) error {
	source := machine.sshTarget() + ":" + projectPath + "/"
	target := destinationPath + string(os.PathSeparator)
	args := []string{
		"-az",
		"--delete",
		"--human-readable",
		source,
		target,
	}
	sshCommand, err := remoteSSHCommand(machine, false)
	if err != nil {
		return err
	}
	args = append(args[:3], append([]string{"-e", sshCommand}, args[3:]...)...)
	cmd := exec.Command("rsync", args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func runRemoteMachineCommand(cfg Config, machine remoteMachine, commandArgs []string, projectDir string) error {
	if machine.ProjectPath == "" {
		machine.ProjectPath = remoteProjectPath()
	}
	sourcePath, err := normalizedProjectPath(projectDir)
	if err != nil {
		return err
	}
	if err := syncRemoteAuthState(machine, sourcePath); err != nil {
		return err
	}
	if len(commandArgs) == 0 {
		commandArgs = []string{"shell"}
	}

	stdinTTY := term.IsTerminal(int(os.Stdin.Fd()))
	stdoutTTY := term.IsTerminal(int(os.Stdout.Fd()))
	interactive := remoteCommandNeedsTTY(commandArgs)

	if interactive {
		if stdinTTY && stdoutTTY {
			result, updated, err := prepareRemoteBackendSession(cfg, machine, commandArgs, true)
			if err != nil {
				return err
			}
			machine = updated
			if result.Status == "exists" {
				if remoteShellCommand(commandArgs) {
					info("Connecting to existing remote session %s via direct SSH", machine.Name)
				} else {
					info("Connecting to existing remote session %s via direct SSH; %q was not started", machine.Name, strings.Join(commandArgs, " "))
				}
			} else {
				info("Starting remote session %s via direct SSH", machine.Name)
			}
			if strings.TrimSpace(result.AttachCommand) == "" {
				return nil
			}
			return runSSHCommand(machine, result.AttachCommand, true, false)
		} else {
			if _, _, err := prepareRemoteBackendSession(cfg, machine, commandArgs, false); err != nil {
				if remoteBackendErrorCode(err) == "session_exists" {
					info("Remote session %s is already running; run `bh connect %s` from a terminal to attach", machine.Name, machine.Name)
					return nil
				}
				return err
			}
			info("Starting detached remote session %s via direct SSH; run from a terminal to connect", machine.Name)
			return nil
		}
	}

	remoteCommand, err := remoteBackendSSHCommand(cfg, machine, commandArgs)
	if err != nil {
		return err
	}
	info("Running on remote %s via direct SSH", machine.Name)
	if err := runSSHCommand(machine, remoteCommand, false, shouldForwardSSHAgent(machine.RepoURL)); err != nil {
		return err
	}
	if err := recordRemoteBackendCommand(cfg, machine, commandArgs); err != nil {
		warn("Could not update remote backend machine state: %v", err)
	}
	return nil
}

func runSSHCommand(machine remoteMachine, remoteCommand string, tty bool, forwardAgent bool, stdin ...*strings.Reader) error {
	if err := requireRemoteClientTools("ssh"); err != nil {
		return err
	}
	args, err := remoteSSHOptions(machine, forwardAgent)
	if err != nil {
		return err
	}
	if tty {
		args = append(args, "-t")
	}
	args = append(args, machine.sshTarget(), remoteCommand)
	cmd := exec.Command("ssh", args...)
	if len(stdin) > 0 {
		cmd.Stdin = stdin[0]
	} else {
		cmd.Stdin = os.Stdin
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func remoteSSHOptions(machine remoteMachine, forwardAgent bool) ([]string, error) {
	if strings.TrimSpace(machine.SSHKeyPath) == "" {
		return nil, fmt.Errorf("remote %s has no temporary SSH key", machine.Name)
	}
	if strings.TrimSpace(machine.SSHCertificatePath) == "" {
		return nil, fmt.Errorf("remote %s has no backend-signed SSH certificate", machine.Name)
	}
	if strings.TrimSpace(machine.sshHost()) == "" {
		return nil, fmt.Errorf("remote %s has no public SSH host", machine.Name)
	}
	knownHostsPath, err := remoteKnownHostsPath()
	if err != nil {
		return nil, err
	}
	args := []string{
		"-i", machine.SSHKeyPath,
		"-o", "CertificateFile=" + machine.SSHCertificatePath,
		"-o", "IdentitiesOnly=yes",
		"-o", "BatchMode=yes",
		"-o", "PreferredAuthentications=publickey",
		"-o", "PasswordAuthentication=no",
		"-o", "KbdInteractiveAuthentication=no",
		"-o", "NumberOfPasswordPrompts=0",
		"-o", "UserKnownHostsFile=" + knownHostsPath,
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "CheckHostIP=no",
		"-o", "HashKnownHosts=no",
		"-o", "HostKeyAlias=" + machine.sshHostAlias(),
		"-o", "ServerAliveInterval=30",
	}
	if machine.sshPort() != 22 {
		args = append(args, "-p", strconv.Itoa(machine.sshPort()))
	}
	if forwardAgent {
		args = append(args, "-A")
	}
	return args, nil
}

func remoteKnownHostsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home directory for remote SSH known hosts: %w", err)
	}
	if strings.TrimSpace(home) == "" {
		return "", fmt.Errorf("resolve home directory for remote SSH known hosts: home directory is empty")
	}
	dir := filepath.Join(home, ".boxhaven")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", fmt.Errorf("create remote SSH state directory: %w", err)
	}
	path := filepath.Join(dir, remoteKnownHostsFileName)
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		file, createErr := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0600)
		if createErr != nil {
			return "", fmt.Errorf("create remote SSH known hosts file: %w", createErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			return "", fmt.Errorf("close remote SSH known hosts file: %w", closeErr)
		}
	} else if err != nil {
		return "", fmt.Errorf("stat remote SSH known hosts file: %w", err)
	}
	return path, nil
}

func remoteSSHCommand(machine remoteMachine, forwardAgent bool) (string, error) {
	options, err := remoteSSHOptions(machine, forwardAgent)
	if err != nil {
		return "", err
	}
	args := append([]string{"ssh"}, options...)
	return shellJoin(args), nil
}

func (m remoteMachine) sshTarget() string {
	user := m.SSHUser
	if user == "" {
		user = remoteDefaultSSHUser
	}
	return user + "@" + m.sshHost()
}

func (m remoteMachine) sshHost() string {
	if host := strings.TrimSpace(m.SSHHost); host != "" {
		return host
	}
	return strings.TrimSpace(m.PublicIPv4)
}

func (m remoteMachine) sshPort() int {
	if m.SSHPort > 0 {
		return m.SSHPort
	}
	return 22
}

func (m remoteMachine) sshHostAlias() string {
	parts := []string{"boxhaven", m.Name}
	if providerID := sanitizeSSHHostAliasPart(m.ProviderID); providerID != "" {
		parts = append(parts, providerID)
	}
	return strings.Join(parts, "-")
}

func sanitizeSSHHostAliasPart(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	lastDash := false
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash && b.Len() > 0 {
			b.WriteByte('-')
			lastDash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

func shouldForwardSSHAgent(repoURL string) bool {
	repoURL = strings.TrimSpace(repoURL)
	return strings.HasPrefix(repoURL, "git@") || strings.HasPrefix(repoURL, "ssh://")
}

// syncRemoteAuthState forwards GitHub auth, Git identity, and agent auth
// files in one SSH round trip; each previously cost its own connection.
func syncRemoteAuthState(machine remoteMachine, projectDir string) error {
	var script strings.Builder
	script.WriteString("set -euo pipefail\numask 077\n")
	script.WriteString(remoteSessionEnvScript(remoteGitAuthEnv(machine.RepoURL)))
	script.WriteString(remoteGitIdentityScript(currentGitIdentity(projectDir)))
	script.WriteString(remoteAuthFilesScript(machine, localRemoteAuthFiles(machine.SSHUser)))
	info("Syncing session auth to remote %s", machine.Name)
	return runSSHCommand(machine, script.String(), false, false)
}

func remoteSessionEnvScript(env map[string]string) string {
	if len(env) == 0 {
		return strings.Join([]string{
			"if [ \"$(id -u)\" -eq 0 ]; then",
			"  rm -f " + shellQuote(remoteSessionEnvFile),
			"else",
			"  sudo rm -f " + shellQuote(remoteSessionEnvFile),
			"fi",
		}, "\n") + "\n"
	}
	var contents strings.Builder
	contents.WriteString("# Generated by BoxHaven. Stored in tmpfs and replaced by the CLI.\n")
	for _, key := range []string{"GH_TOKEN", "GITHUB_TOKEN"} {
		value := strings.TrimSpace(env[key])
		if value == "" {
			continue
		}
		contents.WriteString("export ")
		contents.WriteString(key)
		contents.WriteString("=")
		contents.WriteString(shellQuote(value))
		contents.WriteString("\n")
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(contents.String()))
	return strings.Join([]string{
		"bh_env_tmp=$(mktemp)",
		"printf %s " + shellQuote(encoded) + " | base64 -d > \"$bh_env_tmp\"",
		"chmod 0600 \"$bh_env_tmp\"",
		"bh_uid=$(id -u)",
		"bh_gid=$(id -g)",
		"if [ \"$bh_uid\" -eq 0 ]; then",
		"  install -d -o \"$bh_uid\" -g \"$bh_gid\" -m 0700 /run/boxhaven",
		"  install -o \"$bh_uid\" -g \"$bh_gid\" -m 0600 \"$bh_env_tmp\" " + shellQuote(remoteSessionEnvFile),
		"else",
		"  sudo install -d -o \"$bh_uid\" -g \"$bh_gid\" -m 0700 /run/boxhaven",
		"  sudo install -o \"$bh_uid\" -g \"$bh_gid\" -m 0600 \"$bh_env_tmp\" " + shellQuote(remoteSessionEnvFile),
		"fi",
		"rm -f \"$bh_env_tmp\"",
	}, "\n") + "\n"
}

func remoteGitIdentityScript(identity gitIdentity) string {
	var script strings.Builder
	if identity.Name != "" {
		script.WriteString("git config --global user.name ")
		script.WriteString(shellQuote(identity.Name))
		script.WriteString("\n")
	}
	if identity.Email != "" {
		script.WriteString("git config --global user.email ")
		script.WriteString(shellQuote(identity.Email))
		script.WriteString("\n")
	}
	return script.String()
}

func remoteGitAuthEnv(repoURL string) map[string]string {
	if !isGitHubRepoURL(repoURL) {
		return nil
	}
	env := map[string]string{}
	if token := strings.TrimSpace(os.Getenv("GH_TOKEN")); token != "" {
		env["GH_TOKEN"] = token
	}
	if token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN")); token != "" {
		env["GITHUB_TOKEN"] = token
	}
	if env["GH_TOKEN"] == "" && env["GITHUB_TOKEN"] == "" {
		if token := githubAuthTokenFromCLI(); token != "" {
			env["GH_TOKEN"] = token
			env["GITHUB_TOKEN"] = token
		}
	}
	if env["GH_TOKEN"] == "" && env["GITHUB_TOKEN"] != "" {
		env["GH_TOKEN"] = env["GITHUB_TOKEN"]
	}
	if env["GITHUB_TOKEN"] == "" && env["GH_TOKEN"] != "" {
		env["GITHUB_TOKEN"] = env["GH_TOKEN"]
	}
	return env
}

func githubAuthTokenFromCLI() string {
	if _, err := exec.LookPath("gh"); err != nil {
		return ""
	}
	cmd := exec.Command("gh", "auth", "token")
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	output, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func isGitHubRepoURL(repoURL string) bool {
	value := strings.TrimSpace(repoURL)
	if value == "" {
		return false
	}
	parsed, err := url.Parse(value)
	if err == nil && parsed.Hostname() != "" {
		return normalizedGitHost(parsed.Hostname()) == "github.com"
	}
	scpLike := strings.ToLower(value)
	if at := strings.LastIndex(scpLike, "@"); at >= 0 {
		scpLike = scpLike[at+1:]
	}
	if idx := strings.IndexAny(scpLike, ":/"); idx >= 0 {
		scpLike = scpLike[:idx]
	}
	return normalizedGitHost(scpLike) == "github.com"
}

func normalizedGitHost(host string) string {
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	return strings.TrimPrefix(host, "www.")
}

type remoteAuthFile struct {
	Source string
	Target string
	Data   string
}

func localRemoteAuthFiles(sshUser string) []remoteAuthFile {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return nil
	}
	remoteHome := remoteHomeDir(sshUser)
	candidates := []struct {
		source string
		target string
	}{
		{filepath.Join(home, ".codex", "auth.json"), filepath.Join(remoteHome, ".codex", "auth.json")},
		{filepath.Join(home, ".codex", "config.toml"), filepath.Join(remoteHome, ".codex", "config.toml")},
		{filepath.Join(home, ".claude.json"), filepath.Join(remoteHome, ".claude.json")},
		{filepath.Join(home, ".claude", "settings.json"), filepath.Join(remoteHome, ".claude", "settings.json")},
	}
	var files []remoteAuthFile
	for _, candidate := range candidates {
		data, err := readRemoteAuthFile(candidate.source)
		if err != nil {
			continue
		}
		files = append(files, remoteAuthFile{
			Source: candidate.source,
			Target: candidate.target,
			Data:   data,
		})
	}
	return files
}

func readRemoteAuthFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() <= 0 || info.Size() > maxRemoteAuthFileBytes {
		return "", fmt.Errorf("skip auth file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func remoteAuthFilesScript(machine remoteMachine, files []remoteAuthFile) string {
	var script strings.Builder
	remoteHome := remoteHomeDir(machine.SSHUser)
	for _, file := range files {
		target := filepath.Clean(strings.TrimSpace(file.Target))
		if !isPathInsideRemoteHome(target, remoteHome) || strings.Contains(target, "\x00") {
			continue
		}
		script.WriteString("install -d -m 0700 ")
		script.WriteString(shellQuote(filepath.Dir(target)))
		script.WriteString("\nprintf %s ")
		script.WriteString(shellQuote(base64.StdEncoding.EncodeToString([]byte(file.Data))))
		script.WriteString(" | base64 -d > ")
		script.WriteString(shellQuote(target))
		script.WriteString("\nchmod 0600 ")
		script.WriteString(shellQuote(target))
		script.WriteString("\n")
	}
	return script.String()
}

func remoteHomeDir(user string) string {
	user = strings.TrimSpace(user)
	if user == "" {
		user = remoteDefaultSSHUser
	}
	if user == "root" {
		return "/root"
	}
	return filepath.Join("/home", user)
}

func isPathInsideRemoteHome(path string, remoteHome string) bool {
	if path == "" || remoteHome == "" {
		return false
	}
	home := filepath.Clean(remoteHome)
	return path == home || strings.HasPrefix(path, home+"/")
}

func shellJoin(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, arg := range args {
		quoted = append(quoted, shellQuote(arg))
	}
	return strings.Join(quoted, " ")
}

func shellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func commandExists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func requireRemoteClientTools(names ...string) error {
	for _, name := range names {
		if commandExists(name) {
			continue
		}
		switch name {
		case "rsync":
			return fmt.Errorf("rsync is required for remote mode full-directory sync")
		case "ssh":
			return fmt.Errorf("ssh is required for remote mode")
		case "ssh-keygen":
			return fmt.Errorf("ssh-keygen is required for remote mode")
		default:
			return fmt.Errorf("%s is required for remote mode", name)
		}
	}
	return nil
}

func displayTime(value time.Time) string {
	if value.IsZero() {
		return "(not set)"
	}
	return value.Format(time.RFC3339)
}

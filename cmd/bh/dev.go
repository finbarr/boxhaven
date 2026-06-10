package main

import (
	"fmt"
	"path/filepath"
	"strings"
)

// bh dev is the one-command flow: derive the box name from the project,
// create the box if it does not exist, sync the project, and run the
// configured (or given) command in the managed session.
func runRemoteDev(args []string, projectDir string) error {
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	opts, noSync, command, err := parseRemoteDevArgs(args, cfg)
	if err != nil {
		return err
	}
	opts.Name = remoteDevBoxName(cfg, projectDir)
	if err := validateRemoteName(opts.Name); err != nil {
		return fmt.Errorf("derived box name %q is invalid (set remote_name in .boxhaven.toml): %w", opts.Name, err)
	}
	cfg, err = remoteConfigForProvision(cfg, opts)
	if err != nil {
		return err
	}
	if len(command) == 0 {
		command = cfg.Command
	}

	machine, _, err := getRemoteBackendMachine(cfg, opts.Name)
	switch {
	case err == nil:
		if err := requireRemoteMachineBootstrapped(machine); err != nil {
			return err
		}
		info("Using existing box %s", opts.Name)
	case remoteBackendErrorCode(err) == "not_found":
		info("No box named %s yet; creating it", opts.Name)
		if _, err := createRemoteMachine(cfg, projectDir, opts, !noSync); err != nil {
			return err
		}
		// The box was synced during create; do not sync again below.
		noSync = true
	default:
		return err
	}

	machine, cleanup, err := readyExistingRemoteMachine(cfg, projectDir, opts.Name, !noSync)
	if err != nil {
		return err
	}
	defer cleanup()
	return runRemoteMachineCommand(cfg, machine, command, projectDir)
}

func parseRemoteDevArgs(args []string, cfg Config) (remoteProvisionOptions, bool, []string, error) {
	opts := remoteProvisionOptions{
		SSHUser:    cfg.Remote.SSHUser,
		BackendURL: remoteBackendURL(cfg),
		Provider:   cfg.Remote.Provider,
	}
	noSync := false
	var command []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		flagValue := func(flag string) (string, error) {
			if strings.HasPrefix(arg, flag+"=") {
				return strings.TrimPrefix(arg, flag+"="), nil
			}
			i++
			if i >= len(args) {
				return "", fmt.Errorf("bh dev %s requires a value", flag)
			}
			return args[i], nil
		}
		switch {
		case len(command) > 0:
			command = append(command, arg)
		case arg == "-h" || arg == "--help" || arg == "help":
			printRemoteUsage()
			return opts, noSync, nil, errHelp
		case arg == "--no-sync":
			noSync = true
		case arg == "--provider" || strings.HasPrefix(arg, "--provider="):
			value, err := flagValue("--provider")
			if err != nil {
				return opts, noSync, nil, err
			}
			opts.Provider = strings.ToLower(strings.TrimSpace(value))
		case arg == "--tier" || strings.HasPrefix(arg, "--tier="):
			value, err := flagValue("--tier")
			if err != nil {
				return opts, noSync, nil, err
			}
			opts.Tier = value
		case arg == "--region" || strings.HasPrefix(arg, "--region="):
			value, err := flagValue("--region")
			if err != nil {
				return opts, noSync, nil, err
			}
			opts.Region = value
		case arg == "--image" || strings.HasPrefix(arg, "--image="):
			value, err := flagValue("--image")
			if err != nil {
				return opts, noSync, nil, err
			}
			opts.Image = value
		case arg == "--team" || strings.HasPrefix(arg, "--team="):
			value, err := flagValue("--team")
			if err != nil {
				return opts, noSync, nil, err
			}
			opts.Team = value
		case strings.HasPrefix(arg, "-"):
			return opts, noSync, nil, fmt.Errorf("unknown bh dev option: %s (the command starts at the first non-flag argument)", arg)
		default:
			command = append(command, arg)
		}
	}
	tier, err := normalizeRemoteMachineTier(opts.Tier)
	if err != nil {
		return opts, noSync, nil, err
	}
	opts.Tier = tier
	return opts, noSync, command, nil
}

// remoteDevBoxName picks the box for bh dev: the remote_name config key when
// set, otherwise a name derived from the project directory.
func remoteDevBoxName(cfg Config, projectDir string) string {
	if cfg.RemoteName != "" {
		return cfg.RemoteName
	}
	base := strings.ToLower(filepath.Base(projectDir))
	var b strings.Builder
	lastDash := true
	for _, r := range base {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	name := strings.Trim(b.String(), "-")
	if len(name) > 63 {
		name = strings.Trim(name[:63], "-")
	}
	if name == "" {
		return "dev"
	}
	return name
}

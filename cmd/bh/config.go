package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

type RemoteConfig struct {
	BackendURL string   `toml:"backend_url"`
	Token      string   `toml:"token"`
	SSHUser    string   `toml:"ssh_user"`
	Setup      []string `toml:"setup"`
}

type Config struct {
	RemoteName string       `toml:"remote_name"`
	Command    []string     `toml:"command"`
	Remote     RemoteConfig `toml:"remote"`
}

func defaultConfig() Config {
	return Config{
		Remote: RemoteConfig{
			BackendURL: defaultRemoteBackendURL,
			SSHUser:    "root",
		},
	}
}

func loadConfig(projectDir string) (Config, error) {
	cfg := defaultConfig()
	globalPath, err := globalConfigPath()
	if err != nil {
		return Config{}, err
	}
	if err := mergeConfigFile(globalPath, &cfg); err != nil {
		return Config{}, err
	}
	if err := mergeConfigFile(filepath.Join(projectDir, ".boxhaven.toml"), &cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func loadSetupDefaults() (Config, error) {
	cfg := defaultConfig()
	globalPath, err := globalConfigPath()
	if err != nil {
		return Config{}, err
	}
	if err := mergeConfigFile(globalPath, &cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func globalConfigPath() (string, error) {
	if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
		return filepath.Join(xdg, "boxhaven", "config.toml"), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "boxhaven", "config.toml"), nil
}

func mergeConfigFile(path string, cfg *Config) error {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var fileCfg Config
	if _, err := toml.DecodeFile(path, &fileCfg); err != nil {
		return err
	}
	mergeConfig(cfg, fileCfg)
	return nil
}

func mergeConfig(dst *Config, src Config) {
	if src.RemoteName != "" {
		dst.RemoteName = strings.ToLower(strings.TrimSpace(src.RemoteName))
	}
	if len(src.Command) > 0 {
		dst.Command = append([]string{}, src.Command...)
	}
	if src.Remote.BackendURL != "" {
		dst.Remote.BackendURL = strings.TrimRight(strings.TrimSpace(src.Remote.BackendURL), "/")
	}
	if src.Remote.Token != "" {
		dst.Remote.Token = strings.TrimSpace(src.Remote.Token)
	}
	if src.Remote.SSHUser != "" {
		dst.Remote.SSHUser = strings.TrimSpace(src.Remote.SSHUser)
	}
	if len(src.Remote.Setup) > 0 {
		dst.Remote.Setup = append([]string{}, src.Remote.Setup...)
	}
}

func saveGlobalConfig(cfg Config) error {
	path, err := globalConfigPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}

	var lines []string
	if name := strings.TrimSpace(cfg.RemoteName); name != "" {
		lines = append(lines, fmt.Sprintf("remote_name = %q", strings.ToLower(name)))
	}
	if len(cfg.Command) > 0 {
		lines = append(lines, fmt.Sprintf("command = %s", formatTomlStringSlice(cfg.Command)))
	}
	lines = append(lines, "", "[remote]")
	if cfg.Remote.BackendURL != "" && cfg.Remote.BackendURL != defaultConfig().Remote.BackendURL {
		lines = append(lines, fmt.Sprintf("backend_url = %q", cfg.Remote.BackendURL))
	}
	if cfg.Remote.Token != "" {
		lines = append(lines, fmt.Sprintf("token = %q", cfg.Remote.Token))
	}
	if cfg.Remote.SSHUser != "" && cfg.Remote.SSHUser != defaultConfig().Remote.SSHUser {
		lines = append(lines, fmt.Sprintf("ssh_user = %q", cfg.Remote.SSHUser))
	}
	if len(cfg.Remote.Setup) > 0 {
		lines = append(lines, fmt.Sprintf("setup = %s", formatTomlStringSlice(cfg.Remote.Setup)))
	}
	return os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0600)
}

func printConfig(cfg Config) error {
	fmt.Printf("%sbackend_url:%s %s\n", colorBold, colorReset, remoteBackendURL(cfg))
	fmt.Printf("%stoken:%s %s\n", colorBold, colorReset, redactConfigSecret(remoteAuthToken(cfg)))
	fmt.Printf("%sssh_user:%s %s\n", colorBold, colorReset, configValueOrNotSet(cfg.Remote.SSHUser))
	fmt.Printf("%sremote_name:%s %s\n", colorBold, colorReset, configValueOrNotSet(cfg.RemoteName))
	printSliceConfigField("command", cfg.Command)
	printSliceConfigField("setup", cfg.Remote.Setup)
	return nil
}

func printSliceConfigField(name string, values []string) {
	if len(values) == 0 {
		fmt.Printf("%s%s:%s (none)\n", colorBold, name, colorReset)
		return
	}
	fmt.Printf("%s%s:%s\n", colorBold, name, colorReset)
	for _, value := range values {
		fmt.Printf("  - %s\n", value)
	}
}

func formatTomlStringSlice(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, fmt.Sprintf("%q", value))
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

func redactConfigSecret(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "(not set)"
	}
	if len(value) <= 8 {
		return "********"
	}
	return value[:4] + "..." + value[len(value)-4:]
}

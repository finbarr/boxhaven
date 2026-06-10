package main

import (
	"fmt"
	"strings"
)

func validateRemoteName(name string) error {
	if name == "" {
		return fmt.Errorf("remote name cannot be empty")
	}
	if len(name) > 63 {
		return fmt.Errorf("remote name %q is too long; max 63 characters", name)
	}
	for i, r := range name {
		ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-'
		if !ok {
			return fmt.Errorf("remote name %q must use lowercase letters, numbers, and hyphens", name)
		}
		if i == 0 && r == '-' {
			return fmt.Errorf("remote name %q must start with a letter or number", name)
		}
	}
	if strings.HasSuffix(name, "-") {
		return fmt.Errorf("remote name %q must end with a letter or number", name)
	}
	return nil
}

func remoteCommandNeedsTTY(command []string) bool {
	if len(command) == 0 {
		return true
	}
	switch strings.TrimSpace(command[0]) {
	case "shell", "bash", "sh", "zsh", "fish":
		// A bare shell is an interactive session; a shell with arguments
		// (bash -lc '...', sh script.sh) is a one-off command over SSH.
		return len(command) == 1
	case "claude", "codex", "gemini", "opencode", "copilot", "pi":
		return true
	default:
		return false
	}
}

func remoteShellCommand(command []string) bool {
	return len(command) == 0 || (len(command) == 1 && (command[0] == "shell" || command[0] == "bash"))
}

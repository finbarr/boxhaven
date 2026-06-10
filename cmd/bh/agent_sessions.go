package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	maxAgentSessionsToForward  = 3
	maxAgentSessionFileBytes   = 256 << 20
	maxCodexSessionAgeDays     = 14
	codexSessionSniffBytes     = 16 << 10
	codexSessionsRelativePath  = ".codex/sessions"
	claudeProjectsRelativePath = ".claude/projects"
)

// forwardAgentSessions copies the newest local agent sessions for this
// project onto the box, keyed so the agent finds them at the box's project
// path. Claude sessions move between the per-project directories; codex
// sessions keep their date layout and are matched by recorded cwd.
func forwardAgentSessions(machine remoteMachine, agent string, projectDir string) (int, int64, error) {
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return 0, 0, nil
	}
	var sources []agentSessionFile
	switch agent {
	case "claude":
		sources = claudeSessionFiles(home, projectDir, remoteWorkPath(machine))
	case "codex":
		sources = codexSessionFiles(home, projectDir)
	default:
		return 0, 0, nil
	}
	if len(sources) == 0 {
		return 0, 0, nil
	}

	stage, err := os.MkdirTemp("", "boxhaven-agent-sessions-*")
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = os.RemoveAll(stage) }()
	var total int64
	staged := 0
	for _, source := range sources {
		target := filepath.Join(stage, source.RemoteRelativePath)
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return 0, 0, err
		}
		size, err := copyFile(source.LocalPath, target)
		if err != nil {
			continue
		}
		total += size
		staged++
	}
	if staged == 0 {
		return 0, 0, nil
	}

	if err := rsyncStageToRemoteHome(machine, stage); err != nil {
		return 0, 0, err
	}
	return staged, total, nil
}

// forwardSessionsForCommand forwards local sessions when the command starts
// a session-capable agent; other commands are untouched.
func forwardSessionsForCommand(machine remoteMachine, command []string, projectDir string) {
	if len(command) == 0 {
		return
	}
	agent := strings.TrimSpace(command[0])
	if agent != "claude" && agent != "codex" {
		return
	}
	count, size, err := forwardAgentSessions(machine, agent, projectDir)
	if err != nil {
		warn("Could not forward local %s sessions: %v", agent, err)
		return
	}
	if count == 0 {
		return
	}
	info("Forwarded %d recent local %s session(s) (%s) for this project", count, agent, formatByteSize(size))
	if agent == "claude" && !argsMentionResume(command[1:]) {
		info("Resume the latest with `bh run %s claude --continue`", machine.Name)
	}
}

// argsMentionResume reports whether the agent arguments already resume a
// session, so the hint is not printed redundantly.
func argsMentionResume(args []string) bool {
	for _, arg := range args {
		switch arg {
		case "--continue", "-c", "--resume", "-r", "resume":
			return true
		}
	}
	return false
}

func formatByteSize(size int64) string {
	switch {
	case size >= 1<<20:
		return fmt.Sprintf("%.1fMB", float64(size)/(1<<20))
	case size >= 1<<10:
		return fmt.Sprintf("%.0fKB", float64(size)/(1<<10))
	default:
		return fmt.Sprintf("%dB", size)
	}
}

type agentSessionFile struct {
	LocalPath          string
	RemoteRelativePath string
	ModTime            time.Time
}

// claudeProjectDirName mirrors how Claude Code names per-project session
// directories: every character outside [a-zA-Z0-9] becomes a dash.
func claudeProjectDirName(projectPath string) string {
	var b strings.Builder
	for _, r := range projectPath {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('-')
	}
	return b.String()
}

func claudeSessionFiles(home string, projectDir string, remoteProjectPath string) []agentSessionFile {
	localDir := filepath.Join(home, claudeProjectsRelativePath, claudeProjectDirName(projectDir))
	entries, err := os.ReadDir(localDir)
	if err != nil {
		return nil
	}
	remoteDir := filepath.Join(claudeProjectsRelativePath, claudeProjectDirName(remoteProjectPath))
	var files []agentSessionFile
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		fileInfo, err := entry.Info()
		if err != nil || fileInfo.Size() <= 0 || fileInfo.Size() > maxAgentSessionFileBytes {
			continue
		}
		files = append(files, agentSessionFile{
			LocalPath:          filepath.Join(localDir, entry.Name()),
			RemoteRelativePath: filepath.Join(remoteDir, entry.Name()),
			ModTime:            fileInfo.ModTime(),
		})
	}
	return newestSessions(files)
}

func codexSessionFiles(home string, projectDir string) []agentSessionFile {
	root := filepath.Join(home, codexSessionsRelativePath)
	cutoff := time.Now().AddDate(0, 0, -maxCodexSessionAgeDays)
	var files []agentSessionFile
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			return nil
		}
		fileInfo, err := entry.Info()
		if err != nil || fileInfo.Size() <= 0 || fileInfo.Size() > maxAgentSessionFileBytes || fileInfo.ModTime().Before(cutoff) {
			return nil
		}
		if !fileMentionsPath(path, projectDir) {
			return nil
		}
		relative, err := filepath.Rel(home, path)
		if err != nil || strings.HasPrefix(relative, "..") {
			return nil
		}
		files = append(files, agentSessionFile{
			LocalPath:          path,
			RemoteRelativePath: relative,
			ModTime:            fileInfo.ModTime(),
		})
		return nil
	})
	return newestSessions(files)
}

func newestSessions(files []agentSessionFile) []agentSessionFile {
	sort.Slice(files, func(i, j int) bool {
		return files[i].ModTime.After(files[j].ModTime)
	})
	if len(files) > maxAgentSessionsToForward {
		files = files[:maxAgentSessionsToForward]
	}
	return files
}

// fileMentionsPath reports whether the head of a codex session records the
// project directory as its working directory.
func fileMentionsPath(path string, projectDir string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer func() { _ = file.Close() }()
	head := make([]byte, codexSessionSniffBytes)
	read, _ := io.ReadFull(file, head)
	return strings.Contains(string(head[:read]), projectDir)
}

func copyFile(source string, target string) (int64, error) {
	in, err := os.Open(source)
	if err != nil {
		return 0, err
	}
	defer func() { _ = in.Close() }()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, err
	}
	size, err := io.Copy(out, in)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	return size, err
}

func rsyncStageToRemoteHome(machine remoteMachine, stage string) error {
	if err := requireRemoteClientTools("ssh", "rsync"); err != nil {
		return err
	}
	sshCommand, err := remoteSSHCommand(machine, false)
	if err != nil {
		return err
	}
	target := machine.sshTarget() + ":" + remoteHomeDir(machine.SSHUser) + "/"
	cmd := exec.Command("rsync", "-az", "--human-readable", "-e", sshCommand, stage+string(os.PathSeparator), target)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("forward agent sessions: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestRemoteMachineListJSON(t *testing.T) {
	now := time.Now()
	var output bytes.Buffer
	if err := writeRemoteMachineListJSON(&output, nil, now); err != nil {
		t.Fatal(err)
	}
	if output.String() != "{\"machines\":[]}\n" {
		t.Fatalf("empty list = %q", output.String())
	}
	output.Reset()
	machines := []remoteMachine{
		{Name: "ready", BootstrapComplete: true, AgentLastSeenAt: now, SSHKeyPath: "private-key", SSHCertificatePath: "private-cert"},
		{Name: "starting"},
		{Name: "stale", BootstrapComplete: true, AgentLastSeenAt: now.Add(-10 * time.Minute)},
		{Name: "interrupted", CreateState: "recovery_required"},
	}
	if err := writeRemoteMachineListJSON(&output, machines, now); err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Machines []struct{ Name, Status string }
	}
	if err := json.Unmarshal(output.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	for i, status := range []string{"online", "creating", "offline", "recovery required"} {
		if decoded.Machines[i].Name != machines[i].Name || decoded.Machines[i].Status != status {
			t.Fatalf("machine %d = %+v", i, decoded.Machines[i])
		}
	}
	if strings.Contains(output.String(), "private-") {
		t.Fatal("JSON exposed private SSH paths")
	}
}

func TestRemoteListRejectsUnknownFlags(t *testing.T) {
	if err := runRemoteList([]string{"--unexpected"}, t.TempDir()); err == nil {
		t.Fatal("unknown list flag accepted")
	}
}

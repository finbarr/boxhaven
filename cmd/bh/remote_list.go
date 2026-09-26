package main

import (
	"encoding/json"
	"io"
	"time"
)

// JSON consumers get the same liveness label as the human-readable list.
// remoteMachine's private SSH fields are deliberately excluded by its JSON tags.
func writeRemoteMachineListJSON(w io.Writer, machines []remoteMachine, now time.Time) error {
	type entry struct {
		remoteMachine
		Status string `json:"status"`
	}
	entries := make([]entry, 0, len(machines))
	for _, machine := range machines {
		entries = append(entries, entry{machine, remoteMachineStatusLabel(machine, now)})
	}
	return json.NewEncoder(w).Encode(struct {
		Machines []entry `json:"machines"`
	}{entries})
}

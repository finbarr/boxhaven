package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"golang.org/x/term"
)

func confirmDestructiveAction(action string, force bool) error {
	if force {
		return nil
	}
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return fmt.Errorf("%s; pass --force to continue", action)
	}
	fmt.Fprintf(os.Stderr, "%s? Type \"yes\" to continue: ", action)
	answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return err
	}
	if strings.ToLower(strings.TrimSpace(answer)) != "yes" {
		return fmt.Errorf("aborted")
	}
	return nil
}

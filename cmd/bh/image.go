package main

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"
)

type remoteImage struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Provider     string  `json:"provider,omitempty"`
	Status       string  `json:"status,omitempty"`
	CreatedAt    string  `json:"created_at,omitempty"`
	SizeGB       float64 `json:"size_gb,omitempty"`
	Bootstrapped bool    `json:"bootstrapped,omitempty"`
	Active       bool    `json:"active,omitempty"`
}

type remoteImageListResponse struct {
	Images []remoteImage `json:"images"`
}

type remoteImageResponse struct {
	Image remoteImage `json:"image"`
}

type remoteImageCreateRequest struct {
	Machine string `json:"machine"`
	Name    string `json:"name,omitempty"`
}

type remoteImageActivateRequest struct {
	Provider string `json:"provider,omitempty"`
	ID       string `json:"id"`
}

type remoteImageDeactivateRequest struct {
	Provider string `json:"provider,omitempty"`
}

type remoteImageActiveState struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Bootstrapped bool   `json:"bootstrapped,omitempty"`
	ActivatedAt  string `json:"activated_at,omitempty"`
}

type remoteImageActivateResponse struct {
	Provider string                 `json:"provider"`
	Active   remoteImageActiveState `json:"active"`
}

func runImage(args []string, projectDir string) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		printImageUsage()
		return errHelp
	}

	switch args[0] {
	case "ls", "list":
		return runImageList(args[1:], projectDir)
	case "create":
		return runImageCreate(args[1:], projectDir)
	case "activate":
		return runImageActivate(args[1:], projectDir)
	case "deactivate":
		return runImageDeactivate(args[1:], projectDir)
	case "rm":
		return runImageRemove(args[1:], projectDir)
	default:
		return fmt.Errorf("unknown bh image command: %s (try 'bh image --help')", args[0])
	}
}

func printImageUsage() {
	fmt.Fprintln(os.Stderr, "USAGE:")
	fmt.Fprintln(os.Stderr, "  bh image ls [--provider <name>]")
	fmt.Fprintln(os.Stderr, "  bh image create <machine> [--name <name>]")
	fmt.Fprintln(os.Stderr, "  bh image activate <id> [--provider <name>]")
	fmt.Fprintln(os.Stderr, "  bh image deactivate [--provider <name>]")
	fmt.Fprintln(os.Stderr, "  bh image rm <id> [--provider <name>]")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Golden images are admin-only. The active image becomes the default for new boxes")
	fmt.Fprintln(os.Stderr, "on its provider; without --provider the backend's default provider is used.")
}

func parseImageArgs(command string, args []string, wantPositional bool) (string, string, error) {
	positional := ""
	provider := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--provider":
			i++
			if i >= len(args) {
				return "", "", fmt.Errorf("bh image %s --provider requires a value", command)
			}
			provider = args[i]
		case strings.HasPrefix(arg, "--provider="):
			provider = strings.TrimPrefix(arg, "--provider=")
		case strings.HasPrefix(arg, "-"):
			return "", "", fmt.Errorf("unknown bh image %s option: %s", command, arg)
		default:
			if !wantPositional || positional != "" {
				return "", "", fmt.Errorf("unexpected bh image %s argument: %s", command, arg)
			}
			positional = arg
		}
	}
	return strings.TrimSpace(positional), strings.ToLower(strings.TrimSpace(provider)), nil
}

func runImageList(args []string, projectDir string) error {
	_, provider, err := parseImageArgs("ls", args, false)
	if err != nil {
		return err
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	endpoint := "/v1/images"
	if provider != "" {
		endpoint += "?provider=" + url.QueryEscape(provider)
	}
	var response remoteImageListResponse
	if err := remoteBackendRequest(cfg, http.MethodGet, endpoint, nil, &response); err != nil {
		return err
	}
	if len(response.Images) == 0 {
		if _, err := fmt.Fprintln(os.Stdout, "No golden images yet. Run `bh image create <machine>` to snapshot a box."); err != nil {
			return err
		}
		return nil
	}
	table := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	if _, err := fmt.Fprintln(table, "PROVIDER\tNAME\tID\tSTATUS\tSIZE\tCREATED\tACTIVE"); err != nil {
		return err
	}
	for _, image := range response.Images {
		active := ""
		if image.Active {
			active = "yes"
		}
		if _, err := fmt.Fprintf(
			table,
			"%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			valueOrDash(image.Provider),
			valueOrDash(image.Name),
			valueOrDash(image.ID),
			valueOrDash(image.Status),
			imageSizeDisplay(image.SizeGB),
			valueOrDash(image.CreatedAt),
			active,
		); err != nil {
			return err
		}
	}
	return table.Flush()
}

func imageSizeDisplay(sizeGB float64) string {
	if sizeGB <= 0 {
		return "-"
	}
	return strconv.FormatFloat(sizeGB, 'f', -1, 64) + "GB"
}

func runImageCreate(args []string, projectDir string) error {
	machine := ""
	name := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--name":
			i++
			if i >= len(args) {
				return fmt.Errorf("bh image create --name requires a value")
			}
			name = args[i]
		case strings.HasPrefix(arg, "--name="):
			name = strings.TrimPrefix(arg, "--name=")
		case strings.HasPrefix(arg, "-"):
			return fmt.Errorf("unknown bh image create option: %s", arg)
		default:
			if machine != "" {
				return fmt.Errorf("unexpected bh image create argument: %s", arg)
			}
			machine = arg
		}
	}
	machine = strings.ToLower(strings.TrimSpace(machine))
	if machine == "" {
		return fmt.Errorf("bh image create requires a machine name")
	}
	if err := validateRemoteName(machine); err != nil {
		return err
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	req := remoteImageCreateRequest{Machine: machine, Name: strings.TrimSpace(name)}
	var response remoteImageResponse
	if err := remoteBackendRequest(cfg, http.MethodPost, "/v1/images", req, &response); err != nil {
		return err
	}
	imageName := firstNonEmpty(response.Image.Name, req.Name, machine)
	success("Snapshot %s started from %s", imageName, machine)
	info("Snapshots take a few minutes; watch progress with `bh image ls`.")
	return nil
}

func runImageActivate(args []string, projectDir string) error {
	id, provider, err := parseImageArgs("activate", args, true)
	if err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("bh image activate requires an image id")
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	req := remoteImageActivateRequest{Provider: provider, ID: id}
	var response remoteImageActivateResponse
	if err := remoteBackendRequest(cfg, http.MethodPost, "/v1/images/activate", req, &response); err != nil {
		return err
	}
	success("Activated image %s on %s; new boxes now boot from it", firstNonEmpty(response.Active.Name, id), firstNonEmpty(response.Provider, provider, "the default provider"))
	return nil
}

func runImageDeactivate(args []string, projectDir string) error {
	_, provider, err := parseImageArgs("deactivate", args, false)
	if err != nil {
		return err
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	req := remoteImageDeactivateRequest{Provider: provider}
	if err := remoteBackendRequest(cfg, http.MethodPost, "/v1/images/deactivate", req, nil); err != nil {
		return err
	}
	success("Deactivated the active image on %s; new boxes fall back to the backend's configured image", firstNonEmpty(provider, "the default provider"))
	return nil
}

func runImageRemove(args []string, projectDir string) error {
	id, provider, err := parseImageArgs("rm", args, true)
	if err != nil {
		return err
	}
	if id == "" {
		return fmt.Errorf("bh image rm requires an image id")
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	endpoint := "/v1/images/" + url.PathEscape(id)
	if provider != "" {
		endpoint += "?provider=" + url.QueryEscape(provider)
	}
	if err := remoteBackendRequest(cfg, http.MethodDelete, endpoint, nil, nil); err != nil {
		return err
	}
	success("Deleted image %s", id)
	return nil
}

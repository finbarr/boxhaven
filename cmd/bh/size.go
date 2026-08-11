package main

import (
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
)

type remoteMachinePlanPrice struct {
	Region   string  `json:"region,omitempty"`
	Hourly   float64 `json:"hourly"`
	Monthly  float64 `json:"monthly"`
	Currency string  `json:"currency"`
}

type remoteMachinePlanGPU struct {
	Count    int    `json:"count"`
	Model    string `json:"model"`
	MemoryMB int    `json:"memory_mb,omitempty"`
}

type remoteMachinePlan struct {
	Provider         string                   `json:"provider"`
	Slug             string                   `json:"slug"`
	Label            string                   `json:"label"`
	VCPUs            int                      `json:"vcpus"`
	MemoryMB         int                      `json:"memory_mb"`
	DiskGB           int                      `json:"disk_gb"`
	Available        bool                     `json:"available"`
	Regions          []string                 `json:"regions"`
	Prices           []remoteMachinePlanPrice `json:"prices"`
	HourlyPriceCents *int                     `json:"hourly_price_cents,omitempty"`
	GPU              *remoteMachinePlanGPU    `json:"gpu,omitempty"`
}

type remoteMachineSizeOption struct {
	Name             string            `json:"name"`
	Kind             string            `json:"kind"`
	Provider         string            `json:"provider"`
	Plan             remoteMachinePlan `json:"plan"`
	HourlyPriceCents *int              `json:"hourly_price_cents,omitempty"`
}

type remoteSizesResponse struct {
	Plans []remoteMachinePlan       `json:"plans"`
	Sizes []remoteMachineSizeOption `json:"sizes"`
}

type remoteSizeShortcutRequest struct {
	Name     string `json:"name"`
	Provider string `json:"provider"`
	Plan     string `json:"plan"`
	Team     string `json:"team,omitempty"`
}

func runSize(args []string, projectDir string) error {
	if len(args) == 0 || args[0] == "-h" || args[0] == "--help" {
		printSizeUsage()
		return errHelp
	}
	switch args[0] {
	case "list", "ls":
		return runSizeList(args[1:], projectDir, false)
	case "plans":
		return runSizeList(args[1:], projectDir, true)
	case "create":
		return runSizeCreate(args[1:], projectDir)
	case "rm", "delete":
		return runSizeDelete(args[1:], projectDir)
	default:
		return fmt.Errorf("unknown bh size command: %s", args[0])
	}
}

func printSizeUsage() {
	fmt.Fprintln(os.Stderr, "USAGE:")
	fmt.Fprintln(os.Stderr, "  bh size list [--provider <name>] [--region <region>] [--team <team>]")
	fmt.Fprintln(os.Stderr, "  bh size plans [--provider <name>] [--region <region>] [--team <team>]")
	fmt.Fprintln(os.Stderr, "  bh size create <name> --provider <name> --plan <slug> [--team <team>]")
	fmt.Fprintln(os.Stderr, "  bh size rm <name> [--team <team>]")
}

func runSizeList(args []string, projectDir string, plans bool) error {
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	values, err := parseSizeFlags(args)
	if err != nil {
		return err
	}
	query := url.Values{}
	for _, key := range []string{"provider", "region", "team"} {
		if values[key] != "" {
			query.Set(key, values[key])
		}
	}
	path := "/v1/sizes"
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	var response remoteSizesResponse
	if err := remoteBackendRequest(cfg, http.MethodGet, path, nil, &response); err != nil {
		return err
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	if plans {
		if _, err := fmt.Fprintln(w, "PLAN\tCPU\tMEMORY\tDISK\tGPU\tPRICE"); err != nil {
			return err
		}
		sort.Slice(response.Plans, func(i, j int) bool { return response.Plans[i].Slug < response.Plans[j].Slug })
		for _, plan := range response.Plans {
			if !plan.Available {
				continue
			}
			gpu := "-"
			if plan.GPU != nil {
				gpu = fmt.Sprintf("%dx %s", plan.GPU.Count, plan.GPU.Model)
			}
			price := formatProviderPrice(plan.Prices)
			if plan.HourlyPriceCents != nil {
				price = formatDollarPrice(*plan.HourlyPriceCents)
			}
			if _, err := fmt.Fprintf(w, "%s\t%d\t%s\t%d GB\t%s\t%s\n", plan.Slug, plan.VCPUs, formatMemory(plan.MemoryMB), plan.DiskGB, gpu, price); err != nil {
				return err
			}
		}
	} else {
		if _, err := fmt.Fprintln(w, "NAME\tKIND\tPROVIDER PLAN\tCPU\tMEMORY\tPRICE"); err != nil {
			return err
		}
		for _, size := range response.Sizes {
			price := formatProviderPrice(size.Plan.Prices)
			if size.HourlyPriceCents != nil {
				price = formatDollarPrice(*size.HourlyPriceCents)
			}
			if _, err := fmt.Fprintf(w, "%s\t%s\t%s/%s\t%d\t%s\t%s\n", size.Name, size.Kind, size.Provider, size.Plan.Slug, size.Plan.VCPUs, formatMemory(size.Plan.MemoryMB), price); err != nil {
				return err
			}
		}
	}
	return w.Flush()
}

func runSizeCreate(args []string, projectDir string) error {
	if len(args) == 0 {
		return fmt.Errorf("bh size create requires a shortcut name")
	}
	name, err := normalizeRemoteMachineSize(args[0])
	if err != nil {
		return err
	}
	values, err := parseSizeFlags(args[1:])
	if err != nil {
		return err
	}
	if values["provider"] == "" || values["plan"] == "" {
		return fmt.Errorf("bh size create requires --provider and --plan")
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	var response struct {
		Shortcut remoteSizeShortcutRequest `json:"shortcut"`
	}
	err = remoteBackendRequest(cfg, http.MethodPost, "/v1/sizes/shortcuts", remoteSizeShortcutRequest{Name: name, Provider: values["provider"], Plan: values["plan"], Team: values["team"]}, &response)
	if err != nil {
		return err
	}
	success("Saved size %s as %s/%s", name, response.Shortcut.Provider, response.Shortcut.Plan)
	return nil
}

func runSizeDelete(args []string, projectDir string) error {
	if len(args) == 0 {
		return fmt.Errorf("bh size rm requires a shortcut name")
	}
	name, err := normalizeRemoteMachineSize(args[0])
	if err != nil {
		return err
	}
	values, err := parseSizeFlags(args[1:])
	if err != nil {
		return err
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	path := "/v1/sizes/shortcuts/" + url.PathEscape(name)
	if values["team"] != "" {
		path += "?team=" + url.QueryEscape(values["team"])
	}
	if err := remoteBackendRequest(cfg, http.MethodDelete, path, nil, nil); err != nil {
		return err
	}
	success("Deleted size %s", name)
	return nil
}

func parseSizeFlags(args []string) (map[string]string, error) {
	values := map[string]string{}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		matched := false
		for _, key := range []string{"provider", "plan", "region", "team"} {
			flag := "--" + key
			if arg == flag {
				i++
				if i >= len(args) {
					return nil, fmt.Errorf("%s requires a value", flag)
				}
				values[key] = strings.TrimSpace(args[i])
				matched = true
				break
			}
			if strings.HasPrefix(arg, flag+"=") {
				values[key] = strings.TrimSpace(strings.TrimPrefix(arg, flag+"="))
				matched = true
				break
			}
		}
		if !matched {
			return nil, fmt.Errorf("unknown bh size option: %s", arg)
		}
	}
	return values, nil
}

func formatMemory(memoryMB int) string {
	if memoryMB >= 1024 && memoryMB%1024 == 0 {
		return strconv.Itoa(memoryMB/1024) + " GB"
	}
	return strconv.Itoa(memoryMB) + " MB"
}

func formatDollarPrice(hourlyCents int) string {
	hourly := float64(hourlyCents) / 100
	return fmt.Sprintf("$%.2f/hr ($%.2f/day, $%.2f/mo)", hourly, hourly*24, hourly*730)
}

func formatProviderPrice(prices []remoteMachinePlanPrice) string {
	if len(prices) == 0 {
		return "-"
	}
	price := prices[0]
	prefix := "$"
	if price.Currency == "EUR" {
		prefix = "EUR "
	}
	return fmt.Sprintf("%s%.4f/hr (%s%.2f/day, %s%.2f/mo)", prefix, price.Hourly, prefix, price.Hourly*24, prefix, price.Hourly*730)
}

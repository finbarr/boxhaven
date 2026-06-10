package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"text/tabwriter"
)

type teamOrganization struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type teamMember struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
	Role   string `json:"role"`
	User   struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"user"`
}

type teamMembersResponse struct {
	Members []teamMember `json:"members"`
	Total   int          `json:"total"`
}

// UnmarshalJSON accepts both {"members":[...]} and a bare member array.
func (r *teamMembersResponse) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		if err := json.Unmarshal(trimmed, &r.Members); err != nil {
			return err
		}
		r.Total = len(r.Members)
		return nil
	}
	type alias teamMembersResponse
	var decoded alias
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*r = teamMembersResponse(decoded)
	return nil
}

type teamCreateRequest struct {
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type teamInviteRequest struct {
	Email          string `json:"email"`
	Role           string `json:"role"`
	OrganizationID string `json:"organizationId"`
}

type teamInvitation struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	Status    string `json:"status"`
	ExpiresAt string `json:"expiresAt,omitempty"`
}

type teamWhoamiResponse struct {
	AppURL string `json:"app_url"`
}

type teamMachine struct {
	remoteMachine
	OwnerEmail string `json:"owner_email,omitempty"`
	OwnerName  string `json:"owner_name,omitempty"`
}

type teamMachinesResponse struct {
	Machines []teamMachine `json:"machines"`
	Role     string        `json:"role,omitempty"`
}

func runTeam(args []string, projectDir string) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "-h" || args[0] == "--help" {
		printTeamUsage()
		return errHelp
	}

	switch args[0] {
	case "list", "ls":
		return runTeamList(args[1:], projectDir)
	case "create":
		return runTeamCreate(args[1:], projectDir)
	case "members":
		return runTeamMembers(args[1:], projectDir)
	case "invite":
		return runTeamInvite(args[1:], projectDir)
	case "boxes":
		return runTeamBoxes(args[1:], projectDir)
	default:
		return fmt.Errorf("unknown bh team command: %s (try 'bh team --help')", args[0])
	}
}

func printTeamUsage() {
	fmt.Fprintln(os.Stderr, "USAGE:")
	fmt.Fprintln(os.Stderr, "  bh team list")
	fmt.Fprintln(os.Stderr, "  bh team create <name>")
	fmt.Fprintln(os.Stderr, "  bh team members [--team <slug-or-id>]")
	fmt.Fprintln(os.Stderr, "  bh team invite <email> [--role member|admin|owner] [--team <slug-or-id>]")
	fmt.Fprintln(os.Stderr, "  bh team boxes [--team <slug-or-id>]")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "--team is optional when you belong to exactly one team.")
}

func parseTeamArgs(command string, args []string, wantPositional bool) (string, string, string, error) {
	positional := ""
	team := ""
	role := ""
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--team":
			i++
			if i >= len(args) {
				return "", "", "", fmt.Errorf("bh team %s --team requires a value", command)
			}
			team = args[i]
		case strings.HasPrefix(arg, "--team="):
			team = strings.TrimPrefix(arg, "--team=")
		case arg == "--role":
			i++
			if i >= len(args) {
				return "", "", "", fmt.Errorf("bh team %s --role requires a value", command)
			}
			role = args[i]
		case strings.HasPrefix(arg, "--role="):
			role = strings.TrimPrefix(arg, "--role=")
		case strings.HasPrefix(arg, "-"):
			return "", "", "", fmt.Errorf("unknown bh team %s option: %s", command, arg)
		default:
			if !wantPositional || positional != "" {
				return "", "", "", fmt.Errorf("unexpected bh team %s argument: %s", command, arg)
			}
			positional = arg
		}
	}
	return strings.TrimSpace(positional), strings.TrimSpace(team), strings.ToLower(strings.TrimSpace(role)), nil
}

func teamSlugFromName(name string) string {
	var b strings.Builder
	lastDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
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

func listTeamOrganizations(cfg Config) ([]teamOrganization, error) {
	var orgs []teamOrganization
	if err := remoteBackendRequest(cfg, http.MethodGet, "/v1/auth/organization/list", nil, &orgs); err != nil {
		return nil, err
	}
	return orgs, nil
}

func selectTeamOrganization(orgs []teamOrganization, selector string) (teamOrganization, error) {
	selector = strings.TrimSpace(selector)
	if selector != "" {
		for _, org := range orgs {
			if org.ID == selector || strings.EqualFold(org.Slug, selector) || strings.EqualFold(org.Name, selector) {
				return org, nil
			}
		}
		return teamOrganization{}, fmt.Errorf("no team matches %q (teams: %s)", selector, teamSlugList(orgs))
	}
	switch len(orgs) {
	case 0:
		return teamOrganization{}, fmt.Errorf("no teams yet; run `bh team create <name>`")
	case 1:
		return orgs[0], nil
	default:
		return teamOrganization{}, fmt.Errorf("you belong to multiple teams (%s); pass --team <slug>", teamSlugList(orgs))
	}
}

func teamSlugList(orgs []teamOrganization) string {
	slugs := make([]string, 0, len(orgs))
	for _, org := range orgs {
		slugs = append(slugs, firstNonEmpty(org.Slug, org.ID))
	}
	sort.Strings(slugs)
	return strings.Join(slugs, ", ")
}

func resolveTeamOrganization(cfg Config, selector string) (teamOrganization, error) {
	orgs, err := listTeamOrganizations(cfg)
	if err != nil {
		return teamOrganization{}, err
	}
	return selectTeamOrganization(orgs, selector)
}

func runTeamList(args []string, projectDir string) error {
	if len(args) != 0 {
		return fmt.Errorf("unexpected bh team list args: %v", args)
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	orgs, err := listTeamOrganizations(cfg)
	if err != nil {
		return err
	}
	if len(orgs) == 0 {
		if _, err := fmt.Fprintln(os.Stdout, "No teams yet. Run `bh team create <name>` to start one."); err != nil {
			return err
		}
		return nil
	}
	sort.Slice(orgs, func(i, j int) bool {
		return orgs[i].Name < orgs[j].Name
	})
	table := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	if _, err := fmt.Fprintln(table, "NAME\tSLUG\tID"); err != nil {
		return err
	}
	for _, org := range orgs {
		if _, err := fmt.Fprintf(table, "%s\t%s\t%s\n", valueOrDash(org.Name), valueOrDash(org.Slug), valueOrDash(org.ID)); err != nil {
			return err
		}
	}
	return table.Flush()
}

func runTeamCreate(args []string, projectDir string) error {
	name, team, role, err := parseTeamArgs("create", args, true)
	if err != nil {
		return err
	}
	if team != "" || role != "" {
		return fmt.Errorf("bh team create only takes a team name")
	}
	if name == "" {
		return fmt.Errorf("bh team create requires a team name")
	}
	slug := teamSlugFromName(name)
	if slug == "" {
		return fmt.Errorf("team name %q must contain letters or numbers", name)
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	req := teamCreateRequest{Name: name, Slug: slug}
	var org teamOrganization
	if err := remoteBackendRequest(cfg, http.MethodPost, "/v1/auth/organization/create", req, &org); err != nil {
		return err
	}
	success("Created team %s (slug: %s)", firstNonEmpty(org.Name, name), firstNonEmpty(org.Slug, slug))
	info("Invite teammates with `bh team invite <email>`.")
	return nil
}

func runTeamMembers(args []string, projectDir string) error {
	_, team, role, err := parseTeamArgs("members", args, false)
	if err != nil {
		return err
	}
	if role != "" {
		return fmt.Errorf("bh team members does not take --role")
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	org, err := resolveTeamOrganization(cfg, team)
	if err != nil {
		return err
	}
	endpoint := "/v1/auth/organization/list-members?organizationId=" + url.QueryEscape(org.ID) + "&limit=500"
	var response teamMembersResponse
	if err := remoteBackendRequest(cfg, http.MethodGet, endpoint, nil, &response); err != nil {
		return err
	}
	if len(response.Members) == 0 {
		if _, err := fmt.Fprintf(os.Stdout, "No members in %s yet.\n", firstNonEmpty(org.Name, org.Slug, org.ID)); err != nil {
			return err
		}
		return nil
	}
	sort.Slice(response.Members, func(i, j int) bool {
		return response.Members[i].User.Email < response.Members[j].User.Email
	})
	table := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	if _, err := fmt.Fprintln(table, "EMAIL\tNAME\tROLE"); err != nil {
		return err
	}
	for _, member := range response.Members {
		if _, err := fmt.Fprintf(table, "%s\t%s\t%s\n", valueOrDash(member.User.Email), valueOrDash(member.User.Name), valueOrDash(member.Role)); err != nil {
			return err
		}
	}
	return table.Flush()
}

func runTeamInvite(args []string, projectDir string) error {
	email, team, role, err := parseTeamArgs("invite", args, true)
	if err != nil {
		return err
	}
	if email == "" {
		return fmt.Errorf("bh team invite requires an email address")
	}
	if !strings.Contains(email, "@") {
		return fmt.Errorf("invalid invite email %q", email)
	}
	if role == "" {
		role = "member"
	}
	switch role {
	case "member", "admin", "owner":
	default:
		return fmt.Errorf("invalid team role %q; expected member, admin, or owner", role)
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	org, err := resolveTeamOrganization(cfg, team)
	if err != nil {
		return err
	}
	req := teamInviteRequest{Email: email, Role: role, OrganizationID: org.ID}
	var invitation teamInvitation
	if err := remoteBackendRequest(cfg, http.MethodPost, "/v1/auth/organization/invite-member", req, &invitation); err != nil {
		return err
	}
	if strings.TrimSpace(invitation.ID) == "" {
		return fmt.Errorf("remote backend returned no invitation id")
	}
	success("Invited %s to %s as %s", email, firstNonEmpty(org.Name, org.Slug, org.ID), role)
	link("Accept link: %s", teamInviteAcceptURL(teamAppURL(cfg), invitation.ID))
	info("Send the link to the invitee; it only works when they sign in as %s.", email)
	return nil
}

func teamAppURL(cfg Config) string {
	var whoami teamWhoamiResponse
	if err := remoteBackendRequest(cfg, http.MethodGet, "/v1/auth/whoami", nil, &whoami); err == nil {
		if appURL := strings.TrimSpace(whoami.AppURL); appURL != "" {
			return appURL
		}
	}
	return remoteBackendURL(cfg)
}

func teamInviteAcceptURL(appURL string, invitationID string) string {
	return strings.TrimRight(appURL, "/") + "/invite?id=" + url.QueryEscape(invitationID)
}

func runTeamBoxes(args []string, projectDir string) error {
	_, team, role, err := parseTeamArgs("boxes", args, false)
	if err != nil {
		return err
	}
	if role != "" {
		return fmt.Errorf("bh team boxes does not take --role")
	}
	cfg, err := loadConfig(projectDir)
	if err != nil {
		return err
	}
	org, err := resolveTeamOrganization(cfg, team)
	if err != nil {
		return err
	}
	var response teamMachinesResponse
	if err := remoteBackendRequest(cfg, http.MethodGet, "/v1/orgs/"+url.PathEscape(org.ID)+"/machines", nil, &response); err != nil {
		return err
	}
	if len(response.Machines) == 0 {
		if _, err := fmt.Fprintf(os.Stdout, "No machines in %s yet.\n", firstNonEmpty(org.Name, org.Slug, org.ID)); err != nil {
			return err
		}
		return nil
	}
	sort.Slice(response.Machines, func(i, j int) bool {
		return response.Machines[i].Name < response.Machines[j].Name
	})
	table := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	if _, err := fmt.Fprintln(table, "NAME\tOWNER\tPROVIDER\tSIZE\tURL"); err != nil {
		return err
	}
	for _, machine := range response.Machines {
		owner := firstNonEmpty(machine.OwnerEmail, machine.OwnerName)
		if _, err := fmt.Fprintf(
			table,
			"%s\t%s\t%s\t%s\t%s\n",
			machine.Name,
			valueOrDash(owner),
			valueOrDash(machine.Provider),
			configValueOrNotSet(machine.Size),
			remoteListURL(machine.remoteMachine),
		); err != nil {
			return err
		}
	}
	return table.Flush()
}

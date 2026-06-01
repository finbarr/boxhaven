BINARY ?= bh
CMD_DIR := ./cmd/bh
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-X main.Version=$(VERSION)"

.PHONY: build test go-test backend-test backend-build lint production-check validate-production-env validate-production-compose smoke-production-http smoke-production-dns smoke-remote audit-digitalocean audit-digitalocean-account audit-backup-storage ensure-uptime ensure-alerts ensure-firewalls prune-snapshots verify-backup dist install uninstall clean

build:
	go build $(LDFLAGS) -o $(BINARY) $(CMD_DIR)

test: go-test backend-test

go-test:
	go test -v ./...

backend-test:
	npm --prefix backend ci
	npm --prefix backend test

backend-build:
	npm --prefix backend ci
	npm --prefix backend run build

lint:
	go vet ./...
	@which golangci-lint > /dev/null && golangci-lint run || echo "golangci-lint not installed, skipping"

production-check:
	scripts/production-readiness-check.sh

validate-production-env:
	scripts/validate-production-env.sh

validate-production-compose:
	scripts/validate-production-compose.sh

smoke-production-http:
	scripts/smoke-production-http.sh

smoke-production-dns:
	scripts/smoke-production-dns.sh

smoke-remote: build
	scripts/smoke-remote-lifecycle.sh

audit-digitalocean:
	scripts/digitalocean-production-audit.sh

audit-digitalocean-account:
	scripts/digitalocean-account-cleanup-audit.sh

audit-backup-storage:
	scripts/backup-storage-audit.sh

ensure-uptime:
	scripts/ensure-digitalocean-uptime.sh

ensure-alerts:
	scripts/ensure-digitalocean-alerts.sh

ensure-firewalls:
	scripts/ensure-digitalocean-firewalls.sh

prune-snapshots:
	scripts/prune-digitalocean-snapshots.sh

verify-backup:
	@test -n "$(BACKUP)" || (echo "usage: make verify-backup BACKUP=/path/to/boxhaven-backend-archive.tar.gz" >&2; exit 2)
	scripts/verify-backend-backup-restore.sh "$(BACKUP)"

dist:
	VERSION="$(VERSION)" scripts/build-release.sh

install: build
	mkdir -p $(BINDIR)
	install -m 0755 $(BINARY) $(BINDIR)/$(BINARY)
	@echo "Installed $(BINARY) to $(BINDIR)/$(BINARY)"

uninstall:
	rm -f $(BINDIR)/$(BINARY)
	@echo "Removed $(BINDIR)/$(BINARY)"

clean:
	rm -f $(BINARY)

BINARY ?= bh
CMD_DIR := ./cmd/bh
PREFIX ?= $(HOME)/.local
BINDIR ?= $(PREFIX)/bin
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-X main.Version=$(VERSION)"

.PHONY: build test go-test backend-test backend-build lint smoke-remote verify-backup install uninstall clean

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

smoke-remote: build
	scripts/smoke-remote-lifecycle.sh

verify-backup:
	@test -n "$(BACKUP)" || (echo "usage: make verify-backup BACKUP=/path/to/boxhaven-backend-archive.tar.gz" >&2; exit 2)
	scripts/verify-backend-backup-restore.sh "$(BACKUP)"

install: build
	mkdir -p $(BINDIR)
	install -m 0755 $(BINARY) $(BINDIR)/$(BINARY)
	@echo "Installed $(BINARY) to $(BINDIR)/$(BINARY)"

uninstall:
	rm -f $(BINDIR)/$(BINARY)
	@echo "Removed $(BINDIR)/$(BINARY)"

clean:
	rm -f $(BINARY)

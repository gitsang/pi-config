# pi-webui build
#
# make build   - build frontend (dist/) and Go binary
# make web     - build only the React frontend
# make go      - build only the Go binary
# make clean   - remove build artifacts

GO ?= go
NPM ?= npm
BINARY ?= pi-webui

.PHONY: build web go clean

build: web go

web:
	cd web && $(NPM) install
	cd web && $(NPM) run build

go:
	$(GO) build -o $(BINARY) ./cmd/pi-webui

clean:
	rm -rf dist web/dist $(BINARY)

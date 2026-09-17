CI := 1

.PHONY: help build dev-fmt all check fmt lint typecheck test security update-spec update-spec-latest e2e-deps e2e coverage gts-server

# Port for the GTS server; override with `PORT=8001`.
PORT ?= 8000

# Virtualenv used by the gts-spec conformance suite
VENV := .venv
PYTHON := $(VENV)/bin/python

# The gts-spec release this implementation targets. The submodule pointer is
# the authoritative pin; this file records it in human-readable form and is
# what `make update-spec` checks out.
GTS_SPEC_VERSION ?= $(strip $(shell cat .gts-spec-version 2>/dev/null))

# Default target - show help
.DEFAULT_GOAL := help

# Show this help message
help:
	@awk '/^# / { desc=substr($$0, 3) } /^[a-zA-Z0-9_-]+:/ && desc { target=$$1; sub(/:$$/, "", target); printf "%-20s - %s\n", target, desc; desc="" }' Makefile | sort

# Build the project
build:
	npm run build

# Fix formatting issues
dev-fmt:
	npm run format

# Run all checks and build
all: check build

# Check code formatting
fmt:
	npx prettier --check "src/**/*.ts" "tests/**/*.ts"

# Run linter (eslint)
lint:
	npm run lint

# Run type checker
typecheck:
	npm run typecheck

# Run all tests
test:
	npm run test

# Check dependencies for security vulnerabilities
security:
	npm audit

# Measure code coverage
coverage:
	npx jest --coverage

# Check out the gts-spec release pinned in .gts-spec-version
update-spec:
	@test -n "$(GTS_SPEC_VERSION)" || (echo "ERROR: .gts-spec-version is missing or empty"; exit 1)
	git submodule update --init .gts-spec
	git -C .gts-spec fetch --tags --force origin
	git -C .gts-spec checkout --detach $(GTS_SPEC_VERSION)
	@echo "gts-spec is at $(GTS_SPEC_VERSION) - commit the submodule pointer to record it"

# Move gts-spec to the tip of upstream main (unpinned; for evaluating a new release)
update-spec-latest:
	git submodule update --init --remote .gts-spec
	@echo "gts-spec is at upstream main:"
	@git -C .gts-spec describe --tags
	@echo "Update .gts-spec-version before committing the submodule pointer."

# NOTE: httprunner pins pydantic <1.9, which does not build on modern Python, so
# it is installed with --no-deps and its transitive deps come from the spec's
# requirements.txt (same procedure as .gts-spec/tests/Dockerfile).
#
# Install the Python dependencies for the gts-spec conformance suite
e2e-deps: $(VENV)/.stamp
$(VENV)/.stamp: .gts-spec/tests/requirements.txt
	python3 -m venv $(VENV)
	$(VENV)/bin/pip install --quiet --upgrade pip
	$(VENV)/bin/pip install --quiet -r .gts-spec/tests/requirements.txt
	$(VENV)/bin/pip install --quiet --no-deps 'httprunner>=4,<5'
	@touch $@

# Run the GTS server in the foreground
gts-server: build
	node dist/server/index.js --host 0.0.0.0 --port $(PORT)

# Run end-to-end tests against gts-spec
e2e: build e2e-deps
	@echo "Starting server in background..."
	@node dist/server/index.js --port 8000 & echo $$! > .server.pid
	@sleep 2
	@echo "Running e2e tests..."
	@PYTHONDONTWRITEBYTECODE=1 $(VENV)/bin/pytest -p no:cacheprovider --log-file=e2e.log ./.gts-spec/tests || (kill `cat .server.pid` 2>/dev/null; rm -f .server.pid; exit 1)
	@echo "Stopping server..."
	@kill `cat .server.pid` 2>/dev/null || true
	@rm -f .server.pid
	@echo "E2E tests completed successfully"

# Run all quality checks
check: fmt lint typecheck test e2e

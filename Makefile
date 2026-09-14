# Memberberry task runner.
#
# `make check` is the pre-commit gate (AGENTS.md 1); also run it on explicit request.
#
# `make dev` supervises the Rust server and Vite HMR server together. Register one vault first
# with `make vault-add SLUG=personal VAULT=~/Notes ADMIN=alice`.

SHELL := /bin/bash
.DEFAULT_GOAL := help

CARGO ?= cargo
VAULT ?=
ADMIN ?=
NOTES ?= 10000
CASES ?= 20000
SECS ?= 60
TARGET ?= parse

.PHONY: help
help: ## Show this help
	@echo "Memberberry — available targets:"
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Vault targets need VAULT=/path/to/vault"

# ---------------------------------------------------------------- everyday loop

.PHONY: dev
dev: ## Run the complete app with frontend HMR and Rust auto-restart
	@python3 scripts/dev.py

.PHONY: watch
watch: ## Watch files and re-run the fast tests
	@if command -v cargo-watch >/dev/null 2>&1; then \
		$(CARGO) watch -x 'test --workspace --test markdown'; \
	else \
		echo "cargo-watch not installed. Install with:"; \
		echo "    cargo install cargo-watch"; \
		echo; \
		echo "Running the fast tests once instead."; \
		$(MAKE) test-fast; \
	fi

.PHONY: prod
prod: prod-build ## Build and run the complete production app
	@target/release/memberberry serve

.PHONY: prod-build
prod-build: web-build ## Build the production web bundle and optimised server binary
	$(CARGO) build --release -p mb-cli
	@echo
	@echo "Binary: target/release/memberberry"

.PHONY: check
check: fmt-check lint test coverage-gate token-check deployment-check dev-check web-check ## THE GATE: fmt + clippy + tests + coverage + tokens

.PHONY: full-test
full-test: ## Build WASM, run the full check gate, then desktop/mobile E2E
	$(MAKE) wasm
	$(MAKE) check
	$(MAKE) e2e

# ---------------------------------------------------------------- quality

.PHONY: fmt
fmt: ## Format all code
	$(CARGO) fmt --all

.PHONY: fmt-check
fmt-check:
	$(CARGO) fmt --all -- --check

.PHONY: lint
lint: ## Clippy with warnings denied
	$(CARGO) clippy --workspace --all-targets -- -D warnings

.PHONY: test
test: ## All tests
	$(CARGO) test --workspace

.PHONY: test-fast
test-fast: ## Behavioural tests only — the inner loop
	$(CARGO) test --workspace --test markdown

.PHONY: test-props
test-props: ## Round-trip property suite (SPEC 22.1)
	$(CARGO) test --workspace --test roundtrip

.PHONY: soak
soak: ## Property suite at CASES=$(CASES) — finds rarer corners than CI does
	PROPTEST_CASES=$(CASES) $(CARGO) test -p mb-core --test roundtrip --release

.PHONY: fuzz
fuzz: ## Fuzz TARGET=$(TARGET) for SECS=$(SECS) (SPEC 22.1). Needs nightly + cargo-fuzz.
	@command -v cargo-fuzz >/dev/null 2>&1 || { \
		echo "Install first: cargo install cargo-fuzz"; exit 1; }
	@mkdir -p fuzz/corpus/$(TARGET)
	cd fuzz && cargo +nightly fuzz run $(TARGET) corpus/$(TARGET) seeds \
		-- -max_total_time=$(SECS)

.PHONY: fuzz-list
fuzz-list: ## Show the available fuzz targets
	cd fuzz && cargo +nightly fuzz list

.PHONY: fuzz-build
fuzz-build: ## Compile the fuzz targets without running them — what CI checks
	cd fuzz && cargo +nightly fuzz build

.PHONY: bench
bench: ## Hot-path benchmarks (AGENTS.md 4.5). Laptop numbers; the budget target is a phone.
	$(CARGO) bench -p mb-server --bench sync
	$(CARGO) bench -p mb-search --bench compact

.PHONY: coverage
coverage: ## Per-file coverage report (needs cargo-llvm-cov)
	@$(CARGO) llvm-cov --version >/dev/null 2>&1 || { \
		echo "Install first: cargo install cargo-llvm-cov"; exit 1; }
	CARGO="$(CARGO)" python3 scripts/coverage-run.py --summary-only

.PHONY: coverage-gate
coverage-gate: ## Enforce the per-crate floors in AGENTS.md 2.1
	@$(CARGO) llvm-cov --version >/dev/null 2>&1 || { \
		echo "Install first: cargo install cargo-llvm-cov"; exit 1; }
	@echo "Coverage floors (AGENTS.md 2.1):"
	@set -o pipefail; CARGO="$(CARGO)" python3 scripts/coverage-run.py --json --summary-only | python3 scripts/coverage-gate.py

.PHONY: token-check
token-check: ## Enforce the design-token contract, both directions (SPEC 20.1, 20.2)
	@python3 scripts/token-check.py

.PHONY: deployment-check
deployment-check: ## Validate the container, Compose, and backup contracts
	@python3 scripts/deployment-check.py

.PHONY: dev-check
dev-check: ## Validate the development-process supervisor
	@python3 scripts/dev.py --self-test

.PHONY: backup
backup: ## Stop Compose writers, take a checksummed backup, and restart them
	@deploy/backup.sh

# ---------------------------------------------------------------- web

.PHONY: emoji-catalog
emoji-catalog: ## Generate the Rust emoji catalog from the vendored Emojibase data
	node scripts/generate-emoji-catalog.mjs

.PHONY: wasm
wasm: emoji-catalog ## Build the WebAssembly bindings into web/src/wasm (needs wasm-pack)
	@command -v wasm-pack >/dev/null 2>&1 || { \
		echo "Install first: cargo install wasm-pack"; exit 1; }
	@# why: wasm-pack installs wasm-opt into XDG's cache. Keeping it under target makes the
	@# optimizer usable in restricted build environments without disabling the production pass.
	@# why: wasm-pack 0.15 reads an existing output package.json as a dependency map before
	@# rewriting it; its previous array-valued manifest makes a restart fail before the server binds.
	rm -f web/src/wasm/package.json web/src/wasm/emoji/package.json
	@# why: the wasm-opt binary downloaded by wasm-pack currently fails while parsing its
	@# package metadata on this toolchain; unoptimized release WASM remains valid and lets dev
	@# startup complete. Production bundle optimization is handled by Vite.
	XDG_CACHE_HOME=$(CURDIR)/target/wasm-cache wasm-pack build crates/mb-wasm --target web --out-dir ../../web/src/wasm --out-name mb --no-opt
	XDG_CACHE_HOME=$(CURDIR)/target/wasm-cache wasm-pack build crates/mb-emoji-wasm --target web --out-dir ../../web/src/wasm/emoji --out-name emoji --no-opt

.PHONY: web
web: wasm ## Vite dev server on 9011, against the freshly built wasm
	npm --prefix web install
	npm --prefix web run dev

.PHONY: web-test
web-test: wasm ## Frontend tests, including the wasm boundary
	npm --prefix web install
	npm --prefix web run test

.PHONY: web-build
web-build: wasm ## Production frontend build
	npm --prefix web install
	npm --prefix web run build

# Part of `make check`. Skips loudly rather than silently when the toolchain is absent, so a
# Rust-only machine still gets a green gate but is told what it did not run.
.PHONY: web-check
web-check:
	@if ! command -v npm >/dev/null 2>&1; then \
		echo "web-check: SKIPPED — npm is not installed"; \
	elif [ ! -d web/src/wasm ]; then \
		echo "web-check: SKIPPED — run \`make wasm\` first"; \
	else \
		npm --prefix web install --silent && \
		npm --prefix web run typecheck --silent && \
		npm --prefix web run coverage --silent && \
		python3 scripts/web-coverage-gate.py; \
	fi

# Builds everything the suite needs, because a stale bundle or a stale binary is exactly the
# class of failure this suite exists to catch and it should not be able to cause a false one.
.PHONY: e2e
e2e: web-build ## Playwright E2E in a real browser, desktop and mobile (SPEC 22, 23 M7)
	$(CARGO) build -p mb-cli
	npm --prefix web exec -- playwright install --with-deps chromium
	npm --prefix web run e2e

.PHONY: e2e-report
e2e-report: ## Open the report from the last `make e2e`
	npm --prefix web exec -- playwright show-report

# Separate from `make check` for the same reason `e2e` is: it opens a browser, provisions a
# 10k-note vault and takes minutes. `perf-bundle` is the deterministic half and is quick.
.PHONY: perf
perf: web-build ## Performance harness, both device classes (SPEC 21, 23 M7)
	$(CARGO) build -p mb-cli
	npm --prefix web exec -- playwright install --with-deps chromium
	npm --prefix web run perf

.PHONY: perf-bundle
perf-bundle: web-build ## Just the critical-path bundle budget — deterministic, no browser
	npm --prefix web run perf -- --bundle-only

.PHONY: perf-record
perf-record: web-build ## Run the harness and print the breaches.json entries it would need
	$(CARGO) build -p mb-cli
	npm --prefix web run perf -- --record

.PHONY: wasm-check
wasm-check: ## mb-core and mb-search must stay wasm32-clean (AGENTS.md 4.2)
	@rustup target list --installed | grep -q wasm32-unknown-unknown \
		|| rustup target add wasm32-unknown-unknown
	$(CARGO) check -p mb-core -p mb-search --target wasm32-unknown-unknown

# ---------------------------------------------------------------- vaults

.PHONY: gen-vault
gen-vault: ## Synthetic vault for scale work: make gen-vault NOTES=10000
	$(CARGO) run --release -q -p mb-cli -- gen-vault --out tmp-vault --notes $(NOTES)

.PHONY: vault-add
vault-add: ## Register a vault: make vault-add SLUG=personal VAULT=~/Notes ADMIN=alice
	@test -n "$(SLUG)" || { echo "Set SLUG=name"; exit 1; }
	@test -n "$(VAULT)" || { echo "Set VAULT=/path/to/vault"; exit 1; }
	@test -n "$(ADMIN)" || { echo "Set ADMIN=server-admin"; exit 1; }
	$(CARGO) run -q -p mb-cli -- vault create --slug "$(SLUG)" --path "$(VAULT)" --actor "$(ADMIN)"

.PHONY: vaults
vaults: ## Show the vault registry
	@$(CARGO) run -q -p mb-cli -- vault list

.PHONY: vault-check
vault-check: ## READ-ONLY: report which notes are not canonical. make vault-check VAULT=~/vault
	@test -n "$(VAULT)" || { echo "Set VAULT=/path/to/vault"; exit 1; }
	$(CARGO) run --release -q -p mb-cli -- normalize --check "$(VAULT)"

.PHONY: vault-inspect
vault-inspect: ## Parse one note and print what was extracted. make vault-inspect VAULT=note.md
	@test -n "$(VAULT)" || { echo "Set VAULT=/path/to/note.md"; exit 1; }
	$(CARGO) run --release -q -p mb-cli -- inspect "$(VAULT)"

.PHONY: vault-diff
vault-diff: ## SAFE: copy the vault, normalize the copy, show the diff. make vault-diff VAULT=~/vault
	@test -n "$(VAULT)" || { echo "Set VAULT=/path/to/vault"; exit 1; }
	@set -e; \
	vault="$(VAULT)"; \
	case "$$vault" in \
		"~") vault="$$HOME" ;; \
		"~/"*) vault="$$HOME/$${vault#\~/}" ;; \
	esac; \
	rm -rf tmp-corpus; \
	mkdir -p tmp-corpus; \
	echo "Copying $$vault -> tmp-corpus (original untouched)"; \
	cp -R "$$vault/." tmp-corpus/; \
	$(CARGO) run --release -q -p mb-cli -- normalize tmp-corpus; \
	echo; \
	echo "=== files changed ==="; \
	diff -rq "$$vault" tmp-corpus 2>/dev/null | grep -c '^Files' || true; \
	echo "=== line-level churn ==="; \
	diff -ru "$$vault" tmp-corpus 2>/dev/null | grep -cE '^\+[^+]' | sed 's/^/lines added: /' || true; \
	diff -ru "$$vault" tmp-corpus 2>/dev/null | grep -cE '^-[^-]' | sed 's/^/lines removed: /' || true; \
	echo; \
	echo "Read the full diff with:  diff -ru \"$$vault\" tmp-corpus | less"; \
	echo "Delete the copy with:     rm -rf tmp-corpus"

.PHONY: vault-normalize
vault-normalize: ## REWRITES FILES IN PLACE. Commit or back up first. make vault-normalize VAULT=~/vault
	@test -n "$(VAULT)" || { echo "Set VAULT=/path/to/vault"; exit 1; }
	@echo "This rewrites every .md file under $(VAULT)."
	@echo "Make sure it is committed to git or backed up."
	@read -p "Type yes to continue: " ok && [ "$$ok" = "yes" ]
	$(CARGO) run --release -q -p mb-cli -- normalize "$(VAULT)"

# ---------------------------------------------------------------- housekeeping

.PHONY: clean
clean: ## Remove build artefacts and generated vaults
	$(CARGO) clean
	rm -rf tmp-vault tmp-corpus fuzz/target web/dist web/coverage web/src/wasm

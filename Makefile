# Memberberry task runner.
#
# `make check` is the gate (AGENTS.md 1). Nothing is "done" until it passes.
#
# `make dev` serves the registered vaults read-only on 127.0.0.1:9010. Register one first
# with `make vault-add SLUG=personal VAULT=~/Notes ADMIN=alice`. The editor is M3; this is read-only.

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
dev: ## Run the server against the registered vaults on 127.0.0.1:9010
	$(CARGO) run -p mb-cli -- serve

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
prod: ## Optimised release build of the memberberry binary
	$(CARGO) build --release --workspace
	@echo
	@echo "Binary: target/release/memberberry"

.PHONY: check
check: fmt-check lint test coverage-gate web-check ## THE GATE: fmt + clippy + tests + coverage

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

.PHONY: coverage
coverage: ## Per-file coverage report (needs cargo-llvm-cov)
	@command -v cargo-llvm-cov >/dev/null 2>&1 || { \
		echo "Install first: cargo install cargo-llvm-cov"; exit 1; }
	@# why: llvm-cov merges profiles across runs, so a second invocation silently doubles
	@# every line count and reports roughly half the real coverage. Always start clean.
	$(CARGO) llvm-cov clean --workspace
	$(CARGO) llvm-cov --workspace --summary-only

.PHONY: coverage-gate
coverage-gate: ## Enforce the per-crate floors in AGENTS.md 2.1
	@command -v cargo-llvm-cov >/dev/null 2>&1 || { \
		echo "Install first: cargo install cargo-llvm-cov"; exit 1; }
	@$(CARGO) llvm-cov clean --workspace
	@echo "Coverage floors (AGENTS.md 2.1):"
	@$(CARGO) llvm-cov --workspace --json --quiet | python3 scripts/coverage-gate.py

# ---------------------------------------------------------------- web

.PHONY: wasm
wasm: ## Build the WebAssembly bindings into web/src/wasm (needs wasm-pack)
	@command -v wasm-pack >/dev/null 2>&1 || { \
		echo "Install first: cargo install wasm-pack"; exit 1; }
	wasm-pack build crates/mb-wasm --target web --out-dir ../../web/src/wasm --out-name mb

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

.PHONY: wasm-check
wasm-check: ## mb-core must stay wasm32-clean at all times (AGENTS.md 4.2)
	@rustup target list --installed | grep -q wasm32-unknown-unknown \
		|| rustup target add wasm32-unknown-unknown
	$(CARGO) check -p mb-core --target wasm32-unknown-unknown

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

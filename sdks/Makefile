PYTHON ?= python3
RUST_DIR := rust
TS_DIR := typescript
PY_DIR := python

.PHONY: help generate check vectors test test-rust test-typescript test-python conformance publish-dry-run clean

help:
	@echo "generate          regenerate clients from sdks/spec/streampay.spec.json"
	@echo "check             schema guard + generated-output drift check"
	@echo "vectors           rebuild conformance vectors (deterministic)"
	@echo "test              run all three SDK test suites"
	@echo "conformance       cross-language decode check"
	@echo "publish-dry-run   cargo/npm/PyPI packaging checks (no upload)"

generate:
	$(PYTHON) generator/generate.py

check:
	$(PYTHON) generator/check_contract_surface.py
	$(PYTHON) generator/generate.py --check

vectors:
	cd $(TS_DIR) && node scripts/build-fixtures.mjs

test: test-rust test-typescript test-python

test-rust:
	cd $(RUST_DIR) && cargo test

test-typescript:
	cd $(TS_DIR) && npm test

test-python:
	cd $(PY_DIR) && $(PYTHON) -m unittest discover -s tests -v

conformance:
	./conformance/run.sh

publish-dry-run:
	cd $(RUST_DIR) && cargo publish --dry-run --allow-dirty
	cd $(TS_DIR) && npm publish --dry-run
	cd $(PY_DIR) && $(PYTHON) -m build && $(PYTHON) -m twine check dist/*

clean:
	rm -rf $(TS_DIR)/dist $(PY_DIR)/dist $(PY_DIR)/build $(PY_DIR)/*.egg-info conformance/out

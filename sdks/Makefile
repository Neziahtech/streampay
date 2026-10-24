PYTHON ?= python3
TS_DIR := typescript

.PHONY: help generate check check-spec vectors test publish-dry-run clean

help:
	@echo "generate          regenerate the TypeScript client from sdks/spec/streampay.spec.json"
	@echo "check             schema guard + spec coverage tests + generated-output drift"
	@echo "check-spec        schema guard + spec coverage tests only"
	@echo "vectors           rebuild conformance vectors (deterministic)"
	@echo "test              run the TypeScript SDK test suite"
	@echo "publish-dry-run   npm packaging check (no upload)"

generate:
	$(PYTHON) generator/generate.py

check-spec:
	$(PYTHON) generator/check_contract_surface.py
	$(PYTHON) -m unittest discover -s generator -p "test_*.py" -v

check: check-spec
	$(PYTHON) generator/generate.py --check

vectors:
	cd $(TS_DIR) && node scripts/build-fixtures.mjs

test:
	cd $(TS_DIR) && npm test

publish-dry-run:
	cd $(TS_DIR) && npm pack --dry-run

clean:
	rm -rf $(TS_DIR)/dist $(TS_DIR)/*.tgz

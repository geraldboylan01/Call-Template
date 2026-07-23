LEARNING_SIGNALS_DIR := services/learning-signals
NPM ?= npm
COMPOSE ?= docker compose

-include .env

POSTGRES_DB ?= planeir_telemetry
POSTGRES_USER ?= planeir
POSTGRES_PASSWORD ?= planeir_local_only
POSTGRES_PORT ?= 5432
DATABASE_URL ?= postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@127.0.0.1:$(POSTGRES_PORT)/$(POSTGRES_DB)
SERVICE_HOST ?= 127.0.0.1
SERVICE_PORT ?= 3000
NODE_ENV ?= development
LOG_LEVEL ?= info
POSTHOG_API_KEY ?=
POSTHOG_HOST ?= https://eu.i.posthog.com
LANGFUSE_PUBLIC_KEY ?=
LANGFUSE_SECRET_KEY ?=
LANGFUSE_HOST ?=
OTEL_EXPORTER_OTLP_ENDPOINT ?=
TENANT_SECRET_PROVIDER ?= env
TENANT_SECRETS_JSON ?=
DP_ENABLED ?= false
DP_EPSILON ?= 1.0
PARQUET_EXPORT_ENABLED ?= false
OUTBOX_POLL_INTERVAL_MS ?= 1000
OUTBOX_RETRY_BASE_MS ?= 1000
OUTBOX_RETRY_MAX_MS ?= 60000

export DATABASE_URL POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD POSTGRES_PORT
export SERVICE_HOST SERVICE_PORT NODE_ENV LOG_LEVEL
export POSTHOG_API_KEY POSTHOG_HOST
export LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_HOST
export OTEL_EXPORTER_OTLP_ENDPOINT TENANT_SECRET_PROVIDER TENANT_SECRETS_JSON
export DP_ENABLED DP_EPSILON PARQUET_EXPORT_ENABLED
export OUTBOX_POLL_INTERVAL_MS OUTBOX_RETRY_BASE_MS OUTBOX_RETRY_MAX_MS

DEPS_STAMP := $(LEARNING_SIGNALS_DIR)/node_modules/.package-lock.json

.PHONY: db-up db-migrate db-reset test lint deps

deps: $(DEPS_STAMP)

$(DEPS_STAMP): $(LEARNING_SIGNALS_DIR)/package.json $(LEARNING_SIGNALS_DIR)/package-lock.json
	$(NPM) ci --prefix $(LEARNING_SIGNALS_DIR)

db-up:
	$(COMPOSE) up -d postgres
	@attempt=0; until $(COMPOSE) exec -T postgres sh -c 'pg_isready -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"' >/dev/null 2>&1; do \
		attempt=$$((attempt + 1)); \
		if [ $$attempt -ge 30 ]; then \
			echo "PostgreSQL did not become ready within 30 seconds." >&2; \
			exit 1; \
		fi; \
		sleep 1; \
	done

db-migrate: deps
	$(NPM) --prefix $(LEARNING_SIGNALS_DIR) run db:migrate

db-reset:
	$(COMPOSE) down --volumes --remove-orphans
	$(MAKE) db-up
	$(MAKE) db-migrate

test: deps
	$(NPM) --prefix $(LEARNING_SIGNALS_DIR) test

lint: deps
	$(NPM) --prefix $(LEARNING_SIGNALS_DIR) run lint

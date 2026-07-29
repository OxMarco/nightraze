COMPOSE := docker compose -f docker-compose.prod.yml
COMPOSE_DEV := docker compose -f docker-compose.local.yml

.PHONY: help test test-docker dev dev-down dev-logs up down restart deploy rollback build smoke logs ps status health sh prune

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

test: ## Build both apps and run deterministic unit + integration tests (needs a host Node)
	cd client && npm test
	cd server && npm run test:all

test-docker: ## Run the same suite inside the pinned build image; needs only Docker
	docker build --pull --target test -t nightraze-app:test .

dev: ## Start the local dev stack with hot reload (foreground, http://localhost:5173)
	$(COMPOSE_DEV) up --build

dev-down: ## Stop and remove the local dev stack
	$(COMPOSE_DEV) down

dev-logs: ## Tail logs from the local dev stack
	$(COMPOSE_DEV) logs -f --tail=200

up: ## Start the prod stack in the background
	$(COMPOSE) up -d --wait --wait-timeout 90

down: ## Stop and remove containers (volumes preserved)
	$(COMPOSE) down

restart: ## Restart all services
	$(COMPOSE) restart

build: ## Rebuild the application image
	$(COMPOSE) build --pull

deploy: ## Test, build, deploy, health-check, and auto-rollback on failure
	./scripts/deploy.sh

rollback: ## Restore the application images saved by the previous deploy
	./scripts/deploy.sh --rollback

smoke: ## Check the public production health endpoint over HTTPS
	./scripts/smoke.sh

logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=200

ps: ## Show service status
	$(COMPOSE) ps

status: ps ## Alias for ps

health: ## Show health status of each service
	@$(COMPOSE) ps --format 'table {{.Service}}\t{{.Status}}'

sh: ## Shell into the running application container
	$(COMPOSE) exec app sh

prune: ## Remove dangling images and stopped containers
	docker system prune -f

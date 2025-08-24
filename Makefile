.PHONY: build up down test lint

build:
	docker compose build

up:
	docker compose up -d

down:
	docker compose down

test:
	pytest

lint:
	ruff api && black --check api && cd web && npx eslint . && npx prettier --check .

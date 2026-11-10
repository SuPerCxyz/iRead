SHELL := /bin/sh

PNPM ?= pnpm
GO ?= go
COMPOSE ?= docker compose
VERSION ?= 0.1.0
BIN_DIR ?= bin

.PHONY: help dev-web dev-server build test lint gate e2e docker-build docker-up docker-down

help:
	@printf '%s\n' \
		'make dev-web      启动 Vite 开发服务器（需先 make build 生成 web/dist）' \
		'make dev-server   启动 Go 服务（127.0.0.1:8080，需 web/dist）' \
		'make build        构建 Web 产物与 bin/iread' \
		'make test         运行 Web 单元测试与 Go 测试' \
		'make lint         运行前端 lint/typecheck/样式门禁与 Go vet/gofmt' \
		'make gate         lint + test + build' \
		'make e2e          运行 Web 阶段1 E2E（需服务已在 127.0.0.1:8080 运行）' \
		'make docker-build 构建容器镜像' \
		'make docker-up    启动容器（仅发布 127.0.0.1:8080）' \
		'make docker-down  停止并移除容器（保留三个命名卷）'

dev-web:
	cd web && $(PNPM) dev

dev-server:
	@test -f web/dist/index.html || { \
		echo '缺少 web/dist/index.html：请先运行 make build 或 (cd web && pnpm build)'; \
		exit 1; \
	}
	cd server && $(GO) run ./cmd/iread

build:
	cd web && $(PNPM) build
	mkdir -p $(BIN_DIR)
	cd server && GOFLAGS=-buildvcs=false $(GO) build -trimpath \
		-ldflags "-s -w -X main.version=$(VERSION)" \
		-o ../$(BIN_DIR)/iread ./cmd/iread

test:
	cd web && $(PNPM) test
	cd server && $(GO) test ./...

lint:
	cd web && $(PNPM) lint
	cd web && $(PNPM) typecheck
	cd web && $(PNPM) check:styles
	cd server && $(GO) vet ./...
	@files="$$(gofmt -l server)"; \
	if [ -n "$$files" ]; then echo "gofmt 未通过: $$files"; exit 1; fi

gate: lint test build

e2e:
	cd web && $(PNPM) test:e2e

docker-build:
	$(COMPOSE) build

docker-up:
	$(COMPOSE) up -d

docker-down:
	$(COMPOSE) down

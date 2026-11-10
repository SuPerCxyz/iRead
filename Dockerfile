# syntax=docker/dockerfile:1

# 阶段1 单容器镜像：Web 构建 -> Go 构建 -> 最小运行层。
# 运行层非 root，仅包含二进制、静态产物、CA 证书与时区数据。
ARG NODE_IMAGE=node:24-alpine
ARG GO_IMAGE=golang:1.26-alpine
ARG RUNTIME_IMAGE=alpine:3.22

FROM ${NODE_IMAGE} AS web

# web/package.json 未声明 packageManager；使用仓库验证过的 pnpm 版本与 lockfile。
ARG PNPM_VERSION=11.25.0
# 构建期依赖源，可切换镜像；不影响 lockfile 完整性校验。
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm_config_registry=${NPM_REGISTRY} npm install --global pnpm@${PNPM_VERSION}

WORKDIR /src/web
COPY web/package.json web/pnpm-lock.yaml ./
# pnpm 读取 pnpm_config_registry（不读取 npm_config_registry）。
RUN pnpm_config_registry=${NPM_REGISTRY} pnpm install --frozen-lockfile

COPY web/ ./
ARG VERSION=0.1.0
ENV IREAD_BUILD_ID=${VERSION}
RUN pnpm build


FROM ${GO_IMAGE} AS server

ARG VERSION=0.1.0
# 构建期 Go module 代理，可切换镜像；go.sum 校验不变。
ARG GOPROXY=https://proxy.golang.org,direct
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN GOPROXY=${GOPROXY} go mod download

COPY server/ ./
# Go 1.26 在无有效 VCS 元数据时会报 buildvcs 错误；构建上下文不包含 .git。
RUN CGO_ENABLED=0 GOFLAGS=-buildvcs=false GOPROXY=${GOPROXY} \
    go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/iread ./cmd/iread


FROM ${RUNTIME_IMAGE}

RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S -g 10001 iread \
    && adduser -S -D -H -u 10001 -G iread -s /sbin/nologin iread \
    && mkdir -p /app/web \
    && mkdir -p -m 0750 /data/books /data/db /data/cache \
    && chmod 0750 /data /data/books /data/db /data/cache \
    && chown -R iread:iread /app /data

COPY --from=server --chown=iread:iread /out/iread /app/iread
COPY --from=web --chown=iread:iread /src/web/dist/ /app/web/

# 阶段1 无鉴权：容器内监听 0.0.0.0 必须显式 opt-in；
# 宿主机只允许通过 compose 发布到 127.0.0.1:8080。
ENV IREAD_ADDR=0.0.0.0:8080 \
    IREAD_ALLOW_NON_LOOPBACK=1 \
    IREAD_WEB_DIR=/app/web \
    IREAD_BOOKS_DIR=/data/books \
    IREAD_DB_DIR=/data/db \
    IREAD_CACHE_DIR=/data/cache

USER 10001:10001
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

ENTRYPOINT ["/app/iread"]

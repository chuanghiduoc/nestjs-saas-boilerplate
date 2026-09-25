# syntax=docker/dockerfile:1
# Một image cho 3 vai trò (api/worker/migrate), chọn bằng tham số node (CMD/command).
# Base image pin theo digest trong docker/images.env, truyền qua --build-arg (xem ADR 0013).
ARG BUILD_IMAGE
ARG RUNTIME_IMAGE

FROM ${BUILD_IMAGE} AS deps
# CI=true: pnpm không hỏi xác nhận khi prune/tạo lại node_modules (không có TTY trong build).
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm lấy đúng bản ghi ở "packageManager" của package.json (có hash sha512), corepack tự kiểm.
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM deps AS build
COPY . .
# --prefer-offline (không phải --offline): layer `deps` có thể được lấy từ cache layer (vd. CI
# `type=gha`) trong khi cache mount của store rỗng; --offline khi đó fail, --prefer-offline tải lại.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prefer-offline --frozen-lockfile \
 && pnpm build \
 && test -d dist/migrations && test -f dist/main.migrate.js \
 && pnpm prune --prod \
 && find node_modules -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete
# Dòng `find` trên: source map và khai báo kiểu của dependency không bao giờ được nạp lúc chạy
# (app không bật --enable-source-maps cho node_modules), chiếm ~90 MB trong ~212 MB node_modules
# production (đo ngày 2026-09-25). Source map của dist/ (code của app) được giữ.

FROM ${RUNTIME_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# package.json cần ở runtime: "type": "module" quyết định dist/*.js là ESM.
# Không --chown: code thuộc root (chỉ đọc với user 65532), process bị chiếm quyền không sửa được
# code/dependency của chính nó, kể cả khi chạy không có readOnlyRootFilesystem (vd. compose).
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 65532
# Không HEALTHCHECK ở image: cổng và probe khác nhau theo vai trò (api 3000, worker 3001, migrate
# không có); compose/k8s khai báo probe cho từng vai trò.
# ENTRYPOINT của distroless là /nodejs/bin/node: CMD chỉ là tham số node, khớp script start:api.
CMD ["--import", "./dist/instrumentation.js", "dist/main.api.js"]

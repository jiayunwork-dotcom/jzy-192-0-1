# syntax=docker/dockerfile:1
# ---- 构建阶段：前端 ----
FROM node:20-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY web/package.json web/
RUN npm install --workspace=web
COPY web/ web/
RUN npm run build --workspace=web

# ---- 构建阶段：后端 ----
FROM node:20-alpine AS server-build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/
# 只装后端依赖（含 devDependencies 供 tsc 编译）
RUN npm install --workspace=server
COPY server/ server/
COPY --from=web-build /app/web/dist /app/web/dist
RUN npm run build --workspace=server
# 去掉 devDependencies，只保留运行时依赖
RUN npm prune --omit=dev --workspace=server

# ---- 运行阶段：单镜像同时提供 API 与前端静态文件 ----
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-build /app/node_modules ./node_modules
COPY --from=server-build /app/server/node_modules ./server/node_modules
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=server-build /app/server/package.json ./server/package.json
COPY --from=web-build /app/web/dist ./web/dist
EXPOSE 3000
# 容器启动时先迁移，再启动服务
CMD ["sh", "-c", "node server/dist/migrate.js && node server/dist/server.js"]

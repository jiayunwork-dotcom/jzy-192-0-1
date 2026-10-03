# ---- 构建阶段 ----
FROM node:20-alpine AS build
WORKDIR /app

# 先拷 workspace 清单以利用层缓存
COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install

# 拷贝源码并构建前端
COPY . .
RUN npm run build:web && npm --workspace server run build

# ---- 运行阶段 ----
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/server/migrations ./server/migrations

EXPOSE 8080
CMD ["node", "server/dist/index.js"]

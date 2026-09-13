# 使用轻量级 Node.js 20 镜像
FROM node:20-alpine AS builder

WORKDIR /app

# 安装 SQLite 编译可能需要的构建工具
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci --omit=dev

# 生产运行阶段
FROM node:20-alpine

WORKDIR /app

# 复制生产依赖与源码
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/

# 创建持久化数据目录
RUN mkdir -p /app/data/uploads

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data
ENV FILE_EXPIRE_HOURS=24
ENV SESSION_EXPIRE_DAYS=14
ENV MAX_FILE_SIZE_MB=5120

EXPOSE 8080

VOLUME ["/app/data"]

CMD ["node", "src/server.js"]

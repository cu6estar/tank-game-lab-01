# --- етап 1: збірка клієнта (потрібні dev-залежності: vite) -----------------
FROM node:22-alpine AS builder
WORKDIR /app

# спершу тільки маніфести — шар кешу npm не інвалідовується від зміни коду
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci

COPY . .
RUN npm run build   # vite build → client/dist

# --- етап 2: рантайм (лише прод-залежності, без vite/eslint/vitest) ----------
FROM node:22-alpine AS runtime
WORKDIR /app

# SHA збірки: CI передає --build-arg GIT_SHA=<commit>; видно в /health
ARG GIT_SHA=dev
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    STATIC_DIR=../client/dist \
    GIT_SHA=$GIT_SHA

# прод-залежності: ws, zod, pino (+ symlink workspace @tank/shared)
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev && npm cache clean --force

# сервер виконує .ts напряму (type-stripping Node 22) — копіюємо лише джерела + збірку
COPY --from=builder /app/shared/src shared/src
COPY --from=builder /app/server/src server/src
COPY --from=builder /app/client/dist client/dist

# каталог логів під непривілейованим користувачем
RUN mkdir -p server/logs && chown -R node:node /app
USER node

EXPOSE 3000

# liveness: Node має глобальний fetch, тож зовнішні утиліти не потрібні
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# node (а не npm) — щоб SIGTERM від docker stop дійшов прямо до процесу Node
CMD ["node", "server/src/index.ts"]

# Kleine image voor de NanoPi R4S (linux/arm64) of een andere thuisserver.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DB_PATH=/data/weekmand.sqlite \
    NODE_OPTIONS="--max-old-space-size=96 --max-semi-space-size=2"
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD wget -q -O - http://127.0.0.1:8080/health | grep -q '"ok":true' || exit 1
CMD ["node", "src/server.ts"]

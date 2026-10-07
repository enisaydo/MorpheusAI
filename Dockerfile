# MorpheusAI - production imajı
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY mock ./mock
COPY public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "server.js"]

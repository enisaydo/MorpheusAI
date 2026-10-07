# MorpheusAI - container imajı (Podman / Docker)
# Podman kısa imaj adlarını çözmeyebileceği için tam nitelikli ad kullanılır.
FROM docker.io/library/node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY mock ./mock
COPY public ./public

# Uygulama root kullanıcısıyla çalışır
USER root
EXPOSE 3000

# Not: Podman'da HEALTHCHECK için imajı "--format docker" ile build edin
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1

CMD ["node", "server.js"]

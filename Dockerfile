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

# Not: Podman'da HEALTHCHECK için imajı "--format docker" ile build edin.
# wget/curl yerine node kullanılır: Podman host'taki http_proxy'yi container'a aktarır,
# node'un http modülü ise proxy değişkenlerini dikkate almaz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

CMD ["node", "server.js"]

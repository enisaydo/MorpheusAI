#!/usr/bin/env bash
# MorpheusAI'yi Podman ile (root) build edip ayağa kaldırır / günceller.
# Kullanım:  sudo ./deploy/podman-up.sh            → sadece container
#            sudo ./deploy/podman-up.sh --systemd  → Quadlet ile systemd servisi olarak
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="localhost/morpheus-ai:latest"
NAME="morpheus-ai"
PORT="${HOST_PORT:-3000}"

if [[ $EUID -ne 0 ]]; then
  echo "Bu script root olarak çalıştırılmalı (sudo)." >&2
  exit 1
fi
command -v podman >/dev/null || { echo "podman bulunamadı" >&2; exit 1; }

cd "$APP_DIR"
if [[ ! -f .env ]]; then
  echo ".env bulunamadı. Önce:  cp .env.example .env  && düzenleyin" >&2
  exit 1
fi
chmod 600 .env

# Container'sız kurulumdan kalan servis varsa kaldır: hem portu tutar hem de
# /etc/systemd/system altında olduğu için Quadlet'in ürettiği aynı adlı servisi gölgeler.
LEGACY=/etc/systemd/system/morpheus-ai.service
if [[ -f "$LEGACY" ]]; then
  echo "==> Eski (container'sız) morpheus-ai servisi kaldırılıyor"
  systemctl disable --now morpheus-ai >/dev/null 2>&1 || true
  rm -f "$LEGACY"
  systemctl daemon-reload
fi

if ss -ltnp 2>/dev/null | grep -q ":$PORT "; then
  if ! ss -ltnp 2>/dev/null | grep ":$PORT " | grep -qE "conmon|rootlessport|podman"; then
    echo "Port $PORT başka bir süreç tarafından kullanılıyor:" >&2
    ss -ltnp | grep ":$PORT " >&2
    echo "O süreci durdurun veya HOST_PORT=<port> ile farklı port verin." >&2
    exit 1
  fi
fi

# firewalld açıksa portu kalıcı olarak aç
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  if ! firewall-cmd --query-port="$PORT/tcp" >/dev/null 2>&1; then
    echo "==> firewalld: $PORT/tcp açılıyor"
    firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
  fi
fi

echo "==> İmaj build ediliyor ($IMAGE)"
podman build --format docker -t "$IMAGE" .

if [[ "${1:-}" == "--systemd" ]]; then
  echo "==> Quadlet servisi kuruluyor"
  sed "s#/opt/morpheus-ai#$APP_DIR#g; s#PublishPort=3000:3000#PublishPort=$PORT:3000#" \
    deploy/morpheus-ai.container > /etc/containers/systemd/morpheus-ai.container
  podman rm -f "$NAME" >/dev/null 2>&1 || true
  systemctl daemon-reload
  systemctl restart morpheus-ai
  systemctl --no-pager status morpheus-ai | head -n 5
else
  echo "==> Container başlatılıyor"
  podman rm -f "$NAME" >/dev/null 2>&1 || true
  podman run -d --name "$NAME" --user root \
    --restart unless-stopped \
    -p "$PORT:3000" \
    --env-file .env -e PORT=3000 \
    "$IMAGE"
fi

echo "==> Sağlık kontrolü"
for i in {1..20}; do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    curl -s "http://127.0.0.1:$PORT/api/health"; echo
    echo "MorpheusAI hazır → http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
    exit 0
  fi
  sleep 1
done
echo "Uygulama yanıt vermedi. Loglar:  podman logs $NAME  /  journalctl -u morpheus-ai" >&2
exit 1

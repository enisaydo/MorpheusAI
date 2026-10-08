#!/usr/bin/env bash
# MorpheusAI'yi Podman ile (root) build edip ayağa kaldırır / günceller.
# Kullanım:  sudo ./deploy/podman-up.sh            → sadece container (podman run)
#            sudo ./deploy/podman-up.sh --systemd  → systemd servisi olarak (açılışta otomatik başlar)
set -euo pipefail

# Kurum proxy'si (http_proxy) localhost isteklerini de yakalayıp 403 döndürebiliyor
export no_proxy="localhost,127.0.0.1,::1${no_proxy:+,$no_proxy}"
export NO_PROXY="$no_proxy"

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="localhost/morpheus-ai:latest"
NAME="morpheus-ai"
PORT="${HOST_PORT:-3000}"
UNIT=/etc/systemd/system/morpheus-ai.service
PODMAN="$(command -v podman || true)"

if [[ $EUID -ne 0 ]]; then
  echo "Bu script root olarak çalıştırılmalı (sudo)." >&2
  exit 1
fi
[[ -n "$PODMAN" ]] || { echo "podman bulunamadı" >&2; exit 1; }
echo "==> $("$PODMAN" --version)"

cd "$APP_DIR"
if [[ ! -f .env ]]; then
  echo ".env bulunamadı. Önce:  cp .env.example .env  && düzenleyin" >&2
  exit 1
fi
chmod 600 .env
mkdir -p logs   # AI/AAP istek-cevap logları (container'a bağlanır)

# Port önceliği: komut satırı (HOST_PORT=8080 ./podman-up.sh) > .env'deki HOST_PORT > 3000
if [[ -z "${HOST_PORT:-}" ]]; then
  ENV_PORT="$(grep -E '^HOST_PORT=' .env | tail -n1 | cut -d= -f2 | tr -d '[:space:]"'"'" || true)"
  PORT="${ENV_PORT:-3000}"
fi
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "Geçersiz port: '$PORT'" >&2; exit 1; }
echo "==> Port: $PORT"

# --- Eski kurulum kalıntılarını temizle ------------------------------------
# 1) Container'sız (doğrudan node) servis: portu tutar
if [[ -f "$UNIT" ]] && grep -q "bin/node" "$UNIT"; then
  echo "==> Eski (container'sız) morpheus-ai servisi kaldırılıyor"
  systemctl disable --now morpheus-ai >/dev/null 2>&1 || true
  rm -f "$UNIT"
fi
# 2) Önceki denemeden kalan Quadlet dosyası
rm -f /etc/containers/systemd/morpheus-ai.container
systemctl daemon-reload

# --- Servis durdurulup container kaldırılıyor (güncelleme senaryosu) -------
systemctl stop morpheus-ai >/dev/null 2>&1 || true
"$PODMAN" rm -f "$NAME" >/dev/null 2>&1 || true

if ss -ltnp 2>/dev/null | grep -q ":$PORT "; then
  echo "Port $PORT başka bir süreç tarafından kullanılıyor:" >&2
  ss -ltnp | grep ":$PORT " >&2
  echo "O süreci durdurun veya HOST_PORT=<port> ile farklı port verin." >&2
  exit 1
fi

# firewalld açıksa portu kalıcı olarak aç
if command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  if ! firewall-cmd --query-port="$PORT/tcp" >/dev/null 2>&1; then
    echo "==> firewalld: $PORT/tcp açılıyor"
    firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
  fi
fi

# --- Build -------------------------------------------------------------------
echo "==> İmaj build ediliyor ($IMAGE)"
"$PODMAN" build --format docker -t "$IMAGE" .

# --- Çalıştır ----------------------------------------------------------------
if [[ "${1:-}" == "--systemd" ]]; then
  echo "==> systemd servisi kuruluyor ($UNIT)"
  sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__PORT__#$PORT#g" -e "s#/usr/bin/podman#$PODMAN#g" \
    deploy/morpheus-ai-podman.service > "$UNIT"
  systemctl daemon-reload
  systemctl enable --now morpheus-ai
  systemctl --no-pager --lines=0 status morpheus-ai | head -n 3 || true
else
  echo "==> Container başlatılıyor"
  "$PODMAN" run -d --name "$NAME" --user root \
    --restart unless-stopped \
    -p "$PORT:3000" \
    --env-file .env -e PORT=3000 \
    -v "$APP_DIR/logs:/app/logs:Z" \
    "$IMAGE"
fi

# --- Sağlık kontrolü ---------------------------------------------------------
echo "==> Sağlık kontrolü"
for i in {1..30}; do
  if curl --noproxy '*' -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    curl --noproxy '*' -s "http://127.0.0.1:$PORT/api/health"; echo
    echo "MorpheusAI hazır → http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT"
    exit 0
  fi
  sleep 1
done
echo "Uygulama yanıt vermedi. Loglar:  podman logs $NAME  /  journalctl -u morpheus-ai -n 50" >&2
exit 1

#!/usr/bin/env bash
# Pixel Office — açık kaynak ajan ofisini (Pixel Agents, MIT) bu makineye kurar ve uygulamaya bağlar. Tek başına çalışır.
#
#   UnixAI makinesinde:      sudo bash kur.sh --app unixai   [--app-dir /opt/unixai-os]
#   MorpheusAI makinesinde:  sudo bash kur.sh --app morpheus --app-dir /opt/MorpheusAI
#
#   Seçenekler:
#     --port 3100            ofis portu
#     --paket dosya.tgz      internetsiz kurulum: başka makinede `sablonu-indir.sh` ile hazırlanan klasörün tar.gz'si
#     --gizli                ofisi yalnızca bu makineden izle (firewall'da port açılmaz, 127.0.0.1)
#     --node-kurma           Node.js yoksa dnf ile kurma (kendiniz kurun)
#
# Ne yapar:
#   1) Node.js 20+ yoksa kurar (RHEL: dnf module nodejs:20)
#   2) pixel-agents@1.5.0'ı indirir, npm kaydındaki sha512 ile doğrular, /opt/pixel-office'e bağımlılıklarıyla kurar
#   3) systemd servisi "pixel-office" (gömülü terminal kapalı: --no-terminal) kurar ve başlatır
#   4) "Watch All Sessions" ayarını açar (~/.pixel-agents/config.json) — ajan karakterleri ofise otomatik gelir
#   5) Uygulamanın .env'ine PIXEL_OFFICE=true, PIXEL_URL, PIXEL_TOKEN yazar (yedek alır) ve uygulama servisini yeniden başlatır
#   6) Ofis adresini yazdırır
set -euo pipefail

VERSION=1.5.0
INTEGRITY="sha512-48aBAjfN6elF5xq44knHuhMVUfuYfZ8kj/CT1KRpaQLd9H3Ds76Crrd1O+LRtv0CQKdb0ZJI3wGjJkMr+OPaoA=="
OFFICE=/opt/pixel-office
PORT=3100
APP=""
APP_DIR=""
PAKET=""
GIZLI=0
NODE_KUR=1

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --paket) PAKET="$2"; shift 2 ;;
    --gizli) GIZLI=1; shift ;;
    --node-kurma) NODE_KUR=0; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Bilinmeyen seçenek: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mXX\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root olarak çalıştırın: sudo bash $0 --app unixai|morpheus"
case "$APP" in
  unixai) APP_DIR="${APP_DIR:-/opt/unixai-os}"; SERVICE=unixai-os ;;
  morpheus)
    if [ -z "$APP_DIR" ]; then for d in /opt/morpheus-ai /opt/MorpheusAI /opt/morpheusai; do [ -f "$d/server.js" ] && APP_DIR="$d" && break; done; fi
    SERVICE=morpheus-ai ;;
  *) die "--app unixai veya --app morpheus verin" ;;
esac
[ -n "$APP_DIR" ] && [ -d "$APP_DIR" ] || die "Uygulama klasörü bulunamadı: '${APP_DIR}' (--app-dir ile verin)"
[ -f "$APP_DIR/.env" ] || die "$APP_DIR/.env yok (önce uygulamayı kurun)"
HOST_FQDN="$(hostname -f 2>/dev/null || hostname)"

# Uygulama container'da mı? (podman: host'un 127.0.0.1'ine erişemez)
CONTAINER=0
if systemctl cat "$SERVICE" 2>/dev/null | grep -q "podman run"; then CONTAINER=1; fi
if command -v podman >/dev/null && podman ps --format '{{.Names}}' 2>/dev/null | grep -qx "$SERVICE"; then CONTAINER=1; fi

# --- 1) Node.js 20+ ---
node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  [ "$NODE_KUR" -eq 1 ] && command -v dnf >/dev/null || die "Node.js 20+ gerekli (RHEL: dnf module install -y nodejs:20)"
  say "Node.js 20 kuruluyor (dnf)"
  dnf module reset -y nodejs >/dev/null 2>&1 || true
  dnf module install -y nodejs:20 >/dev/null || dnf install -y nodejs >/dev/null
  node_ok || die "Node.js 20+ kurulamadı"
fi
NODE="$(command -v node)"

# --- 2) şablon ---
mkdir -p "$OFFICE"
if [ -n "$PAKET" ]; then
  say "Hazır paketten kuruluyor: $PAKET"
  tar xzf "$PAKET" -C "$OFFICE" --strip-components=1
else
  command -v npm >/dev/null || die "npm yok (nodejs paketiyle gelir); internetsiz kurulum için --paket kullanın"
  cd "$OFFICE"
  say "pixel-agents@$VERSION indiriliyor"
  npm pack "pixel-agents@$VERSION" --silent >/dev/null || die "İndirilemedi (internet/npm aynası?). İnternetsiz: --paket"
  GOT="sha512-$(openssl dgst -sha512 -binary "pixel-agents-$VERSION.tgz" | base64 | tr -d '\n')"
  [ "$GOT" = "$INTEGRITY" ] || { rm -f "pixel-agents-$VERSION.tgz"; die "Bütünlük doğrulanamadı (beklenen $INTEGRITY)"; }
  say "sha512 doğrulandı"
  [ -f package.json ] || echo '{ "name": "pixel-office", "private": true }' > package.json
  npm install "./pixel-agents-$VERSION.tgz" --omit=dev --no-audit --no-fund --silent
fi
CLI="$OFFICE/node_modules/pixel-agents/dist/cli.js"
[ -f "$CLI" ] || die "Pixel Agents bulunamadı: $CLI"

# --- 3) Watch All Sessions (servis açılmadan önce) ---
mkdir -p /root/.pixel-agents
CFG=/root/.pixel-agents/config.json
"$NODE" -e '
  const fs = require("fs"); const f = process.argv[1];
  let c = {}; try { c = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  c.watchAllSessions = true;
  fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });' "$CFG"
say "Watch All Sessions açık ($CFG)"

# --- 4) systemd servisi ---
BIND=0.0.0.0
EXTRA="--allowed-host $HOST_FQDN"
if [ "$GIZLI" -eq 1 ] && [ "$CONTAINER" -eq 0 ]; then BIND=127.0.0.1; EXTRA=""; fi
cat > /etc/systemd/system/pixel-office.service <<EOF
[Unit]
Description=Pixel Office - acik kaynak ajan ofisi (Pixel Agents, MIT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$OFFICE
ExecStart=$NODE $CLI --port $PORT --host $BIND $EXTRA --no-terminal
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q --now pixel-office
systemctl restart pixel-office

for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || { journalctl -u pixel-office -n 30 --no-pager; die "Pixel Office açılmadı"; }
TOKEN="$(cat /root/.pixel-agents/standalone-token 2>/dev/null || true)"
[ -n "$TOKEN" ] || TOKEN="$("$NODE" -e 'const fs=require("fs"),p="/root/.pixel-agents/servers";for(const f of fs.readdirSync(p)){const c=JSON.parse(fs.readFileSync(p+"/"+f,"utf8"));if(c.port==process.argv[1]){console.log(c.token);break}}' "$PORT" 2>/dev/null || true)"
[ -n "$TOKEN" ] || die "Pixel Office token'ı bulunamadı (/root/.pixel-agents/)"
say "Pixel Office çalışıyor (port $PORT)"

if [ "$GIZLI" -eq 0 ] && command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1 && ! firewall-cmd --query-port="$PORT/tcp" >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT/tcp" >/dev/null && firewall-cmd --reload >/dev/null
  say "firewall: $PORT/tcp açıldı (token'sız adres yalnızca izleme verir; olay ucu token ister)"
fi

# --- 5) uygulamayı bağla ---
if [ "$CONTAINER" -eq 1 ]; then PURL="http://host.containers.internal:$PORT"; else PURL="http://127.0.0.1:$PORT"; fi
cp -p "$APP_DIR/.env" "$APP_DIR/.env.pixel-yedek.$(date +%Y%m%d%H%M%S)"
setenv() { # anahtar varsa değiştir, yoksa ekle
  if grep -qE "^$1=" "$APP_DIR/.env"; then sed -i -E "s#^$1=.*#$1=$2#" "$APP_DIR/.env"; else printf '%s=%s\n' "$1" "$2" >> "$APP_DIR/.env"; fi
}
setenv PIXEL_OFFICE true
setenv PIXEL_URL "$PURL"
setenv PIXEL_TOKEN "$TOKEN"
say "$APP_DIR/.env güncellendi (PIXEL_OFFICE, PIXEL_URL=$PURL, PIXEL_TOKEN; yedek: .env.pixel-yedek.*)"

if systemctl list-unit-files "$SERVICE.service" >/dev/null 2>&1 && systemctl cat "$SERVICE" >/dev/null 2>&1; then
  systemctl restart "$SERVICE" && say "$SERVICE yeniden başlatıldı"
else
  warn "$SERVICE servisi bulunamadı; uygulamayı kendiniz yeniden başlatın (podman: deploy/podman-up.sh)"
fi

cat <<EOF

$(say "Kuruldu")
  Ofis (izleme):      http://$HOST_FQDN:$PORT/
  Ofis (yönetim):     http://$HOST_FQDN:$PORT/?token=$TOKEN     ← gizli tutun
  Durum:              systemctl status pixel-office   ·   curl -s http://127.0.0.1:<uygulama-portu>/api/pixel/status
  Kaldırmak:          systemctl disable --now pixel-office; rm -rf $OFFICE /etc/systemd/system/pixel-office.service; .env'de PIXEL_OFFICE=false
EOF

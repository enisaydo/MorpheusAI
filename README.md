# MorpheusAI

Ansible (AWX / AAP) Job Template ve Workflow'larının kurumsal standartlara uygunluğunu analiz eden interaktif web arayüzü.

## Çalıştırma

```bash
npm start            # veya: node server.js
# → http://localhost:3000
```

Bağımlılık yoktur, Node.js 18+ yeterlidir. `npm test` smoke testleri çalıştırır.

## Sunucuya kurulum (Podman, root)

Uygulama container içinde **root** kullanıcısıyla çalışır.

```bash
sudo -i
git clone https://github.com/enisaydo/MorpheusAI.git /opt/morpheus-ai
cd /opt/morpheus-ai
cp .env.example .env && vi .env          # TMS / CHAT değerlerini girin

./deploy/podman-up.sh --systemd          # build + systemd servisi (podman run), açılışta otomatik başlar
# veya
./deploy/podman-up.sh                    # sadece build + podman run
```

Güncelleme:

```bash
cd /opt/morpheus-ai && git pull && ./deploy/podman-up.sh --systemd
```

Yönetim:

```bash
systemctl status morpheus-ai       # --systemd kurulumunda
journalctl -u morpheus-ai -f
podman ps / podman logs -f morpheus-ai
```

### podman-compose ile

```bash
podman-compose up -d --build       # veya: podman compose up -d --build
```

### Hazır imaj (GHCR)

`main` dalına her push'ta CI testleri çalıştırır ve imajı `ghcr.io/enisaydo/morpheusai:latest` olarak yayınlar.

```bash
podman run -d --name morpheus-ai --user root -p 3000:3000 --env-file .env ghcr.io/enisaydo/morpheusai:latest
```

### Container olmadan (systemd)

`deploy/morpheus-ai.service` dosyasındaki adımları izleyin (Node.js 18+ gerekir).

## Ekranlar

| Ekran | Ne yapar |
|---|---|
| **Komuta Merkezi** | Genel uyum skoru, KPI'lar, template ve workflow listeleri |
| **Template Analizi** | YAML editörü (AWX'ten seç / dosya yükle / yapıştır), kural seçimi, ek prompt, skor + bulgular + eksikler + düzeltme önerileri |
| **Workflow Analizi** | Workflow akışının görsel diyagramı (success/failure/always), akış standart analizi, sorunlu düğümlerin işaretlenmesi |
| **Morpheus'a Sor** | Son analizi bağlam olarak alan sohbet / prompt ekranı |
| **Standartlar** | Kural kataloğu; kuralları aç/kapat, özel kural ekle |
| **Ayarlar** | API Base URL, API anahtarı, model, sistem promptu, API sözleşmesi |

## AI bağlantısı (GenAI gateway)

```
.env  →  TMS token servisi  →  Authorization: Bearer <token> + header'lar  →  chat/completions
```

1. `cp .env.example .env` ve değerleri doldurun (Bruno'daki istekle birebir):
   - `TMS_TOKEN_URL`, `TMS_BODY`, `TMS_H_*` → token isteği
   - `CHAT_URL`, `CHAT_H_*`, `CHAT_MODEL` → chat/completions isteği
   - Header'lar `PREFIX_HEADER_ADI` biçiminde yazılır: `CHAT_H_CLIENT_SESSION_ID` → `client-session-id`
   - `{{uuid}}` her istekte yeni UUID üretir
2. `npm start` — `.env` doluysa sunucu otomatik **GENAI** moduna geçer.
3. *Ayarlar → Token al & test et* ile bağlantıyı doğrulayın.

Token sunucuda cache'lenir, süresi dolunca veya 401/403 alınınca otomatik yenilenir. Token ve header'lar tarayıcıya hiç gönderilmez.
Kurum içi sertifika için `NODE_EXTRA_CA_CERTS=/yol/kurum-ca.pem` kullanın.

| Mod | Ne zaman |
|---|---|
| `genai` | `.env`'de `TMS_TOKEN_URL` ve `CHAT_URL` tanımlı |
| `proxy` | `AI_BACKEND_URL` tanımlı — tüm `/api/*` istekleri o servise gider |
| `demo` | hiçbiri yok — mock veri + kural motoru |

> **Uyarı:** Repo public'tir. `.env` dosyası `.gitignore`'dadır; kurum adresleri, client-id ve token'ları asla commit'lemeyin.

Beklenen uç noktalar ve veri şekilleri `public/js/api.js` içindeki `API_CONTRACT`'ta ve *Ayarlar* ekranında yer alır.

## Yapı

```
server.js            statik sunucu + API yönlendirme (genai / proxy / demo)
lib/genai.js         TMS token + chat/completions istemcisi
lib/analyzer.js      prompt oluşturma ve AI cevabını AnalysisResult'a dönüştürme
lib/demo.js          demo kural motoru
lib/env.js           .env yükleyici
mock/                demo standartlar, template'ler, workflow'lar
public/index.html    arayüz iskeleti
public/styles.css    Morpheus / Matrix teması
public/js/api.js     API katmanı (backend bağlantısı burada)
public/js/ui.js      ortak UI yardımcıları
public/js/app.js     ekran mantığı
scripts/smoke-test.js  uçtan uca smoke test (npm test)
Dockerfile, docker-compose.yml, .env.example
deploy/              podman-up.sh, Podman systemd servisi, container'sız systemd servisi
.github/workflows/   CI: test + GHCR'a docker imajı
```

# MorpheusAI

Ansible (AWX / AAP) Job Template ve Workflow'larının kurumsal standartlara uygunluğunu analiz eden interaktif web arayüzü.

## Çalıştırma

```bash
npm start            # veya: node server.js
# → http://localhost:3000
```

Bağımlılık yoktur, Node.js 18+ yeterlidir. `npm test` smoke testleri çalıştırır.

## Sunucuya kurulum

### Docker Compose (önerilen)

```bash
cp .env.example .env        # AI_BACKEND_URL ve HOST_PORT'u düzenleyin
docker compose up -d --build
```

### Hazır imaj (GHCR)

`main` dalına her push'ta CI testleri çalıştırır ve imajı `ghcr.io/<owner>/<repo>:latest` olarak yayınlar.

```bash
docker run -d --name morpheus-ai -p 3000:3000 \
  -e AI_BACKEND_URL=http://ai-backend:8000 \
  ghcr.io/<owner>/<repo>:latest
```

### Docker olmadan (systemd)

`deploy/morpheus-ai.service` dosyasındaki adımları izleyin.

## Ekranlar

| Ekran | Ne yapar |
|---|---|
| **Komuta Merkezi** | Genel uyum skoru, KPI'lar, template ve workflow listeleri |
| **Template Analizi** | YAML editörü (AWX'ten seç / dosya yükle / yapıştır), kural seçimi, ek prompt, skor + bulgular + eksikler + düzeltme önerileri |
| **Workflow Analizi** | Workflow akışının görsel diyagramı (success/failure/always), akış standart analizi, sorunlu düğümlerin işaretlenmesi |
| **Morpheus'a Sor** | Son analizi bağlam olarak alan sohbet / prompt ekranı |
| **Standartlar** | Kural kataloğu; kuralları aç/kapat, özel kural ekle |
| **Ayarlar** | API Base URL, API anahtarı, model, sistem promptu, API sözleşmesi |

## AI backend'i bağlama

Varsayılan olarak sunucu **demo modunda** çalışır (`mock/` altındaki örnek veriler + basit kural motoru).

Gerçek backend'i bağlamanın iki yolu var:

1. **Proxy (önerilen):** Sunucuyu backend adresiyle başlatın; tüm `/api/*` istekleri oraya yönlendirilir.
   ```bash
   # PowerShell
   $env:AI_BACKEND_URL="http://ai-backend:8000"; node server.js
   ```
2. **Doğrudan:** Arayüzde *Ayarlar → API Base URL* alanına backend adresini girin (backend CORS'a izin vermelidir).

Beklenen uç noktalar ve veri şekilleri `public/js/api.js` içindeki `API_CONTRACT`'ta ve *Ayarlar* ekranında yer alır.

## Yapı

```
server.js            statik sunucu + demo API + proxy
mock/                demo standartlar, template'ler, workflow'lar
public/index.html    arayüz iskeleti
public/styles.css    Morpheus / Matrix teması
public/js/api.js     API katmanı (backend bağlantısı burada)
public/js/ui.js      ortak UI yardımcıları
public/js/app.js     ekran mantığı
scripts/smoke-test.js  uçtan uca smoke test (npm test)
Dockerfile, docker-compose.yml, .env.example
deploy/              systemd servis dosyası
.github/workflows/   CI: test + GHCR'a docker imajı
```

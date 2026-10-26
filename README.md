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
| **Genel Bakış** | AAP'deki job template ve workflow'lar, uyum skorları |
| **Template Analizi** | AAP job template tanımı veya playbook YAML'ı; kural seçimi, ek talimat, bulgular + eksikler + düzeltmeler |
| **Workflow Analizi** | AAP workflow akış diyagramı (success/failure/always), akış standart analizi |
| **Analiz Geçmişi** | Tüm analizler: zaman, kullanıcı, hedef, skor, ihlal edilen kurallar; en sık ihlal edilen kurallar, hedef bazında skor değişimi, CSV |
| **Ajan & MCP** | Barındırılan /mcp, erişim token'ları, izinli alanlar, bağlı MCP sunucuları, ajan ayarları ve konuşmaları |
| **Morpheus Ajanı** | Sohbet; bağlam olarak job template / workflow / son analiz seçilebilir, standartlar AI'a otomatik gönderilir |
| **Düzeltmeler** | UnixAI OS'un sunucu bulguları için üretilen standart uyumlu playbook'lar; onay, AAP'de check / gerçek çalıştırma, iş çıktısı |
| **Standartlar** | Kural kataloğu (STD / JT / WF); aç/kapat, özel kural ekle |
| **Token Kullanımı** | Günlük token grafiği ve limit, kullanıcıya / türe göre dağılım, her sorgunun token kullanımı, CSV dışa aktarma |
| **AI Logları** | GenAI ve AAP'ye giden her istek ve dönen cevap (gizli alanlar maskeli), token kullanımı |
| **Ayarlar** | GenAI ve AAP bağlantı durumu ve testi, API sözleşmesi |

## Ansible Automation Platform bağlantısı

`.env` içinde `AAP_URL` ve `AAP_TOKEN` (veya `AAP_USERNAME`/`AAP_PASSWORD`) tanımlanınca template ve workflow listeleri AAP'den okunur.
API yolu otomatik algılanır (AAP 2.5/2.6: `/api/controller/v2`, 2.4/AWX: `/api/v2`); gerekirse `AAP_API_PREFIX` ile sabitlenebilir. Yalnızca okuma (GET) yapılır; token için *Read* scope yeterlidir.

AAP API'si playbook dosya içeriğini sunmaz; template analizi job template **tanımı** (envanter, credential, extra_vars, survey,
verbosity, timeout, execution environment, bildirimler...) üzerinden yapılır. Playbook YAML'ı editöre yapıştırılarak ayrıca analiz edilebilir.

## UnixAI OS düzeltmeleri (bulgu → playbook → AAP)

UnixAI OS bir sunucuda bulgu bulduğunda `POST /api/remediations` ile Morpheus'a gönderir (Bearer `MORPHEUS_API_TOKEN`).
Morpheus kurumsal standartlara uygun bir playbook üretir (GenAI; yoksa yalnızca salt-okunur tanı komutlarından güvenli bir playbook),
standart analizinden geçirir, uyum skoru `REMEDIATION_MIN_SCORE` altındaysa ihlalleri modele verip bir kez yeniden üretir.
Playbook **onay bekler**: onaydan önce AAP'de hiçbir şey çalışmaz (istek UnixAI ajanından gelse bile). Bir kişi **Düzeltmeler**
ekranından veya **UnixAI ekranından** playbook'u görüp onaylar; ardından AAP runner job template'i ile **check (dry-run)** otomatik başlar,
check başarılıysa kişi **Sunucuya uygula** der ve o sunucu (`limit`) için gerçek çalıştırma yapılır. Kurulum: [`deploy/aap/README.md`](deploy/aap/README.md).

**MCP:** `mcp/morpheus-mcp.js`, UnixAI OS'un `mcp/unixai_mcp.py` sunucusuyla birlikte bir MCP istemcisine eklenince iki sistem
araç çağrılarıyla konuşur — bkz. [`mcp/README.md`](mcp/README.md).

## Ajan ve MCP (birbiriyle konuşan iki ajan)

MorpheusAI bir **ajandır**: kurumsal GPT + araçlarla çok adımlı çalışır. Araçlarını `POST /mcp` (Streamable HTTP) üzerinden başka alanlara **barındırır** (arayüzden üretilen token'lar, salt-okunur seçeneği, izinli Origin listesi) ve başka MCP sunucularına **istemci olarak bağlanır** (ör. UnixAI OS, diğer ekiplerin ajanları). İki uygulama `*_agent_ask` araçlarıyla birbirinin ajanına doğal dilde soru sorar; hop sınırı döngüyü önler. Gerçek uygulama her zaman insan onayı gerektirir.

Kurulum ve mimari: [`mcp/README.md`](mcp/README.md) · Arayüz: **Ajan & MCP**

## LDAP ile giriş

`.env`'de üç değer yeterli; `LDAP_SERVER` dolunca uygulamaya giriş zorunlu olur (Active Directory / OpenLDAP):

```env
LDAP_SERVER=dc01.kurum.local:636
LDAP_BASE_DN=DC=kurum,DC=local
LDAP_BIND_DN={{username}}@kurum.local
```

- `LDAP_SERVER`: ad, `ad:port` veya `ldap(s)://ad:port` (636 → otomatik ldaps).
- `LDAP_BIND_DN` bir OU ise (`OU=All users,DC=fw,DC=kurum,DC=com`) kullanıcılar o OU altında aranır ve `kullanici@fw.kurum.com` ile kendi parolasıyla bağlanır; alan adı DC bileşenlerinden çıkarılır (`LDAP_UPN_SUFFIX` ile değiştirilebilir).
- `LDAP_BIND_DN` örnekleri: `{{username}}@kurum.local`, `KURUM\{{username}}`, `uid={{username}},ou=people,dc=kurum,dc=local`.
- Değerlerin başındaki/sonundaki tırnaklar otomatik temizlenir; satır sonuna yorum eklemeyin.

- `LDAP_BIND_DN` `{{username}}` içeriyorsa kullanıcı kendi parolasıyla doğrudan bağlanır, servis hesabı gerekmez.
  Sabit bir DN ise kullanıcı `LDAP_BASE_DN` altında aranır, ardından kendi parolasıyla doğrulanır. Arama `LDAP_BIND_PASSWORD` varsa bu hesapla, yoksa anonim yapılır (sunucu anonim aramaya izin vermeli; AD varsayılan olarak vermez).
- Giriş ekranında kullanıcının kendi parolası her durumda zorunludur.
- Varsayılan kullanıcı filtresi AD (`sAMAccountName`, `userPrincipalName`) ve OpenLDAP (`uid`) için çalışır; gerekirse `LDAP_USER_FILTER`.
- `LDAP_REQUIRED_GROUP`: yalnızca bu grubun (doğrudan) üyeleri girebilir. `LDAP_ADMIN_GROUP`: limit ve sistem mesajını yalnızca bu grup değiştirebilir.
- Oturum HMAC imzalı, HttpOnly çerezde tutulur (`SESSION_TTL_HOURS`). Boş parola reddedilir; 15 dakikada 5 hatalı deneme kullanıcıyı ve IP'yi 15 dakika kilitler.
- `ldaps` (636) veya `LDAP_STARTTLS=true` kullanın; düz 389 parolayı ağda şifresiz gönderir.

## Analiz geçmişi

Her template ve workflow analizi `data/history/YYYY-MM-DD.jsonl` dosyasına kaydedilir: zaman, kullanıcı, hedef (AAP ID ve adı),
skor, durum, tüm bulgular (kural, önem, açıklama, satır/düğüm, düzeltme), eksikler, uygulanan kurallar ve ek talimat.
Genel Bakış'taki "son skor" bu kayıtlardan okunur; servis yeniden başlatılınca kaybolmaz.

## Token kullanımı ve limitler

- Her AI çağrısı `data/usage/YYYY-MM-DD.jsonl` dosyasına kaydedilir: zaman, kullanıcı, IP, tür, sorgu metni, model, girdi/çıktı/toplam token.
- **Ayarlar → Token limitleri**: günlük toplam limit ve kullanıcı başına günlük limit (0 = sınırsız). Limit dolunca yeni AI istekleri `429` ile reddedilir ve gateway'e hiç gidilmez; gün `USAGE_TIMEZONE`'a göre 00:00'da sıfırlanır.
- Kullanıcı adı ilk girişte arayüzde sorulur ve `X-Morpheus-User` header'ı ile gönderilir (doğrulanmaz). Önde SSO yapan bir proxy varsa `.env`'de `USER_HEADER` ile onun header'ı kullanılabilir.
- Gateway `usage` alanı döndürmezse token sayısı karakter sayısından tahmin edilir ve raporda "≈" ile işaretlenir.

## Pixel Office

MorpheusAI ajanı, açık kaynak Pixel Agents ofisinde UnixAI ajanıyla birlikte karakter olarak görünür
(playbook yazarken, onay beklerken izin balonu). Kurulum ve köprü: UnixAI-OS deposunda `integrations/pixel-office/`.
Köprü gerekmez: `.env`'de `PIXEL_OFFICE=true` olunca MorpheusAI aynı makinedeki Pixel Agents ofisine olayları
doğrudan gönderir (token `~/.pixel-agents/` altından otomatik bulunur). Durum: `GET /api/pixel/status`.
Tek komutla kurulum: `sudo bash deploy/pixel-office/kur.sh --app morpheus` (ofisi kurar, `.env`'i ayarlar, servisi yeniden başlatır).

## Ajan izleme arayüzü (Langfuse)

Ajan çalışmaları, araç adımları, GPT çağrıları (model, token) ve playbook üretimi kurum içi Langfuse'a OpenTelemetry ile
gönderilir; UnixAI'den gelen konuşmalar UnixAI'nin iziyle birleşir. Kurulum: UnixAI-OS deposunda `deploy/langfuse/kur.sh`;
sonra `.env`'e `LANGFUSE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_PROJECT_ID` girin.

## Loglar

Sistemin yaptığı her işlem, kategorisine göre **ayrı dosyaya** yazılır (`logs/<kategori>/<kategori>-YYYY-MM-DD.jsonl`,
container'da `/opt/morpheus-ai/logs` dizinine bağlı; `LOG_RETENTION_DAYS` gün saklanır):

| Dosya | İçerik |
|---|---|
| `logs/islem/` | arayüz/API'den yapılan her değişiklik: kim, ne, sonuç (HTTP kodu), hata |
| `logs/giris/` | LDAP giriş denemeleri |
| `logs/duzeltme/` | düzeltme akışı: bulgu alındı → playbook üretildi → onay → Bitbucket commit → AAP proje sync → template → check/run → sonuç |
| `logs/bitbucket/` | Bitbucket REST çağrıları (istek/cevap) |
| `logs/aap/` | AAP REST çağrıları (proje sync, job template, launch, durum) |
| `logs/genai/` | TMS token ve GPT çağrıları |
| `logs/mcp-istemci/`, `logs/mcp-sunucu/` | giden / gelen MCP çağrıları |
| `logs/ajan/`, `logs/ajanlar-arasi/` | ajanın araç adımları, UnixAI ⇄ MorpheusAI konuşmaları |

Arayüzde **Log Dosyaları** ekranından kategori/tarih seçip arayabilirsiniz; `journalctl -u morpheus-ai` tek satırlık özetleri gösterir.
Parola ve secret'lar tamamen, token/client-id'ler ilk 4 karakter dışında maskelenir.

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
3. *Ayarlar → Bağlantıları test et* ile doğrulayın.

Token önce `TMS_TOKEN_PATH`, sonra yanıt header'ı (`TMS_TOKEN_HEADER`, varsayılan `authorization`; `Bearer` / `Bearer:` öneki temizlenir), en son gövdedeki bilinen alanlardan okunur; `TMS_TOKEN_SOURCE=header|body` ile sabitlenebilir.
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
lib/aap.js           Ansible Automation Platform API istemcisi
lib/http.js          ortak HTTP istemcisi (loglu)
lib/logger.js        istek/cevap logları (maskeli)
lib/ldap.js          bağımlılıksız LDAPv3 istemcisi (bind, search, StartTLS)
lib/auth.js          LDAP girişi, oturum çerezi, kilitleme
lib/usage.js         token kullanımı ve limitler
lib/history.js       analiz geçmişi
lib/analyzer.js      prompt oluşturma ve AI cevabını AnalysisResult'a dönüştürme
lib/demo.js          demo kural motoru
lib/env.js           .env yükleyici
mock/                demo standartlar, template'ler, workflow'lar
public/index.html    arayüz iskeleti
public/styles.css    AAP (PatternFly) görünümü
public/js/api.js     API katmanı (backend bağlantısı burada)
public/js/ui.js      ortak UI yardımcıları
public/js/app.js     ekran mantığı
scripts/smoke-test.js  uçtan uca smoke test (npm test)
Dockerfile, docker-compose.yml, .env.example
deploy/              podman-up.sh, Podman systemd servisi, container'sız systemd servisi
.github/workflows/   CI: test + GHCR'a docker imajı
```

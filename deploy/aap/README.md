# UnixAI OS → MorpheusAI → AAP düzeltme akışı

```
UnixAI OS (bulgu) ──POST /api/remediations──▶ MorpheusAI
                                               │ GenAI: standartlara uygun playbook
                                               │ Standart analizi (uyum skoru, gerekirse 1 kez düzeltme)
                                               │ İnsan onayı (Düzeltmeler ekranı veya UnixAI ekranı) — onaysız AAP işi yok
                                               ▼
                       AAP runner job template ──limit=<sunucu>──▶ RHEL sunucu
                       (onaydan sonra check / dry-run, sonra kişi "Sunucuya uygula" der)
```

## Onay akışı (AAP'de hiçbir şey onaysız çalışmaz)

1. MorpheusAI playbook'u yazar ve standart analizinden geçirir → kayıt **onay bekliyor** (`generated`). AAP'ye hiçbir iş gönderilmez —
   istek UnixAI ajanından / MCP'den gelse bile. Ajan cevabında "bu playbook'u yazdım" der ve onay ister.
2. Bir kişi playbook'u (YAML) görüp **Onayla** der — MorpheusAI → Düzeltmeler ekranından **veya UnixAI ekranından**
   (sohbet cevabındaki kart, MorpheusAI sekmesi, sunucu detayı, dashboard'daki "N playbook onayınızı bekliyor" bandı).
3. Onaydan sonra AAP'de **check (dry-run)** otomatik başlar (`REMEDIATION_CHECK_ON_APPROVE`).
4. Check başarılıysa bir kişi **Sunucuya uygula** der → AAP gerçek çalıştırma. Ajanlar uygulama başlatamaz.

UnixAI'den onay için MorpheusAI → **Ajan & MCP** → token üret → **"Onay aktarabilir"** işaretleyin; bu token'ı UnixAI'de
Ayarlar → MorpheusAI (veya Ajan & MCP → morpheusai bağlantısı) alanına girin. UnixAI onaylayan kişinin adını `X-Approved-By`
ile iletir; kayıtta `EnisA (unixai üzerinden)` gibi görünür. Bu token MCP'de onay aracı açmaz — onay yalnızca insan eliyle verilir.


## Teslim: Bitbucket → AAP template (önerilen, `REMEDIATION_DELIVERY=scm`)

AAP, playbook dosyası projenin SCM reposunda olmadan job template oluşturamaz. Bu yüzden onaydan sonra sıra şöyledir:

1. Playbook Bitbucket'a commit edilir: `BITBUCKET_PATH/<sunucu>/<kayıt>.yml` (commit mesajında onaylayan kişi)
2. AAP projesi Bitbucket'tan güncellenir (`POST projects/<AAP_PROJECT_ID>/update/`, bitmesi beklenir)
3. Kayda özel job template oluşturulur/güncellenir: `UnixAI | <sunucu> | <kayıt>` (envanter, credential, Prompt on launch: Limit/Variables/Job type)
4. Check (dry-run) başlar; başarılıysa bir kişi **Sunucuya uygula** der

Bir adım başarısız olursa (ör. Bitbucket 403) hata kayda ve `logs/duzeltme/` dosyasına yazılır; düzeltip
**Tekrar dene** (MorpheusAI veya UnixAI ekranı) ile kaldığı yerden devam edilir.

Gerekenler:
- Bitbucket token'ı: repoda **Repository write** (Server/DC: HTTP access token; Cloud: repository access token veya app password)
- AAP'de bu repoya bağlı bir **proje** (SCM branch = `BITBUCKET_BRANCH`)
- AAP token'ı: projede **Update**, envanter/credential/projede **Use**, organizasyonda **Job Template Admin** (template oluşturma) ve **Execute**

```env
BITBUCKET_URL=https://bitbucket.kurum.local
BITBUCKET_TOKEN=<HTTP access token>
BITBUCKET_PROJECT=OPS
BITBUCKET_REPO=ansible-ops
BITBUCKET_BRANCH=main
AAP_PROJECT_ID=12
AAP_INVENTORY_ID=3
AAP_CREDENTIAL_IDS=7
```

Bağlantıyı denemek için: `curl -X POST http://localhost:3000/api/bitbucket/test`

## Bir kerelik AAP kurulumu (runner yöntemi, `REMEDIATION_DELIVERY=runner`)

1. `unixai_remediation_runner.yml` dosyasını AAP'nin kullandığı bir Git projesine koyun (örn. `ansible-ops` reposu) ve projeyi senkronlayın.
2. **Job template** oluşturun:
   - Playbook: `unixai_remediation_runner.yml`
   - Inventory: RHEL sunucularının bulunduğu envanter (UnixAI'deki sunucu adları envanterdeki host adlarıyla aynı olmalı;
     değilse UnixAI → Ayarlar → MorpheusAI → "AAP hedefi" alanını *adres* yapın)
   - Credentials: hedeflere bağlanan Machine credential (root veya sudo)
   - Privilege escalation: açık
   - **Prompt on launch**: *Limit*, *Variables (extra vars)* ve *Job type* kutularını işaretleyin
3. Template ID'sini MorpheusAI `.env` dosyasına yazın ve token'a bu template üzerinde **Execute** yetkisi verin:

```env
AAP_URL=https://aap.kurum.local
AAP_TOKEN=<Execute yetkili token>
REMEDIATION_JOB_TEMPLATE_ID=42
```

## Güvenlik ayarları (`.env`)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `MORPHEUS_API_TOKEN` | — | UnixAI OS köprüsü ve MCP sunucusunun kullandığı token (≥16 karakter, virgülle birden fazla) |
| `REMEDIATION_MIN_SCORE` | 85 | Uyum skoru bunun altındaysa ihlaller modele geri verilip bir kez yeniden üretilir |
| `REMEDIATION_REQUIRE_CHECK` | true | Gerçek çalıştırmadan önce başarılı bir check (dry-run) zorunlu |
| `REMEDIATION_AUTO_APPROVE` | false | true ise uyum skoru eşiği geçen playbook'lar otomatik onaylanır |
| `REMEDIATION_APPROVAL_BEFORE_AAP` | true | AAP'ye (check dahil) iş göndermeden önce insan onayı zorunlu |
| `REMEDIATION_CHECK_ON_APPROVE` | true | Onay verilince check (dry-run) otomatik başlar |
| `REMEDIATION_ALLOW_API_APPROVE` | false | true ise `.env` `MORPHEUS_API_TOKEN`'ı da onay aktarabilir (X-Approved-By zorunlu). Tercih edilen: arayüzde "Onay aktarabilir" token |

Kesinti riski olan task'lar (reboot, servis restart, LV resize, paket güncelleme) playbook'ta
`when: unixai_allow_disruptive | default(false) | bool` koşuluyla yazılır; yalnızca onaylı gerçek çalıştırmada
"Kesinti riskli adımlara izin ver" işaretlenirse çalışır.

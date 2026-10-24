# UnixAI OS → MorpheusAI → AAP düzeltme akışı

```
UnixAI OS (bulgu) ──POST /api/remediations──▶ MorpheusAI
                                               │ GenAI: standartlara uygun playbook
                                               │ Standart analizi (uyum skoru, gerekirse 1 kez düzeltme)
                                               │ İnsan onayı (Düzeltmeler ekranı)
                                               ▼
                       AAP runner job template ──limit=<sunucu>──▶ RHEL sunucu
                       (önce check / dry-run, sonra gerçek)
```

## Bir kerelik AAP kurulumu

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
| `REMEDIATION_ALLOW_API_APPROVE` | false | true ise API/MCP üzerinden onay verilebilir (önerilmez) |

Kesinti riski olan task'lar (reboot, servis restart, LV resize, paket güncelleme) playbook'ta
`when: unixai_allow_disruptive | default(false) | bool` koşuluyla yazılır; yalnızca onaylı gerçek çalıştırmada
"Kesinti riskli adımlara izin ver" işaretlenirse çalışır.

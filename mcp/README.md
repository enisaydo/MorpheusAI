# UnixAI OS ⇄ MorpheusAI — MCP ile konuşturma

İki MCP sunucusu vardır; MCP protokolünde sunucular birbirine doğrudan bağlanmaz, **bir MCP istemcisi (Claude Code, Claude Desktop vb.)
ikisini birlikte kullanır** ve araç çağrılarıyla iki sistem arasında veri taşır. Ayrıca MCP olmadan da çalışan doğrudan bir **köprü** vardır
(UnixAI OS → Ayarlar → MorpheusAI).

```
                 ┌──────────── MCP istemcisi (Claude Code / Desktop) ────────────┐
                 │                                                                │
   unixai_mcp.py (stdio)                                           morpheus-mcp.js (stdio)
        │  unixai_get_server_findings  ──── bulgu ────▶  morpheus_create_remediation │
        │  unixai_send_to_morpheus (köprü) ─────────────▶ (UnixAI OS kendi gönderir) │
        ▼                                                                ▼
   UnixAI OS REST  ─────────── köprü: POST /api/remediations ───────────▶ MorpheusAI REST ──▶ AAP runner ──▶ RHEL sunucu
```

## Kurulum

1. Her iki uygulamada servisler arası token tanımlayın (≥16 karakter, örn. `openssl rand -hex 24`):
   - UnixAI OS `.env`: `UNIXAI_API_TOKEN=...`
   - MorpheusAI `.env`: `MORPHEUS_API_TOKEN=...`
2. UnixAI OS → **Ayarlar → MorpheusAI**: MorpheusAI adresi + `MORPHEUS_API_TOKEN` → *Kaydet + bağlantıyı test et*.
3. MCP istemcisine iki sunucuyu ekleyin (`claude-mcp.example.json`):

```bash
# Claude Code
claude mcp add unixai-os -e UNIXAI_URL=http://unixai.kurum.local:3000 -e UNIXAI_API_TOKEN=... -- python3 /opt/unixai-os/mcp/unixai_mcp.py
claude mcp add morpheusai -e MORPHEUS_URL=http://morpheus.kurum.local:3000 -e MORPHEUS_API_TOKEN=... -- node /opt/morpheus-ai/mcp/morpheus-mcp.js
```

Claude Desktop için aynı içeriği `claude_desktop_config.json` dosyasındaki `mcpServers` altına koyun.

## Araçlar

| UnixAI OS (`unixai-os`) | MorpheusAI (`morpheusai`) |
|---|---|
| `unixai_list_servers` — sunucular, skor, durum, P1 | `morpheus_list_standards` — kurumsal Ansible standartları |
| `unixai_get_server_findings` — anomaliler, aksiyonlar (index'li), kural bulguları | `morpheus_create_remediation` — bulgudan standartlara uygun playbook + uyum skoru |
| `unixai_get_fleet_summary` | `morpheus_list_remediations` / `morpheus_get_remediation` |
| `unixai_run_collection` / `unixai_get_run` | `morpheus_launch_remediation` — `check` (dry-run) veya `run` (onay gerekir) |
| `unixai_send_to_morpheus` — köprüyle gönderim | `morpheus_job_output` — AAP iş çıktısı |
| `unixai_list_remediations` | `morpheus_analyze_template` |
| `unixai_ask` | |

## Örnek istem

> UnixAI'deki kritik sunucuların P1 bulgularını al, her biri için MorpheusAI'de düzeltme playbook'u oluştur,
> uyum skoru 85'in altında olanları bana göster, diğerlerini check modunda çalıştır ve sonuçlarını özetle.

## Güvenlik

- Gerçek uygulama (`mode=run`) yalnızca MorpheusAI arayüzünde bir yönetici **onay** verdikten ve (varsayılan) başarılı bir
  **check** çalıştırmasından sonra mümkündür; MCP/API token onay veremez (`REMEDIATION_ALLOW_API_APPROVE=false`).
- Kesinti riskli task'lar `unixai_allow_disruptive` koşuluyla yazılır; yalnızca onaylı gerçek çalıştırmada açıkça izin verilirse çalışır.
- Token'lar arayüzde maskelenir, loglarda gizlenir.

# UnixAI OS ⇄ MorpheusAI — birbiriyle konuşan iki ajan (MCP)

İki ayrı uygulama, iki ayrı ajan. Her biri kendi kurumsal GPT gateway'iyle çalışır, **kendi araçlarını MCP sunucusu olarak barındırır**
(`/mcp`) ve **başka MCP sunucularına istemci olarak bağlanır**. Böylece birbirleriyle — ve başka alanlardaki ajanlarla — konuşurlar.

```
          başka alanlar (ekip ajanları, Claude Code/Desktop, portal)            başka MCP sunucuları
                       │ Bearer token                                                  ▲
                       ▼                                                               │
   ┌──────────── UnixAI OS ────────────┐      MCP (Streamable HTTP)      ┌──────────── MorpheusAI ────────────┐
   │ ajan: GPT + araçlar               │ ─── morpheusai__morpheus_* ───▶ │ /mcp  morpheus_create_remediation  │
   │ /mcp  unixai_get_server_findings  │                                 │       morpheus_launch_remediation  │
   │       unixai_run_diagnostic       │ ◀── unixai__unixai_* ────────── │ ajan: GPT + araçlar                │
   │       unixai_agent_ask  ◀─────────┼──── ajan ↔ ajan (agent_ask) ───▶│       morpheus_agent_ask            │
   └───────────────────────────────────┘                                 └────────────────────────────────────┘
          │ SSH (salt-okunur)                                                    │ AAP runner (check → onay → run)
          ▼                                                                      ▼
       RHEL sunucular                                                      RHEL sunucular
```

## Kurulum (her iki uygulamada da arayüzden: **Ajan & MCP**)

1. **UnixAI OS → Ajan & MCP → Token üret**: ad `morpheusai` → token'ı kopyalayın.
2. **MorpheusAI → Ajan & MCP → Bağlantı ekle**: ad `unixai`, adres `http://unixai.kurum.local:3000/mcp`, 1. adımdaki token → *Kaydet ve test et*.
3. **MorpheusAI → Ajan & MCP → Token üret**: ad `unixai` → token'ı kopyalayın.
4. **UnixAI OS → Ajan & MCP → Bağlantı ekle**: ad `morpheusai`, adres `http://morpheus.kurum.local:3000/mcp`, 3. adımdaki token.
5. **UnixAI Ajanı** ekranında konuşun: *"En kritik sunucunun P1 bulgusunu canlı tanıyla doğrula ve MorpheusAI ajanından düzeltme playbook'u iste"*.
   Cevabın altındaki **araç adımları** hangi araçların çağrıldığını ve hangi ajanla konuşulduğunu gösterir; iki tarafta da **Ajan konuşmaları** listesine düşer.

Başka bir ekibin ajanını bağlamak için aynı şekilde *Bağlantı ekle* (onların `/mcp` adresi + token'ı); onların sizi kullanması için
*Token üret* (gerekirse **salt-okunur**). Tarayıcı tabanlı istemciler için **İzinli alanlar** (Origin) listesine alan adını ekleyin.

## Barındırılan MCP sunucusu

| | UnixAI OS | MorpheusAI |
|---|---|---|
| Uç nokta | `POST /mcp` | `POST /mcp` |
| Taşıma | Streamable HTTP, JSON yanıt, durumsuz (2025-06-18 / 2025-03-26 / 2024-11-05) | aynı |
| Kimlik | `Authorization: Bearer <token>` — arayüzde üretilen (salt-okunur seçeneği) veya `.env UNIXAI_API_TOKEN` | `.env MORPHEUS_API_TOKEN` veya arayüz |
| Ajan aracı | `unixai_agent_ask` | `morpheus_agent_ask` |

Claude Code'a doğrudan HTTP ile:

```bash
claude mcp add --transport http unixai-os  http://unixai.kurum.local:3000/mcp   --header "Authorization: Bearer <token>"
claude mcp add --transport http morpheusai http://morpheus.kurum.local:3000/mcp --header "Authorization: Bearer <token>"
```

Yalnızca stdio destekleyen istemciler için aktarıcılar: `mcp/unixai_mcp.py` ve MorpheusAI'de `mcp/morpheus-mcp.js` (örnek: `claude-mcp.example.json`).

## Ajan

- **Araç çağırma modu** (Ajan & MCP → Ajan ayarları): *otomatik* önce function calling (`tools`) dener; gateway reddederse JSON araç protokolüne
  geçer ve bunu öğrenir. Gateway'iniz `tools` desteklemiyorsa *JSON protokolü* seçebilirsiniz.
- **Hop sınırı** (varsayılan 1): bir ajan diğerine `agent_ask` ile sorabilir; gelen istekte karşı ajana geri soru soramaz (yalnızca veri araçlarını
  kullanır) — sonsuz döngü önlenir.
- **Canlı tanı**: UnixAI ajanı sunucuda yalnızca katalogdaki **salt-okunur** komutları (LVM, servis logları, portlar, SELinux...) doğrulanmış
  parametrelerle çalıştırabilir; serbest komut çalıştıramaz.
- **Onay**: playbook'un gerçek uygulaması (`mode=run`) her zaman MorpheusAI arayüzünde insan onayı ve başarılı check gerektirir; ajanlar ve
  MCP token'ları onay veremez.

## Doğrulama

```bash
# UnixAI OS reposunda:
MORPHEUS_DIR=../MorpheusAI python3 scripts/agents_e2e.py
```

Sahte GPT ve sahte AAP ile iki gerçek uygulamayı ayağa kaldırır; UnixAI ajanının MCP üzerinden MorpheusAI ajanıyla konuştuğunu,
MorpheusAI ajanının UnixAI'nin veri aracını geri çağırıp playbook ürettiğini ve yalnızca check başlattığını doğrular.

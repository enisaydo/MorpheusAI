/* MorpheusAI - demo analiz motoru (AI bağlı değilken kullanılır) */
const SHORT_MODULES = [
  "apt", "yum", "dnf", "package", "service", "systemd", "copy", "template",
  "file", "lineinfile", "shell", "command", "user", "group", "git", "get_url",
  "unarchive", "debug", "set_fact", "include_tasks", "import_tasks", "uri", "stat",
];

const SEV_WEIGHT = { critical: 25, high: 12, medium: 6, low: 3, info: 1 };

function scored(findings, summaries, extra = {}) {
  findings.sort((a, b) => SEV_WEIGHT[b.severity] - SEV_WEIGHT[a.severity]);
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + SEV_WEIGHT[f.severity], 0));
  const status = score >= 85 ? "compliant" : score >= 60 ? "warning" : "non_compliant";
  return { score, status, summary: summaries[status], findings, engine: "demo-heuristic", ...extra };
}

/** AAP job template tanımı (lib/aap.js → content JSON) için kural kontrolleri */
function analyzeJobTemplateDef(def, enabled) {
  const findings = [];
  const on = (id) => !enabled || enabled.includes(id);
  const add = (id, severity, title, detail, fix) => on(id) && findings.push({ ruleId: id, severity, title, detail, line: null, fix });
  const prod = /prod/i.test(`${def.inventory} ${def.name} ${(def.labels || []).join(" ")}`);

  if (!/^.+\s\|\s.+$/.test(def.name || "")) add("JT-001", "high", "İsimlendirme standardı", `'${def.name}' adı "<Uygulama> | <Aksiyon>" formatında değil.`, "NGINX | Install & Configure");
  if (!def.description) add("JT-001", "medium", "Açıklama boş", "Job template açıklaması (description) doldurulmalı.", null);
  if (/(password|passwd|secret|token|api_key)\s*[:=]\s*["']?(?!\{\{|\$encrypted)[^\s"'{]/i.test(def.extra_vars || ""))
    add("JT-002", "critical", "extra_vars içinde secret", "extra_vars düz metin gizli bilgi içeriyor.", "Değeri bir AAP credential'ına veya Vault'a taşıyın.");
  if (prod && Number(def.verbosity) > 1) add("JT-003", "high", "Prod verbosity yüksek", `verbosity=${def.verbosity}; prod için en fazla 1 olmalı.`, "verbosity: 1");
  if (!Number(def.timeout)) add("JT-004", "medium", "Timeout tanımsız", "timeout 0 (sınırsız).", "timeout: 3600");
  if (!def.execution_environment) add("JT-005", "medium", "Execution environment seçilmemiş", "EE varsayılana bırakılmış.", null);
  if (prod && def.notifications && Array.isArray(def.notifications.error) && !def.notifications.error.length)
    add("JT-006", "high", "Hata bildirimi yok", "notification_templates_error tanımlı değil.", "Template → Notifications → Failure için bildirim ekleyin.");
  if (prod && (def.ask_on_launch?.ask_inventory_on_launch || def.ask_on_launch?.ask_credential_on_launch))
    add("JT-007", "medium", "Launch'ta envanter/credential soruluyor", "Prod template'inde envanter/credential launch sırasında değiştirilebilir.", null);
  if (prod && def.allow_simultaneous) add("JT-008", "medium", "Eşzamanlı çalıştırma açık", "allow_simultaneous=true.", "allow_simultaneous: false");
  if ((def.survey?.questions || []).some((q) => q.type === "password" && q.default))
    add("JT-009", "medium", "Survey parola varsayılanı", "password tipindeki bir survey sorusu varsayılan değer içeriyor.", null);
  if (!(def.labels || []).length) add("JT-010", "low", "Label yok", "Template'e sahip/uygulama label'ı eklenmemiş.", null);

  return scored(findings, {
    compliant: "Job template tanımı standartlara uygun.",
    warning: "Job template tanımında giderilmesi gereken standart ihlalleri var.",
    non_compliant: "Job template tanımı kurumsal standartlara uygun değil.",
  }, { missing: [] });
}

function analyzeTemplate(content, enabled) {
  if (/^\s*\{/.test(content)) {
    try {
      const def = JSON.parse(content);
      if (def.type === "aap_job_template") return analyzeJobTemplateDef(def, enabled);
    } catch {}
  }
  const lines = content.split(/\r?\n/);
  const findings = [];
  const on = (id) => !enabled || enabled.includes(id);
  const add = (id, severity, title, detail, line, fix) =>
    on(id) && findings.push({ ruleId: id, severity, title, detail, line, fix });

  const lineOf = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    return i === -1 ? null : i + 1;
  };

  if (!/^\s*-\s+name:/m.test(content))
    add("STD-001", "high", "Play adı tanımlı değil", "Her play açıklayıcı bir 'name' alanı içermeli.", 1,
      "- name: \"<Uygulama> | <Aksiyon>\"");

  if (!/^\s*-?\s*hosts:/m.test(content))
    add("STD-002", "critical", "'hosts' alanı eksik", "Play hedef host grubunu belirtmiyor.", 1, "hosts: \"{{ target_hosts }}\"");

  if (/^\s*-?\s*hosts:\s*all\s*$/m.test(content))
    add("STD-002", "high", "'hosts: all' kullanımı", "Tüm envantere çalışmak standartlara aykırı; değişkenle sınırlandırın.",
      lineOf(/hosts:\s*all/), "hosts: \"{{ target_hosts }}\"");

  // isimsiz task'lar
  let unnamed = 0, firstUnnamed = null;
  lines.forEach((l, i) => {
    const m = l.match(/^\s*-\s+([a-z_][\w.]*):/);
    if (m && !["name", "hosts", "block", "role", "include_role", "import_playbook"].includes(m[1])) {
      const prev = lines[i - 1] || "";
      if (!/name:/.test(prev)) { unnamed++; firstUnnamed = firstUnnamed || i + 1; }
    }
  });
  if (unnamed) add("STD-003", "medium", `${unnamed} task isimsiz`, "Tüm task'lar 'name' ile başlamalı.", firstUnnamed,
    "- name: \"Paket kurulumu\"\n  ansible.builtin.apt: ...");

  // FQCN
  const shortUsed = new Set();
  let fqcnLine = null;
  lines.forEach((l, i) => {
    const m = l.match(/^\s*-?\s*([a-z_]+):/);
    if (m && SHORT_MODULES.includes(m[1])) { shortUsed.add(m[1]); fqcnLine = fqcnLine || i + 1; }
  });
  if (shortUsed.size) add("STD-004", "medium", "FQCN kullanılmıyor",
    `Kısa modül adları: ${[...shortUsed].join(", ")}`, fqcnLine,
    [...shortUsed].slice(0, 3).map((m) => `ansible.builtin.${m}`).join("\n"));

  // hardcoded secret
  const secretRe = /^\s*[\w]*(password|passwd|secret|token|api_key)[\w]*:\s*["']?(?!\{\{)(?!!vault)[^\s"'{][^\n]*$/i;
  const secretLine = lineOf(secretRe);
  if (secretLine) add("STD-005", "critical", "Açık metin parola / secret",
    "Gizli bilgi template içinde düz metin olarak yer alıyor. Vault veya credential kullanılmalı.", secretLine,
    "db_password: \"{{ vault_db_password }}\"");

  if (!/become:/m.test(content))
    add("STD-006", "low", "'become' açıkça belirtilmemiş", "Yetki yükseltme davranışı explicit olmalı.", null, "become: true");

  if (!/tags:/m.test(content))
    add("STD-007", "low", "Tag kullanılmıyor", "Task'lar seçici çalıştırma için tag'lenmeli.", null, "tags: [install, config]");

  lines.forEach((l, i) => {
    if (/^\s*-?\s*(ansible\.builtin\.)?(shell|command):/.test(l)) {
      const block = lines.slice(i, i + 8).join("\n");
      if (!/changed_when|creates:|removes:/.test(block))
        add("STD-008", "medium", "shell/command idempotent değil",
          "shell/command kullanımı 'changed_when' veya 'creates' içermiyor.", i + 1, "changed_when: false");
    }
  });

  const ignoreLine = lineOf(/ignore_errors:\s*(true|yes)/i);
  if (ignoreLine) add("STD-009", "high", "ignore_errors: true", "Hatalar sessizce yutuluyor; failed_when / block-rescue kullanın.",
    ignoreLine, "block:\n  ...\nrescue:\n  ...");

  if (/notify:/m.test(content) && !/handlers:/m.test(content))
    add("STD-010", "high", "Handler tanımı eksik", "'notify' kullanılmış ama 'handlers' bölümü yok.", lineOf(/notify:/),
      "handlers:\n  - name: Restart service\n    ansible.builtin.service: ...");

  const latestLine = lineOf(/state:\s*latest/);
  if (latestLine) add("STD-011", "medium", "state: latest", "Sürüm sabitlenmeli, 'latest' öngörülemez değişikliklere yol açar.",
    latestLine, "state: present\nname: \"nginx={{ nginx_version }}\"");

  lines.forEach((l, i) => {
    if (/^\s*-?\s*(ansible\.builtin\.)?(copy|template|file):/.test(l)) {
      const block = lines.slice(i, i + 8).join("\n");
      if (!/mode:/.test(block))
        add("STD-012", "medium", "Dosya izinleri (mode) eksik", "copy/template/file task'ında 'mode' tanımlı değil.", i + 1, "mode: \"0644\"");
    }
  });

  if (!/^\s*#/.test(lines[0] || "") && !/^---/.test(lines[0] || ""))
    add("STD-013", "info", "Doküman başlığı yok", "Dosya başında '---' ve açıklama yorumu bulunmalı.", 1,
      "---\n# Amaç: ...\n# Sahip: ...");

  const weights = { critical: 25, high: 12, medium: 6, low: 3, info: 1 };
  const penalty = findings.reduce((s, f) => s + weights[f.severity], 0);
  const score = Math.max(0, 100 - penalty);

  const missing = [];
  if (!/handlers:/.test(content)) missing.push("handlers bölümü");
  if (!/tags:/.test(content)) missing.push("tags");
  if (!/vars(_files)?:/.test(content)) missing.push("vars / vars_files");
  if (!/pre_tasks:/.test(content)) missing.push("pre_tasks (ön kontroller)");
  if (!/assert:/.test(content)) missing.push("girdi doğrulama (assert)");
  if (!/rescue:/.test(content)) missing.push("hata yönetimi (block / rescue)");

  return {
    score,
    status: score >= 85 ? "compliant" : score >= 60 ? "warning" : "non_compliant",
    summary:
      score >= 85
        ? "Template standartlara büyük ölçüde uygun. Küçük iyileştirmeler önerildi."
        : score >= 60
        ? "Template çalışır durumda ancak birkaç standart ihlali giderilmeli."
        : "Template kurumsal standartlara uygun değil. Kritik bulgular giderilmeden prod'a alınmamalı.",
    findings: findings.sort((a, b) => weights[b.severity] - weights[a.severity]),
    missing,
    stats: { lines: lines.length, tasks: (content.match(/^\s*-\s+name:/gm) || []).length },
    engine: "demo-heuristic",
  };
}

function analyzeWorkflow(wf, enabled) {
  const findings = [];
  const on = (id) => !enabled || enabled.includes(id);
  const add = (id, severity, title, detail, nodeId, fix) =>
    on(id) && findings.push({ ruleId: id, severity, title, detail, nodeId, fix });

  const nodes = wf.nodes || [];
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const targets = new Set(nodes.flatMap((n) => [...(n.success || []), ...(n.failure || []), ...(n.always || [])]));
  const roots = nodes.filter((n) => !targets.has(n.id));

  if (!/^WF_(DEV|TEST|UAT|PROD)_[A-Z0-9]+_[A-Z0-9_]+$/.test(wf.name || ""))
    add("WF-001", "medium", "İsimlendirme standardı", `'${wf.name}' adı WF_<ENV>_<UYGULAMA>_<AKSİYON> formatına uymuyor.`,
      null, "WF_PROD_PAYMENT_DEPLOY");

  if (!roots.some((n) => n.type === "project_sync"))
    add("WF-002", "high", "Project sync ile başlamıyor", "Workflow ilk adımda SCM project sync yapmalı.", roots[0]?.id,
      "Başlangıca 'project_sync' düğümü ekleyin.");

  nodes.filter((n) => n.type === "job" && !(n.failure || []).length && !(n.always || []).length).forEach((n) =>
    add("WF-003", "high", "Failure yolu tanımsız", `'${n.name}' adımı başarısız olursa hiçbir aksiyon tetiklenmiyor.`, n.id,
      "Failure dalına rollback veya bildirim düğümü bağlayın."));

  if (/PROD/i.test(wf.name || "") && !nodes.some((n) => n.type === "approval"))
    add("WF-004", "critical", "Prod onay adımı yok", "Prod ortamına giden workflow'larda approval düğümü zorunludur.", null,
      "Deploy adımından önce 'approval' düğümü ekleyin.");

  if (!nodes.some((n) => n.type === "notification" || /notify|bildirim/i.test(n.name)) && !wf.notifications?.error?.length)
    add("WF-005", "medium", "Bildirim adımı yok", "Hata/başarı durumunda ekip bilgilendirilmiyor.", null,
      "Failure dalına Teams/Mail bildirim adımı ekleyin.");

  const missingRef = nodes.flatMap((n) => [...(n.success || []), ...(n.failure || []), ...(n.always || [])]).filter((id) => !byId[id]);
  if (missingRef.length)
    add("WF-006", "critical", "Kopuk bağlantı", `Var olmayan düğümlere referans: ${missingRef.join(", ")}`, null, "Bağlantıları düzeltin.");

  if (roots.length > 1)
    add("WF-007", "low", "Birden fazla başlangıç düğümü", `${roots.length} adet bağımsız başlangıç noktası var.`, roots[1].id,
      "Tek bir giriş noktası kullanın.");

  if (/PROD|DEPLOY/i.test(wf.name || "") && !nodes.some((n) => /rollback|geri/i.test(n.name)))
    add("WF-008", "high", "Rollback adımı yok", "Deploy workflow'unda geri alma senaryosu tanımlı değil.", null,
      "Deploy failure dalına rollback job template bağlayın.");

  const weights = { critical: 25, high: 12, medium: 6, low: 3, info: 1 };
  const score = Math.max(0, 100 - findings.reduce((s, f) => s + weights[f.severity], 0));
  return {
    score,
    status: score >= 85 ? "compliant" : score >= 60 ? "warning" : "non_compliant",
    summary:
      score >= 85
        ? "Workflow akışı standartlara uygun."
        : "Workflow akışında standartlara aykırı noktalar tespit edildi.",
    findings: findings.sort((a, b) => weights[b.severity] - weights[a.severity]),
    engine: "demo-heuristic",
  };
}

function chatReply(messages, context) {
  const last = (messages[messages.length - 1]?.content || "").toLowerCase();
  let body;
  if (context && context.findings) {
    const top = context.findings.slice(0, 4);
    body =
      `Son analizde **${context.findings.length} bulgu** var (skor: **${context.score}/100**). Öncelikli olanlar:\n\n` +
      top.map((f, i) => `${i + 1}. **${f.title}** _(${f.severity})_ — ${f.detail}`).join("\n") +
      (top[0]?.fix ? `\n\nÖrnek düzeltme:\n\n\`\`\`yaml\n${top[0].fix}\n\`\`\`` : "");
  } else if (/workflow|akış/.test(last)) {
    body =
      "Kurumsal workflow standardımıza göre her akışta şunlar bulunmalı:\n\n" +
      "- Başlangıçta **project sync**\n- Prod için **approval** düğümü\n- Her job için **failure** dalı\n" +
      "- **Rollback** ve **bildirim** adımları\n\nAnaliz için *Workflow Analizi* ekranından bir workflow seçebilirsiniz.";
  } else {
    body =
      "Ben **Morpheus**. Ansible template ve workflow'larınızı kurumsal standartlara göre denetlerim.\n\n" +
      "Bir template yapıştırıp `Analiz Et` diyebilir ya da şunu sorabilirsiniz:\n\n" +
      "- \"Bu template'te eksik ne var?\"\n- \"FQCN standardını açıkla\"\n- \"Prod workflow'u için onay adımı nasıl eklenir?\"";
  }
  return {
    reply: body + "\n\n> _Demo modu: Gerçek AI backend bağlandığında cevaplar modelden gelecektir._",
    engine: "demo",
  };
}

module.exports = { analyzeTemplate, analyzeWorkflow, chatReply };

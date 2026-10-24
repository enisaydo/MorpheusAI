/*
 * Bitbucket istemcisi — onaylanan playbook'u AAP projesinin bağlı olduğu repoya commit eder
 *
 *  .env:
 *    BITBUCKET_URL=https://bitbucket.kurum.local      Server / Data Center (veya https://api.bitbucket.org → Cloud)
 *    BITBUCKET_TOKEN=<HTTP access token>              veya BITBUCKET_USERNAME + BITBUCKET_PASSWORD (app password / API token)
 *    BITBUCKET_PROJECT=OPS                            Server: proje anahtarı   ·   Cloud: BITBUCKET_WORKSPACE
 *    BITBUCKET_REPO=ansible-ops                       repo slug
 *    BITBUCKET_BRANCH=main                            AAP projesinin SCM branch'i ile aynı olmalı
 *    BITBUCKET_PATH=playbooks/unixai                  playbook'ların yazılacağı klasör
 *    BITBUCKET_TLS_INSECURE=true                      kurum içi sertifika
 *    BITBUCKET_KIND=server|cloud                      boş = adresten otomatik
 *
 *  Server/DC: PUT /rest/api/1.0/projects/{p}/repos/{r}/browse/{yol} (multipart: content, message, branch, sourceCommitId)
 *  Cloud:     POST /2.0/repositories/{ws}/{r}/src                   (multipart: /{yol}, message, branch)
 */
const crypto = require("crypto");
const { request } = require("./http");
const { bool } = require("./env");

const env = (k, d = "") => process.env[k] ?? d;
const TLS_HINT = "Sertifika doğrulamasını kapatmak için .env'e BITBUCKET_TLS_INSECURE=true ekleyin.";

const kind = () => (env("BITBUCKET_KIND") || (/bitbucket\.org/i.test(env("BITBUCKET_URL")) ? "cloud" : "server")).toLowerCase();
const owner = () => (kind() === "cloud" ? env("BITBUCKET_WORKSPACE") || env("BITBUCKET_PROJECT") : env("BITBUCKET_PROJECT"));
const branch = () => env("BITBUCKET_BRANCH", "main");
const baseUrl = () => env("BITBUCKET_URL").replace(/\/+$/, "");

function isConfigured() {
  try { new URL(baseUrl()); } catch { return false; }
  return Boolean((env("BITBUCKET_TOKEN") || env("BITBUCKET_USERNAME")) && owner() && env("BITBUCKET_REPO"));
}

function authHeaders() {
  if (env("BITBUCKET_TOKEN")) return { authorization: `Bearer ${env("BITBUCKET_TOKEN")}` };
  return { authorization: "Basic " + Buffer.from(`${env("BITBUCKET_USERNAME")}:${env("BITBUCKET_PASSWORD")}`).toString("base64") };
}

const enc = (p) => p.split("/").map(encodeURIComponent).join("/");

/** Basit multipart/form-data gövdesi */
function multipart(fields) {
  const boundary = "----morpheus" + crypto.randomBytes(12).toString("hex");
  const body = Object.entries(fields).filter(([, v]) => v != null)
    .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k.replace(/"/g, "")}"\r\n\r\n${v}\r\n`).join("") + `--${boundary}--\r\n`;
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

async function call(method, url, { body, type, kindName }) {
  const res = await request("bitbucket", kindName, url, {
    method, headers: { accept: "application/json", ...authHeaders(), ...(type ? { "content-type": type } : {}), "x-atlassian-token": "no-check" },
    body, insecureTls: bool("BITBUCKET_TLS_INSECURE"), timeoutMs: Number(env("BITBUCKET_TIMEOUT_MS", "30000")), tlsHint: TLS_HINT,
  });
  return res;
}

const errText = (res) => {
  const j = res.json || {};
  return j.errors?.map((e) => e.message).join("; ") || j.error?.message || res.text.slice(0, 300);
};

function explain(res, what) {
  if (res.status === 401) return `Bitbucket kimlik doğrulaması başarısız (401): BITBUCKET_TOKEN veya kullanıcı/parola hatalı`;
  if (res.status === 403) return `Bitbucket yetkisi yok (403): token'ın ${owner()}/${env("BITBUCKET_REPO")} reposunda yazma (Repository write) yetkisi olmalı`;
  if (res.status === 404) return `Bitbucket'ta bulunamadı (404): ${what}. BITBUCKET_PROJECT/WORKSPACE, BITBUCKET_REPO ve BITBUCKET_BRANCH (${branch()}) doğru mu?`;
  return `Bitbucket isteği başarısız (HTTP ${res.status}): ${errText(res)}`;
}

/* ---------------- Server / Data Center ---------------- */
const srvRepo = () => `${baseUrl()}/rest/api/1.0/projects/${encodeURIComponent(owner())}/repos/${encodeURIComponent(env("BITBUCKET_REPO"))}`;

async function srvLastCommit(filePath) {
  const res = await call("GET", `${srvRepo()}/commits?path=${encodeURIComponent(filePath)}&until=${encodeURIComponent(`refs/heads/${branch()}`)}&limit=1`, { kindName: "file-last-commit" });
  if (res.status >= 400) return null;
  return res.json?.values?.[0]?.id || null;
}

async function srvCommit(filePath, content, message) {
  const url = `${srvRepo()}/browse/${enc(filePath)}`;
  const put = (sourceCommitId) => {
    const m = multipart({ branch: branch(), content, message, sourceCommitId });
    return call("PUT", url, { body: m.body, type: m.type, kindName: sourceCommitId ? "file-update" : "file-create" });
  };
  let res = await put();
  if (res.status === 409 || (res.status === 400 && /exist|sourceCommitId/i.test(res.text))) {
    // Dosya zaten var (ör. önceki deneme): son commit'in üzerine güncelle
    const last = await srvLastCommit(filePath);
    res = await put(last || undefined);
    if (res.status === 409 && /same|not changed|identical|değiş/i.test(res.text) && last) return { commit: last, unchanged: true };
  }
  if (res.status >= 400) throw new Error(explain(res, `${owner()}/${env("BITBUCKET_REPO")}@${branch()}`));
  return { commit: res.json?.id || null };
}

/* ---------------- Cloud ---------------- */
const cloudRepo = () => `${baseUrl().replace(/\/2\.0$/, "")}/2.0/repositories/${encodeURIComponent(owner())}/${encodeURIComponent(env("BITBUCKET_REPO"))}`;

async function cloudCommit(filePath, content, message) {
  const m = multipart({ [`/${filePath}`]: content, message, branch: branch(), author: env("BITBUCKET_AUTHOR") || undefined });
  const res = await call("POST", `${cloudRepo()}/src`, { body: m.body, type: m.type, kindName: "file-commit" });
  if (res.status >= 400) throw new Error(explain(res, `${owner()}/${env("BITBUCKET_REPO")}@${branch()}`));
  const loc = String(res.headers.location || "");
  return { commit: loc.split("/").pop() || null };
}

/* ---------------- Ortak ---------------- */
function webUrl(filePath) {
  if (kind() === "cloud") return `https://bitbucket.org/${owner()}/${env("BITBUCKET_REPO")}/src/${encodeURIComponent(branch())}/${enc(filePath)}`;
  return `${baseUrl()}/projects/${encodeURIComponent(owner())}/repos/${encodeURIComponent(env("BITBUCKET_REPO"))}/browse/${enc(filePath)}?at=${encodeURIComponent(`refs/heads/${branch()}`)}`;
}

/** Playbook yolu: BITBUCKET_PATH/<sunucu>/<kayıt>.yml */
function pathFor(server, id) {
  const dir = env("BITBUCKET_PATH", "playbooks/unixai").replace(/^\/+|\/+$/g, "");
  const srv = String(server || "sunucu").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80);
  return `${dir ? dir + "/" : ""}${srv}/${id}.yml`;
}

/**
 * Dosyayı commit eder.
 * @returns {Promise<{commit:string|null, path:string, branch:string, url:string, repo:string, unchanged?:boolean}>}
 */
async function commitFile(filePath, content, message) {
  if (!isConfigured()) throw new Error("Bitbucket yapılandırılmamış (.env: BITBUCKET_URL, BITBUCKET_TOKEN, BITBUCKET_PROJECT/WORKSPACE, BITBUCKET_REPO)");
  const r = kind() === "cloud" ? await cloudCommit(filePath, content, message) : await srvCommit(filePath, content, message);
  return { ...r, path: filePath, branch: branch(), url: webUrl(filePath), repo: `${owner()}/${env("BITBUCKET_REPO")}` };
}

/** Bağlantı testi: repo ve branch erişilebilir mi */
async function test() {
  if (!isConfigured()) throw new Error("Bitbucket yapılandırılmamış");
  const url = kind() === "cloud" ? `${cloudRepo()}/refs/branches/${encodeURIComponent(branch())}` : `${srvRepo()}/branches?filterText=${encodeURIComponent(branch())}&limit=25`;
  const res = await call("GET", url, { kindName: "test-branch" });
  if (res.status >= 400) throw new Error(explain(res, `${owner()}/${env("BITBUCKET_REPO")}`));
  if (kind() === "server" && !(res.json?.values || []).some((b) => b.displayId === branch()))
    throw new Error(`Branch bulunamadı: ${branch()} (${owner()}/${env("BITBUCKET_REPO")})`);
  return { ok: true, kind: kind(), repo: `${owner()}/${env("BITBUCKET_REPO")}`, branch: branch() };
}

function status() {
  let host = null;
  try { host = new URL(baseUrl()).host; } catch {}
  return { configured: isConfigured(), kind: kind(), host, repo: owner() && env("BITBUCKET_REPO") ? `${owner()}/${env("BITBUCKET_REPO")}` : null,
    branch: branch(), path: env("BITBUCKET_PATH", "playbooks/unixai") };
}

module.exports = { isConfigured, commitFile, pathFor, test, status, webUrl };

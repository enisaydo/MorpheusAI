/*
 * Sistem mesajı (role: "system") ayarları
 *  - Arayüzdeki Ayarlar ekranından düzenlenir, sunucuda data/prompts.json'a kaydedilir
 *    (tüm kullanıcılar aynı sistem mesajını kullanır)
 *  - Container'da data/ dizini /opt/morpheus-ai/data'ya bağlanır
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.MORPHEUS_DATA_DIR || path.join(__dirname, "..", "data");
const FILE = path.join(DATA_DIR, "prompts.json");

const DEFAULTS = {
  system:
    "Sen Morpheus'sun: kurumsal Ansible standartlarına göre Ansible Automation Platform (AAP) job template, " +
    "playbook ve workflow'larını denetleyen kıdemli bir otomasyon uzmanısın.\n" +
    "- Yalnızca verilen kurumsal kurallara göre değerlendir, uydurma kural ekleme.\n" +
    "- Her bulgu için kural ID'si, önem derecesi ve somut düzeltme önerisi ver.\n" +
    "- Cevaplarını Türkçe ve Markdown ile yaz; YAML örneklerini ```yaml bloğunda ver.",
  includeStandards: true,
};

let cache = null;

function get() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save({ system, includeStandards }) {
  if (typeof system !== "string" || !system.trim()) throw new Error("Sistem mesajı boş olamaz");
  if (system.length > 50000) throw new Error("Sistem mesajı çok uzun (en fazla 50.000 karakter)");
  const next = { system, includeStandards: includeStandards !== false, updatedAt: new Date().toISOString() };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  cache = { ...DEFAULTS, ...next };
  return cache;
}

module.exports = { get, save, DEFAULTS };

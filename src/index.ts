/**
 * Job-change detector
 * --------------------
 * 1. Pagina uma busca de pessoas na Unipile (só traz a URL do LinkedIn).
 * 2. Casa cada pessoa contra a base do Active (active_campaign_linkedin) pelo slug
 *    da URL. Quem NÃO está na base é ignorado (não gasta fetch de perfil).
 * 3. Pros que estão: 2ª request (retrieve profile) pra pegar a empresa atual.
 * 4. Compara com company_name salvo. Mudou -> webhook + update da linha + log.
 *
 * Roda como GitHub Action (cron). Limite do runner: 6h.
 */

import { createClient } from "@supabase/supabase-js";

// ---------- Config (secrets/env do GitHub Action) ----------
const UNIPILE_DSN = reqEnv("UNIPILE_DSN"); // ex: api27.unipile.com:15712
const UNIPILE_API_KEY = reqEnv("UNIPILE_API_KEY");
const UNIPILE_ACCOUNT_ID = reqEnv("UNIPILE_ACCOUNT_ID");

// Corpo exato da busca (cole o JSON que já funciona). Ex (classic):
//   {"api":"classic","category":"people","keywords":"teste"}
// Sales Navigator: {"api":"sales_navigator","category":"people", ...seus filtros}
const SEARCH_BODY = JSON.parse(
  process.env.SEARCH_BODY ??
    '{"api":"classic","category":"people","keywords":"teste"}'
);

const PAGE_LIMIT = Number(process.env.PAGE_LIMIT ?? "10");
const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS ?? "3000");
const MAX_PAGES = Number(process.env.MAX_PAGES ?? "200");

// Recuperação de perfil é o recurso caro (limite ~150/dia em SN). Pace + teto.
const PROFILE_DELAY_MS = Number(process.env.PROFILE_DELAY_MS ?? "4000");
const MAX_PROFILE_FETCHES = Number(process.env.MAX_PROFILE_FETCHES ?? "120");

const SUPABASE_URL = reqEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = reqEnv("SUPABASE_SERVICE_ROLE_KEY");
const CONTACTS_TABLE = process.env.CONTACTS_TABLE ?? "active_campaign_linkedin";
const CHANGES_TABLE = process.env.CHANGES_TABLE ?? "linkedin_job_changes";

const WEBHOOK_URL =
  process.env.WEBHOOK_URL ?? "https://webhook.slcomm.xyz/webhook/mudanca-de-empresa";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";

// Modo teste: faz leitura (busca/match/perfil) mas NÃO escreve no banco nem dispara webhook.
const DRY_RUN = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

// ---------- Tipos ----------
type SearchPerson = {
  linkedin_url: string;
  slug: string; // identificador público extraído da URL (/in/<slug>)
  provider_id: string | null;
  full_name: string | null;
};

type Contact = {
  id: number;
  contact_id: number;
  linkedin_url: string | null;
  company_name: string | null;
  uuid_linkedin: string | null;
  slug: string;
};

type ChangeEvent = {
  contact_id: number;
  linkedin_url: string | null;
  full_name: string | null;
  company: string; // empresa atual (vinda do fetch da Unipile)
  detected_at: string;
};

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ===================================================================
// 1) Busca paginada (só URLs)
// ===================================================================
async function fetchAllPeople(): Promise<SearchPerson[]> {
  const people: SearchPerson[] = [];
  let cursor: string | null = null;
  let page = 0;

  do {
    page++;
    const url = new URL(`https://${UNIPILE_DSN}/api/v1/linkedin/search`);
    url.searchParams.set("account_id", UNIPILE_ACCOUNT_ID);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    if (cursor) url.searchParams.set("cursor", cursor);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "X-API-KEY": UNIPILE_API_KEY,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(SEARCH_BODY),
    });
    if (!res.ok) throw new Error(`Unipile search ${res.status} (pág ${page}): ${await res.text()}`);

    const data: any = await res.json();
    const items: any[] = data.items ?? data.results ?? [];
    for (const item of items) {
      const linkedin_url =
        item.public_profile_url ?? item.profile_url ?? item.public_url ?? item.url ?? null;
      const slug = slugFromUrl(linkedin_url) ?? slugFromUrl(item.public_identifier);
      if (!slug) continue; // sem slug não dá pra casar
      people.push({
        linkedin_url: linkedin_url ?? `https://www.linkedin.com/in/${slug}`,
        slug,
        provider_id: item.id ?? item.provider_id ?? item.member_urn ?? null,
        full_name: item.name ?? item.full_name ?? null,
      });
    }

    cursor = data.cursor ?? null; // null = fim (padrão Unipile)
    console.log(`Busca pág ${page}: ${items.length} itens | cursor=${cursor ? "..." : "null"}`);
    if (cursor && page < MAX_PAGES) await sleep(PAGE_DELAY_MS);
  } while (cursor && page < MAX_PAGES);

  console.log(`Busca total: ${people.length} pessoas com slug.`);
  return people;
}

// ===================================================================
// 2) Carrega o Active e indexa por slug (match por "contains" via slug)
// ===================================================================
async function loadContactsBySlug(): Promise<Map<string, Contact>> {
  const map = new Map<string, Contact>();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(CONTACTS_TABLE)
      .select("id, contact_id, linkedin_url, company_name, uuid_linkedin")
      .not("linkedin_url", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Supabase select contatos: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      const slug = slugFromUrl(row.linkedin_url);
      if (slug) map.set(slug, { ...(row as any), slug });
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Active carregado: ${map.size} contatos com URL.`);
  return map;
}

// ===================================================================
// 3) Retrieve profile (2ª request) -> empresa atual
// ===================================================================
async function fetchCurrentCompany(slug: string): Promise<string | null> {
  const url = new URL(`https://${UNIPILE_DSN}/api/v1/users/${encodeURIComponent(slug)}`);
  url.searchParams.set("account_id", UNIPILE_ACCOUNT_ID);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "X-API-KEY": UNIPILE_API_KEY, accept: "application/json" },
  });
  if (!res.ok) {
    console.warn(`Perfil ${slug}: ${res.status} — pulando. ${await res.text()}`);
    return null;
  }
  return extractCurrentCompany(await res.json());
}

// AJUSTE conforme o payload real do retrieve profile da Unipile.
function extractCurrentCompany(profile: any): string | null {
  const exp: any[] =
    profile.work_experience ?? profile.experience ?? profile.positions ?? [];
  const current =
    exp.find((e) => e?.current === true || e?.is_current === true || e?.end == null) ??
    exp[0] ??
    null;

  const company =
    current?.company ??
    current?.company_name ??
    profile.current_company?.name ??
    profile.company ??
    null;

  return company ? String(company).trim() : null;
}

// ===================================================================
// Orquestração
// ===================================================================
async function run() {
  const people = await fetchAllPeople();
  if (people.length === 0) return console.log("Busca vazia. Encerrando.");

  const contacts = await loadContactsBySlug();

  // Mantém só quem está no Active, deduplicando por slug.
  const matched = new Map<string, SearchPerson>();
  for (const p of people) if (contacts.has(p.slug)) matched.set(p.slug, p);
  console.log(`Match no Active: ${matched.size}.`);
  if (matched.size === 0) return;

  const changes: ChangeEvent[] = [];
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let fetches = 0;

  for (const [slug, person] of matched) {
    if (fetches >= MAX_PROFILE_FETCHES) {
      console.warn(`Teto de ${MAX_PROFILE_FETCHES} perfis/dia atingido. Resto fica pra amanhã.`);
      break;
    }
    fetches++;
    const newCompany = await fetchCurrentCompany(slug);
    await sleep(PROFILE_DELAY_MS);
    if (!newCompany) continue;

    const contact = contacts.get(slug)!;
    const oldCompany = (contact.company_name ?? "").trim();

    const changed = oldCompany && !sameCompany(oldCompany, newCompany);

    // Atualiza a linha do Active (enriquece sempre; sinaliza empresa nova).
    const patch: Record<string, any> = {
      company_name: newCompany,
      last_update_date: today,
      updated_at: now,
    };
    if (!contact.uuid_linkedin && person.provider_id) patch.uuid_linkedin = person.provider_id;

    if (DRY_RUN) {
      console.log(
        `[dry-run] update contato ${contact.contact_id}: "${oldCompany || "(vazio)"}" -> "${newCompany}"${changed ? "  *** MUDOU ***" : ""}`
      );
    } else {
      const { error: upErr } = await supabase
        .from(CONTACTS_TABLE)
        .update(patch)
        .eq("contact_id", contact.contact_id);
      if (upErr) console.error(`Update contato ${contact.contact_id}: ${upErr.message}`);
    }

    if (changed) {
      changes.push({
        contact_id: contact.contact_id,
        linkedin_url: person.linkedin_url,
        full_name: person.full_name,
        company: newCompany,
        detected_at: now,
      });
    }
  }

  console.log(`Mudanças de empresa: ${changes.length} (perfis consultados: ${fetches}).`);

  if (changes.length > 0) {
    if (DRY_RUN) {
      console.log(`[dry-run] gravaria ${changes.length} em ${CHANGES_TABLE} e dispararia ${changes.length} webhook(s):`);
      for (const c of changes) console.log(`  -> ${c.full_name} (${c.contact_id}): ${c.company}`);
    } else {
      // Registra na linkedin_job_changes (apenas a empresa atual)
      const { error: logErr } = await supabase.from(CHANGES_TABLE).insert(
        changes.map((c) => ({
          contact_id: c.contact_id,
          linkedin_url: c.linkedin_url,
          full_name: c.full_name,
          company: c.company,
          detected_at: c.detected_at,
        }))
      );
      if (logErr) console.error(`Insert ${CHANGES_TABLE}: ${logErr.message}`);

      // Webhook: uma chamada por mudança
      for (const c of changes) await sendWebhook(c);
    }
  }
}

async function sendWebhook(change: ChangeEvent) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(WEBHOOK_SECRET ? { "x-webhook-secret": WEBHOOK_SECRET } : {}),
    },
    body: JSON.stringify(change),
  });
  if (!res.ok) {
    console.error(`Webhook ${res.status} (contato ${change.contact_id}): ${await res.text()}`);
    return;
  }
  console.log(`Webhook ok: contato ${change.contact_id} -> ${change.company}`);
}

// ---------- helpers ----------
function slugFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  // já é um slug puro?
  if (!value.includes("/") && !value.includes(".")) return value.toLowerCase().trim();
  const m = value.match(/\/in\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]).toLowerCase().trim();
  // fallback: último segmento da URL
  const clean = value.split("?")[0].replace(/\/+$/, "");
  const last = clean.split("/").pop();
  return last ? last.toLowerCase().trim() : null;
}

function sameCompany(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return norm(a) === norm(b);
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Env obrigatória ausente: ${name}`);
  return v;
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

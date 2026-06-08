/**
 * Job-change detector
 * --------------------
 * Active: usado SÓ pra resolver o contact_id (match pela URL). Nada mais vem dele.
 * linkedin_job_changes: 1 linha por contato com a empresa atual do LinkedIn (a baseline).
 *
 * Por contato que casa:
 *   - busca a empresa atual no LinkedIn (retrieve profile);
 *   - se o contato NÃO está na linkedin_job_changes -> INSERE (seed), sem webhook;
 *   - se JÁ está e a empresa difere -> ATUALIZA a linha + dispara webhook.
 *
 * Primeira rodada insere todo mundo (baseline). Da segunda em diante, detecta mudanças.
 */

import { createClient } from "@supabase/supabase-js";

// ---------- Config ----------
const UNIPILE_DSN = reqEnv("UNIPILE_DSN");
const UNIPILE_API_KEY = reqEnv("UNIPILE_API_KEY");
const UNIPILE_ACCOUNT_ID = reqEnv("UNIPILE_ACCOUNT_ID");

const SEARCH_BODY = JSON.parse(
  process.env.SEARCH_BODY ??
    '{"api":"classic","category":"people","keywords":"teste"}'
);

const PAGE_LIMIT = Number(process.env.PAGE_LIMIT ?? "10");
const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS ?? "3000");
const MAX_PAGES = Number(process.env.MAX_PAGES ?? "200");

const PROFILE_DELAY_MS = Number(process.env.PROFILE_DELAY_MS ?? "4000");
const MAX_PROFILE_FETCHES = Number(process.env.MAX_PROFILE_FETCHES ?? "120");

const SUPABASE_URL = reqEnv("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = reqEnv("SUPABASE_SERVICE_ROLE_KEY");
const ACTIVE_TABLE = process.env.CONTACTS_TABLE ?? "active_campaign_linkedin";
const STATE_TABLE = process.env.CHANGES_TABLE ?? "linkedin_job_changes";

const WEBHOOK_URL =
  process.env.WEBHOOK_URL ?? "https://webhook.slcomm.xyz/webhook/mudanca-de-empresa";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";

// Teste: lê tudo mas NÃO escreve no banco nem dispara webhook.
const DRY_RUN = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

// ---------- Tipos ----------
type SearchPerson = {
  slug: string;
  linkedin_url: string;
  full_name: string | null;
};

type StateRow = {
  contact_id: number;
  linkedin_url: string | null;
  full_name: string | null;
  company: string;
  updated_at: string;
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
      if (!slug) continue;
      people.push({
        slug,
        linkedin_url: linkedin_url ?? `https://www.linkedin.com/in/${slug}`,
        full_name: item.name ?? item.full_name ?? null,
      });
    }

    cursor = data.cursor ?? null;
    console.log(`Busca pág ${page}: ${items.length} itens | cursor=${cursor ? "..." : "null"}`);
    if (cursor && page < MAX_PAGES) await sleep(PAGE_DELAY_MS);
  } while (cursor && page < MAX_PAGES);

  console.log(`Busca total: ${people.length} pessoas com slug.`);
  return people;
}

// ===================================================================
// 2) Do Active, SÓ o contact_id (mapeado por slug da URL)
// ===================================================================
async function loadContactIdBySlug(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(ACTIVE_TABLE)
      .select("contact_id, linkedin_url")
      .not("linkedin_url", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Supabase select Active: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      const slug = slugFromUrl(row.linkedin_url);
      if (slug && row.contact_id != null) map.set(slug, row.contact_id);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Active carregado: ${map.size} contatos com URL.`);
  return map;
}

// ===================================================================
// 3) Snapshot atual (empresa salva por contato) da linkedin_job_changes
// ===================================================================
async function loadSnapshot(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(STATE_TABLE)
      .select("contact_id, company")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Supabase select ${STATE_TABLE}: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data) {
      if (row.contact_id != null && row.company) map.set(row.contact_id, row.company);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  console.log(`Snapshot carregado: ${map.size} contatos já com empresa salva.`);
  return map;
}

// ===================================================================
// 4) Retrieve profile -> empresa atual
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

  const contactIdBySlug = await loadContactIdBySlug();
  const snapshot = await loadSnapshot();

  // Só quem está no Active, dedup por slug.
  const matched = new Map<string, SearchPerson>();
  for (const p of people) if (contactIdBySlug.has(p.slug)) matched.set(p.slug, p);

  // Prioriza quem ainda não tem baseline (pra semear primeiro dentro do teto de perfis/dia).
  const list = [...matched.values()].sort((a, b) => {
    const aSeeded = snapshot.has(contactIdBySlug.get(a.slug)!) ? 1 : 0;
    const bSeeded = snapshot.has(contactIdBySlug.get(b.slug)!) ? 1 : 0;
    return aSeeded - bSeeded;
  });
  console.log(`Match no Active: ${list.length}.`);
  if (list.length === 0) return;

  const now = new Date().toISOString();
  const toUpsert: StateRow[] = []; // seeds + mudanças
  const changes: StateRow[] = []; // só mudanças -> webhook
  let fetches = 0;
  let seeds = 0;

  for (const person of list) {
    if (fetches >= MAX_PROFILE_FETCHES) {
      console.warn(`Teto de ${MAX_PROFILE_FETCHES} perfis atingido. Resto fica pra próxima rodada.`);
      break;
    }
    fetches++;
    const contactId = contactIdBySlug.get(person.slug)!;
    const stored = snapshot.get(contactId); // undefined = ainda não semeado
    const newCompany = await fetchCurrentCompany(person.slug);
    await sleep(PROFILE_DELAY_MS);

    console.log(
      `[match] ${person.slug} (contato ${contactId}): banco="${stored ?? "(novo)"}" unipile="${newCompany ?? "(null)"}"`
    );
    if (!newCompany) continue;

    const row: StateRow = {
      contact_id: contactId,
      linkedin_url: person.linkedin_url,
      full_name: person.full_name,
      company: newCompany,
      updated_at: now,
    };

    if (stored === undefined) {
      // Baseline: insere, sem webhook.
      toUpsert.push(row);
      seeds++;
    } else if (!sameCompany(stored, newCompany)) {
      // Mudou: atualiza + webhook.
      toUpsert.push(row);
      changes.push(row);
    }
    // mesma empresa -> nada
  }

  console.log(`Novos (seed): ${seeds} | Mudanças: ${changes.length} | perfis consultados: ${fetches}.`);

  if (DRY_RUN) {
    console.log("[dry-run] não escreve no banco nem dispara webhook.");
    for (const c of changes) console.log(`[dry-run] mudança contato ${c.contact_id} -> ${c.company}`);
    return;
  }

  if (toUpsert.length > 0) {
    const { error } = await supabase
      .from(STATE_TABLE)
      .upsert(toUpsert, { onConflict: "contact_id" });
    if (error) console.error(`Upsert ${STATE_TABLE}: ${error.message}`);
    else console.log(`Gravados na ${STATE_TABLE}: ${toUpsert.length} (sendo ${seeds} novos).`);
  }

  for (const c of changes) await sendWebhook(c);
}

async function sendWebhook(c: StateRow) {
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(WEBHOOK_SECRET ? { "x-webhook-secret": WEBHOOK_SECRET } : {}),
    },
    body: JSON.stringify({
      contact_id: c.contact_id,
      linkedin_url: c.linkedin_url,
      full_name: c.full_name,
      company: c.company,
      detected_at: c.updated_at,
    }),
  });
  if (!res.ok) {
    console.error(`Webhook ${res.status} (contato ${c.contact_id}): ${await res.text()}`);
    return;
  }
  console.log(`Webhook ok: contato ${c.contact_id} -> ${c.company}`);
}

// ---------- helpers ----------
function slugFromUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.includes("/") && !value.includes(".")) return value.toLowerCase().trim();
  const m = value.match(/\/in\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]).toLowerCase().trim();
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

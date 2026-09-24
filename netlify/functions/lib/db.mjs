import { createClient } from "@libsql/client";
import leadsSeed from "./data/leads_seed.json" with { type: "json" };
import planilhaContatos from "./data/planilha_contatos.json" with { type: "json" };
import { hashPassword } from "./auth.mjs";

// Funil de vendas, na ordem real usada pela equipe (planilha "Acompanhamento comercial"):
// cadastro inicial -> primeiro contato agendado -> aguardando resposta -> follow-up de
// nutrição -> orçamento ativo -> negociação -> desfecho (Perdido) / Arquivado.
export const STATUS_OPTIONS = [
  "Prospect",
  "Fazer contato futuro",
  "Aguardando resposta",
  "Follow-up",
  "Em orçamento",
  "Negociação",
  "Perdido",
  "Arquivado",
];
export const VENDEDOR_OPTIONS = ["Augusto", "Luciano", "Jair", "Flávio", "Jorge", "Renan"];
export const CANAL_OPTIONS = [
  "Ligação", "Whatsapp", "E-mail", "Visita", "Reunião online",
  "Follow-up", "Orçamento enviado", "LinkedIn", "Instagram",
];

export const LEAD_FIELDS = [
  "cliente_empresa", "contato", "cargo", "telefone1", "telefone2", "email",
  "segmento", "cidade", "vendedor", "status", "tipo_obra", "num_orcamentos",
  "primeiro_orcamento", "ultimo_orcamento", "primeiro_contato", "proximo_contato",
  "notas", "origem",
];

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_empresa TEXT NOT NULL,
    contato TEXT DEFAULT '',
    cargo TEXT DEFAULT '',
    telefone1 TEXT DEFAULT '',
    telefone2 TEXT DEFAULT '',
    email TEXT DEFAULT '',
    segmento TEXT DEFAULT '',
    cidade TEXT DEFAULT '',
    vendedor TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'Prospect',
    tipo_obra TEXT DEFAULT '',
    num_orcamentos INTEGER DEFAULT 0,
    primeiro_orcamento TEXT DEFAULT '',
    ultimo_orcamento TEXT DEFAULT '',
    primeiro_contato TEXT DEFAULT '',
    proximo_contato TEXT DEFAULT '',
    notas TEXT DEFAULT '',
    origem TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS orcamento_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    url TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    data TEXT NOT NULL,
    canal TEXT DEFAULT '',
    assunto TEXT DEFAULT '',
    resultado TEXT DEFAULT '',
    proxima_acao TEXT DEFAULT '',
    data_followup TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_vendedor ON leads(vendedor)`,
  `CREATE INDEX IF NOT EXISTS idx_orcamento_links_lead ON orcamento_links(lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id)`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'vendedor',
    vendedor TEXT DEFAULT '',
    nome TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS map_regions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS map_assignments (
    municipio_codigo TEXT PRIMARY KEY,
    region_id TEXT NOT NULL
  )`,
];

// Papel + vendedor de cada login inicial. As senhas abaixo são só o ponto de
// partida (geradas uma vez para o primeiro deploy) — cada pessoa deve trocar
// a própria senha assim que entrar pela primeira vez (tela "Minha conta").
const DEFAULT_USERS = [
  { username: "sil", password: "ZeC2nagK3j", role: "admin", vendedor: "", nome: "Sil" },
  { username: "luciano", password: "HdRPCUPcUn", role: "vendedor", vendedor: "Luciano", nome: "Luciano" },
  { username: "renan", password: "ysf9EkarWy", role: "vendedor", vendedor: "Renan", nome: "Renan" },
  { username: "jair", password: "PZssPhS5CJ", role: "vendedor", vendedor: "Jair", nome: "Jair" },
];

// Regiões/vendedores padrão do Mapa Comercial (mesmas do arquivo original
// enviado por e-mail/desktop) — só usadas para popular a tabela na primeira
// vez; depois disso o mapa é todo editável pela aba Administração/Mapa.
const DEFAULT_MAP_REGIONS = [
  { id: "r1", name: "Luciano", color: "#c5e1a5" },
  { id: "r2", name: "Renan", color: "#d1c4e9" },
  { id: "r3", name: "Jair", color: "#ffcc80" },
];

async function ensureUsersSeeded(db) {
  const countRes = await db.execute("SELECT COUNT(*) as n FROM users");
  if (Number(countRes.rows[0].n) > 0) return;
  const statements = DEFAULT_USERS.map((u) => ({
    sql: `INSERT INTO users (username, password_hash, role, vendedor, nome) VALUES (?, ?, ?, ?, ?)`,
    args: [u.username, hashPassword(u.password), u.role, u.vendedor, u.nome],
  }));
  await db.batch(statements, "write");
}

async function ensureMapSeeded(db) {
  const countRes = await db.execute("SELECT COUNT(*) as n FROM map_regions");
  if (Number(countRes.rows[0].n) > 0) return;
  const statements = DEFAULT_MAP_REGIONS.map((r, i) => ({
    sql: `INSERT INTO map_regions (id, name, color, sort_order) VALUES (?, ?, ?, ?)`,
    args: [r.id, r.name, r.color, i],
  }));
  await db.batch(statements, "write");
}

// Nota: como o cliente Turso/libSQL roda sobre HTTP (sem conexão persistente
// com estado garantido entre chamadas), não confiamos em "ON DELETE CASCADE" /
// PRAGMA foreign_keys — o cascade de exclusão é feito manualmente no código
// (veja lead-detail.mjs), o que é mais robusto nesse contexto serverless.

let client = null;
export function getClient() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) {
      throw new Error(
        "TURSO_DATABASE_URL não configurada. Defina as variáveis de ambiente TURSO_DATABASE_URL e TURSO_AUTH_TOKEN no painel do Netlify (Site settings > Environment variables)."
      );
    }
    client = createClient({ url, authToken });
  }
  return client;
}

let seededPromise = null;
export async function ensureSeeded() {
  if (!seededPromise) {
    seededPromise = doEnsureSeeded();
  }
  return seededPromise;
}

// Tamanho de cada lote enviado ao Turso via `batch()` (uma única chamada HTTP
// por lote, em vez de uma chamada por linha) — é o que permite importar os
// ~1880 leads dentro do tempo limite de uma execução de function.
const SEED_CHUNK = 300;

// Orçamento de tempo (ms) que uma única execução gasta semeando antes de
// desistir e salvar o progresso — deixa folga pro resto do tempo limite da
// function na Netlify. Uma próxima requisição continua de onde parou.
const TIME_BUDGET_MS = Number(process.env.SEED_TIME_BUDGET_MS) || 8000;

// Depois de reivindicado, por quanto tempo nenhuma outra execução concorrente
// tenta assumir a semeadura — curto o bastante pra um usuário atualizando a
// página algumas vezes conseguir terminar a importação sozinho.
const CLAIM_LOCK_SECONDS = 30;

async function doEnsureSeeded() {
  const db = getClient();
  await db.batch(SCHEMA_STATEMENTS, "write");
  await ensureUsersSeeded(db);
  await ensureMapSeeded(db);
  await db.execute(`CREATE TABLE IF NOT EXISTS seed_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'pending',
    leads_offset INTEGER NOT NULL DEFAULT 0,
    claimed_at TEXT
  )`);
  // Migração: uma versão anterior deste arquivo criou a tabela seed_state sem
  // a coluna leads_offset — em produção ela pode já existir sem essa coluna,
  // e "CREATE TABLE IF NOT EXISTS" não altera uma tabela já existente.
  try {
    await db.execute("ALTER TABLE seed_state ADD COLUMN leads_offset INTEGER NOT NULL DEFAULT 0");
  } catch (err) {
    if (!/duplicate column/i.test(String(err?.message || err))) throw err;
  }
  await db.execute(
    "INSERT OR IGNORE INTO seed_state (id, status, leads_offset) VALUES (1, 'pending', 0)"
  );

  const stateRes = await db.execute("SELECT status, leads_offset FROM seed_state WHERE id = 1");
  let state = stateRes.rows[0];
  if (state.status === "done") return;

  // Evita corrida entre execuções concorrentes (cold starts simultâneos): só
  // segue quem conseguir "reivindicar" a semeadura agora — outra execução que
  // reivindicou há pouco tempo continua com prioridade.
  const claim = await db.execute(
    `UPDATE seed_state SET claimed_at = datetime('now')
     WHERE id = 1 AND status != 'done'
       AND (claimed_at IS NULL OR claimed_at < datetime('now', '-${CLAIM_LOCK_SECONDS} seconds'))`
  );
  if (Number(claim.rowsAffected) === 0) {
    // Outra execução está (ou acabou de ficar) responsável por semear agora —
    // não faz nada; uma próxima requisição confere de novo.
    return;
  }

  if (state.status !== "leads" && state.status !== "planilha") {
    // Cobre 'pending' e também qualquer valor de status deixado por uma
    // versão anterior deste arquivo (ex.: 'running') — nesses casos garante
    // estado limpo antes de começar a importar do zero.
    await db.batch(
      ["DELETE FROM orcamento_links", "DELETE FROM activities", "DELETE FROM leads"],
      "write"
    );
    await db.execute("UPDATE seed_state SET status = 'leads', leads_offset = 0 WHERE id = 1");
    state = { status: "leads", leads_offset: 0 };
  }

  const deadline = Date.now() + TIME_BUDGET_MS;

  if (state.status === "leads") {
    const offsetReached = await seedLeadsInBatches(db, Number(state.leads_offset), deadline);
    if (offsetReached < leadsSeed.length) {
      // Orçamento de tempo estourou no meio da importação dos leads — salva
      // o progresso; uma próxima requisição continua a partir daqui.
      await db.execute({
        sql: "UPDATE seed_state SET leads_offset = ? WHERE id = 1",
        args: [offsetReached],
      });
      return;
    }
    await db.execute({
      sql: "UPDATE seed_state SET status = 'planilha', leads_offset = ? WHERE id = 1",
      args: [offsetReached],
    });
  }

  await seedPlanilhaInBatches(db);
  await db.execute("UPDATE seed_state SET status = 'done' WHERE id = 1");
}

const LEAD_INSERT_SQL = `INSERT INTO leads
  (cliente_empresa, cidade, vendedor, status, tipo_obra, num_orcamentos,
   primeiro_orcamento, ultimo_orcamento, notas, origem)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Importa leadsSeed[startOffset..] em lotes via db.batch() (uma chamada HTTP
// por lote), parando assim que o orçamento de tempo (deadline) é atingido.
// Retorna o índice até onde conseguiu chegar — igual a leadsSeed.length
// quando termina tudo, ou um valor menor se precisou parar no meio.
async function seedLeadsInBatches(db, startOffset, deadline) {
  let offset = startOffset;
  while (offset < leadsSeed.length) {
    if (Date.now() > deadline) break;
    const chunk = leadsSeed.slice(offset, offset + SEED_CHUNK);
    const statements = chunk.map((rec) => ({
      sql: LEAD_INSERT_SQL,
      args: [
        (rec["Cliente/Empresa"] || "").trim() || "(sem nome)",
        rec["Cidade"] || "",
        rec["Vendedor"] || "",
        rec["Status do Lead"] || "Em orçamento",
        rec["Tipo de Obra"] || "",
        rec["Nº de Orçamentos"] || 0,
        rec["Primeiro Orçamento"] || "",
        rec["Último Orçamento"] || "",
        "",
        "",
      ],
    }));
    const results = await db.batch(statements, "write");

    const linkStatements = [];
    results.forEach((res, idx) => {
      const leadId = Number(res.lastInsertRowid);
      const urls = chunk[idx]["Orçamentos"] || [];
      for (const url of urls) {
        linkStatements.push({
          sql: "INSERT INTO orcamento_links (lead_id, url) VALUES (?, ?)",
          args: [leadId, url],
        });
      }
    });
    for (let j = 0; j < linkStatements.length; j += SEED_CHUNK) {
      await db.batch(linkStatements.slice(j, j + SEED_CHUNK), "write");
    }
    offset += chunk.length;
  }
  return offset;
}

async function seedPlanilhaInBatches(db) {
  if (!planilhaContatos.length) return;
  const existingPairsRes = await db.execute("SELECT cliente_empresa, contato FROM leads");
  const existingPairs = new Set(
    existingPairsRes.rows.map((r) => `${r.cliente_empresa} ${r.contato}`)
  );
  const toInsert = [];
  for (const rec of planilhaContatos) {
    const key = `${rec.cliente_empresa} ${rec.contato}`;
    if (existingPairs.has(key)) continue;
    existingPairs.add(key);
    toInsert.push(rec);
  }
  const sql = `INSERT INTO leads
    (cliente_empresa, contato, cargo, telefone1, telefone2, email,
     segmento, cidade, status, primeiro_contato, proximo_contato,
     notas, origem)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  for (let i = 0; i < toInsert.length; i += SEED_CHUNK) {
    const chunk = toInsert.slice(i, i + SEED_CHUNK);
    const statements = chunk.map((rec) => ({
      sql,
      args: [
        rec.cliente_empresa, rec.contato, rec.cargo,
        rec.telefone1, rec.telefone2, rec.email,
        rec.segmento, rec.cidade, rec.status,
        rec.primeiro_contato, rec.proximo_contato,
        rec.notas, rec.origem,
      ],
    }));
    await db.batch(statements, "write");
  }
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

export function errorJson(message, status = 400) {
  return json({ detail: message }, { status });
}

// sqlite/libSQL retorna BigInt para colunas INTEGER em alguns drivers — normaliza
// pra Number/valores simples antes de serializar como JSON.
export function rowToPlain(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "bigint" ? Number(v) : v;
  }
  return out;
}

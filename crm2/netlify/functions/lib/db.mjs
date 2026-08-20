import { createClient } from "@libsql/client";
import leadsSeed from "./data/leads_seed.json" with { type: "json" };
import planilhaContatos from "./data/planilha_contatos.json" with { type: "json" };

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
export const VENDEDOR_OPTIONS = ["Augusto", "Luciano", "Jair", "Flávio", "Jorge"];
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
];

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
const SEED_CHUNK = 250;

async function doEnsureSeeded() {
  const db = getClient();
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.execute(stmt);
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS seed_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    status TEXT NOT NULL DEFAULT 'pending',
    claimed_at TEXT
  )`);
  await db.execute("INSERT OR IGNORE INTO seed_state (id, status) VALUES (1, 'pending')");

  const stateRes = await db.execute("SELECT status FROM seed_state WHERE id = 1");
  if (stateRes.rows[0]?.status === "done") return;

  // Evita corrida entre execuções concorrentes (cold starts simultâneos): só
  // segue quem conseguir "reivindicar" o estado 'pending', ou uma reivindicação
  // antiga (mais de 2 minutos), sinal de que uma tentativa anterior travou/caiu
  // no meio (por exemplo, por timeout).
  const claim = await db.execute(
    `UPDATE seed_state SET status = 'running', claimed_at = datetime('now')
     WHERE id = 1 AND (status = 'pending' OR (status = 'running' AND claimed_at < datetime('now', '-2 minutes')))`
  );
  if (Number(claim.rowsAffected) === 0) {
    // Outra execução está (ou acabou de ficar) responsável por semear agora —
    // não faz nada; uma próxima requisição confere de novo.
    return;
  }

  try {
    // Garante estado limpo: se uma tentativa anterior deixou dados parciais
    // (por exemplo, importação interrompida por timeout no meio do caminho),
    // começa a importação do zero em vez de tentar reconciliar o que já tem.
    await db.execute("DELETE FROM orcamento_links");
    await db.execute("DELETE FROM activities");
    await db.execute("DELETE FROM leads");

    await seedLeadsInBatches(db);
    await seedPlanilhaInBatches(db);

    await db.execute("UPDATE seed_state SET status = 'done' WHERE id = 1");
  } catch (err) {
    // Deixa em 'pending' pra uma próxima requisição poder tentar de novo.
    await db.execute("UPDATE seed_state SET status = 'pending' WHERE id = 1");
    throw err;
  }
}

const LEAD_INSERT_SQL = `INSERT INTO leads
  (cliente_empresa, cidade, vendedor, status, tipo_obra, num_orcamentos,
   primeiro_orcamento, ultimo_orcamento, notas, origem)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

async function seedLeadsInBatches(db) {
  // Primeira inicialização do banco: importa os dados originais (Notion + planilha),
  // igual ao seed.py / import_planilha.py da versão Python/Render — mas em lotes,
  // usando db.batch() (uma chamada HTTP por lote) em vez de um INSERT por vez.
  for (let i = 0; i < leadsSeed.length; i += SEED_CHUNK) {
    const chunk = leadsSeed.slice(i, i + SEED_CHUNK);
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
  }
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

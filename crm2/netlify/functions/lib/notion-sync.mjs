import { getClient, VENDEDOR_OPTIONS } from "./db.mjs";

// Sincronização Notion -> CRM (um sentido só: o Notion "alimenta" o CRM,
// nada que o vendedor digita no CRM é escrito de volta no Notion).
//
// Fonte: a base "💰 ORÇAMENTOS" do Notion — CORRIGIDO em 24/09/2026 a pedido
// da Sil (a versão anterior lia da base "🧲 CADASTRO DE CLIENTES / LEADS",
// que ela explicitamente não quer usar aqui). ORÇAMENTOS tem uma linha por
// PROPOSTA (não por cliente), então esta sincronização agrupa as propostas
// por cliente antes de gravar no CRM — decisão confirmada com a Sil:
// "Uma linha por cliente" (não uma linha por orçamento).
//
// Requer a variável de ambiente NOTION_TOKEN (um "internal integration
// secret" criado em notion.so/my-integrations, com a base ORÇAMENTOS
// compartilhada com ela — menu "•••" > Conexões, dentro do Notion).

const NOTION_VERSION = "2022-06-28";
// ID da página/base "💰 ORÇAMENTOS" no Notion (não confundir com o ID de
// "data source" que o Notion usa internamente pra bases com múltiplas fontes
// de dados — descoberto na tentativa de teste real: usar o ID de data source
// aqui dá "Could not find database" nesse endpoint mais antigo da API).
// Extraído do link que a Sil compartilhou:
// https://app.notion.com/p/185237ac46f5809fb117e70c705b84a6?v=...
const DATABASE_ID = "185237ac-46f5-809f-b117-e70c705b84a6"; // 💰 ORÇAMENTOS

// Valores de "Situação" (base ORÇAMENTOS) que contam como "em produção/fila"
// — ou seja, proposta ainda ativa. Basta UM orçamento do cliente estar em
// algum desses estados para o cliente contar como "com proposta ativa" (isso
// é o que acende o estado dele no Mapa Comercial nacional).
// Confirmado com a Sil em 24/09/2026 (opção "Tudo em produção/fila").
// Observação: "Desenho 2D" não estava listado nas opções que ela escolheu
// explicitamente, mas é claramente uma etapa de produção análoga a
// "Desenho 3D" — incluída aqui por consistência. Fácil de tirar depois se
// ela discordar.
const SITUACOES_ATIVAS = new Set([
  "Leads",
  "Aguardar informações",
  "Fazer",
  "Desenho 3D",
  "Desenho 2D",
  "Discriminativo",
  "Revisão discriminativo",
  "Aguardar cotação",
  "Aguardar projetos",
  "Licitação",
]);

// Situações de "fechamento": quando a situação do orçamento MAIS RECENTE do
// cliente é uma dessas, sobrescreve o status do lead no CRM. Fora esses 4
// casos, o status que o vendedor controla manualmente no CRM é preservado —
// evita que o Notion reverta um estágio mais fino (Negociação, Follow-up
// etc.) só porque ainda não foi atualizado por lá.
const SITUACAO_PARA_STATUS_FECHAMENTO = {
  Concluído: "Cliente",
  Entregar: "Cliente",
  Negado: "Perdido",
  Arquivado: "Arquivado",
};

function notionToken() {
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    throw new Error(
      "NOTION_TOKEN não configurada. Crie uma integração interna em notion.so/my-integrations, compartilhe a base \"ORÇAMENTOS\" com ela, e defina NOTION_TOKEN no painel do Netlify (Site settings > Environment variables)."
    );
  }
  return token;
}

async function notionFetch(path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken()}`,
      "Notion-Version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || `Notion API respondeu ${res.status}`;
    throw new Error(`Erro consultando o Notion: ${msg}`);
  }
  return data;
}

function plainText(prop) {
  const arr = prop?.title || prop?.rich_text || [];
  return arr.map((t) => t.plain_text || "").join("").trim();
}

function pageUrl(id) {
  return `https://www.notion.so/${String(id).replace(/-/g, "")}`;
}

// Normaliza o nome do cliente pra usar como chave de sincronização estável
// (indiferente a acento/maiúscula/espaço extra) — ver clienteSyncKey abaixo.
function normalizeClientName(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Chave usada para casar um "cliente agregado" desta sincronização com um
// lead já existente no CRM (gravada na coluna `notion_page_id`, reaproveitada
// aqui como uma chave de sincronização genérica, não literalmente um ID de
// página). Decisão de design: como ORÇAMENTOS não tem uma página por
// cliente (só por proposta), não existe um ID de página estável por cliente.
// Usar o ID da proposta mais recente quebraria a cada novo orçamento criado
// pro mesmo cliente (viraria uma "página mais recente" diferente a cada
// sync, duplicando o lead). Por isso a chave é derivada do NOME do cliente
// (normalizado) — estável entre sincronizações, só muda se o nome do
// cliente for editado no Notion (nesse caso, o próximo sync cria um lead
// novo em vez de atualizar o antigo — aceitável, é um caso raro).
function clienteSyncKey(cliente) {
  return "orc:" + normalizeClientName(cliente);
}

// Busca todas as páginas (propostas) da base ORÇAMENTOS no Notion.
async function fetchAllNotionOrcamentos() {
  const pages = [];
  let cursor = undefined;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const data = await notionFetch(`/databases/${DATABASE_ID}/query`, body);
    pages.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

function mapOrcamentoPage(page) {
  const p = page.properties || {};
  return {
    page_id: page.id,
    cliente: plainText(p["Cliente"]),
    cidade: plainText(p["Cidade"]),
    vendedor: p["Vendedor"]?.select?.name || "",
    situacao: p["Situação"]?.select?.name || "",
    orcar: (p["Orçar"]?.multi_select || []).map((o) => o.name).filter(Boolean),
    created_time: page.created_time || "",
  };
}

function groupByCliente(orcamentos) {
  const groups = new Map();
  for (const o of orcamentos) {
    if (!groups.has(o.cliente)) groups.set(o.cliente, []);
    groups.get(o.cliente).push(o);
  }
  return groups;
}

// Agrega os orçamentos de UM cliente numa única "linha de lead": cidade e
// vendedor vêm do orçamento mais recente (created_time), tipo_obra é a união
// dos valores de "Orçar" de todos os orçamentos, e tem_orcamento_ativo é
// verdadeiro se QUALQUER orçamento do cliente estiver numa situação ativa.
function aggregateCliente(cliente, orcamentos) {
  const sorted = [...orcamentos].sort((a, b) => (b.created_time || "").localeCompare(a.created_time || ""));
  const latest = sorted[0];

  const temAtivo = orcamentos.some((o) => SITUACOES_ATIVAS.has(o.situacao));
  const statusFechamento = SITUACAO_PARA_STATUS_FECHAMENTO[latest.situacao] || null;

  const tipoObra = Array.from(new Set(orcamentos.flatMap((o) => o.orcar))).join(", ");
  const times = orcamentos.map((o) => o.created_time).filter(Boolean).sort();

  // Filtra valores de "Vendedor" que não são vendedores reais do CRM
  // (a base ORÇAMENTOS usa o mesmo campo pra placeholders como "Leads" ou
  // "Licitação", e há um valor "Lucas" que não corresponde a ninguém no CRM).
  const vendedor = VENDEDOR_OPTIONS.includes(latest.vendedor) ? latest.vendedor : "";

  return {
    cliente_empresa: cliente,
    cidade: latest.cidade,
    vendedor,
    tem_orcamento_ativo: temAtivo ? 1 : 0,
    status_fechamento: statusFechamento,
    tipo_obra: tipoObra,
    num_orcamentos: orcamentos.length,
    primeiro_orcamento: times[0] || "",
    ultimo_orcamento: times[times.length - 1] || "",
    orcamento_urls: orcamentos.map((o) => pageUrl(o.page_id)),
  };
}

// Executa uma sincronização completa. Retorna um resumo { criados, atualizados,
// total_notion, quando }. Lança erro se NOTION_TOKEN não estiver configurada
// ou se a chamada à API do Notion falhar (o chamador decide como reportar).
export async function runNotionSync() {
  const db = getClient();
  const notionPages = await fetchAllNotionOrcamentos();
  const orcamentos = notionPages
    .filter((pg) => !pg.archived && !pg.in_trash)
    .map(mapOrcamentoPage)
    .filter((o) => o.cliente); // ignora propostas sem nome de cliente preenchido

  const groups = groupByCliente(orcamentos);
  const clientes = Array.from(groups.entries()).map(([cliente, list]) => aggregateCliente(cliente, list));

  const existingRes = await db.execute("SELECT id, notion_page_id, status FROM leads WHERE notion_page_id IS NOT NULL");
  const existingByKey = new Map(existingRes.rows.map((r) => [r.notion_page_id, r]));

  let criados = 0;
  let atualizados = 0;

  for (const c of clientes) {
    const key = clienteSyncKey(c.cliente_empresa);
    const existing = existingByKey.get(key);

    if (!existing) {
      const statusInicial = c.status_fechamento || (c.tem_orcamento_ativo ? "Em orçamento" : "Prospect");
      const insertRes = await db.execute({
        sql: `INSERT INTO leads
          (cliente_empresa, cidade, vendedor, status, tipo_obra, num_orcamentos,
           primeiro_orcamento, ultimo_orcamento, notas, origem, notion_page_id, tem_orcamento_ativo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)`,
        args: [
          c.cliente_empresa, c.cidade, c.vendedor, statusInicial,
          c.tipo_obra, c.num_orcamentos, c.primeiro_orcamento, c.ultimo_orcamento,
          key, c.tem_orcamento_ativo,
        ],
      });
      const leadId = Number(insertRes.lastInsertRowid);
      await replaceOrcamentoLinks(db, leadId, c.orcamento_urls);
      criados++;
      continue;
    }

    // Regra de conflito de status (ver SITUACAO_PARA_STATUS_FECHAMENTO acima):
    // só troca o status do lead já existente se o Notion está mandando um
    // fechamento; senão preserva o status atual do CRM.
    const novoStatus = c.status_fechamento || existing.status;

    await db.execute({
      sql: `UPDATE leads SET
              cliente_empresa = ?, cidade = ?, vendedor = ?, status = ?,
              tipo_obra = ?, num_orcamentos = ?, primeiro_orcamento = ?,
              ultimo_orcamento = ?, tem_orcamento_ativo = ?, updated_at = datetime('now')
            WHERE id = ?`,
      args: [
        c.cliente_empresa, c.cidade, c.vendedor, novoStatus,
        c.tipo_obra, c.num_orcamentos, c.primeiro_orcamento, c.ultimo_orcamento,
        c.tem_orcamento_ativo, existing.id,
      ],
    });
    await replaceOrcamentoLinks(db, existing.id, c.orcamento_urls);
    atualizados++;
  }

  const resumo = {
    criados,
    atualizados,
    total_notion: clientes.length,
    quando: new Date().toISOString(),
  };
  await db.execute({
    sql: "UPDATE sync_state SET last_synced_at = datetime('now'), last_result = ? WHERE id = 1",
    args: [JSON.stringify(resumo)],
  });
  return resumo;
}

async function replaceOrcamentoLinks(db, leadId, urls) {
  await db.execute({ sql: "DELETE FROM orcamento_links WHERE lead_id = ?", args: [leadId] });
  if (!urls.length) return;
  const statements = urls.map((url) => ({
    sql: "INSERT INTO orcamento_links (lead_id, url) VALUES (?, ?)",
    args: [leadId, url],
  }));
  await db.batch(statements, "write");
}

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
    // "Nº Proposta" (texto), "Revisão" e "Valor" (números) — pedido pela Sil
    // em 30/09/2026: mostrar o número real da proposta no lugar de uma
    // contagem, e trazer a revisão/valor do orçamento mais recente do cliente.
    numero_proposta: plainText(p["Nº Proposta"]),
    revisao: typeof p["Revisão"]?.number === "number" ? p["Revisão"].number : null,
    valor: typeof p["Valor"]?.number === "number" ? p["Valor"].number : null,
  };
}

// Agrupa pelo NOME NORMALIZADO do cliente (não pelo texto exato) — dois
// orçamentos do mesmo cliente digitados de forma levemente diferente no
// Notion ("CARGILL" vs "Cargill ", por exemplo) precisam cair no mesmo
// grupo. Se agrupássemos pelo texto exato, viravam "clientes" diferentes
// aqui mas calculavam a MESMA clienteSyncKey (que também normaliza) na hora
// de gravar — e o INSERT em lote quebrava com "UNIQUE constraint failed"
// por tentar criar duas linhas novas com a mesma chave no mesmo lote.
function groupByCliente(orcamentos) {
  const groups = new Map();
  for (const o of orcamentos) {
    const norm = normalizeClientName(o.cliente);
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(o);
  }
  return groups;
}

// Agrega os orçamentos de UM cliente numa única "linha de lead": o nome
// exibido, cidade e vendedor vêm do orçamento mais recente (created_time),
// tipo_obra é a união dos valores de "Orçar" de todos os orçamentos, e
// tem_orcamento_ativo é verdadeiro se QUALQUER orçamento do cliente estiver
// numa situação ativa.
function aggregateCliente(orcamentos) {
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
    cliente_empresa: latest.cliente,
    cidade: latest.cidade,
    vendedor,
    tem_orcamento_ativo: temAtivo ? 1 : 0,
    status_fechamento: statusFechamento,
    tipo_obra: tipoObra,
    num_orcamentos: orcamentos.length,
    // Do orçamento mais recente do cliente (não agregado — é o que a Sil
    // pediu: "Nº da Proposta", Revisão e Valor de que orçamento está valendo
    // agora, não uma soma/lista de todos os orçamentos do cliente).
    numero_proposta: latest.numero_proposta || "",
    revisao: latest.revisao,
    valor: latest.valor,
    primeiro_orcamento: times[0] || "",
    ultimo_orcamento: times[times.length - 1] || "",
    orcamento_urls: orcamentos.map((o) => pageUrl(o.page_id)),
  };
}

// Tamanho de cada lote enviado ao Turso via `batch()` — mesmo padrão usado em
// lib/db.mjs pro seed inicial. Fazer um `db.execute()` por cliente (like a
// primeira versão desta função fazia) significa uma chamada HTTP de rede por
// cliente — com centenas de clientes isso facilmente estoura o tempo limite
// de uma execução de function na Netlify. Em lote, é uma chamada HTTP por
// lote de até CHUNK linhas.
const CHUNK = 300;

// Compara Revisão/Valor (podem ser null quando o Notion não preencheu o
// campo) tratando null/undefined como equivalentes — evita marcar "mudou"
// só por causa de null vs undefined vindos de fontes diferentes (Notion vs.
// linha já gravada no banco).
function numEq(a, b) {
  const an = a === null || a === undefined ? null : Number(a);
  const bn = b === null || b === undefined ? null : Number(b);
  return an === bn;
}

// Campos que só existem no CRM (nunca vêm do Notion) — ao mesclar um cliente
// duplicado, preserva o que já tiver sido preenchido manualmente em qualquer
// uma das linhas duplicadas, escolhendo a primeira não-vazia.
const MERGE_BACKFILL_FIELDS = [
  "contato", "cargo", "telefone1", "telefone2", "email", "segmento",
  "notas", "origem", "primeiro_contato", "proximo_contato",
];

// Corrige a duplicidade entre o cadastro antigo (importado de planilha antes
// de existir sincronização, sem notion_page_id) e o cadastro que a
// sincronização com o Notion passou a gerar: quando o MESMO cliente (nome
// normalizado) tem mais de uma linha em `leads`, mantém só uma — a que já
// está ligada ao Notion (notion_page_id preenchido) quando existir —,
// preserva nela o que tiver sido digitado manualmente nas outras (notas,
// origem, contato, etc.), mexe as atividades/links de orçamento das
// duplicatas pra linha que sobra, e só então apaga as duplicatas. Roda
// sempre no início de uma sincronização, antes de criar/atualizar qualquer
// coisa — pedido pela Sil em 01/10/2026 ao notar o mesmo cliente aparecendo
// ao mesmo tempo em "Em orçamento" (cadastro antigo) e em "Cliente"
// (sincronizado do Notion). Retorna quantas linhas duplicadas foram
// removidas (0 quando não há nada pra mesclar — seguro de rodar sempre).
async function mergeDuplicateLeads(db) {
  const allRes = await db.execute(
    `SELECT id, cliente_empresa, notion_page_id, num_orcamentos,
            ${MERGE_BACKFILL_FIELDS.join(", ")}
     FROM leads`
  );

  const groups = new Map();
  for (const row of allRes.rows) {
    const norm = normalizeClientName(row.cliente_empresa);
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(row);
  }

  const activityMoves = [];
  const linkMoves = [];
  const leadUpdates = [];
  const leadDeletes = [];

  for (const rows of groups.values()) {
    if (rows.length < 2) continue;

    // Prioriza manter a linha já ligada ao Notion (dados mais completos e
    // atualizados pela sincronização); sem nenhuma ligada, mantém a que tem
    // mais orçamentos registrados (provavelmente a mais usada/atualizada).
    const comNotion = rows.filter((r) => r.notion_page_id);
    const keeper =
      comNotion[0] ||
      rows.reduce((a, b) => (Number(b.num_orcamentos || 0) > Number(a.num_orcamentos || 0) ? b : a));
    const losers = rows.filter((r) => r.id !== keeper.id);
    if (!losers.length) continue;

    const fieldUpdates = {};
    for (const f of MERGE_BACKFILL_FIELDS) {
      const keeperVal = keeper[f];
      if (keeperVal !== null && keeperVal !== undefined && String(keeperVal).trim() !== "") continue;
      const fromLoser = losers.find((l) => l[f] !== null && l[f] !== undefined && String(l[f]).trim() !== "");
      if (fromLoser) fieldUpdates[f] = fromLoser[f];
    }

    for (const loser of losers) {
      activityMoves.push({ keeperId: keeper.id, loserId: loser.id });
      linkMoves.push({ keeperId: keeper.id, loserId: loser.id });
      leadDeletes.push(loser.id);
    }
    if (Object.keys(fieldUpdates).length) {
      leadUpdates.push({ id: keeper.id, fields: fieldUpdates });
    }
  }

  for (let i = 0; i < activityMoves.length; i += CHUNK) {
    const chunk = activityMoves.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((m) => ({ sql: "UPDATE activities SET lead_id = ? WHERE lead_id = ?", args: [m.keeperId, m.loserId] })),
      "write"
    );
  }
  for (let i = 0; i < linkMoves.length; i += CHUNK) {
    const chunk = linkMoves.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((m) => ({ sql: "UPDATE orcamento_links SET lead_id = ? WHERE lead_id = ?", args: [m.keeperId, m.loserId] })),
      "write"
    );
  }
  for (let i = 0; i < leadUpdates.length; i += CHUNK) {
    const chunk = leadUpdates.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((u) => {
        const cols = Object.keys(u.fields);
        return {
          sql: `UPDATE leads SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
          args: [...cols.map((c) => u.fields[c]), u.id],
        };
      }),
      "write"
    );
  }
  for (let i = 0; i < leadDeletes.length; i += CHUNK) {
    const chunk = leadDeletes.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((id) => ({ sql: "DELETE FROM leads WHERE id = ?", args: [id] })),
      "write"
    );
  }

  return leadDeletes.length;
}

// Executa uma sincronização completa. Retorna um resumo { criados, atualizados,
// total_notion, quando }. Lança erro se NOTION_TOKEN não estiver configurada
// ou se a chamada à API do Notion falhar (o chamador decide como reportar).
export async function runNotionSync() {
  const db = getClient();

  // Primeiro corrige duplicidade já existente (cadastro antigo x Notion) —
  // ver mergeDuplicateLeads acima. Sempre antes de criar/atualizar qualquer
  // coisa, pra já sincronizar em cima do estado limpo.
  const duplicadosMesclados = await mergeDuplicateLeads(db);

  const notionPages = await fetchAllNotionOrcamentos();
  const orcamentos = notionPages
    .filter((pg) => !pg.archived && !pg.in_trash)
    .map(mapOrcamentoPage)
    .filter((o) => o.cliente); // ignora propostas sem nome de cliente preenchido

  const groups = groupByCliente(orcamentos);
  const clientes = Array.from(groups.values()).map((list) => aggregateCliente(list));

  // Traz todas as colunas que essa sincronização pode alterar, pra poder
  // comparar e NÃO escrever de novo quando nada realmente mudou (ver
  // "só grava quem mudou" logo abaixo — importante pro plano de escrita do
  // banco: reescrever ~2000 clientes inteiros a cada 15 minutos, mesmo sem
  // nenhuma mudança real, esgota rápido a cota de escrita do Turso).
  const existingRes = await db.execute(
    `SELECT id, notion_page_id, status, cliente_empresa, cidade, vendedor,
            tipo_obra, num_orcamentos, numero_proposta, revisao, valor,
            primeiro_orcamento, ultimo_orcamento, tem_orcamento_ativo
     FROM leads`
  );
  // Dois mapas: por chave de sincronização (clientes já ligados ao Notion) e
  // por nome normalizado, só dos SEM notion_page_id (cadastro antigo/manual)
  // — usado pra "adotar" um lead antigo em vez de criar um novo duplicado
  // quando o Notion manda um cliente que já existe no CRM sob outro nome.
  const existingByKey = new Map();
  const existingByNormName = new Map();
  for (const r of existingRes.rows) {
    if (r.notion_page_id) {
      existingByKey.set(r.notion_page_id, r);
    } else {
      existingByNormName.set(normalizeClientName(r.cliente_empresa), r);
    }
  }

  const toInsert = [];
  const toUpdate = [];
  let semAlteracao = 0;
  for (const c of clientes) {
    const key = clienteSyncKey(c.cliente_empresa);
    let existing = existingByKey.get(key);
    // Adoção: não achou por chave do Notion, mas já existe um lead antigo
    // (sem notion_page_id) com o mesmo nome normalizado — usa essa linha em
    // vez de criar uma nova, ligando-a ao Notion a partir de agora.
    let adotando = false;
    if (!existing) {
      const normName = normalizeClientName(c.cliente_empresa);
      const legacyMatch = existingByNormName.get(normName);
      if (legacyMatch) {
        existing = legacyMatch;
        adotando = true;
        existingByNormName.delete(normName);
      }
    }
    if (!existing) {
      toInsert.push({ ...c, key });
      continue;
    }

    const novoStatus = c.status_fechamento || existing.status;
    // Só grava quem mudou: se nenhum campo que a sincronização controla é
    // diferente do que já está no banco, pula o UPDATE (e o reescrever dos
    // links) desse cliente por completo — evita reescrever ~2000 linhas
    // inteiras a cada rodada só porque a sincronização rodou de novo.
    // Adoção sempre conta como "mudou" (precisa gravar o notion_page_id).
    const mudou =
      adotando ||
      c.cliente_empresa !== existing.cliente_empresa ||
      c.cidade !== existing.cidade ||
      c.vendedor !== existing.vendedor ||
      novoStatus !== existing.status ||
      c.tipo_obra !== existing.tipo_obra ||
      Number(c.num_orcamentos) !== Number(existing.num_orcamentos) ||
      (c.numero_proposta || "") !== (existing.numero_proposta || "") ||
      !numEq(c.revisao, existing.revisao) ||
      !numEq(c.valor, existing.valor) ||
      c.primeiro_orcamento !== existing.primeiro_orcamento ||
      c.ultimo_orcamento !== existing.ultimo_orcamento ||
      Number(c.tem_orcamento_ativo) !== Number(existing.tem_orcamento_ativo);

    if (!mudou) {
      semAlteracao++;
      continue;
    }
    toUpdate.push({ ...c, key, existingId: existing.id, existingStatus: existing.status });
  }

  // leadId -> urls dos orçamentos desse lead, preenchido conforme insere/atualiza
  // em lote (pros inserts, o leadId só existe depois do INSERT rodar).
  const linkRowsByLeadId = [];

  // --- Cria leads novos, em lote -----------------------------------------
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    const statements = chunk.map((c) => {
      const statusInicial = c.status_fechamento || (c.tem_orcamento_ativo ? "Em orçamento" : "Prospect");
      return {
        sql: `INSERT INTO leads
          (cliente_empresa, cidade, vendedor, status, tipo_obra, num_orcamentos,
           numero_proposta, revisao, valor,
           primeiro_orcamento, ultimo_orcamento, notas, origem, notion_page_id, tem_orcamento_ativo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)`,
        args: [
          c.cliente_empresa, c.cidade, c.vendedor, statusInicial,
          c.tipo_obra, c.num_orcamentos, c.numero_proposta, c.revisao, c.valor,
          c.primeiro_orcamento, c.ultimo_orcamento,
          c.key, c.tem_orcamento_ativo,
        ],
      };
    });
    const results = await db.batch(statements, "write");
    results.forEach((res, idx) => {
      linkRowsByLeadId.push({ leadId: Number(res.lastInsertRowid), urls: chunk[idx].orcamento_urls });
    });
  }

  // --- Atualiza leads existentes, em lote ---------------------------------
  for (let i = 0; i < toUpdate.length; i += CHUNK) {
    const chunk = toUpdate.slice(i, i + CHUNK);
    const statements = chunk.map((c) => {
      // Regra de conflito de status (ver SITUACAO_PARA_STATUS_FECHAMENTO
      // acima): só troca o status do lead já existente se o Notion está
      // mandando um fechamento; senão preserva o status atual do CRM.
      const novoStatus = c.status_fechamento || c.existingStatus;
      return {
        sql: `UPDATE leads SET
                cliente_empresa = ?, cidade = ?, vendedor = ?, status = ?,
                tipo_obra = ?, num_orcamentos = ?, numero_proposta = ?, revisao = ?, valor = ?,
                primeiro_orcamento = ?, ultimo_orcamento = ?, tem_orcamento_ativo = ?,
                notion_page_id = ?, updated_at = datetime('now')
              WHERE id = ?`,
        args: [
          c.cliente_empresa, c.cidade, c.vendedor, novoStatus,
          c.tipo_obra, c.num_orcamentos, c.numero_proposta, c.revisao, c.valor,
          c.primeiro_orcamento, c.ultimo_orcamento,
          c.tem_orcamento_ativo, c.key, c.existingId,
        ],
      };
    });
    await db.batch(statements, "write");
    chunk.forEach((c) => linkRowsByLeadId.push({ leadId: c.existingId, urls: c.orcamento_urls }));
  }

  // --- Regrava os links de orçamento de todo mundo, em lote ---------------
  for (let i = 0; i < linkRowsByLeadId.length; i += CHUNK) {
    const chunk = linkRowsByLeadId.slice(i, i + CHUNK);
    const deleteStatements = chunk.map((r) => ({
      sql: "DELETE FROM orcamento_links WHERE lead_id = ?",
      args: [r.leadId],
    }));
    await db.batch(deleteStatements, "write");
  }
  const insertLinkStatements = [];
  for (const r of linkRowsByLeadId) {
    for (const url of r.urls) {
      insertLinkStatements.push({
        sql: "INSERT INTO orcamento_links (lead_id, url) VALUES (?, ?)",
        args: [r.leadId, url],
      });
    }
  }
  for (let i = 0; i < insertLinkStatements.length; i += CHUNK) {
    await db.batch(insertLinkStatements.slice(i, i + CHUNK), "write");
  }

  const resumo = {
    criados: toInsert.length,
    atualizados: toUpdate.length,
    sem_alteracao: semAlteracao,
    duplicados_mesclados: duplicadosMesclados,
    total_notion: clientes.length,
    quando: new Date().toISOString(),
  };
  await db.execute({
    sql: "UPDATE sync_state SET last_synced_at = datetime('now'), last_result = ? WHERE id = 1",
    args: [JSON.stringify(resumo)],
  });
  return resumo;
}

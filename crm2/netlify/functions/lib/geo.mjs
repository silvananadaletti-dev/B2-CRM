import municipioUfLookup from "./data/municipio_uf_lookup.json" with { type: "json" };

function normalizeCityName(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

// Extrai a UF a partir do campo "cidade" de um lead. Duas estratégias:
// 1) sufixo explícito ", RS" no fim da string (formato usado em ~60% dos leads);
// 2) busca o nome do município (sem a UF) na tabela de 5571 municípios do IBGE
//    (pacote municipios-brasil, MIT) — se o nome for ambíguo entre estados,
//    retorna todas as UFs candidatas (mais permissivo do que restritivo).
// Retorna um array de UFs (pode ser vazio se não achou nada, ou ter mais de
// um item em caso de nome de cidade ambíguo sem sufixo de UF).
export function inferUFs(cidade) {
  if (!cidade) return [];
  const raw = String(cidade).trim();

  const suffixMatch = raw.match(/,\s*([A-Za-z]{2})\s*$/);
  if (suffixMatch) {
    return [suffixMatch[1].toUpperCase()];
  }

  const norm = normalizeCityName(raw);
  return municipioUfLookup[norm] || [];
}

// Dado um array de leads ({ cidade }) que a sincronização com o Notion já
// marcou como "com proposta ativa" (coluna `tem_orcamento_ativo`, calculada
// a partir da base ORÇAMENTOS — ver lib/notion-sync.mjs), retorna o conjunto
// (array ordenado) de UFs correspondentes. Note que aqui não se olha mais
// pro `status` do lead: quem decide o que é "ativo" é a sincronização, não
// esta função — ela só resolve cidade -> UF.
export function estadosAtivosFromLeads(leads) {
  const ativos = new Set();
  for (const lead of leads) {
    for (const uf of inferUFs(lead.cidade)) {
      ativos.add(uf);
    }
  }
  return Array.from(ativos).sort();
}

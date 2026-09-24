import { ensureSeeded } from "./lib/db.mjs";
import { runNotionSync } from "./lib/notion-sync.mjs";

// Roda sozinha a cada 15 minutos (Netlify Scheduled Functions) puxando a base
// "CADASTRO DE CLIENTES / LEADS" do Notion pro CRM. Além dela, a Administração
// tem um botão "Sincronizar agora" (POST /api/admin/notion-sync) pra forçar
// na hora sem esperar os 15 minutos.
//
// Se NOTION_TOKEN ainda não estiver configurada, essa execução simplesmente
// loga o erro e sai — não trava nada mais no site (o resto do CRM funciona
// normalmente mesmo sem a integração do Notion configurada).
export default async () => {
  try {
    await ensureSeeded();
    const resumo = await runNotionSync();
    console.log("[notion-sync] ok:", JSON.stringify(resumo));
  } catch (err) {
    console.error("[notion-sync] falhou:", err.message);
  }
  return new Response("ok");
};

export const config = { schedule: "*/15 * * * *" };

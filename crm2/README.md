# CRM Pré-Fabricados

Sistema web (backend + frontend + banco de dados) para gestão de clientes/leads,
construído a partir de duas fontes:

1. Histórico do Notion ("💰 ORÇAMENTOS" e "🧲 CADASTRO DE CLIENTES / LEADS") — 1832 leads.
2. Planilha "Acompanhamento comercial.xlsx" (aba Controle Geral) — 47 contatos em
   prospecção/follow-up que ainda não tinham orçamento formal, com nome do contato,
   cargo, telefone, e-mail, segmento e histórico de notas real.

Total: **1879 leads**.

Esta é uma cópia independente dos dados — mudanças feitas aqui **não** são
sincronizadas de volta ao Notion nem à planilha, e vice-versa. Ambos continuam
funcionando normalmente como estão hoje; este sistema é separado, conforme pedido.

## O que tem aqui

- **Backend**: Python + FastAPI + SQLite (`backend/`)
- **Frontend**: HTML/CSS/JS puro, sem build step, servido pelo próprio backend (`frontend/`)
- **Dados**: `notion_export/leads_seed.json` (Notion) + `notion_export/planilha_contatos.json`
  (planilha comercial)

## Funil de vendas (Status do Lead)

Baseado no fluxo real de trabalho identificado na planilha:

`Prospect` (cadastro inicial) → `Fazer contato futuro` → `Aguardando resposta` →
`Follow-up` → `Em orçamento` → `Negociação` / `Perdido` → `Arquivado`

A interface é dividida em 4 abas:
- **Prospecção**: Prospect, Fazer contato futuro, Aguardando resposta, Follow-up
- **Negócios em Andamento**: Em orçamento, Negociação, Perdido
- **Arquivados**: Arquivado
- **Calendário**: visão de agenda com todos os compromissos futuros (veja abaixo)

## Funcionalidades

- **Kanban**: quadro com colunas por Status do Lead. Arraste um card entre
  colunas para mudar o status.
- **Lista**: tabela com todos os leads, ordenável por coluna, com busca e
  filtros por vendedor, segmento e cidade.
- **Detalhes/edição**: clique em qualquer card ou linha para ver e editar
  todos os campos — dados da empresa, dados do contato (nome, cargo, telefones,
  e-mail, segmento), pipeline, datas de contato/orçamento, notas e origem.
  Também é possível criar leads novos e excluir leads.
- **Histórico de interações**: cada lead tem uma lista de atividades (data,
  canal — ligação/whatsapp/e-mail/visita/etc. —, assunto, resultado, próxima
  ação) que pode ser registrada a cada novo contato, no estilo do relatório
  diário que já era usado na planilha.
- **Calendário**: mostra em um grid mensal todos os compromissos agendados a
  partir de hoje — tanto o "Próximo Contato" de cada lead (📞) quanto os
  follow-ups registrados no histórico de interações (🔔). Aceita datas no
  formato dd/mm/aaaa ou "mmm/aa" (ex: "ago/26"); quando só o mês é conhecido,
  o compromisso aparece na seção "sem dia definido" do mês correspondente, em
  vez de ser descartado. Clique em qualquer compromisso para abrir o lead.
  Os filtros de vendedor/segmento/cidade/busca também valem para o calendário.
- Links para os orçamentos originais no Notion aparecem no detalhe do lead
  (apenas como referência/consulta — não editam o Notion).

## Como rodar na sua máquina

Pré-requisitos: Python 3.9+ instalado.

```bash
cd backend
pip install -r requirements.txt

# o banco já vem populado com os 1879 leads — só rode os imports de novo
# se apagar crm.db e quiser reimportar do zero:
#   python3 seed.py             (1832 leads do Notion)
#   python3 import_planilha.py  (47 contatos da planilha, sem duplicar)

uvicorn main:app --reload
```

Abra `http://localhost:8000` no navegador.

## Como colocar no ar (acessar de fora do seu computador)

Este projeto vem pronto pra publicar de duas formas — escolha uma. As duas
usam exatamente a mesma tela/funcionalidades (kanban, lista, calendário
etc.); a diferença é só onde o backend e o banco de dados rodam.

### Opção A: Render (Python, custo fixo baixo)

Jeito mais simples de colocar no ar sem precisar mexer em servidor. Custo:
plano Starter ~US$7/mês + ~US$0,25/mês de disco (cobrado em dólar, cartão de
crédito internacional). Existe um arquivo `render.yaml` na raiz do projeto
que já configura tudo automaticamente (servidor + disco persistente para o
banco de dados não se perder a cada atualização).

**Passo a passo:**

1. **Coloque o código no GitHub.** Se você não tem conta, crie uma grátis em
   [github.com](https://github.com). Depois crie um repositório novo (pode
   ser privado) e suba os arquivos desta pasta `crm2/`. O jeito mais fácil
   pra quem não usa terminal é instalar o
   [GitHub Desktop](https://desktop.github.com), fazer login, escolher
   "Add local repository" apontando pra esta pasta, e clicar em "Publish
   repository".
2. **Crie uma conta no Render** em [render.com](https://render.com) — dá
   pra entrar direto com a conta do GitHub.
3. No painel do Render, clique em **New +** → **Blueprint** e selecione o
   repositório que você acabou de criar. O Render lê o arquivo `render.yaml`
   sozinho e já preenche tudo: servidor web + disco persistente de 1GB para
   o banco de dados.
4. Clique em **Apply** / **Deploy**. Na primeira vez que o servidor subir,
   ele importa automaticamente os 1879 leads originais (Notion + planilha)
   pro disco persistente — não precisa rodar nada manualmente.
5. Em alguns minutos o Render mostra um link tipo
   `https://crm-prefabricados.onrender.com` — esse é o endereço que você
   pode abrir de qualquer computador ou celular, de qualquer lugar.

**Importante — segurança:** por enquanto o sistema **não tem senha** —
qualquer pessoa que tiver esse link consegue ver, editar e apagar os leads.
Não compartilhe o link publicamente; mande só para quem realmente precisa
acessar. Se quiser adicionar uma tela de login mais pra frente, é só pedir.

Depois do primeiro deploy, sempre que você quiser atualizar o site com
mudanças no código, basta subir (`git push`) as alterações pro GitHub — o
Render redeploya sozinho automaticamente.

### Opção B: Netlify (com banco Turso)

O Netlify não roda um servidor Python tradicional como o Render — ele funciona
com "funções" que ligam e desligam a cada requisição, então o backend dessa
opção foi reescrito em JavaScript (pasta `netlify/functions/`) e o banco de
dados é o [Turso](https://turso.tech) (compatível com SQLite, tem plano
gratuito generoso: 5GB de armazenamento, sem precisar de cartão de crédito).
A tela e as funcionalidades são **idênticas** à versão Render — testei ponta
a ponta e os dois back-ends dão o mesmo resultado.

**Passo a passo:**

1. **Suba o código no GitHub** (mesmo passo 1 da opção Render acima, se ainda
   não tiver feito).
2. **Crie o banco no Turso:**
   - Instale a CLI: `curl -sSfL https://get.tur.so/install.sh | bash`
     (Mac/Linux) — no Windows, use o WSL ou veja
     [docs.turso.tech](https://docs.turso.tech) para outras opções.
   - `turso auth login` (abre o navegador pra você criar a conta grátis)
   - `turso db create crm-prefabricados`
   - `turso db show crm-prefabricados --url` → copie a URL que aparece
     (algo como `libsql://crm-prefabricados-seuusuario.turso.io`)
   - `turso db tokens create crm-prefabricados` → copie o token gerado
3. **Crie uma conta no Netlify** em [netlify.com](https://netlify.com) — dá
   pra entrar com a conta do GitHub.
4. No painel do Netlify: **Add new site** → **Import an existing project** →
   selecione o repositório do GitHub. O Netlify lê o `netlify.toml` sozinho
   (sabe onde estão o site e as funções) e instala as dependências do
   `package.json` automaticamente.
5. Antes de finalizar o deploy (ou depois, em **Site settings → Environment
   variables**), adicione duas variáveis:
   - `TURSO_DATABASE_URL` = a URL do passo 2
   - `TURSO_AUTH_TOKEN` = o token do passo 2
6. Deploy. Na primeira requisição à API, o próprio site importa
   automaticamente os 1879 leads originais pro banco Turso — não precisa
   rodar nada manualmente.
7. O Netlify mostra um link tipo `https://seu-site.netlify.app`, acessível
   de qualquer lugar.

O mesmo aviso de segurança da opção Render vale aqui: **sem senha por
enquanto**, não compartilhe o link publicamente.

## Estrutura

```
crm2/
├── render.yaml                    # config de deploy no Render (Blueprint) — Opção A
├── netlify.toml                   # config de deploy no Netlify — Opção B
├── package.json                   # dependência (@libsql/client) das funções do Netlify
├── .gitignore
├── backend/                       # backend Python/FastAPI — usado na Opção A (Render)
│   ├── main.py              # API REST (FastAPI) — leads + atividades
│   ├── database.py           # conexão SQLite + schema + funil/canais
│   ├── seed.py                 # importa notion_export/leads_seed.json -> crm.db
│   ├── import_planilha.py       # importa notion_export/planilha_contatos.json -> crm.db
│   ├── crm.db                     # banco SQLite já populado (1879 leads)
│   └── requirements.txt
├── netlify/functions/             # backend JS/Turso — usado na Opção B (Netlify)
│   ├── meta.mjs, stats.mjs, leads.mjs, lead-detail.mjs,
│   │   lead-activities.mjs, activity-detail.mjs, activities-all.mjs
│   └── lib/db.mjs                 # conexão Turso + schema + funil/canais + auto-seed
├── frontend/                      # mesma interface, usada pelas duas opções
│   ├── index.html
│   ├── style.css
│   └── app.js
└── notion_export/
    ├── leads_seed.json            # dump dos 1832 leads exportados do Notion
    └── planilha_contatos.json     # dump dos 47 contatos da planilha comercial
```

## Próximos passos possíveis

- Autenticação de usuários (hoje qualquer pessoa com acesso ao link/máquina
  pode editar — veja o aviso de segurança acima).
- Importar também o relatório diário de atividades (abas "jul26 (2)" e "ago26"
  da planilha, ~900 linhas) como histórico de interações — não foi feito ainda
  porque vincular cada linha ao lead certo exige um pareamento por nome que
  pode errar; dá para fazer com revisão manual se quiser.
- Dashboard com gráficos de conversão, valor total em orçamento, canais mais
  usados, etc. (o banco de ORÇAMENTOS do Notion tem um campo "Valor" que não
  foi trazido para cá ainda, pois o CADASTRO DE LEADS não o agregava).
- Sincronização automática com o Notion e/ou com a planilha (hoje é uma cópia
  estática do momento da exportação).

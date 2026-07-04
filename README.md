# CRM Leads

Sistema completo de gestão de leads com bot IA, integração Meta API e Evolution API.

## Deploy no Railway

### Passo 1 — Backend
1. Acesse railway.app e crie um novo projeto
2. Conecte ao repositório `kurtmurdock/crm-leads`
3. Selecione a pasta `/backend`
4. Adicione as variáveis de ambiente do `.env.example`
5. Adicione um banco PostgreSQL (botão "+ New" > PostgreSQL)
6. O Railway vai gerar a `DATABASE_URL` automaticamente

### Passo 2 — Variáveis de ambiente no Railway
Configure essas variáveis em "Variables":
- `ANTHROPIC_API_KEY` → console.anthropic.com > API Keys
- `META_VERIFY_TOKEN` → qualquer string secreta (ex: `crm_token_2026`)
- `EVOLUTION_URL` → URL da sua Evolution API na Hostinger
- `EVOLUTION_KEY` → chave da sua Evolution API
- `SECRET_KEY` → qualquer string longa e aleatória

### Passo 3 — Frontend
O frontend fica em `/frontend` e pode ser hospedado no GitHub Pages:
1. Ative GitHub Pages no repositório (Settings > Pages > main branch > /frontend)
2. Configure a variável `API_URL` no arquivo `frontend/js/config.js` com a URL do Railway

### Passo 4 — Configurar Webhooks

**Meta API:**
- URL: `https://seu-backend.railway.app/webhook/meta`
- Verify Token: o mesmo que você colocou em `META_VERIFY_TOKEN`

**Evolution API:**
- URL: `https://seu-backend.railway.app/webhook/evolution`
- Configurar no painel da Evolution para cada instância de vendedor

## Estrutura
```
backend/     → FastAPI + PostgreSQL (Railway)
frontend/    → HTML/CSS/JS (GitHub Pages)
```

# CRM Leads — Frontend

Frontend estático (HTML/CSS/JS puro, sem build) para o CRM das lojas
Salinas e Atlântica. Feito para rodar direto no GitHub Pages.

## Estrutura

```
frontend/
├── login.html        — tela de login (por loja)
├── index.html         — app (Dashboard, Kanban, Contatos, Agendamentos, Métricas, Equipe, Config)
├── css/style.css       — design system
└── js/
    ├── config.js       — URL da API e do WebSocket
    └── app.js           — toda a lógica do app
```

## Publicar no GitHub Pages

1. Copie esta pasta `frontend/` para a raiz do repositório `Kurtmurdock/crm-leads`
   (ou para uma branch `gh-pages`, como preferir).
2. No GitHub: **Settings → Pages → Build and deployment**.
   - Source: "Deploy from a branch"
   - Branch: `main` (ou `gh-pages`), pasta `/frontend` (ou `/` se mover o
     conteúdo para a raiz).
3. Aguarde alguns minutos — o GitHub mostra a URL pública quando terminar
   (algo como `https://kurtmurdock.github.io/crm-leads/frontend/login.html`).

## Configuração

Edite `js/config.js` se a URL do backend no Railway mudar:

```js
const CONFIG = {
  API_URL: "https://crm-leads-production-27fc.up.railway.app",
  WS_URL: "wss://crm-leads-production-27fc.up.railway.app/ws",
};
```

> Nota: o `config.js` que já existia no projeto apontava para
> `crm-leads-production.up.railway.app` (sem `-27fc`). Atualizei para a URL
> que você confirmou estar no ar. Se a URL sem `-27fc` também estiver
> ativa, me avise para eu saber qual é a definitiva.

## Login

O backend atual (`/api/auth/login`) não expõe uma rota para *criar* o
primeiro usuário — os registros da tabela `usuarios` precisam ser inseridos
diretamente no banco (ou por uma rota que vocês criem depois). Enquanto
isso não existir, peça para alguém inserir manualmente pelo menos um
usuário `master` no Postgres do Railway para conseguir entrar.

## O que falta no backend para o frontend funcionar 100%

- `GET /api/lojas` já existe e é usado para montar o seletor de lojas.
- Não existe endpoint de **cadastro de usuário** — só de login. Vale criar
  um `POST /api/usuarios` (ou seed manual) antes de distribuir o CRM.
- `POST /api/vendedores` e `PATCH /api/lojas/{id}/meta|evolution` não
  exigem autenticação hoje — qualquer pessoa com a URL do backend pode
  chamá-los. Recomendo adicionar um middleware de auth simples (token ou
  sessão) antes de ir para produção com dados reais de clientes.

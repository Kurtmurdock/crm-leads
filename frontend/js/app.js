/* =====================================================================
   CRM Leads — app.js
   Vanilla JS SPA. No build step — designed to run straight from
   GitHub Pages. Talks to the FastAPI backend defined in CONFIG.
   ===================================================================== */

(() => {
  "use strict";

  // ---------------------------------------------------------------
  // Auth guard
  // ---------------------------------------------------------------
  const rawUser = sessionStorage.getItem("crm_user");
  if (!rawUser) {
    window.location.href = "login.html";
    return;
  }
  const USER = JSON.parse(rawUser);

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------
  const state = {
    view: "dashboard",
    lojas: [],
    lojaAtual: USER.role === "master" || !USER.loja_id ? "" : USER.loja_id, // "" = todas
    leads: [],
    vendedores: [],
    agendamentos: [],
    metricas: null,
    ws: null,
    wsRetryMs: 2000,
    rtLeadId: null,
    charts: {}, // Chart.js instances, keyed by canvas id, so we can destroy before re-render
    kanbanMode: "etapa", // "etapa" | "vendedor"
    campanhaSelecionados: new Set(),
  };

  const COLUNAS = [
    { id: "entrada", label: "Entrada", icon: "📥" },
    { id: "atribuido", label: "Atribuído", icon: "👤" },
    { id: "negociacao", label: "Negociação", icon: "💬" },
    { id: "fechado", label: "Fechado", icon: "🏁" },
    { id: "perdido", label: "Perdido", icon: "✕" },
  ];

  // Lojas conhecidas do grupo — usadas só para cadastro rápido na aba Config
  // quando ainda não existem no banco. A fonte de verdade continua sendo
  // sempre a API /api/lojas.
  const LOJAS_CONHECIDAS = [
    { id: "salinas", nome: "Salinas" },
    { id: "atlantica", nome: "Atlântica" },
    { id: "uniao", nome: "União" },
    { id: "vision", nome: "Vision" },
    { id: "mare", nome: "Maré" },
    { id: "muralha", nome: "Muralha" },
    { id: "imperio", nome: "Império" },
    { id: "confort", nome: "Confort" },
    { id: "infinity", nome: "Infinity Motos" },
  ];

  // ---------------------------------------------------------------
  // API helper
  // ---------------------------------------------------------------
  async function api(path, opts = {}) {
    const resp = await fetch(`${CONFIG.API_URL}${path}`, {
      headers: { "Content-Type": "application/json" },
      ...opts,
    });
    if (!resp.ok) {
      let detail = `Erro ${resp.status}`;
      try {
        const data = await resp.json();
        detail = data.detail || detail;
      } catch (_) {}
      throw new Error(detail);
    }
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) return resp.json();
    return resp;
  }

  function toast(msg, type = "") {
    const stack = document.getElementById("toastStack");
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  // ---------------------------------------------------------------
  // Sidebar / topbar chrome
  // ---------------------------------------------------------------
  const VIEW_META = {
    dashboard: ["Dashboard", "Visão geral do funil de leads"],
    kanban: ["Kanban", "Arraste os cards entre as etapas"],
    realtime: ["Ao Vivo", "Atendimentos em andamento, em tempo real"],
    contatos: ["Contatos", "Todos os leads, com filtros e exportação"],
    agendamentos: ["Agendamentos", "Visitas e compromissos marcados"],
    campanhas: ["Campanhas", "Remarketing em massa com intervalo entre envios"],
    metricas: ["Métricas", "Velocidade de atendimento e conversão"],
    equipe: ["Equipe", "Vendedores por loja"],
    config: ["Configuração Meta", "WhatsApp Business API e Evolution"],
  };

  function initChrome() {
    document.getElementById("whoName").textContent = USER.nome || USER.username;
    document.getElementById("whoRole").textContent = USER.role || "vendedor";
    document.getElementById("whoAvatar").textContent = (USER.nome || USER.username || "?").slice(0, 1).toUpperCase();

    document.getElementById("logoutBtn").addEventListener("click", () => {
      sessionStorage.removeItem("crm_user");
      window.location.href = "login.html";
    });

    document.querySelectorAll(".nav-item[data-view]").forEach((item) => {
      item.addEventListener("click", () => setView(item.dataset.view));
    });

    document.getElementById("menuBtn").addEventListener("click", () => {
      document.getElementById("sidebar").classList.toggle("open");
    });
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll(".nav-item[data-view]").forEach((el) => {
      el.classList.toggle("active", el.dataset.view === view);
    });
    document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
    document.getElementById(`view${view[0].toUpperCase()}${view.slice(1)}`).classList.remove("hidden");
    const [title, sub] = VIEW_META[view];
    document.getElementById("viewTitle").textContent = title;
    document.getElementById("viewSub").textContent = sub;
    document.getElementById("sidebar").classList.remove("open");
    renderView(view);
  }

  function renderLojaSwitch() {
    const box = document.getElementById("lojaSwitch");
    const items = [{ id: "", nome: "Todas" }, ...state.lojas];
    box.innerHTML = items.map((l) => `
      <button data-loja="${esc(l.id)}" class="${l.id === state.lojaAtual ? "active" : ""}">${esc(l.nome)}</button>
    `).join("");
    box.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.lojaAtual = btn.dataset.loja;
        renderLojaSwitch();
        renderView(state.view);
      });
    });
    // Non-master users are pinned to their own store.
    if (USER.role !== "master" && USER.loja_id) {
      box.style.display = "none";
    }
  }

  function renderView(view) {
    if (view === "dashboard") renderDashboard();
    if (view === "kanban") renderKanban();
    if (view === "realtime") renderRealtime();
    if (view === "contatos") renderContatos();
    if (view === "agendamentos") renderAgendamentos();
    if (view === "campanhas") renderCampanhas();
    if (view === "metricas") renderMetricas();
    if (view === "equipe") renderEquipe();
    if (view === "config") renderConfig();
  }

  // ---------------------------------------------------------------
  // DASHBOARD
  // ---------------------------------------------------------------
  async function renderDashboard() {
    const el = document.getElementById("viewDashboard");
    el.innerHTML = `<div class="empty-state"><div class="skeleton" style="height:120px;border-radius:14px;"></div></div>`;
    try {
      const [m] = await Promise.all([
        api(`/api/metricas${state.lojaAtual ? `?loja_id=${encodeURIComponent(state.lojaAtual)}` : ""}`),
        loadLeads(),
        loadVendedores(),
      ]);
      state.metricas = m;
      el.innerHTML = buildDashboardHTML(m, "dash");
      renderCharts(m, "dash");
    } catch (e) {
      el.innerHTML = emptyState("Não foi possível carregar as métricas", e.message);
    }
  }

  function buildDashboardHTML(m, idPrefix) {
    const canalEntries = Object.entries(m.por_canal || {});
    const colunaEntries = Object.entries(m.por_coluna || {});
    const hasCanal = canalEntries.length > 0;
    const hasColuna = colunaEntries.length > 0;

    return `
      <div class="kpi-row">
        <div class="kpi"><div class="accent-bar"></div><div class="label">Leads (30d)</div><div class="value">${m.total}</div></div>
        <div class="kpi"><div class="accent-bar" style="background:var(--green)"></div><div class="label">Fechados</div><div class="value">${m.fechados}</div></div>
        <div class="kpi"><div class="accent-bar" style="background:var(--blue)"></div><div class="label">Conversão</div><div class="value">${m.taxa_conversao}<small>%</small></div></div>
        <div class="kpi"><div class="accent-bar" style="background:var(--amber)"></div><div class="label">Vel. média</div><div class="value">${m.velocidade_media_min}<small>min</small></div></div>
      </div>

      <div class="two-col">
        <div class="card">
          <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:16px;">Painel de velocidade de resposta</div>
          <div class="gauge-wrap">
            ${gaugeSVG(m.velocidade_media_min)}
            <div class="gauge-legend">
              <div class="row"><span class="sw" style="background:var(--green)"></span> 0–20 min · ágil</div>
              <div class="row"><span class="sw" style="background:var(--amber)"></span> 20–60 min · atenção</div>
              <div class="row"><span class="sw" style="background:var(--red)"></span> 60min+ · lento</div>
            </div>
          </div>
        </div>

        <div class="card">
          <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:16px;">Por etapa</div>
          ${hasColuna
            ? `<div class="chart-box"><canvas id="${idPrefix}Coluna"></canvas></div>`
            : `<div class="faint" style="font-size:13px;">Sem dados no período.</div>`}
        </div>
      </div>

      <div class="card" style="margin-top:16px;">
        <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:16px;">Por canal</div>
        ${hasCanal
          ? `<div class="chart-box" style="max-width:420px;"><canvas id="${idPrefix}Canal"></canvas></div>`
          : `<div class="faint" style="font-size:13px;">Sem dados no período.</div>`}
      </div>

      <div class="card" style="margin-top:16px;">
        <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:16px;">Desempenho por vendedor</div>
        <div id="${idPrefix}VendedorPerf">${desempenhoPorVendedorHTML()}</div>
      </div>
    `;
  }

  function desempenhoPorVendedorHTML() {
    if (!state.vendedores.length) {
      return `<div class="faint" style="font-size:13px;">Nenhum vendedor cadastrado ainda.</div>`;
    }
    const linhas = state.vendedores.map((v) => {
      const leadsDoVendedor = state.leads.filter((l) => l.vendedor_id === v.id);
      const abertos = leadsDoVendedor.filter((l) => l.coluna !== "fechado" && l.coluna !== "perdido").length;
      const fechados = leadsDoVendedor.filter((l) => l.coluna === "fechado").length;
      const perdidos = leadsDoVendedor.filter((l) => l.coluna === "perdido").length;
      return { nome: v.nome, total: leadsDoVendedor.length, abertos, fechados, perdidos };
    });
    return `
      <div class="table-wrap" style="border:none;">
        <table>
          <thead><tr><th>Vendedor</th><th>Leads</th><th>Abertos</th><th>Fechados</th><th>Perdidos</th></tr></thead>
          <tbody>
            ${linhas.map((r) => `
              <tr>
                <td>${esc(r.nome)}</td>
                <td class="mono">${r.total}</td>
                <td class="mono">${r.abertos}</td>
                <td class="mono">${r.fechados}</td>
                <td class="mono">${r.perdidos}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  // Cores do tema, na ordem em que aparecem nas etapas do Kanban.
  const CHART_COLORS = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#64748b"];

  function renderCharts(m, idPrefix) {
    if (typeof Chart === "undefined") return; // CDN pode falhar a carregar; degrada graciosamente
    const colunaEntries = Object.entries(m.por_coluna || {});
    const canalEntries = Object.entries(m.por_canal || {});

    const colunaCanvas = document.getElementById(`${idPrefix}Coluna`);
    if (colunaCanvas && colunaEntries.length) {
      destroyChart(`${idPrefix}Coluna`);
      state.charts[`${idPrefix}Coluna`] = new Chart(colunaCanvas, {
        type: "bar",
        data: {
          labels: colunaEntries.map(([k]) => colLabel(k)),
          datasets: [{ data: colunaEntries.map(([, v]) => v), backgroundColor: "#3b82f6", borderRadius: 4, maxBarThickness: 34 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: "#94a3b8", font: { size: 11 } }, grid: { display: false } },
            y: { ticks: { color: "#94a3b8", stepSize: 1 }, grid: { color: "#1e2d45" }, beginAtZero: true },
          },
        },
      });
    }

    const canalCanvas = document.getElementById(`${idPrefix}Canal`);
    if (canalCanvas && canalEntries.length) {
      destroyChart(`${idPrefix}Canal`);
      state.charts[`${idPrefix}Canal`] = new Chart(canalCanvas, {
        type: "doughnut",
        data: {
          labels: canalEntries.map(([k]) => k),
          datasets: [{ data: canalEntries.map(([, v]) => v), backgroundColor: CHART_COLORS, borderColor: "#111827", borderWidth: 2 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: "right", labels: { color: "#94a3b8", boxWidth: 11, font: { size: 12 } } } },
        },
      });
    }
  }

  function destroyChart(key) {
    if (state.charts[key]) {
      state.charts[key].destroy();
      delete state.charts[key];
    }
  }

  function colLabel(id) {
    const c = COLUNAS.find((c) => c.id === id);
    return c ? `${c.icon} ${c.label}` : id;
  }

  function gaugeSVG(minutes) {
    const max = 120;
    const clamped = Math.max(0, Math.min(minutes, max));
    const angle = (clamped / max) * 180; // 0..180
    const cx = 95, cy = 100, r = 78;
    // needle endpoint: 0deg = left (0min, fast) .. 180deg = right (max min, slow)
    const theta = Math.PI - (angle * Math.PI) / 180;
    const tipX = cx + (r - 14) * Math.cos(theta);
    const tipY = cy - (r - 14) * Math.sin(theta);
    return `
      <div class="gauge">
        <svg viewBox="0 0 190 110">
          <path d="M 17 100 A 78 78 0 0 1 61.5 27.4" stroke="var(--green)" stroke-width="12" fill="none" stroke-linecap="round"/>
          <path d="M 61.5 27.4 A 78 78 0 0 1 128.5 27.4" stroke="var(--amber)" stroke-width="12" fill="none" stroke-linecap="round"/>
          <path d="M 128.5 27.4 A 78 78 0 0 1 173 100" stroke="var(--red)" stroke-width="12" fill="none" stroke-linecap="round"/>
          <line x1="${cx}" y1="${cy}" x2="${tipX}" y2="${tipY}" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>
          <circle cx="${cx}" cy="${cy}" r="5.5" fill="var(--text)"/>
        </svg>
        <div class="gauge-readout">
          <div class="n">${minutes}</div>
          <div class="u">min médio</div>
        </div>
      </div>
    `;
  }

  function emptyState(title, sub) {
    return `<div class="empty-state"><div class="big">${esc(title)}</div>${sub ? esc(sub) : ""}</div>`;
  }

  // ---------------------------------------------------------------
  // KANBAN
  // ---------------------------------------------------------------
  async function renderKanban() {
    const el = document.getElementById("viewKanban");
    el.innerHTML = `
      <div class="kanban-toolbar">
        <div class="loja-switch" id="kanbanModeSwitch" style="margin-right:auto;">
          <button data-mode="etapa" class="${state.kanbanMode === "etapa" ? "active" : ""}">Por etapa</button>
          <button data-mode="vendedor" class="${state.kanbanMode === "vendedor" ? "active" : ""}">Por vendedor</button>
        </div>
        <input type="search" id="kanbanSearch" placeholder="Buscar por nome ou WhatsApp...">
      </div>
      <div class="kanban-board" id="kanbanBoard"></div>
    `;
    document.getElementById("kanbanSearch").addEventListener("input", (e) => {
      drawKanban(e.target.value.trim().toLowerCase());
    });
    document.querySelectorAll("#kanbanModeSwitch button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.kanbanMode = btn.dataset.mode;
        document.querySelectorAll("#kanbanModeSwitch button").forEach((b) => b.classList.toggle("active", b === btn));
        drawKanban(document.getElementById("kanbanSearch").value.trim().toLowerCase());
      });
    });
    await Promise.all([loadLeads(), loadVendedores()]);
    drawKanban("");
  }

  function drawKanban(filter) {
    if (state.kanbanMode === "vendedor") drawKanbanBoardByVendedor(filter);
    else drawKanbanBoard(filter);
  }

  async function loadLeads() {
    try {
      const qs = state.lojaAtual ? `?loja_id=${encodeURIComponent(state.lojaAtual)}` : "";
      state.leads = await api(`/api/leads${qs}`);
    } catch (e) {
      toast(`Erro ao carregar leads: ${e.message}`, "error");
      state.leads = [];
    }
  }

  function drawKanbanBoard(filter) {
    const board = document.getElementById("kanbanBoard");
    if (!board) return;
    const leads = state.leads.filter((l) =>
      !filter || (l.nome || "").toLowerCase().includes(filter) || (l.whatsapp || "").includes(filter)
    );
    board.innerHTML = COLUNAS.map((col) => {
      const items = leads.filter((l) => l.coluna === col.id);
      return `
        <div class="kcol stage-${col.id}" data-coluna="${col.id}">
          <div class="kcol-head"><span>${col.icon} ${col.label}</span><span class="count">${items.length}</span></div>
          <div class="kcol-body" data-coluna="${col.id}">
            ${items.map(leadCardHTML).join("") || `<div class="faint" style="font-size:12px;padding:8px 2px;">Vazio</div>`}
          </div>
        </div>
      `;
    }).join("");
    wireKanbanDnD();
  }

  function leadCardHTML(l) {
    return `
      <div class="lead-card" draggable="true" data-id="${l.id}">
        <div class="name">${esc(l.nome || "Sem nome")}</div>
        <div class="phone mono">${esc(l.whatsapp)}</div>
        <div class="meta-row">
          <span class="badge b-gray">${esc(l.canal || "WhatsApp")}</span>
          ${l.bot_ativo ? '<span class="badge b-amber">🤖 bot</span>' : ""}
          ${l.vendedor ? `<span class="badge b-blue">${esc(l.vendedor)}</span>` : ""}
        </div>
      </div>
    `;
  }

  function wireKanbanDnD() {
    document.querySelectorAll(".lead-card").forEach((card) => {
      card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        e.dataTransfer.setData("text/plain", card.dataset.id);
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      card.addEventListener("click", () => openLeadDrawer(Number(card.dataset.id)));
    });

    document.querySelectorAll(".kcol-body").forEach((body) => {
      body.addEventListener("dragover", (e) => {
        e.preventDefault();
        body.classList.add("drag-over");
      });
      body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
      body.addEventListener("drop", async (e) => {
        e.preventDefault();
        body.classList.remove("drag-over");
        const id = Number(e.dataTransfer.getData("text/plain"));
        const novaColuna = body.dataset.coluna;
        const lead = state.leads.find((l) => l.id === id);
        if (!lead || lead.coluna === novaColuna) return;
        const antiga = lead.coluna;
        lead.coluna = novaColuna;
        drawKanbanBoard(document.getElementById("kanbanSearch").value.trim().toLowerCase());
        try {
          await api(`/api/leads/${id}/coluna`, { method: "PATCH", body: JSON.stringify({ coluna: novaColuna }) });
          toast(`${lead.nome || "Lead"} movido para ${colLabel(novaColuna)}`, "success");
        } catch (err) {
          lead.coluna = antiga;
          drawKanbanBoard("");
          toast(`Não foi possível mover: ${err.message}`, "error");
        }
      });
    });
  }

  // ---------------------------------------------------------------
  // KANBAN — modo "Por vendedor": uma coluna por vendedor + Pendentes/Bot
  // ---------------------------------------------------------------
  function drawKanbanBoardByVendedor(filter) {
    const board = document.getElementById("kanbanBoard");
    if (!board) return;
    const leads = state.leads.filter((l) =>
      (!filter || (l.nome || "").toLowerCase().includes(filter) || (l.whatsapp || "").includes(filter)) &&
      l.coluna !== "perdido" && l.coluna !== "fechado" // board ao vivo: só atendimentos em andamento
    );

    const colunas = [
      { id: "pendente", label: "🤖 Pendentes / Bot", vendedorId: null },
      ...state.vendedores.map((v) => ({ id: `v-${v.id}`, label: v.nome, vendedorId: v.id })),
    ];

    board.innerHTML = colunas.map((col) => {
      const items = col.vendedorId === null
        ? leads.filter((l) => !l.vendedor_id)
        : leads.filter((l) => l.vendedor_id === col.vendedorId);
      return `
        <div class="kcol" data-vendedor-col="${col.id}">
          <div class="kcol-head"><span>${esc(col.label)}</span><span class="count">${items.length}</span></div>
          <div class="kcol-body" data-vendedor-target="${col.vendedorId === null ? "" : col.vendedorId}">
            ${items.map(leadCardHTML).join("") || `<div class="faint" style="font-size:12px;padding:8px 2px;">Vazio</div>`}
          </div>
        </div>
      `;
    }).join("");

    wireKanbanDnDVendedor();
  }

  function wireKanbanDnDVendedor() {
    document.querySelectorAll("#kanbanBoard .lead-card").forEach((card) => {
      card.addEventListener("dragstart", (e) => {
        card.classList.add("dragging");
        e.dataTransfer.setData("text/plain", card.dataset.id);
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
      card.addEventListener("click", () => openLeadDrawer(Number(card.dataset.id)));
    });

    document.querySelectorAll("#kanbanBoard .kcol-body").forEach((body) => {
      body.addEventListener("dragover", (e) => { e.preventDefault(); body.classList.add("drag-over"); });
      body.addEventListener("dragleave", () => body.classList.remove("drag-over"));
      body.addEventListener("drop", async (e) => {
        e.preventDefault();
        body.classList.remove("drag-over");
        const id = Number(e.dataTransfer.getData("text/plain"));
        const targetRaw = body.dataset.vendedorTarget;
        const novoVendedorId = targetRaw ? Number(targetRaw) : null;
        const lead = state.leads.find((l) => l.id === id);
        if (!lead || lead.vendedor_id === novoVendedorId) return;
        const anterior = { vendedor_id: lead.vendedor_id, vendedor: lead.vendedor, coluna: lead.coluna, bot_ativo: lead.bot_ativo };
        const vendedorNovo = state.vendedores.find((v) => v.id === novoVendedorId);
        lead.vendedor_id = novoVendedorId;
        lead.vendedor = vendedorNovo ? vendedorNovo.nome : null;
        if (novoVendedorId) { lead.bot_ativo = false; if (lead.coluna === "entrada") lead.coluna = "atribuido"; }
        drawKanbanBoardByVendedor(document.getElementById("kanbanSearch")?.value.trim().toLowerCase() || "");
        try {
          await api(`/api/leads/${id}/vendedor`, { method: "PATCH", body: JSON.stringify({ vendedor_id: novoVendedorId }) });
          toast(vendedorNovo ? `Atribuído a ${vendedorNovo.nome}.` : "Lead voltou para pendentes.", "success");
        } catch (err) {
          Object.assign(lead, anterior);
          drawKanbanBoardByVendedor("");
          toast(`Não foi possível atribuir: ${err.message}. Verifique se a rota /api/leads/{id}/vendedor já foi publicada no backend.`, "error");
        }
      });
    });
  }

  async function openLeadDrawer(id) {
    const lead = state.leads.find((l) => l.id === id);
    if (!lead) return;
    const root = document.getElementById("drawerRoot");
    root.innerHTML = `
      <div class="drawer-overlay" id="drawerOverlay">
        <div class="drawer">
          <div class="drawer-head">
            <div>
              <div style="font-family:var(--font-display);font-weight:700;font-size:17px;">${esc(lead.nome || "Sem nome")}</div>
              <div class="mono dim" style="font-size:12.5px;margin-top:2px;">${esc(lead.whatsapp)}</div>
              <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;">
                <span class="badge b-gray">${esc(colLabel(lead.coluna))}</span>
                ${lead.veiculo ? `<span class="badge b-blue">${esc(lead.veiculo)}</span>` : ""}
                ${lead.forma_compra ? `<span class="badge b-amber">${esc(lead.forma_compra)}</span>` : ""}
              </div>
            </div>
            <button class="btn btn-ghost btn-sm" id="closeDrawer">Fechar</button>
          </div>
          ${lead.bot_ativo ? `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 20px; background:var(--amberbg); border-bottom:1px solid var(--border-soft);">
              <span style="font-size:12.5px; color:var(--amber2);">🤖 IA está atendendo este lead</span>
              <button class="btn btn-accent btn-sm" id="assumirLeadBtn">Assumir conversa</button>
            </div>
          ` : ""}
          <div class="drawer-body" id="drawerMsgs">
            <div class="skeleton" style="height:40px;"></div>
          </div>
        </div>
      </div>
    `;
    document.getElementById("closeDrawer").addEventListener("click", () => (root.innerHTML = ""));
    document.getElementById("drawerOverlay").addEventListener("click", (e) => {
      if (e.target.id === "drawerOverlay") root.innerHTML = "";
    });
    document.getElementById("assumirLeadBtn")?.addEventListener("click", async (e) => {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = "Assumindo...";
      try {
        await api(`/api/leads/${id}/assumir`, { method: "PATCH" });
        lead.bot_ativo = false;
        if (lead.coluna === "entrada") lead.coluna = "atribuido";
        toast("Conversa assumida — o bot parou de responder este lead.", "success");
        openLeadDrawer(id); // redesenha sem o banner
      } catch (err) {
        toast(`Não foi possível assumir: ${err.message}`, "error");
        btn.disabled = false;
        btn.textContent = "Assumir conversa";
      }
    });
    try {
      const msgs = await api(`/api/leads/${id}/mensagens`);
      const box = document.getElementById("drawerMsgs");
      box.innerHTML = msgs.length ? msgs.map((m) => `
        <div class="msg ${esc(m.de)}">
          <div class="h">${esc(m.de)} · ${fmtDateTime(m.hora)}</div>
          ${esc(m.conteudo)}
        </div>
      `).join("") : emptyState("Sem mensagens ainda");
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      document.getElementById("drawerMsgs").innerHTML = emptyState("Erro ao carregar conversa", e.message);
    }
  }

  // ---------------------------------------------------------------
  // AO VIVO (realtime — atendimentos já transferidos pro vendedor)
  // ---------------------------------------------------------------
  async function renderRealtime() {
    const el = document.getElementById("viewRealtime");
    el.innerHTML = `
      <div class="rt-wrap">
        <div class="rt-list" id="rtList"><div class="skeleton" style="height:80px;margin:10px;"></div></div>
        <div class="rt-chat">
          <div class="rt-chat-head" id="rtChatHead">Selecione um atendimento</div>
          <div class="rt-chat-body" id="rtChatBody">
            <div class="empty-state">Escolha um lead à esquerda para ver a conversa em tempo real.</div>
          </div>
        </div>
      </div>
    `;
    await loadLeads();
    drawRtList();
  }

  function drawRtList() {
    const list = document.getElementById("rtList");
    if (!list) return;
    // Atendimentos "ao vivo" = já saíram do bot e não estão perdidos —
    // ou seja, estão de fato em conversa ativa com um vendedor.
    const ativos = state.leads.filter((l) => !l.bot_ativo && l.coluna !== "perdido");
    if (!ativos.length) {
      list.innerHTML = emptyState("Nenhum atendimento ativo", "Assim que um lead for transferido para um vendedor, ele aparece aqui.");
      return;
    }
    list.innerHTML = ativos.map((l) => `
      <div class="rt-lead ${state.rtLeadId === l.id ? "active" : ""}" data-id="${l.id}">
        <div class="name">${esc(l.nome || "Sem nome")}</div>
        <div class="phone mono">${esc(l.whatsapp)}</div>
        <div class="when">${esc(l.vendedor || "sem vendedor")} · ${fmtDate(l.criado_em)}</div>
      </div>
    `).join("");
    list.querySelectorAll(".rt-lead").forEach((it) => {
      it.addEventListener("click", () => selectRtLead(Number(it.dataset.id)));
    });
  }

  async function selectRtLead(id) {
    state.rtLeadId = id;
    drawRtList();
    const lead = state.leads.find((l) => l.id === id);
    document.getElementById("rtChatHead").textContent = lead ? `${lead.nome || "Lead"} · ${lead.whatsapp}` : "Conversa";
    await drawRtMessages(id);
  }

  async function drawRtMessages(id) {
    const body = document.getElementById("rtChatBody");
    if (!body) return;
    try {
      const msgs = await api(`/api/leads/${id}/mensagens`);
      body.innerHTML = msgs.length ? msgs.map((m) => `
        <div class="msg ${esc(m.de)}">
          <div class="h">${esc(m.de)} · ${fmtDateTime(m.hora)}</div>
          ${esc(m.conteudo)}
        </div>
      `).join("") : emptyState("Sem mensagens ainda");
      body.scrollTop = body.scrollHeight;
    } catch (e) {
      body.innerHTML = emptyState("Erro ao carregar conversa", e.message);
    }
  }

  // ---------------------------------------------------------------
  // CONTATOS
  // ---------------------------------------------------------------
  async function renderContatos() {
    const el = document.getElementById("viewContatos");
    el.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <select id="filtroColuna">
            <option value="">Todas as etapas</option>
            ${COLUNAS.map((c) => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join("")}
          </select>
          <input type="search" id="filtroBusca" placeholder="Buscar nome ou WhatsApp...">
        </div>
        <button class="btn btn-accent" id="exportBtn">⭳ Exportar Excel</button>
      </div>
      <div class="table-wrap"><div style="padding:20px;"><div class="skeleton" style="height:220px;"></div></div></div>
    `;
    document.getElementById("exportBtn").addEventListener("click", () => {
      const qs = state.lojaAtual ? `?loja_id=${encodeURIComponent(state.lojaAtual)}` : "";
      window.open(`${CONFIG.API_URL}/api/leads/exportar${qs}`, "_blank");
    });
    document.getElementById("filtroColuna").addEventListener("change", drawContatosTable);
    document.getElementById("filtroBusca").addEventListener("input", drawContatosTable);
    await loadLeads();
    drawContatosTable();
  }

  function drawContatosTable() {
    const wrap = document.querySelector("#viewContatos .table-wrap");
    if (!wrap) return;
    const coluna = document.getElementById("filtroColuna").value;
    const busca = document.getElementById("filtroBusca").value.trim().toLowerCase();
    const rows = state.leads.filter((l) =>
      (!coluna || l.coluna === coluna) &&
      (!busca || (l.nome || "").toLowerCase().includes(busca) || (l.whatsapp || "").includes(busca))
    );
    if (!rows.length) {
      wrap.innerHTML = emptyState("Nenhum lead encontrado", "Ajuste os filtros ou aguarde novos contatos chegarem.");
      return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr>
          <th>Nome</th><th>WhatsApp</th><th>CPF</th><th>Canal</th><th>Etapa</th><th>Vendedor</th><th>Veículo</th><th>Forma</th><th>Modalidade</th><th>Criado</th>
        </tr></thead>
        <tbody>
          ${rows.map((l) => `
            <tr data-id="${l.id}">
              <td>${esc(l.nome || "—")}</td>
              <td class="mono">${esc(l.whatsapp)}</td>
              <td class="mono">${esc(l.cpf || "—")}</td>
              <td>${esc(l.canal || "—")}</td>
              <td>${badgeForColuna(l.coluna)}</td>
              <td>${esc(l.vendedor || "—")}</td>
              <td>${esc(l.veiculo || "—")}</td>
              <td>${esc(l.forma_compra || "—")}</td>
              <td>${esc(l.modalidade || "—")}</td>
              <td class="dim">${fmtDate(l.criado_em)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    wrap.querySelectorAll("tbody tr").forEach((tr) => {
      tr.addEventListener("click", () => openLeadDrawer(Number(tr.dataset.id)));
    });
  }

  function badgeForColuna(id) {
    const map = { fechado: "b-green", perdido: "b-red", atribuido: "b-blue" };
    return `<span class="badge ${map[id] || "b-gray"}">${esc(colLabel(id))}</span>`;
  }

  // ---------------------------------------------------------------
  // AGENDAMENTOS
  // ---------------------------------------------------------------
  async function renderAgendamentos() {
    const el = document.getElementById("viewAgendamentos");
    el.innerHTML = `
      <div class="two-col" style="grid-template-columns:1fr 320px;">
        <div>
          <div class="agenda-list" id="agendaList"><div class="skeleton" style="height:80px;"></div></div>
        </div>
        <div class="card">
          <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:14px;">Novo agendamento</div>
          <form id="agendaForm" style="display:flex;flex-direction:column;gap:12px;">
            <div class="field"><label>Nome do cliente</label><input name="nome" required></div>
            <div class="field"><label>WhatsApp</label><input name="whatsapp" placeholder="55219..." required></div>
            <div class="field"><label>Data e hora</label><input name="data_hora" type="datetime-local" required></div>
            <div class="field"><label>Tipo</label>
              <select name="tipo"><option value="visita">Visita</option><option value="test-ride">Test-ride</option><option value="entrega">Entrega</option></select>
            </div>
            <div class="field"><label>Observação</label><textarea name="observacao" placeholder="Opcional"></textarea></div>
            <button class="btn btn-accent" type="submit">Agendar</button>
          </form>
        </div>
      </div>
    `;
    document.getElementById("agendaForm").addEventListener("submit", onCreateAgendamento);
    await loadAgendamentos();
  }

  async function loadAgendamentos() {
    const list = document.getElementById("agendaList");
    try {
      const qs = state.lojaAtual ? `?loja_id=${encodeURIComponent(state.lojaAtual)}` : "";
      state.agendamentos = await api(`/api/agendamentos${qs}`);
      drawAgendaList();
    } catch (e) {
      list.innerHTML = emptyState("Erro ao carregar agendamentos", e.message);
    }
  }

  function drawAgendaList() {
    const list = document.getElementById("agendaList");
    if (!list) return;
    if (!state.agendamentos.length) {
      list.innerHTML = emptyState("Nenhum agendamento", "Crie o primeiro usando o formulário ao lado.");
      return;
    }
    list.innerHTML = state.agendamentos.map((a) => {
      const d = a.data_hora ? new Date(a.data_hora) : null;
      return `
        <div class="agenda-item">
          <div class="agenda-date">
            <div class="d">${d ? d.getDate() : "—"}</div>
            <div class="m">${d ? d.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "") : ""}</div>
          </div>
          <div class="agenda-info">
            <div class="t">${esc(a.nome)}</div>
            <div class="s mono">${esc(a.whatsapp)} · ${esc(a.tipo)}</div>
          </div>
          <div class="agenda-time">${d ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}</div>
        </div>
      `;
    }).join("");
  }

  async function onCreateAgendamento(e) {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const body = {
      nome: fd.get("nome"),
      whatsapp: fd.get("whatsapp"),
      loja_id: state.lojaAtual || (state.lojas[0] && state.lojas[0].id),
      data_hora: fd.get("data_hora"),
      tipo: fd.get("tipo"),
      observacao: fd.get("observacao"),
      origem: "manual",
    };
    if (!body.loja_id) {
      toast("Selecione uma loja específica antes de agendar.", "error");
      return;
    }
    try {
      await api("/api/agendamentos", { method: "POST", body: JSON.stringify(body) });
      toast("Agendamento criado com sucesso.", "success");
      form.reset();
      await loadAgendamentos();
    } catch (err) {
      toast(`Erro ao agendar: ${err.message}`, "error");
    }
  }

  // ---------------------------------------------------------------
  // MÉTRICAS (detalhada)
  // ---------------------------------------------------------------
  async function renderMetricas() {
    const el = document.getElementById("viewMetricas");
    el.innerHTML = `
      <div class="toolbar">
        <div class="toolbar-left">
          <select id="periodoSel">
            <option value="7">Últimos 7 dias</option>
            <option value="30" selected>Últimos 30 dias</option>
            <option value="90">Últimos 90 dias</option>
          </select>
        </div>
      </div>
      <div id="metricasBody"><div class="skeleton" style="height:260px;"></div></div>
    `;
    document.getElementById("periodoSel").addEventListener("change", loadMetricasDetalhe);
    await loadMetricasDetalhe();
  }

  async function loadMetricasDetalhe() {
    const dias = document.getElementById("periodoSel").value;
    const body = document.getElementById("metricasBody");
    try {
      const qs = new URLSearchParams({ dias });
      if (state.lojaAtual) qs.set("loja_id", state.lojaAtual);
      const [m] = await Promise.all([api(`/api/metricas?${qs.toString()}`), loadLeads(), loadVendedores()]);
      body.innerHTML = buildDashboardHTML(m, "met");
      renderCharts(m, "met");
    } catch (e) {
      body.innerHTML = emptyState("Erro ao carregar métricas", e.message);
    }
  }

  // ---------------------------------------------------------------
  // EQUIPE
  // ---------------------------------------------------------------
  async function renderEquipe() {
    const el = document.getElementById("viewEquipe");
    el.innerHTML = `
      <div class="two-col" style="grid-template-columns:1fr 300px;">
        <div class="team-grid" id="teamGrid"><div class="skeleton" style="height:100px;"></div></div>
        <div class="card">
          <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:14px;">Adicionar vendedor</div>
          <form id="vendedorForm" style="display:flex;flex-direction:column;gap:12px;">
            <div class="field"><label>Nome</label><input name="nome" required></div>
            <div class="field"><label>WhatsApp</label><input name="whatsapp" placeholder="55219..." required></div>
            ${state.lojas.length > 1 ? `
              <div class="field"><label>Loja</label>
                <select name="loja_id">${state.lojas.map((l) => `<option value="${esc(l.id)}">${esc(l.nome)}</option>`).join("")}</select>
              </div>` : ""}
            <button class="btn btn-accent" type="submit">Adicionar</button>
          </form>
        </div>
      </div>
    `;
    document.getElementById("vendedorForm").addEventListener("submit", onCreateVendedor);
    await loadVendedores();
  }

  async function loadVendedores() {
    const grid = document.getElementById("teamGrid");
    try {
      const qs = state.lojaAtual ? `?loja_id=${encodeURIComponent(state.lojaAtual)}` : "";
      state.vendedores = await api(`/api/vendedores${qs}`);
      drawTeamGrid();
    } catch (e) {
      grid.innerHTML = emptyState("Erro ao carregar equipe", e.message);
    }
  }

  function drawTeamGrid() {
    const grid = document.getElementById("teamGrid");
    if (!grid) return;
    if (!state.vendedores.length) {
      grid.innerHTML = emptyState("Nenhum vendedor cadastrado", "Adicione o primeiro usando o formulário ao lado.");
      return;
    }
    grid.innerHTML = state.vendedores.map((v) => `
      <div class="team-card">
        <div class="avatar">${esc((v.nome || "?").slice(0, 1).toUpperCase())}</div>
        <div>
          <div class="name">${esc(v.nome)}</div>
          <div class="phone mono">${esc(v.whatsapp)}</div>
        </div>
        <button class="btn btn-danger btn-sm" data-id="${v.id}">Remover</button>
      </div>
    `).join("");
    grid.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", () => onRemoveVendedor(Number(btn.dataset.id)));
    });
  }

  async function onCreateVendedor(e) {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const loja_id = fd.get("loja_id") || state.lojaAtual || (state.lojas[0] && state.lojas[0].id);
    if (!loja_id) {
      toast("Selecione uma loja para o vendedor.", "error");
      return;
    }
    try {
      await api("/api/vendedores", { method: "POST", body: JSON.stringify({ nome: fd.get("nome"), whatsapp: fd.get("whatsapp"), loja_id }) });
      toast("Vendedor adicionado.", "success");
      form.reset();
      await loadVendedores();
    } catch (err) {
      toast(`Erro ao adicionar: ${err.message}`, "error");
    }
  }

  async function onRemoveVendedor(id) {
    confirmModal("Remover vendedor?", "Ele deixará de receber novos leads.", async () => {
      try {
        await api(`/api/vendedores/${id}`, { method: "DELETE" });
        toast("Vendedor removido.", "success");
        await loadVendedores();
      } catch (err) {
        toast(`Erro ao remover: ${err.message}`, "error");
      }
    });
  }

  // ---------------------------------------------------------------
  // CONFIG (Meta API + Evolution)
  // ---------------------------------------------------------------
  async function renderConfig() {
    const el = document.getElementById("viewConfig");
    const webhookMeta = `${CONFIG.API_URL}/webhook/meta`;
    const webhookEvo = `${CONFIG.API_URL}/webhook/evolution`;
    el.innerHTML = `
      <div class="card" style="margin-bottom:16px;">
        <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:14px;">Passo a passo — Meta Business Suite</div>
        <ol class="step-list">
          <li>No Meta Business Suite, abra <strong>WhatsApp &gt; Configuração da API &gt; Webhooks</strong>.</li>
          <li>Informe a URL de callback:
            <div class="copyable" style="margin-top:6px;">${esc(webhookMeta)}<button class="btn btn-ghost btn-sm" data-copy="${esc(webhookMeta)}">Copiar</button></div>
          </li>
          <li>Informe o token de verificação:
            <div class="copyable" style="margin-top:6px;">crm_verify_token<button class="btn btn-ghost btn-sm" data-copy="crm_verify_token">Copiar</button></div>
          </li>
          <li>Assine o campo <strong>messages</strong> e salve.</li>
          <li>Preencha abaixo o <em>Phone Number ID</em>, o <em>WABA ID</em> e o token de acesso de cada loja.</li>
        </ol>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:14px;">Webhook Evolution API</div>
        <div class="copyable">${esc(webhookEvo)}<button class="btn btn-ghost btn-sm" data-copy="${esc(webhookEvo)}">Copiar</button></div>
        <div class="dim" style="font-size:12.5px;margin-top:10px;">Configure este endpoint como webhook global (ou por instância) na sua Evolution API para monitorar as respostas dos vendedores em tempo real.</div>
      </div>

      <div class="card" style="margin-bottom:16px;">
        <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:4px;">Lojas do grupo</div>
        <div class="dim" style="font-size:12.5px;margin-bottom:14px;">Cadastre rapidamente as lojas que ainda não existem no banco. As já cadastradas aparecem com um selo verde.</div>
        <div id="lojasConhecidasGrid" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
      </div>

      <div class="config-grid" id="configGrid"><div class="skeleton" style="height:220px;"></div></div>
    `;

    el.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(btn.dataset.copy);
        toast("Copiado.", "success");
      });
    });

    drawLojasConhecidas();
    drawConfigGrid();
  }

  function drawLojasConhecidas() {
    const box = document.getElementById("lojasConhecidasGrid");
    if (!box) return;
    box.innerHTML = LOJAS_CONHECIDAS.map((lc) => {
      const existente = state.lojas.find((l) => l.id === lc.id);
      return existente
        ? `<span class="badge b-green">✓ ${esc(lc.nome)}</span>`
        : `<button class="btn btn-sm" data-criar-loja="${esc(lc.id)}" data-nome-loja="${esc(lc.nome)}">+ ${esc(lc.nome)}</button>`;
    }).join("");
    box.querySelectorAll("[data-criar-loja]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Criando...";
        try {
          await api("/api/lojas", { method: "POST", body: JSON.stringify({ id: btn.dataset.criarLoja, nome: btn.dataset.nomeLoja }) });
          state.lojas = await api("/api/lojas");
          toast(`${btn.dataset.nomeLoja} cadastrada.`, "success");
          renderLojaSwitch();
          drawLojasConhecidas();
          drawConfigGrid();
        } catch (err) {
          toast(`Erro ao criar loja: ${err.message}`, "error");
          btn.disabled = false;
          btn.textContent = `+ ${btn.dataset.nomeLoja}`;
        }
      });
    });
  }

  function drawConfigGrid() {
    const grid = document.getElementById("configGrid");
    if (!grid) return;
    if (!state.lojas.length) {
      grid.innerHTML = emptyState("Nenhuma loja cadastrada");
      return;
    }
    grid.innerHTML = state.lojas.map((l) => `
      <div class="card">
        <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:14px;">${esc(l.nome)}</div>

        <button class="btn btn-accent" style="width:100%;justify-content:center;margin-bottom:16px;" data-embedded-loja="${esc(l.id)}">
          ⚡ Conectar automaticamente (recomendado)
        </button>
        <div class="faint" style="font-size:11.5px;margin:-10px 0 16px;">Abre um popup oficial da Meta — preenche os campos abaixo sozinho.</div>

        <form class="meta-form" data-loja="${esc(l.id)}" style="display:flex;flex-direction:column;gap:10px;">
          <div class="field"><label>Phone Number ID</label><input name="phone_id" value="${esc(l.meta_phone_id || "")}"></div>
          <div class="field"><label>WABA ID</label><input name="waba_id" value="${esc(l.meta_waba_id || "")}"></div>
          <div class="field"><label>Token de acesso</label><input name="token" type="password" placeholder="Deixe em branco para manter"></div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-sm" type="submit" style="flex:1;">Salvar manualmente</button>
            <button class="btn btn-ghost btn-sm" type="button" data-testar-loja="${esc(l.id)}">🔗 Testar</button>
          </div>
          <div class="test-result" data-result-loja="${esc(l.id)}" style="font-size:12px;display:none;"></div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text-dim);margin-top:4px;cursor:pointer;">
            <input type="checkbox" data-monitorar-loja="${esc(l.id)}" ${l.apenas_monitorar ? "checked" : ""}>
            Somente monitorar (não responder — usar quando outro sistema já atende esse número)
          </label>
        </form>
        <div class="nav-sep"></div>
        <form class="evo-form" data-loja="${esc(l.id)}" style="display:flex;flex-direction:column;gap:10px;">
          <div class="field"><label>Instância Evolution</label><input name="instance" value="${esc(l.evolution_instance || "")}"></div>
          <button class="btn btn-sm" type="submit">Salvar Evolution</button>
        </form>
      </div>
    `).join("");

    grid.querySelectorAll("[data-embedded-loja]").forEach((btn) => {
      btn.addEventListener("click", () => startEmbeddedSignup(btn.dataset.embeddedLoja, btn));
    });

    grid.querySelectorAll("[data-testar-loja]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const lojaId = btn.dataset.testarLoja;
        const resultEl = grid.querySelector(`[data-result-loja="${lojaId}"]`);
        btn.disabled = true;
        btn.textContent = "Testando...";
        resultEl.style.display = "block";
        resultEl.className = "test-result";
        resultEl.textContent = "Verificando conexão...";
        try {
          const r = await api(`/api/lojas/${lojaId}/meta/testar`);
          if (r.ok) {
            resultEl.className = "test-result ok";
            resultEl.textContent = `✅ Conectado: ${r.nome || "número válido"} (${r.numero || ""})`;
          } else {
            resultEl.className = "test-result err";
            resultEl.textContent = `❌ ${r.detail || "Falha na conexão"}`;
          }
        } catch (err) {
          resultEl.className = "test-result err";
          resultEl.textContent = `❌ ${err.message}`;
        } finally {
          btn.disabled = false;
          btn.textContent = "🔗 Testar";
        }
      });
    });
    grid.querySelectorAll("[data-monitorar-loja]").forEach((chk) => {
      chk.addEventListener("change", async () => {
        const lojaId = chk.dataset.monitorarLoja;
        try {
          await api(`/api/lojas/${lojaId}/monitoramento`, {
            method: "PATCH",
            body: JSON.stringify({ apenas_monitorar: chk.checked }),
          });
          toast(chk.checked ? "Modo monitoramento ativado — o bot não vai responder por essa loja." : "Modo monitoramento desativado.", "success");
        } catch (err) {
          chk.checked = !chk.checked; // reverte se der erro
          toast(`Erro ao salvar: ${err.message}`, "error");
        }
      });
    });

    grid.querySelectorAll(".meta-form").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = { phone_id: fd.get("phone_id"), waba_id: fd.get("waba_id") };
        if (fd.get("token")) body.token = fd.get("token");
        try {
          await api(`/api/lojas/${form.dataset.loja}/meta`, { method: "PATCH", body: JSON.stringify(body) });
          toast("Configuração Meta salva.", "success");
        } catch (err) {
          toast(`Erro: ${err.message}`, "error");
        }
      });
    });
    grid.querySelectorAll(".evo-form").forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
          await api(`/api/lojas/${form.dataset.loja}/evolution`, { method: "PATCH", body: JSON.stringify({ instance: fd.get("instance") }) });
          toast("Instância Evolution salva.", "success");
        } catch (err) {
          toast(`Erro: ${err.message}`, "error");
        }
      });
    });
  }

  // ---------------------------------------------------------------
  // CAMPANHAS (remarketing em massa, inspirado no fluxo do AutoLead)
  // ---------------------------------------------------------------
  async function renderCampanhas() {
    const el = document.getElementById("viewCampanhas");
    el.innerHTML = `
      <div class="two-col" style="grid-template-columns:1.3fr 1fr;">
        <div>
          <div class="toolbar">
            <div class="toolbar-left">
              <select id="campFiltroColuna">
                <option value="">Todas as etapas</option>
                ${COLUNAS.map((c) => `<option value="${c.id}">${c.icon} ${c.label}</option>`).join("")}
              </select>
              <input type="search" id="campBusca" placeholder="Buscar nome ou WhatsApp...">
            </div>
            <div style="display:flex;gap:8px;">
              <button class="btn btn-sm" id="campMarcarTudo">Marcar todos</button>
              <button class="btn btn-sm" id="campLimpar">Limpar seleção</button>
            </div>
          </div>
          <div class="table-wrap"><div id="campTableBody"><div class="skeleton" style="height:220px;"></div></div></div>
        </div>

        <div class="card">
          <div style="font-family:var(--font-display);font-weight:700;font-size:15px;margin-bottom:4px;">Nova campanha</div>
          <div class="dim" style="font-size:12px;margin-bottom:16px;"><span id="campContagem">0</span> leads selecionados</div>
          <div style="display:flex;flex-direction:column;gap:12px;">
            <div class="field">
              <label>Mensagem</label>
              <textarea id="campMensagem" rows="5" placeholder="Oi {nome}! Vimos que você ainda não finalizou..."></textarea>
            </div>
            <div class="faint" style="font-size:11.5px;margin-top:-6px;">Use <code>{nome}</code> pra personalizar automaticamente com o nome de cada lead.</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div class="field"><label>Intervalo mín. (seg)</label><input type="number" id="campIntervaloMin" value="20" min="5"></div>
              <div class="field"><label>Intervalo máx. (seg)</label><input type="number" id="campIntervaloMax" value="60" min="10"></div>
            </div>
            <div class="faint" style="font-size:11.5px;">O envio espera um tempo aleatório entre esse mínimo e máximo pra cada lead, evitando bloqueio por spam.</div>
            <button class="btn btn-accent" id="campDisparar" style="justify-content:center;">🚀 Disparar campanha</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById("campFiltroColuna").addEventListener("change", drawCampanhaTable);
    document.getElementById("campBusca").addEventListener("input", drawCampanhaTable);
    document.getElementById("campMarcarTudo").addEventListener("click", () => {
      camposFiltradosAtuais().forEach((l) => state.campanhaSelecionados.add(l.id));
      drawCampanhaTable();
    });
    document.getElementById("campLimpar").addEventListener("click", () => {
      state.campanhaSelecionados.clear();
      drawCampanhaTable();
    });
    document.getElementById("campDisparar").addEventListener("click", onDispararCampanha);
    await loadLeads();
    drawCampanhaTable();
  }

  function camposFiltradosAtuais() {
    const coluna = document.getElementById("campFiltroColuna")?.value || "";
    const busca = (document.getElementById("campBusca")?.value || "").trim().toLowerCase();
    return state.leads.filter((l) =>
      (!coluna || l.coluna === coluna) &&
      (!busca || (l.nome || "").toLowerCase().includes(busca) || (l.whatsapp || "").includes(busca))
    );
  }

  function drawCampanhaTable() {
    const wrap = document.getElementById("campTableBody");
    if (!wrap) return;
    const rows = camposFiltradosAtuais();
    document.getElementById("campContagem").textContent = state.campanhaSelecionados.size;
    if (!rows.length) {
      wrap.innerHTML = emptyState("Nenhum lead encontrado", "Ajuste os filtros.");
      return;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th style="width:36px;"></th><th>Nome</th><th>WhatsApp</th><th>Etapa</th></tr></thead>
        <tbody>
          ${rows.map((l) => `
            <tr data-id="${l.id}" style="cursor:pointer;">
              <td><input type="checkbox" class="campCheck" data-id="${l.id}" ${state.campanhaSelecionados.has(l.id) ? "checked" : ""}></td>
              <td>${esc(l.nome || "—")}</td>
              <td class="mono">${esc(l.whatsapp)}</td>
              <td>${badgeForColuna(l.coluna)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    wrap.querySelectorAll(".campCheck").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = Number(cb.dataset.id);
        if (cb.checked) state.campanhaSelecionados.add(id);
        else state.campanhaSelecionados.delete(id);
        document.getElementById("campContagem").textContent = state.campanhaSelecionados.size;
      });
    });
    wrap.querySelectorAll("tbody tr").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.classList.contains("campCheck")) return;
        const cb = tr.querySelector(".campCheck");
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change"));
      });
    });
  }

  async function onDispararCampanha() {
    const mensagem = document.getElementById("campMensagem").value.trim();
    const intervaloMin = Number(document.getElementById("campIntervaloMin").value) || 20;
    const intervaloMax = Number(document.getElementById("campIntervaloMax").value) || 60;
    const leadIds = Array.from(state.campanhaSelecionados);
    if (!leadIds.length) { toast("Selecione pelo menos um lead.", "error"); return; }
    if (!mensagem) { toast("Escreva a mensagem da campanha.", "error"); return; }
    if (intervaloMax < intervaloMin) { toast("Intervalo máximo precisa ser maior que o mínimo.", "error"); return; }

    const btn = document.getElementById("campDisparar");
    btn.disabled = true;
    btn.textContent = "Disparando...";
    try {
      const resp = await api("/api/campanhas/disparar", {
        method: "POST",
        body: JSON.stringify({ lead_ids: leadIds, mensagem, intervalo_min: intervaloMin, intervalo_max: intervaloMax }),
      });
      toast(`Campanha disparada para ${resp.total} leads. Os envios vão acontecer aos poucos, com intervalo entre eles.`, "success");
      state.campanhaSelecionados.clear();
      drawCampanhaTable();
    } catch (err) {
      toast(`Erro ao disparar campanha: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "🚀 Disparar campanha";
    }
  }

  // ---------------------------------------------------------------
  // Embedded Signup — fluxo "conectar com 2 cliques" oficial da Meta
  // ---------------------------------------------------------------
  let embeddedSignupData = null; // guarda phone_number_id/waba_id vindos do postMessage, até o FB.login resolver

  function ensureEmbeddedListener() {
    if (window.__embeddedListenerSet__) return;
    window.__embeddedListenerSet__ = true;
    window.addEventListener("message", (event) => {
      if (!event.origin.endsWith("facebook.com")) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === "WA_EMBEDDED_SIGNUP" && data.event === "FINISH") {
          embeddedSignupData = {
            phone_number_id: data.data?.phone_number_id,
            waba_id: data.data?.waba_id,
          };
        }
      } catch (_) { /* mensagens de outras origens do FB que não são JSON — ignora */ }
    });
  }

  async function startEmbeddedSignup(lojaId, btnEl) {
    ensureEmbeddedListener();

    if (!CONFIG.META_APP_ID || !CONFIG.META_CONFIG_ID) {
      toast("Preencha META_APP_ID e META_CONFIG_ID em js/config.js primeiro (depois que o App da Meta for aprovado).", "error");
      return;
    }
    if (typeof FB === "undefined") {
      toast("SDK da Meta ainda carregando, tenta de novo em 2 segundos.", "error");
      return;
    }

    embeddedSignupData = null;
    const originalText = btnEl.textContent;
    btnEl.disabled = true;
    btnEl.textContent = "Abrindo popup da Meta...";

    FB.login((response) => {
      btnEl.disabled = false;
      btnEl.textContent = originalText;

      if (response.authResponse && response.authResponse.code) {
        const code = response.authResponse.code;
        finishEmbeddedSignup(lojaId, code);
      } else {
        toast("Login cancelado ou não concluído no popup da Meta.", "error");
      }
    }, {
      config_id: CONFIG.META_CONFIG_ID,
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
    });
  }

  async function finishEmbeddedSignup(lojaId, code) {
    toast("Concluindo conexão automática...", "");
    try {
      await api(`/api/lojas/${lojaId}/meta/embedded`, {
        method: "POST",
        body: JSON.stringify({
          code,
          phone_number_id: embeddedSignupData?.phone_number_id || null,
          waba_id: embeddedSignupData?.waba_id || null,
        }),
      });
      toast("WhatsApp conectado automaticamente! ✅", "success");
      state.lojas = await api("/api/lojas");
      drawConfigGrid();
    } catch (err) {
      toast(`Erro ao finalizar conexão: ${err.message}`, "error");
    }
  }

  // ---------------------------------------------------------------
  // Confirm modal
  // ---------------------------------------------------------------
  function confirmModal(title, body, onConfirm) {
    const root = document.getElementById("modalRoot");
    root.innerHTML = `
      <div class="modal-overlay" id="modalOverlay">
        <div class="modal">
          <h3>${esc(title)}</h3>
          <div class="dim" style="font-size:13.5px;">${esc(body)}</div>
          <div class="modal-actions">
            <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
            <button class="btn btn-danger" id="modalConfirm">Confirmar</button>
          </div>
        </div>
      </div>
    `;
    const close = () => (root.innerHTML = "");
    document.getElementById("modalCancel").addEventListener("click", close);
    document.getElementById("modalOverlay").addEventListener("click", (e) => { if (e.target.id === "modalOverlay") close(); });
    document.getElementById("modalConfirm").addEventListener("click", () => { close(); onConfirm(); });
  }

  // ---------------------------------------------------------------
  // WebSocket (real-time)
  // ---------------------------------------------------------------
  function connectWS() {
    try {
      state.ws = new WebSocket(CONFIG.WS_URL);
    } catch (e) {
      return scheduleReconnect();
    }
    const dot = document.getElementById("liveDot");
    const label = document.getElementById("liveLabel");

    state.ws.onopen = () => {
      dot.classList.remove("off"); dot.classList.add("on");
      label.textContent = "ao vivo";
      state.wsRetryMs = 2000;
    };
    state.ws.onclose = () => {
      dot.classList.remove("on"); dot.classList.add("off");
      label.textContent = "reconectando";
      scheduleReconnect();
    };
    state.ws.onerror = () => state.ws.close();
    state.ws.onmessage = (evt) => {
      let data;
      try { data = JSON.parse(evt.data); } catch (_) { return; }
      if (["novo_lead", "nova_mensagem", "novo_agendamento"].includes(data.tipo)) {
        if (state.view === "kanban") { Promise.all([loadLeads(), loadVendedores()]).then(() => drawKanban("")); }
        if (state.view === "dashboard") renderDashboard();
        if (state.view === "contatos") { loadLeads().then(drawContatosTable); }
        if (state.view === "realtime") {
          loadLeads().then(() => {
            drawRtList();
            if (data.tipo === "nova_mensagem" && Number(data.lead_id) === state.rtLeadId) {
              drawRtMessages(state.rtLeadId);
            }
          });
        }
        if (data.tipo === "novo_agendamento" && state.view === "agendamentos") loadAgendamentos();
      }
    };
  }

  function scheduleReconnect() {
    setTimeout(connectWS, state.wsRetryMs);
    state.wsRetryMs = Math.min(state.wsRetryMs * 1.5, 30000);
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  async function init() {
    initChrome();
    try {
      state.lojas = await api("/api/lojas");
    } catch (e) {
      toast("Não foi possível carregar as lojas. Verifique a conexão com o backend.", "error");
      state.lojas = [];
    }
    renderLojaSwitch();
    setView("dashboard");
    connectWS();
  }

  init();
})();

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from datetime import datetime, timedelta
import json, os, httpx

from models.database import Base, engine, get_db, Lead, Mensagem, Vendedor, Loja, Agendamento, Usuario
from services.bot_service import processar_mensagem_bot, notificar_vendedor, enviar_whatsapp

Base.metadata.create_all(bind=engine)

app = FastAPI(title="CRM Leads API", version="1.0.0")

app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# WebSocket manager para tempo real
class ConnectionManager:
    def __init__(self):
        self.connections: list[WebSocket] = []
    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.connections.append(ws)
    def disconnect(self, ws: WebSocket):
        self.connections.remove(ws)
    async def broadcast(self, data: dict):
        for ws in self.connections:
            try:
                await ws.send_json(data)
            except:
                pass

manager = ConnectionManager()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# ─── WEBHOOK META ───────────────────────────────────────────────
@app.get("/webhook/meta")
async def meta_verify(request: Request):
    params = dict(request.query_params)
    verify_token = os.environ.get("META_VERIFY_TOKEN", "crm_verify_token")
    if params.get("hub.verify_token") == verify_token:
        return int(params.get("hub.challenge", 0))
    raise HTTPException(status_code=403, detail="Token inválido")

@app.post("/webhook/meta")
async def meta_webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    try:
        entry = body.get("entry", [])[0]
        changes = entry.get("changes", [])[0]
        value = changes.get("value", {})
        messages = value.get("messages", [])

        for msg in messages:
            phone = msg.get("from")
            text = msg.get("text", {}).get("body", "")
            waba_id = value.get("metadata", {}).get("phone_number_id")

            loja = db.query(Loja).filter(Loja.meta_phone_id == waba_id).first()
            if not loja:
                continue

            lead = db.query(Lead).filter(Lead.whatsapp == phone, Lead.loja_id == loja.id).first()
            if not lead:
                lead = Lead(whatsapp=phone, loja_id=loja.id, bot_ativo=True, bot_etapa=0, coluna="entrada")
                db.add(lead)
                db.commit()
                db.refresh(lead)
                # Envia boas-vindas
                from services.bot_service import FLUXO
                boas_vindas = f"Olá! 😊 Que bom ter você na *{loja.nome}*!\n\n" + FLUXO[0]["mensagem"]
                await enviar_whatsapp(loja.meta_phone_id, loja.meta_token, phone, boas_vindas)

            msg_obj = Mensagem(lead_id=lead.id, de="cliente", conteudo=text, origem="whatsapp")
            db.add(msg_obj)
            db.commit()

            resultado = await processar_mensagem_bot(lead, text, db, loja)

            if resultado:
                if resultado.get("resposta"):
                    await enviar_whatsapp(loja.meta_phone_id, loja.meta_token, phone, resultado["resposta"])
                    msg_bot = Mensagem(lead_id=lead.id, de="bot", conteudo=resultado["resposta"], origem="bot")
                    db.add(msg_bot)
                    db.commit()

                if resultado.get("transferir"):
                    vendedores = db.query(Vendedor).filter(Vendedor.loja_id == loja.id, Vendedor.ativo == True).all()
                    if vendedores:
                        import random
                        vendedor = random.choice(vendedores)
                        lead.vendedor_id = vendedor.id
                        db.commit()
                        evolution_url = os.environ.get("EVOLUTION_URL", "")
                        evolution_key = os.environ.get("EVOLUTION_KEY", "")
                        await notificar_vendedor(vendedor, lead, evolution_url, evolution_key)

            await manager.broadcast({"tipo": "novo_lead", "lead_id": lead.id, "loja": loja.id, "coluna": lead.coluna})

    except Exception as e:
        print(f"Erro no webhook Meta: {e}")
    return {"status": "ok"}

# ─── WEBHOOK EVOLUTION (monitorar conversas do vendedor) ────────
@app.post("/webhook/evolution")
async def evolution_webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    try:
        event = body.get("event")
        data = body.get("data", {})

        if event in ["messages.upsert", "messages.update"]:
            phone = data.get("key", {}).get("remoteJid", "").replace("@s.whatsapp.net", "")
            text = data.get("message", {}).get("conversation", "") or \
                   data.get("message", {}).get("extendedTextMessage", {}).get("text", "")
            de_mim = data.get("key", {}).get("fromMe", False)

            lead = db.query(Lead).filter(Lead.whatsapp == phone, Lead.bot_ativo == False).first()
            if lead:
                remetente = "vendedor" if de_mim else "cliente"
                msg = Mensagem(lead_id=lead.id, de=remetente, conteudo=text, origem="evolution")
                db.add(msg)
                db.commit()
                await manager.broadcast({
                    "tipo": "nova_mensagem",
                    "lead_id": lead.id,
                    "de": remetente,
                    "texto": text,
                    "hora": datetime.utcnow().isoformat()
                })

    except Exception as e:
        print(f"Erro no webhook Evolution: {e}")
    return {"status": "ok"}

# ─── LEADS ──────────────────────────────────────────────────────
@app.get("/api/leads")
def listar_leads(loja_id: str = None, coluna: str = None, db: Session = Depends(get_db)):
    q = db.query(Lead)
    if loja_id:
        q = q.filter(Lead.loja_id == loja_id)
    if coluna:
        q = q.filter(Lead.coluna == coluna)
    return [{"id": l.id, "nome": l.nome, "whatsapp": l.whatsapp, "canal": l.canal,
             "coluna": l.coluna, "status": l.status, "loja_id": l.loja_id,
             "vendedor": l.vendedor.nome if l.vendedor else None,
             "veiculo": l.veiculo_interesse, "forma_compra": l.forma_compra,
             "criado_em": l.criado_em.isoformat() if l.criado_em else None,
             "bot_ativo": l.bot_ativo} for l in q.order_by(Lead.criado_em.desc()).all()]

@app.patch("/api/leads/{lead_id}/coluna")
def mover_lead(lead_id: int, body: dict, db: Session = Depends(get_db)):
    lead = db.query(Lead).filter(Lead.id == lead_id).first()
    if not lead:
        raise HTTPException(404)
    lead.coluna = body.get("coluna")
    db.commit()
    return {"ok": True}

@app.get("/api/leads/{lead_id}/mensagens")
def mensagens_lead(lead_id: int, db: Session = Depends(get_db)):
    msgs = db.query(Mensagem).filter(Mensagem.lead_id == lead_id).order_by(Mensagem.criado_em).all()
    return [{"id": m.id, "de": m.de, "conteudo": m.conteudo, "hora": m.criado_em.isoformat()} for m in msgs]

@app.get("/api/leads/exportar")
def exportar_leads(loja_id: str = None, db: Session = Depends(get_db)):
    from fastapi.responses import StreamingResponse
    import openpyxl, io
    q = db.query(Lead)
    if loja_id:
        q = q.filter(Lead.loja_id == loja_id)
    leads = q.all()
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(["ID","Nome","WhatsApp","Canal","Loja","Coluna","Status","Vendedor","Veículo","Forma Compra","CPF","Criado em"])
    for l in leads:
        ws.append([l.id, l.nome, l.whatsapp, l.canal, l.loja_id, l.coluna, l.status,
                   l.vendedor.nome if l.vendedor else "", l.veiculo_interesse,
                   l.forma_compra, l.cpf, str(l.criado_em)])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": "attachment; filename=leads.xlsx"})

# ─── VENDEDORES ─────────────────────────────────────────────────
@app.get("/api/vendedores")
def listar_vendedores(loja_id: str = None, db: Session = Depends(get_db)):
    q = db.query(Vendedor).filter(Vendedor.ativo == True)
    if loja_id:
        q = q.filter(Vendedor.loja_id == loja_id)
    return [{"id": v.id, "nome": v.nome, "whatsapp": v.whatsapp, "loja_id": v.loja_id} for v in q.all()]

@app.post("/api/vendedores")
def criar_vendedor(body: dict, db: Session = Depends(get_db)):
    v = Vendedor(nome=body["nome"], whatsapp=body["whatsapp"], loja_id=body["loja_id"])
    db.add(v)
    db.commit()
    db.refresh(v)
    return {"id": v.id, "nome": v.nome}

@app.delete("/api/vendedores/{vid}")
def remover_vendedor(vid: int, db: Session = Depends(get_db)):
    v = db.query(Vendedor).filter(Vendedor.id == vid).first()
    if v:
        v.ativo = False
        db.commit()
    return {"ok": True}

# ─── LOJAS ──────────────────────────────────────────────────────
@app.get("/api/lojas")
def listar_lojas(db: Session = Depends(get_db)):
    return [{"id": l.id, "nome": l.nome, "meta_phone_id": l.meta_phone_id,
             "evolution_instance": l.evolution_instance} for l in db.query(Loja).filter(Loja.ativo == True).all()]

@app.post("/api/lojas")
def criar_loja(body: dict, db: Session = Depends(get_db)):
    l = Loja(id=body["id"], nome=body["nome"])
    db.add(l)
    db.commit()
    return {"ok": True}

@app.patch("/api/lojas/{loja_id}/meta")
def configurar_meta(loja_id: str, body: dict, db: Session = Depends(get_db)):
    l = db.query(Loja).filter(Loja.id == loja_id).first()
    if not l:
        raise HTTPException(404)
    l.meta_phone_id = body.get("phone_id")
    l.meta_waba_id = body.get("waba_id")
    l.meta_token = body.get("token")
    db.commit()
    return {"ok": True}

@app.patch("/api/lojas/{loja_id}/evolution")
def configurar_evolution(loja_id: str, body: dict, db: Session = Depends(get_db)):
    l = db.query(Loja).filter(Loja.id == loja_id).first()
    if not l:
        raise HTTPException(404)
    l.evolution_instance = body.get("instance")
    db.commit()
    return {"ok": True}

# ─── AGENDAMENTOS ────────────────────────────────────────────────
@app.get("/api/agendamentos")
def listar_agendamentos(loja_id: str = None, db: Session = Depends(get_db)):
    q = db.query(Agendamento)
    if loja_id:
        q = q.filter(Agendamento.loja_id == loja_id)
    return [{"id": a.id, "nome": a.nome_cliente, "whatsapp": a.whatsapp,
             "data_hora": a.data_hora.isoformat() if a.data_hora else None,
             "tipo": a.tipo, "status": a.status, "loja_id": a.loja_id} for a in q.order_by(Agendamento.data_hora).all()]

@app.post("/api/agendamentos")
async def criar_agendamento(body: dict, db: Session = Depends(get_db)):
    from datetime import datetime
    a = Agendamento(
        nome_cliente=body["nome"],
        whatsapp=body["whatsapp"],
        loja_id=body["loja_id"],
        data_hora=datetime.fromisoformat(body["data_hora"]),
        tipo=body.get("tipo", "visita"),
        observacao=body.get("observacao", ""),
        origem=body.get("origem", "manual")
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    await manager.broadcast({"tipo": "novo_agendamento", "id": a.id})
    return {"id": a.id}

# ─── MÉTRICAS ────────────────────────────────────────────────────
@app.get("/api/metricas")
def metricas(loja_id: str = None, dias: int = 30, db: Session = Depends(get_db)):
    desde = datetime.utcnow() - timedelta(days=dias)
    q = db.query(Lead).filter(Lead.criado_em >= desde)
    if loja_id:
        q = q.filter(Lead.loja_id == loja_id)
    leads = q.all()

    total = len(leads)
    fechados = len([l for l in leads if l.coluna == "fechado"])
    transferidos = [l for l in leads if l.transferido_em]

    velocidade_media = 0
    if transferidos:
        tempos = [(l.transferido_em - l.criado_em).total_seconds() / 60 for l in transferidos if l.transferido_em and l.criado_em]
        velocidade_media = round(sum(tempos) / len(tempos), 1) if tempos else 0

    por_canal = {}
    for l in leads:
        por_canal[l.canal] = por_canal.get(l.canal, 0) + 1

    por_coluna = {}
    for l in leads:
        por_coluna[l.coluna] = por_coluna.get(l.coluna, 0) + 1

    return {
        "total": total,
        "fechados": fechados,
        "taxa_conversao": round(fechados / total * 100, 1) if total else 0,
        "velocidade_media_min": velocidade_media,
        "por_canal": por_canal,
        "por_coluna": por_coluna
    }

# ─── AUTH ────────────────────────────────────────────────────────
@app.post("/api/auth/login")
def login(body: dict, db: Session = Depends(get_db)):
    from passlib.context import CryptContext
    pwd = CryptContext(schemes=["bcrypt"])
    u = db.query(Usuario).filter(Usuario.username == body.get("username")).first()
    if not u or not pwd.verify(body.get("senha", ""), u.senha_hash):
        raise HTTPException(401, "Credenciais inválidas")
    return {"ok": True, "nome": u.nome, "role": u.role, "loja_id": u.loja_id, "username": u.username}

@app.get("/health")
def health():
    return {"status": "ok", "ts": datetime.utcnow().isoformat()}

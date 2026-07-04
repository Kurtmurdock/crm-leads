import anthropic
import httpx
import os
from datetime import datetime

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
META_VERSION = "v19.0"

FLUXO = {
    0: {
        "mensagem": "Olá! 😊 Que bom ter você aqui!\nAgora me conta: qual será a principal finalidade da sua moto?\n\n1️⃣ Trabalho 🚚\n2️⃣ Uso dia a dia 🏙️\n3️⃣ Os dois 🏍️",
        "campo": "finalidade",
        "opcoes": {"1": "Trabalho", "2": "Uso dia a dia", "3": "Os dois"}
    },
    1: {
        "mensagem": "Com certeza, você e sua nova moto terão uma parceria de muito sucesso! 🏍️✨\nAgora me diga: como você pretende realizar a compra?\n\n1️⃣ À vista 💰\n2️⃣ Financiado 💳\n3️⃣ Troca 🔄",
        "campo": "forma_compra",
        "opcoes": {"1": "À vista", "2": "Financiado", "3": "Troca"}
    },
    2: {
        "mensagem": "Excelente! 🎉\nAgora, escolha como deseja fazer sua simulação de crédito:\n\n1️⃣ Online 💻\nRápido, agora mesmo e sem sair de casa!\n\n2️⃣ Presencial 🏪\nVenha nos visitar na loja!",
        "campo": "modalidade",
        "opcoes": {"1": "Online", "2": "Presencial"},
        "condicao": "Financiado"
    },
    3: {
        "mensagem": "Perfeito! Agora vamos dar andamento à sua análise. 📋\nPor favor, me envie as seguintes informações:\n\n👤 Nome completo:\n🔢 CPF:\n📅 Data de nascimento:",
        "campo": "dados_pessoais",
        "tipo": "texto_livre"
    }
}

def formatar_whatsapp(numero: str) -> str:
    n = numero.replace("+", "").replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
    if len(n) == 11:
        return f"({n[:2]}) {n[2:7]}-{n[7:]}"
    elif len(n) == 12:
        return f"+{n[:2]} ({n[2:4]}) {n[4:9]}-{n[9:]}"
    elif len(n) == 13:
        return f"+{n[:2]} ({n[2:4]}) {n[4:9]}-{n[9:]}"
    return numero

async def enviar_whatsapp(phone_number_id: str, token: str, destinatario: str, mensagem: str):
    url = f"https://graph.facebook.com/{META_VERSION}/{phone_number_id}/messages"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    payload = {
        "messaging_product": "whatsapp",
        "to": destinatario,
        "type": "text",
        "text": {"body": mensagem}
    }
    async with httpx.AsyncClient() as client:
        resp = await client.post(url, json=payload, headers=headers)
        return resp.json()

async def processar_mensagem_bot(lead, mensagem_cliente: str, db, loja):
    if not lead.bot_ativo:
        return None

    etapa = lead.bot_etapa or 0
    resposta = None

    if etapa in FLUXO:
        passo = FLUXO[etapa]

        if passo.get("tipo") == "texto_livre":
            client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
            msg = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=300,
                messages=[{
                    "role": "user",
                    "content": f"""Extraia do texto abaixo: nome completo, CPF e data de nascimento.
Texto: {mensagem_cliente}
Responda APENAS em JSON: {{"nome": "", "cpf": "", "data_nascimento": ""}}"""
                }]
            )
            import json
            try:
                dados = json.loads(msg.content[0].text)
                lead.nome = dados.get("nome") or lead.nome
                lead.cpf = dados.get("cpf")
                lead.data_nascimento = dados.get("data_nascimento")
            except:
                pass

            lead.bot_etapa = 99
            lead.bot_ativo = False
            lead.coluna = "atribuido"
            lead.status = "Em andamento"
            lead.transferido_em = datetime.utcnow()
            db.commit()

            return {"transferir": True, "lead": lead}

        else:
            opcoes = passo.get("opcoes", {})
            chave = mensagem_cliente.strip()
            valor = opcoes.get(chave)

            if valor:
                setattr(lead, passo["campo"], valor)
                proxima_etapa = etapa + 1

                if passo["campo"] == "forma_compra" and valor != "Financiado":
                    proxima_etapa = 3

                if proxima_etapa in FLUXO:
                    proximo = FLUXO[proxima_etapa]
                    if proximo.get("condicao") and getattr(lead, passo["campo"]) != proximo["condicao"]:
                        proxima_etapa += 1

                lead.bot_etapa = proxima_etapa
                db.commit()

                if proxima_etapa in FLUXO:
                    resposta = FLUXO[proxima_etapa]["mensagem"]
                else:
                    resposta = FLUXO[3]["mensagem"]
                    lead.bot_etapa = 3
                    db.commit()
            else:
                resposta = "Por favor, escolha uma das opções enviando o número correspondente:\n\n"
                for k, v in opcoes.items():
                    resposta += f"{k}️⃣ {v}\n"

    return {"resposta": resposta, "transferir": False}

def montar_mensagem_transferencia(vendedor_nome: str, vendedor_whatsapp: str, loja_nome: str) -> str:
    numero_formatado = formatar_whatsapp(vendedor_whatsapp)
    return (
        f"✅ Perfeito! Suas informações foram registradas com sucesso.\n\n"
        f"Em instantes você será atendido por:\n\n"
        f"👤 *{vendedor_nome}*\n"
        f"📱 *{numero_formatado}*\n"
        f"🏍️ *{loja_nome}*\n\n"
        f"Ele(a) entrará em contato por este mesmo número de WhatsApp. "
        f"Fique à vontade para aguardar ou iniciar a conversa clicando aqui:\n"
        f"👉 https://wa.me/{vendedor_whatsapp.replace('+','').replace(' ','')}"
    )

async def notificar_vendedor(vendedor, lead, evolution_url: str, evolution_key: str):
    loja_nome = lead.loja.nome if lead.loja else ""
    mensagem = (
        f"🏍️ *Novo lead qualificado!* — {loja_nome}\n\n"
        f"👤 *Nome:* {lead.nome or 'Não informado'}\n"
        f"📱 *WhatsApp:* +{lead.whatsapp}\n"
        f"🏍️ *Interesse:* {lead.veiculo_interesse or 'Não informado'}\n"
        f"🎯 *Finalidade:* {lead.finalidade or '-'}\n"
        f"💳 *Forma de compra:* {lead.forma_compra or '-'}\n"
        + (f"🖥️ *Modalidade:* {lead.modalidade}\n" if lead.modalidade else "")
        + f"\n📋 *CPF:* {lead.cpf or 'Não informado'}\n"
        f"🎂 *Nascimento:* {lead.data_nascimento or 'Não informado'}\n\n"
        f"👆 Clique para iniciar o atendimento:\n"
        f"https://wa.me/{lead.whatsapp}"
    )

    url = f"{evolution_url}/message/sendText/{vendedor.loja_id}"
    headers = {"apikey": evolution_key, "Content-Type": "application/json"}
    payload = {"number": vendedor.whatsapp, "text": mensagem}

    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(url, json=payload, headers=headers, timeout=10)
            return resp.status_code == 200
        except Exception as e:
            print(f"Erro ao notificar vendedor: {e}")
            return False

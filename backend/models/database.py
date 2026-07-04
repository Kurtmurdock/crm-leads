from sqlalchemy import create_engine, Column, String, Integer, DateTime, Text, Boolean, ForeignKey
from sqlalchemy.orm import sessionmaker, relationship, DeclarativeBase
from datetime import datetime
import os

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://user:pass@localhost/crm")
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

class Base(DeclarativeBase):
    pass

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

class Loja(Base):
    __tablename__ = "lojas"
    id = Column(String, primary_key=True)
    nome = Column(String, nullable=False)
    meta_phone_id = Column(String)
    meta_waba_id = Column(String)
    meta_token = Column(Text)
    evolution_instance = Column(String)
    ativo = Column(Boolean, default=True)
    criado_em = Column(DateTime, default=datetime.utcnow)
    vendedores = relationship("Vendedor", back_populates="loja")
    leads = relationship("Lead", back_populates="loja")

class Vendedor(Base):
    __tablename__ = "vendedores"
    id = Column(Integer, primary_key=True, autoincrement=True)
    nome = Column(String, nullable=False)
    whatsapp = Column(String, nullable=False)
    loja_id = Column(String, ForeignKey("lojas.id"))
    ativo = Column(Boolean, default=True)
    criado_em = Column(DateTime, default=datetime.utcnow)
    loja = relationship("Loja", back_populates="vendedores")
    leads = relationship("Lead", back_populates="vendedor")

class Lead(Base):
    __tablename__ = "leads"
    id = Column(Integer, primary_key=True, autoincrement=True)
    nome = Column(String)
    whatsapp = Column(String, nullable=False)
    canal = Column(String, default="WhatsApp")
    loja_id = Column(String, ForeignKey("lojas.id"))
    vendedor_id = Column(Integer, ForeignKey("vendedores.id"), nullable=True)
    coluna = Column(String, default="entrada")
    status = Column(String, default="Novo")
    veiculo_interesse = Column(String)
    finalidade = Column(String)
    forma_compra = Column(String)
    modalidade = Column(String)
    cpf = Column(String)
    data_nascimento = Column(String)
    bot_ativo = Column(Boolean, default=True)
    bot_etapa = Column(Integer, default=0)
    reengajamento_enviado = Column(Boolean, default=False)
    transferido_em = Column(DateTime, nullable=True)
    criado_em = Column(DateTime, default=datetime.utcnow)
    atualizado_em = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    loja = relationship("Loja", back_populates="leads")
    vendedor = relationship("Vendedor", back_populates="leads")
    mensagens = relationship("Mensagem", back_populates="lead")

class Mensagem(Base):
    __tablename__ = "mensagens"
    id = Column(Integer, primary_key=True, autoincrement=True)
    lead_id = Column(Integer, ForeignKey("leads.id"))
    de = Column(String)
    conteudo = Column(Text)
    tipo = Column(String, default="texto")
    origem = Column(String, default="whatsapp")
    criado_em = Column(DateTime, default=datetime.utcnow)
    lead = relationship("Lead", back_populates="mensagens")

class Agendamento(Base):
    __tablename__ = "agendamentos"
    id = Column(Integer, primary_key=True, autoincrement=True)
    lead_id = Column(Integer, ForeignKey("leads.id"), nullable=True)
    nome_cliente = Column(String)
    whatsapp = Column(String)
    loja_id = Column(String, ForeignKey("lojas.id"))
    data_hora = Column(DateTime)
    tipo = Column(String, default="visita")
    observacao = Column(Text)
    status = Column(String, default="confirmado")
    origem = Column(String, default="manual")
    criado_em = Column(DateTime, default=datetime.utcnow)

class Usuario(Base):
    __tablename__ = "usuarios"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String, unique=True, nullable=False)
    senha_hash = Column(String, nullable=False)
    nome = Column(String)
    loja_id = Column(String, ForeignKey("lojas.id"), nullable=True)
    role = Column(String, default="vendedor")
    ativo = Column(Boolean, default=True)
    criado_em = Column(DateTime, default=datetime.utcnow)

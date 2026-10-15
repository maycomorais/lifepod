-- ═══════════════════════════════════════════════════════════════════════
--  SCHEMA COMPLETO — PLATAFORMA DE PEDIDOS / MERCADO / DELIVERY
--  Inclui perfil SÓCIO (com permissões customizadas por aba)
--  Idempotente: seguro para projeto novo E para banco existente
-- ═══════════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════════
-- §01  EXTENSÕES
-- ═══════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ═══════════════════════════════════════════════════════════════════════
-- §02  FUNÇÕES AUXILIARES GLOBAIS (não referenciam tabelas)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE OR REPLACE FUNCTION public._set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


-- ═══════════════════════════════════════════════════════════════════════
-- §03  IDENTIDADE
-- ═══════════════════════════════════════════════════════════════════════

-- ── perfis_acesso ──────────────────────────────────────────────────────
-- Cargos: adminMaster > dono > gerente > socio > funcionario > garcom
-- Sócio: acessa apenas as abas listadas em permissoes_customizadas.abas
CREATE TABLE IF NOT EXISTS public.perfis_acesso (
  id                       UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email                    TEXT NOT NULL,
  cargo                    TEXT NOT NULL DEFAULT 'funcionario',
  nome_display             TEXT,
  permissoes_customizadas  JSONB DEFAULT '{}'::JSONB,
  created_at               TIMESTAMPTZ DEFAULT NOW()
);

-- Adiciona coluna caso a tabela já exista (banco antigo)
ALTER TABLE public.perfis_acesso
  ADD COLUMN IF NOT EXISTS permissoes_customizadas JSONB DEFAULT '{}'::JSONB;

-- Atualiza o CHECK para incluir 'socio'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'perfis_acesso_cargo_check'
      AND table_name = 'perfis_acesso'
  ) THEN
    ALTER TABLE public.perfis_acesso DROP CONSTRAINT perfis_acesso_cargo_check;
  END IF;

  ALTER TABLE public.perfis_acesso
    ADD CONSTRAINT perfis_acesso_cargo_check
    CHECK (cargo IN ('adminMaster','dono','gerente','socio','funcionario','garcom'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── filiais ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.filiais (
  id                  UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                TEXT             NOT NULL,
  endereco            TEXT,
  coord_lat           DOUBLE PRECISION,
  coord_lng           DOUBLE PRECISION,
  whatsapp            TEXT,
  status              TEXT             NOT NULL DEFAULT 'ativa',
  raio_entrega_km     DOUBLE PRECISION NOT NULL DEFAULT 10.0,
  taxa_entrega_base   NUMERIC(10,2)    DEFAULT 0,
  horario_abertura    TIME             DEFAULT '08:00',
  horario_fechamento  TIME             DEFAULT '22:00',
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ      NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'filiais_status_check') THEN
    ALTER TABLE public.filiais ADD CONSTRAINT filiais_status_check
      CHECK (status IN ('ativa','inativa','manutencao'));
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_filiais_updated_at ON public.filiais;
CREATE TRIGGER trg_filiais_updated_at
  BEFORE UPDATE ON public.filiais
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();


-- ── perfis (multi-filial) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.perfis (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT,
  nome        TEXT,
  role        TEXT        NOT NULL DEFAULT 'funcionario',
  filial_id   UUID        REFERENCES public.filiais(id) ON DELETE SET NULL,
  ativo       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (usuario_id)
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'perfis_role_check'
      AND table_name = 'perfis'
  ) THEN
    ALTER TABLE public.perfis DROP CONSTRAINT perfis_role_check;
  END IF;

  ALTER TABLE public.perfis
    ADD CONSTRAINT perfis_role_check
    CHECK (role IN ('adminMaster','dono','gerente','socio','funcionario','motoboy'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ── configuracoes (linha única, id=1) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.configuracoes (
  id                          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- Identidade
  nome_restaurante            TEXT          DEFAULT '',
  descricao_loja              TEXT          DEFAULT '',
  url_loja                    TEXT          DEFAULT '',
  telefone_loja               TEXT          DEFAULT '',
  whatsapp_loja               TEXT          DEFAULT '',
  logo_url                    TEXT          DEFAULT '',
  icone_url                   TEXT          DEFAULT '',
  -- Pagamento
  chave_pix                   TEXT          DEFAULT '',
  nome_pix                    TEXT          DEFAULT '',
  dados_alias                 TEXT          DEFAULT '',
  nome_alias                  TEXT          DEFAULT '',
  maquininhas_cartao          JSONB         DEFAULT '[]'::JSONB,
  alias_qr_url                TEXT          DEFAULT '',
  qr_py_url                   TEXT          DEFAULT '',
  -- Localização e Delivery
  coord_lat                   DOUBLE PRECISION DEFAULT 0,
  coord_lng                   DOUBLE PRECISION DEFAULT 0,
  tabela_frete                JSONB         DEFAULT NULL,
  limite_distancia_km         NUMERIC(5,1)  DEFAULT NULL,
  delivery_aberto             BOOLEAN       DEFAULT TRUE,
  aviso_delivery              TEXT          DEFAULT '',
  -- Operação
  loja_aberta                 BOOLEAN       DEFAULT TRUE,
  cotacao_real                NUMERIC(10,2) DEFAULT 1100,
  taxa_motoboy_base           INTEGER       DEFAULT 0,
  ajuda_combustivel           INTEGER       DEFAULT 0,
  -- Taxas cartão BR
  taxa_debito                 NUMERIC(10,2) DEFAULT 0,
  taxa_credito                NUMERIC(10,2) DEFAULT 0,
  -- Horários
  horarios_semanais           JSONB         DEFAULT NULL,
  horario_extra_hoje          JSONB         DEFAULT NULL,
  -- Banners
  banner_imagem               TEXT          DEFAULT '',
  banner_produto_id           INTEGER       DEFAULT NULL,
  banner_desconto_tipo        TEXT          DEFAULT NULL,
  banner_desconto_valor       NUMERIC(10,2) DEFAULT NULL,
  banner2_imagem              TEXT          DEFAULT '',
  banner2_produto_id          INTEGER       DEFAULT NULL,
  banner2_desconto_tipo       TEXT          DEFAULT NULL,
  banner2_desconto_valor      NUMERIC(10,2) DEFAULT NULL,
  -- Visual
  cor_primaria                TEXT          DEFAULT '#1a7a2e',
  cor_secundaria              TEXT          DEFAULT '#155c24',
  -- Adicionais globais
  extras_globais              JSONB         DEFAULT '[]'::JSONB,
  extras_globais_categorias   JSONB         DEFAULT NULL,
  -- Caixa
  sangria_limite              INTEGER       DEFAULT NULL,
  caixa_status                JSONB         DEFAULT '{}'::JSONB,
  bloquear_venda_sem_caixa    BOOLEAN       NOT NULL DEFAULT false,
  -- Cashback
  cashback_percentual         NUMERIC       DEFAULT 10,
  cashback_pct                NUMERIC       DEFAULT 10,
  cashback_validade_dias      INT           DEFAULT 30,
  -- Push
  vapid_public_key            TEXT          DEFAULT '',
  -- Conversor de moeda
  vc_config                   JSONB         DEFAULT '{"ativo":false,"taxa":0,"posicao":"abaixo"}'::JSONB,
  -- Features controladas pelo adminMaster
  features_ativas             JSONB         DEFAULT '{
    "tabs": {
      "pedidos": true, "cozinha": true, "pdv": true,
      "financeiro": true, "inventario": true, "equipe": true,
      "configuracoes": true, "dashboard": true,
      "estatisticas": true, "ficha-tecnica": true, "crm": true,
      "mensalistas": true, "filiais": true
    },
    "tipos_produto": {
      "padrao": true, "bebida": true, "lanche": true, "pizza": true,
      "acai": true, "shake": true, "suco": true, "sorvete": true,
      "montavel": true, "combo": true, "variacoes": true, "kg": true
    },
    "funcionalidades": {
      "delivery": true, "retirada": true, "local": true, "balcao": true,
      "cupons": true, "factura": true, "multipagamento": true, "agendamento": true
    },
    "pagamentos": {
      "Efetivo": true, "Cartao": true, "CartaoBR": true, "Pix": true,
      "Transferencia": true, "QrPy": true, "Multipagamento": true
    }
  }'::JSONB,
  created_at                  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ   DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════
-- §04  CARDÁPIO
-- ═══════════════════════════════════════════════════════════════════════

-- ── categorias ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.categorias (
  id                SERIAL PRIMARY KEY,
  slug              TEXT      NOT NULL UNIQUE,
  nome              TEXT      NOT NULL DEFAULT '',
  nome_exibicao     TEXT      NOT NULL DEFAULT '',
  descricao         TEXT      DEFAULT '',
  emoji             TEXT      DEFAULT '',
  cor               TEXT      DEFAULT '#1a7a2e',
  ordem             INTEGER   DEFAULT 0,
  ativa             BOOLEAN   DEFAULT TRUE,
  ativo             BOOLEAN   DEFAULT TRUE,
  hora_inicio       TIME      DEFAULT NULL,
  hora_fim          TIME      DEFAULT NULL,
  dias_semana       TEXT[]    DEFAULT NULL,
  horarios_semanais JSONB     DEFAULT NULL,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger de sync nome ↔ nome_exibicao
CREATE OR REPLACE FUNCTION public.sync_cat_nome()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.nome IS NOT NULL AND NEW.nome != ''
     AND (NEW.nome_exibicao IS NULL OR NEW.nome_exibicao = '') THEN
    NEW.nome_exibicao := NEW.nome;
  END IF;
  IF NEW.nome_exibicao IS NOT NULL AND NEW.nome_exibicao != ''
     AND (NEW.nome IS NULL OR NEW.nome = '') THEN
    NEW.nome := NEW.nome_exibicao;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_cat_nome ON public.categorias;
CREATE TRIGGER trg_sync_cat_nome
  BEFORE INSERT OR UPDATE ON public.categorias
  FOR EACH ROW EXECUTE FUNCTION sync_cat_nome();


-- ── subcategorias ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.subcategorias (
  id              SERIAL PRIMARY KEY,
  slug            TEXT    NOT NULL UNIQUE,
  nome_exibicao   TEXT    NOT NULL,
  categoria_slug  TEXT    REFERENCES public.categorias(slug) ON DELETE CASCADE,
  ordem           INTEGER DEFAULT 0,
  ativa           BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ── produtos ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.produtos (
  id                     SERIAL PRIMARY KEY,
  nome                   TEXT    NOT NULL,
  descricao              TEXT    DEFAULT '',
  preco                  INTEGER DEFAULT 0,
  imagem_url             TEXT    DEFAULT '',
  categoria_slug         TEXT    REFERENCES public.categorias(slug) ON DELETE SET NULL,
  subcategoria_slug      TEXT    DEFAULT NULL,
  ativo                  BOOLEAN DEFAULT TRUE,
  pausado                BOOLEAN DEFAULT FALSE,
  somente_balcao         BOOLEAN DEFAULT FALSE,
  destaque               BOOLEAN DEFAULT FALSE,
  em_destaque            BOOLEAN DEFAULT FALSE,
  ordem                  INTEGER DEFAULT 0,
  e_montavel             BOOLEAN DEFAULT FALSE,
  montagem_config        JSONB   DEFAULT NULL,
  adicionais             JSONB   DEFAULT '[]'::JSONB,
  inventario_id          INTEGER DEFAULT NULL,
  estoque_qtd            INTEGER DEFAULT NULL,
  estoque_minimo         INTEGER DEFAULT NULL,
  -- Varejo
  es_bebida              BOOLEAN DEFAULT FALSE,
  tem_variacoes          BOOLEAN NOT NULL DEFAULT FALSE,
  unidade_venda          TEXT    DEFAULT NULL,
  promo_ativo            BOOLEAN NOT NULL DEFAULT FALSE,
  promo_tipo             TEXT    DEFAULT NULL,
  promo_valor            NUMERIC(14,2) DEFAULT NULL,
  em_promocao            BOOLEAN DEFAULT FALSE,
  preco_original         INTEGER DEFAULT NULL,
  -- Código de barras
  codigo_barras          TEXT    DEFAULT NULL,
  -- Preço de custo
  preco_compra           INTEGER DEFAULT NULL,
  preco_kg               NUMERIC DEFAULT NULL,
  -- Perecíveis
  perecivel              BOOLEAN DEFAULT FALSE,
  data_validade          DATE    DEFAULT NULL,
  data_validate          DATE    DEFAULT NULL,
  validade               DATE    DEFAULT NULL,
  dias_alerta_validade   INT     DEFAULT 7,
  -- Venda por peso
  venda_por_peso         BOOLEAN DEFAULT FALSE,
  peso_kg                NUMERIC DEFAULT NULL,
  fracionavel            BOOLEAN DEFAULT FALSE,
  unidade_fracionamento  TEXT    DEFAULT NULL,
  tipo_produto           TEXT    DEFAULT NULL,
  -- Timestamps
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_produtos_updated_at ON public.produtos;
CREATE TRIGGER trg_produtos_updated_at
  BEFORE UPDATE ON public.produtos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ── produto_variacoes ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.produto_variacoes (
  id                BIGSERIAL PRIMARY KEY,
  produto_id        BIGINT    NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  nome              TEXT      NOT NULL,
  sku               TEXT,
  preco_adicional   NUMERIC(14,2) NOT NULL DEFAULT 0,
  preco_absoluto    BOOLEAN   NOT NULL DEFAULT FALSE,
  estoque_qtd       INT       NOT NULL DEFAULT 0,
  controlar_estoque BOOLEAN   NOT NULL DEFAULT TRUE,
  ativo             BOOLEAN   NOT NULL DEFAULT TRUE,
  ordem             SMALLINT  NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_pv_updated_at ON public.produto_variacoes;
CREATE TRIGGER trg_pv_updated_at
  BEFORE UPDATE ON public.produto_variacoes
  FOR EACH ROW EXECUTE FUNCTION _set_updated_at();


-- ── combo_componentes ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.combo_componentes (
  id                       BIGSERIAL PRIMARY KEY,
  combo_produto_id         BIGINT NOT NULL,
  componente_produto_id    BIGINT NOT NULL,
  quantidade               NUMERIC NOT NULL DEFAULT 1,
  unidade                  TEXT NOT NULL DEFAULT 'un',
  permite_variacao         BOOLEAN DEFAULT FALSE,
  ordem                    INTEGER DEFAULT 0,
  created_at               TIMESTAMPTZ DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════
-- §05  INVENTÁRIO / FICHA TÉCNICA
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.inventario (
  id                SERIAL PRIMARY KEY,
  nome              TEXT          NOT NULL,
  unidade           TEXT          DEFAULT 'un',
  quantidade        NUMERIC(10,3) DEFAULT 0,
  quantidade_minima NUMERIC(10,3) DEFAULT NULL,
  custo_unit        INTEGER       DEFAULT 0,
  produto_id        INTEGER       DEFAULT NULL,
  perecivel         BOOLEAN       DEFAULT FALSE,
  data_validade     DATE          DEFAULT NULL,
  observacoes       TEXT          DEFAULT NULL,
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.inventario_movimentos (
  id              SERIAL PRIMARY KEY,
  inventario_id   INTEGER REFERENCES public.inventario(id) ON DELETE CASCADE,
  tipo            TEXT    NOT NULL,
  quantidade      NUMERIC(10,3) NOT NULL DEFAULT 0,
  motivo          TEXT    DEFAULT '',
  usuario_email   TEXT    DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inv_mov_tipo_check') THEN
    ALTER TABLE public.inventario_movimentos ADD CONSTRAINT inv_mov_tipo_check
      CHECK (tipo IN ('add','sub','ajuste','fechamento'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.insumos (
  id            BIGSERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  unidade       TEXT NOT NULL DEFAULT 'un',
  preco_custo   NUMERIC NOT NULL DEFAULT 0,
  estoque_atual NUMERIC DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.fichas_tecnicas (
  id             BIGSERIAL PRIMARY KEY,
  produto_id     TEXT,
  produto_nome   TEXT NOT NULL,
  markup_percent NUMERIC NOT NULL DEFAULT 300,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.ficha_itens (
  id              BIGSERIAL PRIMARY KEY,
  ficha_id        BIGINT REFERENCES public.fichas_tecnicas(id) ON DELETE CASCADE,
  insumo_id       BIGINT REFERENCES public.insumos(id) ON DELETE SET NULL,
  insumo_nome     TEXT,
  unidade_insumo  TEXT DEFAULT 'un',
  quantidade      NUMERIC NOT NULL DEFAULT 1
);


-- ═══════════════════════════════════════════════════════════════════════
-- §06  OPERAÇÃO (motoboys, cupons, clientes, cashback)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.motoboys (
  id         SERIAL PRIMARY KEY,
  nome       TEXT    NOT NULL,
  telefone   TEXT    DEFAULT '',
  ativo      BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cupons (
  id              SERIAL PRIMARY KEY,
  codigo          TEXT          NOT NULL UNIQUE,
  tipo            TEXT          NOT NULL,
  valor           NUMERIC(10,2) DEFAULT 0,
  minimo          NUMERIC(10,2) DEFAULT 0,
  limite_uso      INTEGER       DEFAULT NULL,
  usos_realizados INTEGER       DEFAULT 0,
  ativo           BOOLEAN       DEFAULT TRUE,
  validade        DATE          DEFAULT NULL,
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cupons_tipo_check') THEN
    ALTER TABLE public.cupons ADD CONSTRAINT cupons_tipo_check
      CHECK (tipo IN ('percentual','fixo','frete'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.clientes (
  id               BIGSERIAL PRIMARY KEY,
  nome             TEXT NOT NULL,
  telefone         TEXT UNIQUE,
  data_nascimento  DATE,
  nascimento       DATE,
  cashback_saldo   NUMERIC DEFAULT 0,
  total_gasto      NUMERIC DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.cashback_transacoes (
  id                BIGSERIAL PRIMARY KEY,
  cliente_id        BIGINT REFERENCES public.clientes(id) ON DELETE CASCADE,
  cliente_telefone  TEXT,
  pedido_id         BIGINT,
  tipo              TEXT NOT NULL,
  valor             NUMERIC NOT NULL DEFAULT 0,
  validade_dias     INT DEFAULT 30,
  expira_em         TIMESTAMPTZ,
  usado             BOOLEAN DEFAULT FALSE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cashback_tipo_check') THEN
    ALTER TABLE public.cashback_transacoes ADD CONSTRAINT cashback_tipo_check
      CHECK (tipo IN ('credito','debito'));
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- §07  PEDIDOS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.pedidos (
  id                            SERIAL PRIMARY KEY,
  uid_temporal                  TEXT    DEFAULT '',
  idempotency_key               TEXT    DEFAULT NULL,
  status                        TEXT    DEFAULT 'pendente',
  tipo_entrega                  TEXT    DEFAULT 'delivery',
  itens                         JSONB   DEFAULT '[]'::JSONB,
  subtotal                      INTEGER DEFAULT 0,
  desconto_cupom                INTEGER DEFAULT 0,
  desconto_pdv_valor            INTEGER DEFAULT 0,
  desconto_pdv_tipo             TEXT    DEFAULT NULL,
  frete_cobrado_cliente         INTEGER DEFAULT 0,
  frete_motoboy                 INTEGER DEFAULT 0,
  frete_a_combinar              BOOLEAN DEFAULT FALSE,
  total_geral                   INTEGER DEFAULT 0,
  forma_pagamento               TEXT    DEFAULT '',
  obs_pagamento                 TEXT    DEFAULT '',
  cliente_nome                  TEXT    DEFAULT '',
  cliente_telefone              TEXT    DEFAULT '',
  cliente_id                    BIGINT  DEFAULT NULL,
  endereco_entrega              TEXT    DEFAULT '',
  geo_lat                       TEXT    DEFAULT NULL,
  geo_lng                       TEXT    DEFAULT NULL,
  dados_factura                 JSONB   DEFAULT NULL,
  motoboy_id                    INTEGER REFERENCES public.motoboys(id) ON DELETE SET NULL,
  garcom_id                     UUID    REFERENCES public.perfis_acesso(id) ON DELETE SET NULL,
  garcom_nome                   TEXT    DEFAULT NULL,
  filial_id                     UUID    REFERENCES public.filiais(id) ON DELETE SET NULL,
  cancelamento_solicitado       BOOLEAN     DEFAULT FALSE,
  cancelamento_motivo           TEXT        DEFAULT NULL,
  cancelamento_solicitado_por   TEXT        DEFAULT NULL,
  cancelamento_solicitado_em    TIMESTAMPTZ DEFAULT NULL,
  cancelamento_aprovado_por     TEXT        DEFAULT NULL,
  cancelamento_aprovado_em      TIMESTAMPTZ DEFAULT NULL,
  motivo_cancelamento           TEXT        DEFAULT NULL,
  confirmacao_tipo              TEXT        DEFAULT NULL,
  cupom_codigo                  TEXT        DEFAULT NULL,
  cashback_valor                NUMERIC     DEFAULT 0,
  push_subscription             JSONB       DEFAULT NULL,
  entrega_confirmada_em         TIMESTAMPTZ DEFAULT NULL,
  estoque_descontado            BOOLEAN     DEFAULT FALSE,
  tempo_recebido                TIMESTAMPTZ DEFAULT NOW(),
  tempo_confirmado              TIMESTAMPTZ DEFAULT NULL,
  tempo_preparo_iniciado        TIMESTAMPTZ DEFAULT NULL,
  tempo_pronto                  TIMESTAMPTZ DEFAULT NULL,
  tempo_saiu_entrega            TIMESTAMPTZ DEFAULT NULL,
  tempo_entregue                TIMESTAMPTZ DEFAULT NULL,
  created_at                    TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_status_check') THEN
    ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_status_check
      CHECK (status IN ('pendente','em_preparo','pronto_entrega','saiu_entrega','entregue','cancelado'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_tipo_check') THEN
    ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_tipo_check
      CHECK (tipo_entrega IN ('delivery','retirada','local','balcao'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_idempotency_key_key') THEN
    ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_idempotency_key_key
      UNIQUE (idempotency_key);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_cliente_id_fkey') THEN
    ALTER TABLE public.pedidos ADD CONSTRAINT pedidos_cliente_id_fkey
      FOREIGN KEY (cliente_id) REFERENCES public.clientes(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.solicitacoes_cancelamento (
  id              SERIAL PRIMARY KEY,
  pedido_id       INTEGER REFERENCES public.pedidos(id) ON DELETE CASCADE,
  motivo          TEXT    DEFAULT '',
  solicitado_por  TEXT    DEFAULT '',
  aprovado        BOOLEAN DEFAULT FALSE,
  aprovado_por    TEXT    DEFAULT NULL,
  aprovado_em     TIMESTAMPTZ DEFAULT NULL,
  negado          BOOLEAN DEFAULT FALSE,
  negado_por      TEXT    DEFAULT NULL,
  negado_em       TIMESTAMPTZ DEFAULT NULL,
  observacoes     TEXT    DEFAULT NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════
-- §08  FINANCEIRO (caixa)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.sessoes_caixa (
  id                BIGSERIAL PRIMARY KEY,
  usuario_email     TEXT        NOT NULL,
  usuario_nome      TEXT,
  aberto_em         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fechado_em        TIMESTAMPTZ,
  valor_abertura    NUMERIC     DEFAULT 0,
  valor_fechamento  NUMERIC,
  observacao        TEXT,
  resumo_fechamento JSONB
);

CREATE TABLE IF NOT EXISTS public.movimentacoes_caixa (
  id               SERIAL PRIMARY KEY,
  tipo             TEXT          NOT NULL,
  valor            NUMERIC(12,2) NOT NULL DEFAULT 0,
  descricao        TEXT          DEFAULT '',
  usuario_email    TEXT          DEFAULT '',
  tipo_despesa     TEXT          DEFAULT NULL,
  descricao_outro  TEXT          DEFAULT NULL,
  autorizado_por   TEXT          DEFAULT NULL,
  pedido_id        INTEGER       DEFAULT NULL,
  sessao_id        BIGINT        REFERENCES public.sessoes_caixa(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ   DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mov_caixa_tipo_check') THEN
    ALTER TABLE public.movimentacoes_caixa ADD CONSTRAINT mov_caixa_tipo_check
      CHECK (tipo IN ('abertura','suprimento','sangria','despesa','fechamento','efetivo'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.caixa_fechamentos (
  id                   BIGSERIAL PRIMARY KEY,
  sessao_id            BIGINT NOT NULL REFERENCES public.sessoes_caixa(id) ON DELETE CASCADE,
  usuario_email        TEXT NOT NULL,
  usuario_nome         TEXT,
  aberto_em            TIMESTAMPTZ NOT NULL,
  fechado_em           TIMESTAMPTZ NOT NULL,
  valor_abertura       NUMERIC NOT NULL DEFAULT 0,
  faturamento          NUMERIC NOT NULL DEFAULT 0,
  qtd_pedidos          INTEGER NOT NULL DEFAULT 0,
  custo_entregas       NUMERIC NOT NULL DEFAULT 0,
  total_despesas       NUMERIC NOT NULL DEFAULT 0,
  total_sangrias       NUMERIC NOT NULL DEFAULT 0,
  total_suprimentos    NUMERIC NOT NULL DEFAULT 0,
  lucro_operacional    NUMERIC NOT NULL DEFAULT 0,
  dinheiro_gaveta      NUMERIC NOT NULL DEFAULT 0,
  total_efetivo        NUMERIC NOT NULL DEFAULT 0,
  total_pix            NUMERIC NOT NULL DEFAULT 0,
  total_cartao         NUMERIC NOT NULL DEFAULT 0,
  total_cartao_br      NUMERIC NOT NULL DEFAULT 0,
  total_transferencia  NUMERIC NOT NULL DEFAULT 0,
  total_qr_py          NUMERIC NOT NULL DEFAULT 0,
  total_multi_outros   NUMERIC NOT NULL DEFAULT 0,
  detalhes             JSONB DEFAULT '{}'::JSONB,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════
-- §09  MENSALISTAS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.planos_mensalistas (
  id                  BIGSERIAL PRIMARY KEY,
  cliente_id          BIGINT REFERENCES public.clientes(id) ON DELETE CASCADE,
  produto_nome        TEXT NOT NULL,
  quantidade_total    INT NOT NULL DEFAULT 0,
  quantidade_restante INT NOT NULL DEFAULT 0,
  valor_plano         NUMERIC(12,2) NOT NULL DEFAULT 0,
  ativo               BOOLEAN NOT NULL DEFAULT TRUE,
  data_inicio         DATE,
  data_fim            DATE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.mensalista_entregas (
  id           BIGSERIAL PRIMARY KEY,
  plano_id     BIGINT REFERENCES public.planos_mensalistas(id) ON DELETE CASCADE,
  cliente_id   BIGINT REFERENCES public.clientes(id) ON DELETE SET NULL,
  produto_nome TEXT,
  quantidade   INT NOT NULL DEFAULT 1,
  observacoes  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);


-- ═══════════════════════════════════════════════════════════════════════
-- §10  SAAS — ASSINATURAS
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.assinaturas (
  id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_nome              TEXT    NOT NULL DEFAULT 'Loja Principal',
  tenant_email_contato     TEXT,
  tipo_vencimento          TEXT    NOT NULL DEFAULT 'dia_fixo',
  dia_vencimento           INTEGER NOT NULL DEFAULT 5,
  dias_carencia            INTEGER NOT NULL DEFAULT 5,
  ultimo_pagamento_em      DATE,
  pagamento_confirmado_por TEXT,
  bloqueado                BOOLEAN NOT NULL DEFAULT FALSE,
  bloqueado_em             TIMESTAMPTZ,
  desbloqueado_em          TIMESTAMPTZ,
  desbloqueado_por         TEXT,
  obs                      TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assinaturas_tipo_venc_check') THEN
    ALTER TABLE public.assinaturas ADD CONSTRAINT assinaturas_tipo_venc_check
      CHECK (tipo_vencimento IN ('dia_fixo','dia_util'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assinaturas_dia_venc_check') THEN
    ALTER TABLE public.assinaturas ADD CONSTRAINT assinaturas_dia_venc_check
      CHECK (dia_vencimento BETWEEN 1 AND 31);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assinaturas_dias_car_check') THEN
    ALTER TABLE public.assinaturas ADD CONSTRAINT assinaturas_dias_car_check
      CHECK (dias_carencia >= 0);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.assinatura_pagamentos (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assinatura_id   BIGINT NOT NULL REFERENCES public.assinaturas(id) ON DELETE CASCADE,
  competencia     TEXT   NOT NULL,
  confirmado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmado_por  TEXT,
  obs             TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_pagamento_competencia
  ON public.assinatura_pagamentos (assinatura_id, competencia);


-- ═══════════════════════════════════════════════════════════════════════
-- §11  LEGAL — CONTRATOS DE ACEITE
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.contratos_aceites (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  email             TEXT        NOT NULL,
  nome_cliente      TEXT,
  documento_cliente TEXT,
  nome_assinante    TEXT,
  doc_assinante     TEXT,
  data_hora         TIMESTAMPTZ NOT NULL DEFAULT now(),
  aceito_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address        TEXT,
  ip_assinante      TEXT,
  user_agent        TEXT,
  aceito            BOOLEAN     NOT NULL DEFAULT TRUE,
  versao_contrato   TEXT        NOT NULL DEFAULT 'v1.0-2026',
  hash_contrato     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE para upsert (admin.js admAceitarContrato)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contratos_aceites_usuario_id_key') THEN
    ALTER TABLE public.contratos_aceites
      ADD CONSTRAINT contratos_aceites_usuario_id_key UNIQUE (usuario_id);
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- §12  COLUNAS INCREMENTAIS (para bancos antigos)
-- ═══════════════════════════════════════════════════════════════════════

-- configuracoes
ALTER TABLE public.configuracoes
  ADD COLUMN IF NOT EXISTS qr_py_url                TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS cashback_pct             NUMERIC       DEFAULT 10,
  ADD COLUMN IF NOT EXISTS vapid_public_key         TEXT          DEFAULT '',
  ADD COLUMN IF NOT EXISTS bloquear_venda_sem_caixa BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS taxa_debito              NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS taxa_credito             NUMERIC(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cor_secundaria           TEXT          DEFAULT '#155c24';

-- produtos
ALTER TABLE public.produtos
  ADD COLUMN IF NOT EXISTS em_destaque          BOOLEAN     DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS estoque_minimo       INTEGER     DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS dias_alerta_validade INT         DEFAULT 7,
  ADD COLUMN IF NOT EXISTS preco_compra         INTEGER     DEFAULT NULL;

-- pedidos
ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS cashback_valor   NUMERIC DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cliente_id       BIGINT  DEFAULT NULL;


-- ═══════════════════════════════════════════════════════════════════════
-- §13  ÍNDICES
-- ═══════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_pedidos_status        ON public.pedidos (status);
CREATE INDEX IF NOT EXISTS idx_pedidos_created_at    ON public.pedidos (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_garcom        ON public.pedidos (garcom_id) WHERE garcom_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pedidos_filial_id     ON public.pedidos (filial_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_tel   ON public.pedidos (cliente_telefone);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_id    ON public.pedidos (cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_idempotency   ON public.pedidos (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_produtos_cat          ON public.produtos (categoria_slug);
CREATE INDEX IF NOT EXISTS idx_produtos_ativo        ON public.produtos (ativo) WHERE ativo = true;
CREATE INDEX IF NOT EXISTS idx_produtos_subcat       ON public.produtos (subcategoria_slug);
CREATE INDEX IF NOT EXISTS idx_produtos_destaque     ON public.produtos (destaque) WHERE destaque = true AND ativo = true;

CREATE UNIQUE INDEX IF NOT EXISTS idx_produtos_codigo_barras
  ON public.produtos (codigo_barras)
  WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';

CREATE INDEX IF NOT EXISTS idx_pv_produto_id ON public.produto_variacoes (produto_id, ordem);
CREATE INDEX IF NOT EXISTS idx_pv_sku        ON public.produto_variacoes (sku) WHERE sku IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_subcategorias_cat ON public.subcategorias (categoria_slug);
CREATE INDEX IF NOT EXISTS idx_inv_mov_inv       ON public.inventario_movimentos (inventario_id);
CREATE INDEX IF NOT EXISTS idx_caixa_created     ON public.movimentacoes_caixa (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_caixa_operador    ON public.movimentacoes_caixa (usuario_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario   ON public.sessoes_caixa (usuario_email);
CREATE INDEX IF NOT EXISTS idx_sessoes_aberto    ON public.sessoes_caixa (aberto_em);
CREATE INDEX IF NOT EXISTS idx_cupons_codigo     ON public.cupons (codigo);
CREATE INDEX IF NOT EXISTS idx_sol_cancel_pedido ON public.solicitacoes_cancelamento (pedido_id);
CREATE INDEX IF NOT EXISTS idx_clientes_telefone ON public.clientes (telefone);
CREATE INDEX IF NOT EXISTS idx_cashback_cliente  ON public.cashback_transacoes (cliente_id);
CREATE INDEX IF NOT EXISTS idx_planos_cliente    ON public.planos_mensalistas (cliente_id);
CREATE INDEX IF NOT EXISTS idx_entregas_plano    ON public.mensalista_entregas (plano_id);
CREATE INDEX IF NOT EXISTS idx_filiais_status    ON public.filiais (status);
CREATE INDEX IF NOT EXISTS idx_perfis_usuario    ON public.perfis (usuario_id);
CREATE INDEX IF NOT EXISTS idx_perfis_filial     ON public.perfis (filial_id);
CREATE INDEX IF NOT EXISTS idx_perfis_role       ON public.perfis (role);
CREATE INDEX IF NOT EXISTS idx_contratos_user    ON public.contratos_aceites (usuario_id);
CREATE INDEX IF NOT EXISTS idx_perfis_acesso_cargo ON public.perfis_acesso (cargo);


-- ═══════════════════════════════════════════════════════════════════════
-- §14  FUNÇÕES (AGORA, depois de todas as tabelas existirem)
-- ═══════════════════════════════════════════════════════════════════════

-- ── Helpers de perfil ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cargo FROM public.perfis_acesso WHERE id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_filial_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT filial_id FROM public.perfis WHERE usuario_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_permissoes()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(permissoes_customizadas, '{}'::JSONB)
  FROM public.perfis_acesso WHERE id = auth.uid() LIMIT 1;
$$;

-- Verifica se o usuário logado pode acessar uma aba
CREATE OR REPLACE FUNCTION public.pode_ver_aba(p_aba TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cargo TEXT;
  v_perm  JSONB;
  v_abas  JSONB;
BEGIN
  SELECT cargo INTO v_cargo FROM public.perfis_acesso WHERE id = auth.uid() LIMIT 1;

  IF v_cargo IS NULL THEN RETURN false; END IF;
  IF v_cargo IN ('adminMaster','dono') THEN RETURN true; END IF;

  IF v_cargo = 'socio' THEN
    v_perm := COALESCE(get_my_permissoes(), '{}'::JSONB);
    v_abas := COALESCE(v_perm -> 'abas', '[]'::JSONB);
    RETURN v_abas ? p_aba;
  END IF;

  RETURN true;
END;
$$;

-- Retorna todas as abas permitidas em 1 chamada
CREATE OR REPLACE FUNCTION public.get_minhas_abas()
RETURNS TEXT[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cargo TEXT;
  v_perm  JSONB;
BEGIN
  SELECT cargo INTO v_cargo FROM public.perfis_acesso WHERE id = auth.uid() LIMIT 1;

  IF v_cargo IS NULL THEN RETURN ARRAY[]::TEXT[]; END IF;

  IF v_cargo IN ('adminMaster','dono') THEN
    RETURN ARRAY[
      'dashboard','pdv','pedidos','cozinha','equipe',
      'produtos','categorias','motoboys',
      'financeiro','inventario','configuracoes',
      'estatisticas','ficha-tecnica','crm','mensalistas','filiais'
    ];
  END IF;

  IF v_cargo = 'socio' THEN
    v_perm := COALESCE(get_my_permissoes(), '{}'::JSONB);
    RETURN ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(v_perm -> 'abas', '[]'::JSONB))
    );
  END IF;

  RETURN ARRAY[
    'dashboard','pdv','pedidos','cozinha','equipe',
    'produtos','categorias','motoboys',
    'financeiro','inventario','configuracoes',
    'estatisticas','ficha-tecnica','crm','mensalistas'
  ];
END;
$$;

-- ── RPCs operacionais ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE
AS $$ SELECT now(); $$;

CREATE OR REPLACE FUNCTION public.descontar_estoque_atomico(
  p_produto_id BIGINT,
  p_qtd        INTEGER
)
RETURNS TABLE(sucesso boolean, novo_estoque integer, motivo text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_estoque_atual INTEGER;
  v_novo          INTEGER;
BEGIN
  SELECT estoque_qtd INTO v_estoque_atual
  FROM public.produtos WHERE id = p_produto_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::INTEGER, 'Produto não encontrado'; RETURN;
  END IF;
  IF v_estoque_atual IS NULL THEN
    RETURN QUERY SELECT false, NULL::INTEGER, 'Produto sem controle de estoque'; RETURN;
  END IF;

  v_novo := GREATEST(0, v_estoque_atual - GREATEST(0, p_qtd));

  UPDATE public.produtos
     SET estoque_qtd = v_novo,
         ativo = CASE WHEN v_novo = 0 AND ativo = true THEN false ELSE ativo END
   WHERE id = p_produto_id;

  RETURN QUERY SELECT true, v_novo, NULL::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.decrementar_estoque_variacao(
  p_variacao_id BIGINT,
  p_quantidade  INT DEFAULT 1
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _atual INT; _controlar BOOLEAN;
BEGIN
  SELECT estoque_qtd, controlar_estoque INTO _atual, _controlar
  FROM public.produto_variacoes WHERE id = p_variacao_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'erro', 'Variação não encontrada');
  END IF;
  IF NOT _controlar THEN
    RETURN json_build_object('ok', true, 'estoque_restante', NULL);
  END IF;
  IF _atual < p_quantidade THEN
    RETURN json_build_object('ok', false, 'erro', 'Estoque insuficiente', 'disponivel', _atual);
  END IF;

  UPDATE public.produto_variacoes SET estoque_qtd = estoque_qtd - p_quantidade
   WHERE id = p_variacao_id;

  RETURN json_build_object('ok', true, 'estoque_restante', _atual - p_quantidade);
END;
$$;

CREATE OR REPLACE FUNCTION public.incrementar_uso_cupom(cupom_id INTEGER)
RETURNS void LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.cupons SET usos_realizados = COALESCE(usos_realizados, 0) + 1
   WHERE id = cupom_id;
$$;
GRANT EXECUTE ON FUNCTION public.incrementar_uso_cupom(INTEGER) TO anon, authenticated;


-- ═══════════════════════════════════════════════════════════════════════
-- §15  VIEWS
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW public.vw_sessao_resumo AS
SELECT
  sc.id             AS sessao_id,
  sc.usuario_email,
  sc.usuario_nome,
  sc.aberto_em,
  sc.fechado_em,
  sc.valor_abertura,
  sc.valor_fechamento,
  COUNT(p.id)::INT  AS qtd_pedidos
FROM public.sessoes_caixa sc
LEFT JOIN public.pedidos p
  ON p.created_at >= sc.aberto_em
 AND (sc.fechado_em IS NULL OR p.created_at <= sc.fechado_em)
 AND COALESCE(p.status, '') <> 'cancelado'
GROUP BY sc.id;


-- ═══════════════════════════════════════════════════════════════════════
-- §16  RLS
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.perfis_acesso             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perfis                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.filiais                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.configuracoes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categorias                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subcategorias             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produtos                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.produto_variacoes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.combo_componentes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventario                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventario_movimentos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insumos                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fichas_tecnicas           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ficha_itens               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.motoboys                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cupons                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clientes                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashback_transacoes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solicitacoes_cancelamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessoes_caixa             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimentacoes_caixa       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.caixa_fechamentos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planos_mensalistas        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mensalista_entregas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assinaturas               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assinatura_pagamentos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contratos_aceites         ENABLE ROW LEVEL SECURITY;


-- ── Políticas ─────────────────────────────────────────────────────────

-- Leitura pública (cardápio e config)
DROP POLICY IF EXISTS "anon_read_produtos"   ON public.produtos;
DROP POLICY IF EXISTS "anon_read_categorias" ON public.categorias;
DROP POLICY IF EXISTS "anon_read_subcats"    ON public.subcategorias;
DROP POLICY IF EXISTS "anon_read_config"     ON public.configuracoes;
DROP POLICY IF EXISTS "anon_read_cupons"     ON public.cupons;

CREATE POLICY "anon_read_produtos"   ON public.produtos      FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_categorias" ON public.categorias    FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_subcats"    ON public.subcategorias FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_config"     ON public.configuracoes FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read_cupons"     ON public.cupons        FOR SELECT TO anon USING (ativo = true);

-- Autenticados: acesso total (admin)
DROP POLICY IF EXISTS "auth_all_produtos"   ON public.produtos;
DROP POLICY IF EXISTS "auth_all_categorias" ON public.categorias;
DROP POLICY IF EXISTS "auth_all_subcats"    ON public.subcategorias;
DROP POLICY IF EXISTS "auth_all_config"     ON public.configuracoes;
DROP POLICY IF EXISTS "auth_all_cupons"     ON public.cupons;
DROP POLICY IF EXISTS "auth_all_perfis"     ON public.perfis_acesso;
DROP POLICY IF EXISTS "auth_all_inventario" ON public.inventario;
DROP POLICY IF EXISTS "auth_all_inv_mov"    ON public.inventario_movimentos;
DROP POLICY IF EXISTS "auth_all_motoboys"   ON public.motoboys;
DROP POLICY IF EXISTS "auth_all_caixa"      ON public.movimentacoes_caixa;

CREATE POLICY "auth_all_produtos"   ON public.produtos              FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_categorias" ON public.categorias            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_subcats"    ON public.subcategorias         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_config"     ON public.configuracoes         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_cupons"     ON public.cupons                FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_perfis"     ON public.perfis_acesso         FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_inventario" ON public.inventario            FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_inv_mov"    ON public.inventario_movimentos FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_motoboys"   ON public.motoboys              FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_all_caixa"      ON public.movimentacoes_caixa   FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- produto_variacoes
DROP POLICY IF EXISTS "pv_select_public" ON public.produto_variacoes;
DROP POLICY IF EXISTS "pv_write_auth"    ON public.produto_variacoes;
CREATE POLICY "pv_select_public" ON public.produto_variacoes FOR SELECT TO public USING (ativo = TRUE);
CREATE POLICY "pv_write_auth"    ON public.produto_variacoes FOR ALL    TO authenticated USING (TRUE) WITH CHECK (TRUE);

-- sessoes_caixa (gestor vê tudo)
DROP POLICY IF EXISTS "gestor_ve_tudo" ON public.sessoes_caixa;
CREATE POLICY "gestor_ve_tudo" ON public.sessoes_caixa FOR ALL USING (true) WITH CHECK (true);

-- pedidos
DROP POLICY IF EXISTS "pedidos_select_publico" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_update_publico" ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_select_filial"  ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_insert_anon"    ON public.pedidos;
DROP POLICY IF EXISTS "pedidos_update_filial"  ON public.pedidos;

CREATE POLICY "pedidos_select_publico" ON public.pedidos FOR SELECT TO public USING (true);
CREATE POLICY "pedidos_update_publico" ON public.pedidos FOR UPDATE TO public USING (true);
CREATE POLICY "pedidos_select_filial"  ON public.pedidos FOR SELECT TO authenticated USING (
  get_my_role() = 'adminMaster' OR filial_id = get_my_filial_id() OR filial_id IS NULL
);
CREATE POLICY "pedidos_insert_anon"    ON public.pedidos FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "pedidos_update_filial"  ON public.pedidos FOR UPDATE TO authenticated USING (
  get_my_role() = 'adminMaster' OR filial_id = get_my_filial_id() OR filial_id IS NULL
);

-- solicitacoes_cancelamento
DROP POLICY IF EXISTS "anon_insert_solicitacoes" ON public.solicitacoes_cancelamento;
DROP POLICY IF EXISTS "auth_all_solicitacoes"    ON public.solicitacoes_cancelamento;
CREATE POLICY "anon_insert_solicitacoes" ON public.solicitacoes_cancelamento FOR INSERT WITH CHECK (true);
CREATE POLICY "auth_all_solicitacoes"    ON public.solicitacoes_cancelamento FOR ALL    USING (auth.role() = 'authenticated');

-- filiais
DROP POLICY IF EXISTS "filiais_select_auth"   ON public.filiais;
DROP POLICY IF EXISTS "filiais_select_anon"   ON public.filiais;
DROP POLICY IF EXISTS "filiais_insert_master" ON public.filiais;
DROP POLICY IF EXISTS "filiais_update_master" ON public.filiais;
DROP POLICY IF EXISTS "filiais_delete_master" ON public.filiais;

CREATE POLICY "filiais_select_auth"   ON public.filiais FOR SELECT TO authenticated USING (true);
CREATE POLICY "filiais_select_anon"   ON public.filiais FOR SELECT TO anon USING (status = 'ativa');
CREATE POLICY "filiais_insert_master" ON public.filiais FOR INSERT TO authenticated WITH CHECK (get_my_role() = 'adminMaster');
CREATE POLICY "filiais_update_master" ON public.filiais FOR UPDATE TO authenticated USING (get_my_role() = 'adminMaster');
CREATE POLICY "filiais_delete_master" ON public.filiais FOR DELETE TO authenticated USING (get_my_role() = 'adminMaster');

-- perfis (multi-filial) — SÓCIO incluído
DROP POLICY IF EXISTS "perfis_select" ON public.perfis;
DROP POLICY IF EXISTS "perfis_insert" ON public.perfis;
DROP POLICY IF EXISTS "perfis_update" ON public.perfis;

CREATE POLICY "perfis_select" ON public.perfis FOR SELECT TO authenticated USING (
  usuario_id = auth.uid()
  OR get_my_role() = 'adminMaster'
  OR (get_my_role() IN ('gerente','socio') AND filial_id = get_my_filial_id())
);
CREATE POLICY "perfis_insert" ON public.perfis FOR INSERT TO authenticated WITH CHECK (
  usuario_id = auth.uid() OR get_my_role() = 'adminMaster'
);
CREATE POLICY "perfis_update" ON public.perfis FOR UPDATE TO authenticated USING (
  usuario_id = auth.uid()
  OR get_my_role() = 'adminMaster'
  OR (get_my_role() IN ('gerente','socio') AND filial_id = get_my_filial_id())
);

-- contratos_aceites
DROP POLICY IF EXISTS "contratos_select" ON public.contratos_aceites;
DROP POLICY IF EXISTS "contratos_insert" ON public.contratos_aceites;
CREATE POLICY "contratos_select" ON public.contratos_aceites FOR SELECT TO authenticated USING (
  usuario_id = auth.uid() OR get_my_role() = 'adminMaster'
);
CREATE POLICY "contratos_insert" ON public.contratos_aceites FOR INSERT TO authenticated WITH CHECK (usuario_id = auth.uid());

-- assinaturas + assinatura_pagamentos
DROP POLICY IF EXISTS "leitura_assinatura" ON public.assinaturas;
DROP POLICY IF EXISTS "escrita_assinatura" ON public.assinaturas;
DROP POLICY IF EXISTS "leitura_pagamentos" ON public.assinatura_pagamentos;
DROP POLICY IF EXISTS "escrita_pagamentos" ON public.assinatura_pagamentos;
CREATE POLICY "leitura_assinatura" ON public.assinaturas           FOR SELECT TO authenticated USING (auth.role() = 'authenticated');
CREATE POLICY "escrita_assinatura" ON public.assinaturas           FOR ALL    TO authenticated USING (auth.role() = 'authenticated');
CREATE POLICY "leitura_pagamentos" ON public.assinatura_pagamentos FOR SELECT TO authenticated USING (auth.role() = 'authenticated');
CREATE POLICY "escrita_pagamentos" ON public.assinatura_pagamentos FOR ALL    TO authenticated USING (auth.role() = 'authenticated');

-- Bloco genérico "auth_all_access" para tabelas restantes
DO $$
DECLARE t TEXT;
  tabelas TEXT[] := ARRAY[
    'insumos','fichas_tecnicas','ficha_itens','clientes','cashback_transacoes',
    'planos_mensalistas','mensalista_entregas','caixa_fechamentos','combo_componentes'
  ];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    EXECUTE format('DROP POLICY IF EXISTS "auth_all_access" ON public.%I', t);
    EXECUTE format('
      CREATE POLICY "auth_all_access" ON public.%I
      FOR ALL TO authenticated USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- §17  STORAGE — bucket "produtos" (crie manualmente no Dashboard)
--      Storage → New Bucket → "produtos" | Public: ON
-- ═══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_public_read') THEN
    CREATE POLICY "produtos_public_read" ON storage.objects FOR SELECT              USING (bucket_id = 'produtos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_auth_insert') THEN
    CREATE POLICY "produtos_auth_insert" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'produtos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_auth_update') THEN
    CREATE POLICY "produtos_auth_update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'produtos');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='produtos_auth_delete') THEN
    CREATE POLICY "produtos_auth_delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'produtos');
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- §18  REALTIME
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'pedidos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pedidos;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'assinaturas'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.assinaturas;
  END IF;
END $$;


-- ═══════════════════════════════════════════════════════════════════════
-- §19  SEEDS OBRIGATÓRIOS
-- ═══════════════════════════════════════════════════════════════════════

-- Linha única de configurações
INSERT INTO public.configuracoes (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Assinatura padrão (usa WHERE NOT EXISTS por causa do GENERATED ALWAYS AS IDENTITY)
INSERT INTO public.assinaturas (tenant_nome, tipo_vencimento, dia_vencimento, dias_carencia)
SELECT 'Loja Principal', 'dia_util', 5, 5
WHERE NOT EXISTS (SELECT 1 FROM public.assinaturas LIMIT 1);


-- ═══════════════════════════════════════════════════════════════════════
-- §20  VERIFICAÇÕES FINAIS
-- ═══════════════════════════════════════════════════════════════════════

-- Deve listar 'socio' no CHECK
SELECT pg_get_constraintdef(oid) AS check_cargo
  FROM pg_constraint
 WHERE conname = 'perfis_acesso_cargo_check';

-- Deve retornar 3 funções (get_my_permissoes, pode_ver_aba, get_minhas_abas)
SELECT proname FROM pg_proc
 WHERE proname IN ('get_my_permissoes','pode_ver_aba','get_minhas_abas')
 ORDER BY proname;

-- Deve retornar 1 (configuração criada)
SELECT COUNT(*) AS total_config FROM public.configuracoes;

-- Deve retornar 1 (assinatura criada)
SELECT COUNT(*) AS total_assinaturas FROM public.assinaturas;


-- ═══════════════════════════════════════════════════════════════════════
--  FIM — Schema completo com perfil Sócio
--  Reexecução segura: todas operações são idempotentes
-- ═══════════════════════════════════════════════════════════════════════
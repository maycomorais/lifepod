-- =============================================================
-- MIGRAÇÃO: Controle de Assinatura e Inadimplência (SaaS)
-- Execute no SQL Editor do Supabase
-- =============================================================

-- ── 1. Tabela principal de assinaturas ───────────────────────
CREATE TABLE IF NOT EXISTS public.assinaturas (
  id                     bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- Identificação do tenant (uma por instalação; id = 1 por padrão)
  tenant_nome            text    NOT NULL DEFAULT 'Loja Principal',
  tenant_email_contato   text,

  -- Regra de vencimento
  tipo_vencimento        text    NOT NULL DEFAULT 'dia_fixo'
                                 CHECK (tipo_vencimento IN ('dia_fixo','dia_util')),
  dia_vencimento         integer NOT NULL DEFAULT 5
                                 CHECK (dia_vencimento BETWEEN 1 AND 31),
  -- Para 'dia_util': dia_vencimento = N (ex: 5 = 5º dia útil)

  -- Carência após vencimento
  dias_carencia          integer NOT NULL DEFAULT 5 CHECK (dias_carencia >= 0),

  -- Controle de pagamento
  ultimo_pagamento_em    date,
  pagamento_confirmado_por text,

  -- Bloqueio
  bloqueado              boolean NOT NULL DEFAULT false,
  bloqueado_em           timestamp with time zone,
  desbloqueado_em        timestamp with time zone,
  desbloqueado_por       text,

  -- Metadados
  obs                    text,
  created_at             timestamp with time zone NOT NULL DEFAULT now(),
  updated_at             timestamp with time zone NOT NULL DEFAULT now()
);

-- ── 2. Histórico de pagamentos ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.assinatura_pagamentos (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assinatura_id   bigint NOT NULL REFERENCES public.assinaturas(id) ON DELETE CASCADE,
  competencia     text   NOT NULL,  -- 'YYYY-MM' (mês de referência)
  confirmado_em   timestamp with time zone NOT NULL DEFAULT now(),
  confirmado_por  text,
  obs             text
);

-- Índice para busca rápida por competência
CREATE UNIQUE INDEX IF NOT EXISTS uq_pagamento_competencia
  ON public.assinatura_pagamentos (assinatura_id, competencia);

-- ── 3. Função + trigger para atualizar updated_at ────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assinaturas_updated_at ON public.assinaturas;
CREATE TRIGGER trg_assinaturas_updated_at
  BEFORE UPDATE ON public.assinaturas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 4. RLS: somente usuários autenticados lêem; adminMaster escreve ──
ALTER TABLE public.assinaturas          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assinatura_pagamentos ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer usuário autenticado pode ler a assinatura da sua loja
CREATE POLICY "leitura_assinatura" ON public.assinaturas
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "leitura_pagamentos" ON public.assinatura_pagamentos
  FOR SELECT USING (auth.role() = 'authenticated');

-- Escrita: apenas service_role (chamado via Edge Function ou pelo adminMaster autenticado)
-- Para simplificar, permitimos UPDATE para authenticated também
-- (a validação de cargo adminMaster é feita no JS)
CREATE POLICY "escrita_assinatura" ON public.assinaturas
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "escrita_pagamentos" ON public.assinatura_pagamentos
  FOR ALL USING (auth.role() = 'authenticated');

-- ── 5. Seed: insere o tenant padrão se ainda não existir ─────
INSERT INTO public.assinaturas (
  tenant_nome, tipo_vencimento, dia_vencimento, dias_carencia
)
SELECT 'Loja Principal', 'dia_util', 5, 5
WHERE NOT EXISTS (SELECT 1 FROM public.assinaturas LIMIT 1);

-- ── 6. Verificação ───────────────────────────────────────────
SELECT id, tenant_nome, tipo_vencimento, dia_vencimento,
       dias_carencia, ultimo_pagamento_em, bloqueado
FROM public.assinaturas;

-- ══════════════════════════════════════════════════════════════
--  MIGRAÇÃO — Suporte a Variações de Produto (Varejo)
--  Execute no SQL Editor do Supabase (Settings › SQL Editor)
--  Compatível com o schema existente da tabela "produtos".
-- ══════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────
--  1. TABELA produto_variacoes
--     Uma linha por combinação vendável de um produto.
--     Ex: Camiseta Azul P, Camiseta Azul M, Pod Melancia 20mg …
-- ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS produto_variacoes (
  id               BIGSERIAL PRIMARY KEY,
  produto_id       BIGINT      NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,

  -- O que identifica esta variação para o cliente
  nome             TEXT        NOT NULL,          -- "Azul - M", "110v", "Melancia"
  sku              TEXT,                          -- código interno / cód. barras
  
  -- Preço: pode ser sobrepreço (+Gs 5000) ou preço fixo absoluto.
  -- Use preco_absoluto = TRUE para substituir o preço base do produto.
  preco_adicional  NUMERIC(14,2) NOT NULL DEFAULT 0,
  preco_absoluto   BOOLEAN     NOT NULL DEFAULT FALSE,

  -- Controle de estoque
  estoque_qtd      INT         NOT NULL DEFAULT 0  CHECK (estoque_qtd >= 0),
  controlar_estoque BOOLEAN    NOT NULL DEFAULT TRUE,  -- FALSE = estoque infinito

  -- Metadados
  ativo            BOOLEAN     NOT NULL DEFAULT TRUE,
  ordem            SMALLINT    NOT NULL DEFAULT 0,    -- ordem de exibição
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice principal: buscar todas as variações de um produto
CREATE INDEX IF NOT EXISTS idx_pv_produto_id
  ON produto_variacoes (produto_id, ordem);

-- Índice de SKU (útil para busca por código de barras no PDV)
CREATE INDEX IF NOT EXISTS idx_pv_sku
  ON produto_variacoes (sku)
  WHERE sku IS NOT NULL;

-- Trigger: atualiza updated_at automaticamente
CREATE OR REPLACE FUNCTION _set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pv_updated_at ON produto_variacoes;
CREATE TRIGGER trg_pv_updated_at
  BEFORE UPDATE ON produto_variacoes
  FOR EACH ROW EXECUTE FUNCTION _set_updated_at();


-- ──────────────────────────────────────────────────────────────
--  2. COLUNA tem_variacoes NA TABELA produtos
--     Flag que o app lê para decidir se exibe "Comprar" ou "Ver Opções".
--     Mantida sincronizada pelo trigger abaixo — não edite manualmente.
-- ──────────────────────────────────────────────────────────────
ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS tem_variacoes BOOLEAN NOT NULL DEFAULT FALSE;


-- Trigger: sincroniza tem_variacoes sempre que produto_variacoes muda
CREATE OR REPLACE FUNCTION _sync_tem_variacoes()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  _pid BIGINT;
  _tem BOOLEAN;
BEGIN
  -- Determina o produto_id afetado (INSERT, UPDATE, DELETE)
  IF TG_OP = 'DELETE' THEN
    _pid := OLD.produto_id;
  ELSE
    _pid := NEW.produto_id;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM produto_variacoes
    WHERE produto_id = _pid AND ativo = TRUE
  ) INTO _tem;

  UPDATE produtos SET tem_variacoes = _tem WHERE id = _pid;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_variacoes ON produto_variacoes;
CREATE TRIGGER trg_sync_variacoes
  AFTER INSERT OR UPDATE OR DELETE ON produto_variacoes
  FOR EACH ROW EXECUTE FUNCTION _sync_tem_variacoes();


-- ──────────────────────────────────────────────────────────────
--  3. FUNÇÃO DE DECREMENTO DE ESTOQUE
--     Chamada pelo backend/edge-function ao confirmar pedido,
--     ou diretamente via RPC do app.js após criação do pedido.
--     Usa FOR UPDATE para evitar race condition em alto volume.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION decrementar_estoque_variacao(
  p_variacao_id BIGINT,
  p_quantidade  INT DEFAULT 1
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  _atual INT;
  _controlar BOOLEAN;
  _result JSON;
BEGIN
  -- Lock na linha específica
  SELECT estoque_qtd, controlar_estoque
  INTO _atual, _controlar
  FROM produto_variacoes
  WHERE id = p_variacao_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'erro', 'Variação não encontrada');
  END IF;

  -- Se não controla estoque, só confirma sem decrementar
  IF NOT _controlar THEN
    RETURN json_build_object('ok', true, 'estoque_restante', NULL);
  END IF;

  IF _atual < p_quantidade THEN
    RETURN json_build_object('ok', false, 'erro', 'Estoque insuficiente', 'disponivel', _atual);
  END IF;

  UPDATE produto_variacoes
  SET estoque_qtd = estoque_qtd - p_quantidade
  WHERE id = p_variacao_id;

  RETURN json_build_object('ok', true, 'estoque_restante', _atual - p_quantidade);
END;
$$;


-- ──────────────────────────────────────────────────────────────
--  4. VIEW AUXILIAR: produtos_com_estoque
--     Usada no painel admin para ver rapidamente quais variações
--     estão acabando (estoque <= 5).
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW produtos_com_estoque AS
SELECT
  p.id          AS produto_id,
  p.nome        AS produto_nome,
  p.categoria_slug,
  pv.id         AS variacao_id,
  pv.nome       AS variacao_nome,
  pv.sku,
  pv.estoque_qtd,
  pv.controlar_estoque,
  pv.preco_adicional,
  pv.preco_absoluto,
  pv.ativo
FROM produto_variacoes pv
JOIN produtos p ON p.id = pv.produto_id
ORDER BY p.nome, pv.ordem, pv.nome;


-- ──────────────────────────────────────────────────────────────
--  5. RLS (Row Level Security) — opcional mas recomendado
--     Permite leitura pública das variações ativas
--     e escrita apenas para usuários autenticados (admin).
-- ──────────────────────────────────────────────────────────────
ALTER TABLE produto_variacoes ENABLE ROW LEVEL SECURITY;

-- Leitura pública: qualquer visitante vê variações ativas
DROP POLICY IF EXISTS pv_select_public ON produto_variacoes;
CREATE POLICY pv_select_public ON produto_variacoes
  FOR SELECT USING (ativo = TRUE);

-- Escrita: somente usuários autenticados (lojistas)
DROP POLICY IF EXISTS pv_write_auth ON produto_variacoes;
CREATE POLICY pv_write_auth ON produto_variacoes
  FOR ALL TO authenticated USING (TRUE) WITH CHECK (TRUE);


-- ──────────────────────────────────────────────────────────────
--  6. DADOS DE EXEMPLO — remova após testar
--     Demonstra os três segmentos mencionados: Roupas, Pods, Eletrônicos
-- ──────────────────────────────────────────────────────────────

/*
-- Roupas: produto_id = 101 (camiseta básica)
INSERT INTO produto_variacoes (produto_id, nome, sku, estoque_qtd) VALUES
  (101, 'Branco - P',  'CAM-BC-P',  12),
  (101, 'Branco - M',  'CAM-BC-M',  8),
  (101, 'Branco - G',  'CAM-BC-G',  5),
  (101, 'Preto - P',   'CAM-PT-P',  10),
  (101, 'Preto - M',   'CAM-PT-M',  0),   -- esgotado
  (101, 'Preto - G',   'CAM-PT-G',  3);

-- Eletrônicos: produto_id = 202 (carregador)
INSERT INTO produto_variacoes (produto_id, nome, sku, estoque_qtd, preco_adicional) VALUES
  (202, '110v',  'CAR-110', 20, 0),
  (202, '220v',  'CAR-220', 15, 0),
  (202, 'Bivolt','CAR-BIV', 7, 15000);   -- + Gs 15.000 pelo bivolt

-- Pods: produto_id = 303 (pod descartável 20mg)
INSERT INTO produto_variacoes (produto_id, nome, sku, estoque_qtd) VALUES
  (303, 'Melancia',       'POD-MEL', 30),
  (303, 'Menta',          'POD-MNT', 25),
  (303, 'Morango Gelado', 'POD-MRG', 18),
  (303, 'Uva',            'POD-UVA', 5);
*/


-- ──────────────────────────────────────────────────────────────
--  FIM DA MIGRAÇÃO
-- ──────────────────────────────────────────────────────────────
COMMENT ON TABLE produto_variacoes IS
  'Variações de produto para e-commerce varejo (tamanho, cor, sabor, voltagem…). '
  'Cada linha representa uma SKU vendável com controle de estoque independente.';

-- ──────────────────────────────────────────────────────────────
--  7. COLUNA vc_config NA TABELA configuracoes
--     Persiste a taxa de câmbio configurada pelo admin.
--     Execute apenas se a tabela configuracoes já existir.
-- ──────────────────────────────────────────────────────────────
ALTER TABLE configuracoes
  ADD COLUMN IF NOT EXISTS vc_config JSONB DEFAULT '{"ativo":false,"taxa":0,"posicao":"abaixo"}'::jsonb;

COMMENT ON COLUMN configuracoes.vc_config IS
  'Config de moeda dupla: {ativo:bool, taxa:number (1 R$ = X Gs), posicao:"abaixo"|"lado"}';

-- ──────────────────────────────────────────────────────────────
--  8. COLUNAS VAREJO NA TABELA produtos
--     unidade_venda, destaque, promo_ativo, promo_tipo, promo_valor
-- ──────────────────────────────────────────────────────────────

ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS unidade_venda TEXT     DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS destaque      BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS promo_ativo   BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS promo_tipo    TEXT     DEFAULT 'percent'
    CHECK (promo_tipo IN ('percent', 'fixo', NULL)),
  ADD COLUMN IF NOT EXISTS promo_valor   NUMERIC(14,2) DEFAULT NULL;

-- Índice para a página inicial buscar só os destaques rapidamente
CREATE INDEX IF NOT EXISTS idx_produtos_destaque
  ON produtos (destaque) WHERE destaque = TRUE AND ativo = TRUE;

-- View: produtos em promoção ativos
CREATE OR REPLACE VIEW produtos_em_promocao AS
SELECT
  id, nome, categoria_slug, preco,
  promo_tipo, promo_valor,
  CASE
    WHEN promo_tipo = 'percent' THEN ROUND(preco * (1 - promo_valor / 100))
    WHEN promo_tipo = 'fixo'    THEN ROUND(preco - promo_valor)
    ELSE preco
  END AS preco_final,
  imagem_url, destaque, unidade_venda
FROM produtos
WHERE ativo = TRUE AND promo_ativo = TRUE
ORDER BY destaque DESC, nome;

COMMENT ON COLUMN produtos.unidade_venda IS 'Unidade de venda: un, pack, kg, g, l, ml, cx, fardo, duzia, par';
COMMENT ON COLUMN produtos.destaque      IS 'Se TRUE aparece primeiro no grid e na página inicial';
COMMENT ON COLUMN produtos.promo_ativo   IS 'Flag de promoção ativa';
COMMENT ON COLUMN produtos.promo_tipo    IS 'Tipo do desconto: percent (%) ou fixo (Gs)';
COMMENT ON COLUMN produtos.promo_valor   IS 'Valor do desconto: percentual ou valor fixo';

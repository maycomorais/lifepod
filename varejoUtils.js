// ═══════════════════════════════════════════════════════════════
//  varejoUtils.js — Preços por faixa de quantidade
//  Usado por: app.js (cliente) e admin.js (PDV)
//  Carregar ANTES do app.js / admin.js
// ═══════════════════════════════════════════════════════════════

/**
 * Extrai a config de faixas do produto.
 * Aceita montagem_config ou montagem, JSONB ou string.
 */
function vfBuscarConfigFaixa(produto) {
  if (!produto) return null;
  let cfg = produto.montagem_config ?? produto.montagem;
  if (typeof cfg === "string") {
    try { cfg = JSON.parse(cfg); } catch { return null; }
  }
  return cfg?.faixas_preco || null;
}

/**
 * Retorna { price, tierIndex } para uma quantidade total.
 *   tierIndex 0 = preço unitário base
 *   tierIndex 1 = desconto "a partir de N1"
 *   tierIndex 2 = atacado "a partir de N2"
 */
function vfGetTierPrice(cfg, qtdTotal) {
  if (!cfg) return { price: 0, tierIndex: 0 };
  const q = Math.max(1, parseInt(qtdTotal, 10) || 1);

  if (cfg.faixa2_preco && cfg.faixa2_min && q >= cfg.faixa2_min) {
    return { price: Number(cfg.faixa2_preco), tierIndex: 2 };
  }
  if (cfg.faixa1_preco && cfg.faixa1_min && q >= cfg.faixa1_min) {
    return { price: Number(cfg.faixa1_preco), tierIndex: 1 };
  }
  return { price: Number(cfg.unitario || 0), tierIndex: 0 };
}

/**
 * Retorna o próximo degrau ou null.
 * { faltam, preco, label }
 */
function vfGetProximoDegrau(cfg, qtdTotal) {
  if (!cfg) return null;
  const q = Math.max(1, parseInt(qtdTotal, 10) || 1);

  // Está no atacado? Não tem mais pra onde subir
  if (cfg.faixa2_preco && cfg.faixa2_min && q >= cfg.faixa2_min) return null;

  // Está no meio (tier 1) → próximo é atacado
  if (cfg.faixa1_preco && cfg.faixa1_min && q >= cfg.faixa1_min && cfg.faixa2_preco) {
    return {
      faltam: cfg.faixa2_min - q,
      preco: Number(cfg.faixa2_preco),
      label: "atacado",
    };
  }

  // Está no base (tier 0) → próximo é faixa 1
  if (cfg.faixa1_preco && cfg.faixa1_min && q < cfg.faixa1_min) {
    return {
      faltam: cfg.faixa1_min - q,
      preco: Number(cfg.faixa1_preco),
      label: "desconto",
    };
  }

  return null;
}

function vfFmtGs(n) {
  return "Gs " + Math.round(Number(n) || 0).toLocaleString("es-PY");
}

/**
 * Recalcula o preço unitário de todos os itens do carrinho que tenham faixas.
 *
 * Regras:
 *  - Agrupa por produto_id (variação/obs não separam — é o MESMO produto)
 *  - Soma as quantidades de todos os itens do grupo
 *  - Aplica a faixa a TODOS os itens do grupo
 *  - Extras (_extrasSoma) são somados por cima do preço da faixa
 *
 * @param {Array}    carrinho
 * @param {Function} buscarProdutoPorId  — callback que retorna o produto (de cache local)
 */
function vfRecalcularCarrinho(carrinho, buscarProdutoPorId) {
  if (!Array.isArray(carrinho) || !carrinho.length) return;

  // 1. Agrupa por produto_id
  const grupos = {};
  carrinho.forEach((item, idx) => {
    const pid = item.produto_id ?? item.id;
    if (!pid) return;
    if (!grupos[pid]) grupos[pid] = { totalQtd: 0, indices: [] };
    grupos[pid].totalQtd += parseInt(item.qtd, 10) || 1;
    grupos[pid].indices.push(idx);
  });

  // 2. Aplica faixa por grupo
  Object.entries(grupos).forEach(([pid, info]) => {
    const prod = buscarProdutoPorId(pid);
    if (!prod) return;
    const cfg = vfBuscarConfigFaixa(prod);
    if (!cfg || !cfg.unitario) return;

    const { price, tierIndex } = vfGetTierPrice(cfg, info.totalQtd);

    info.indices.forEach((idx) => {
      const item = carrinho[idx];
      const extrasSoma = Number(item._extrasSoma || 0);
      item.preco = price + extrasSoma;
      item._faixaAplicada = price;
      item._faixaQtdTotal = info.totalQtd;
      item._faixaTier = tierIndex;
    });
  });
}

if (typeof window !== "undefined") {
  window.vfBuscarConfigFaixa    = vfBuscarConfigFaixa;
  window.vfGetTierPrice         = vfGetTierPrice;
  window.vfGetProximoDegrau     = vfGetProximoDegrau;
  window.vfFmtGs                = vfFmtGs;
  window.vfRecalcularCarrinho   = vfRecalcularCarrinho;
}
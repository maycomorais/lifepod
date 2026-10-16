// ==========================================
// 1. CONFIGURAÇÕES & DADOS GERAIS
// ==========================================
let FONE_LOJA = "";
let COORD_LOJA = { lat: 0, lng: 0 };
let COTACAO_REAL = "";
let autoConfirmTimer = null;

// DADOS DE PAGAMENTO (Pix e Alias)
let CHAVE_PIX = "";
let NOME_PIX = "";
let DADOS_ALIAS = ""; // Transferência Banco Ueno
let ALIAS_PY = ""; // Titular Banco Ueno
let QR_ALIAS_URL = ""; // QR Code Alias
let QR_PY_URL = ""; // QR Code Paraguay
let WHATSAPP_LOJA_APP = ""; // WhatsApp da loja (dígitos)
let NOME_RESTAURANTE_APP = ""; // Nome da loja para mensagem WhatsApp
let LIMITE_DISTANCIA_KM = null; // Limite de distância para delivery
let TAXA_DEBITO_BR = 0; // Taxa cartão débito (%)
let TAXA_CREDITO_BR = 0; // Taxa cartão crédito (%)
let CFG_LOGO_URL = ""; // Logo da loja (para notificações push)

// ── Fallback defensivo: se freteUtils.js falhar ao carregar,
//    define stubs que evitam o crash do fluxo de frete.
//    (só sobrescreve se as funções reais não existirem) ─────────
if (typeof obterDistanciaPelaRota !== "function") {
  console.error(
    "[app.js] ⚠️ freteUtils.js não carregou. Usando fallback sem OSRM.",
  );
  window.obterDistanciaPelaRota = async () => null; // força fallback Haversine/sem-localização
}

if (typeof calcularFreteSemLocalizacao !== "function") {
  console.error("[app.js] ⚠️ calcularFreteSemLocalizacao ausente — usando stub.");
  window.calcularFreteSemLocalizacao = (tabelaFrete) => {
    const idx = 2; // faixa 2,1–3 km
    const faixa = Array.isArray(tabelaFrete) ? tabelaFrete[idx] : null;
    if (faixa?.acombinar === true) {
      return { loja: 0, motoboy: 0, index: idx, distancia: null, semLocalizacao: true, acombinar: true };
    }
    return {
      loja:    Number(faixa?.loja)    || 12000,
      motoboy: Number(faixa?.motoboy) || 12000,
      index: idx,
      distancia: null,
      semLocalizacao: true,
      acombinar: false,
    };
  };
}

if (typeof calcularFretePorDistancia !== "function") {
  window.calcularFretePorDistancia = (distKm, tabelaFrete) => {
    const limites = [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20];
    const fallback = [
      6000,9000,12000,15000,18000,21000,24000,27000,30000,33000,
      36000,39000,42000,45000,48000,51000,54000,57000,60000,63000,
    ];
    let idx = limites.findIndex(l => distKm <= l);
    if (idx === -1) idx = limites.length - 1;
    const faixa = Array.isArray(tabelaFrete) ? tabelaFrete[idx] : null;
    if (faixa?.acombinar === true) {
      return { loja: 0, motoboy: 0, index: idx, distancia: distKm, acombinar: true };
    }
    return {
      loja:    Number(faixa?.loja)    || fallback[idx],
      motoboy: Number(faixa?.motoboy) || fallback[idx],
      index: idx,
      distancia: distKm,
      acombinar: false,
    };
  };
}

async function carregarConfiguracoesLoja() {
  const { data, error } = await supa
    .from("configuracoes")
    .select(
      "whatsapp_loja, telefone_loja, coord_lat, coord_lng, chave_pix, nome_pix, dados_alias, nome_alias, nome_restaurante, cotacao_real, limite_distancia_km",
    )
    .maybeSingle();

  if (!data || error) return;

  if (data.whatsapp_loja) FONE_LOJA = data.whatsapp_loja;
  if (data.telefone_loja && !FONE_LOJA) FONE_LOJA = data.telefone_loja;
  if (data.coord_lat)
    COORD_LOJA = {
      lat: parseFloat(data.coord_lat),
      lng: parseFloat(data.coord_lng),
    };
  if (data.chave_pix) CHAVE_PIX = data.chave_pix;
  if (data.nome_pix) NOME_PIX = data.nome_pix;
  if (data.dados_alias) DADOS_ALIAS = data.dados_alias;
  if (data.nome_alias) ALIAS_PY = data.nome_alias;
  // Cotação precisa estar pronta ANTES de renderMenu para exibir preço em R$
  if (data.cotacao_real) COTACAO_REAL = Number(data.cotacao_real);
  // Limite de distância precisa estar pronto antes do calcularFrete
  if (data.limite_distancia_km != null)
    LIMITE_DISTANCIA_KM = parseFloat(data.limite_distancia_km) || null;
}

function iniciarTimerAutoConfirmacao(pedidoId) {
  // 4 horas em milissegundos
  const QUATRO_HORAS = 4 * 60 * 60 * 1000;

  // Cancela timer anterior se existir
  if (autoConfirmTimer) {
    clearTimeout(autoConfirmTimer);
  }

  // Inicia novo timer
  autoConfirmTimer = setTimeout(async () => {
    console.log("⏰ 4 horas passadas, confirmando entrega automaticamente...");
    await confirmarEntregaAutomatica(pedidoId);
  }, QUATRO_HORAS);

  // Salva timestamp no localStorage para persistir entre reloads
  const agora = new Date().getTime();
  const tempoExpiracao = agora + QUATRO_HORAS;
  localStorage.setItem("locanda_confirmExpiry_" + pedidoId, tempoExpiracao);

  console.log("⏰ Timer de auto-confirmação iniciado para 4 horas");
}

// ===== FUNÇÃO PARA RESTAURAR TIMER APÓS RELOAD =====
function restaurarTimerSeNecessario() {
  const pedidoId = localStorage.getItem("locanda_pedido_id");
  if (!pedidoId) return;

  const tempoExpiracao = localStorage.getItem(
    "locanda_confirmExpiry_" + pedidoId,
  );
  if (!tempoExpiracao) return;

  const agora = new Date().getTime();
  const tempoRestante = parseInt(tempoExpiracao) - agora;

  if (tempoRestante > 0) {
    // Ainda há tempo restante
    console.log("⏰ Restaurando timer de auto-confirmação...");
    autoConfirmTimer = setTimeout(async () => {
      await confirmarEntregaAutomatica(pedidoId);
    }, tempoRestante);
  } else {
    // Tempo já expirou, confirmar agora
    console.log("⏰ Tempo expirado, confirmando agora...");
    confirmarEntregaAutomatica(parseInt(pedidoId));
  }
}

// ===== CONFIRMAÇÃO AUTOMÁTICA (4 HORAS) =====
async function confirmarEntregaAutomatica(pedidoId) {
  try {
    const { error } = await supa
      .from("pedidos")
      .update({
        status: "entregue",
        tempo_entregue: new Date().toISOString(),
      })
      .eq("id", parseInt(pedidoId)); // parseInt garante que não é string

    if (error) throw error;

    console.log("✅ Entrega confirmada automaticamente após 4 horas");

    // Limpa dados locais
    localStorage.removeItem("locanda_confirmExpiry_" + pedidoId);
    fecharTracker();

    // Mostra notificação
    if (Notification.permission === "granted") {
      new Notification("Pedido Entregue ✅", {
        body: "Sua entrega foi confirmada automaticamente. Obrigado!",
      });
    }
  } catch (err) {
    console.error("Erro ao confirmar entrega automática:", err);
  }
}

// ===== CONFIRMAÇÃO MANUAL (CLIENTE) =====
// ── trava anti-duplo-clique para confirmação de entrega ──────────────
let _confirmandoEntrega = false;

async function confirmarEntregaCliente() {
  if (_confirmandoEntrega) return; // duplo-clique bloqueado

  const pedidoId = localStorage.getItem("locanda_pedido_id");
  if (!pedidoId) {
    alert("Erro: Pedido não encontrado");
    return;
  }

  if (!confirm("Confirmar que você recebeu o pedido?")) {
    return;
  }

  _confirmandoEntrega = true;

  // Desabilita o botão visualmente enquanto processa
  const _btnConf = document.getElementById("btn-confirmar-entrega");
  const _txtOrig = _btnConf ? _btnConf.innerHTML : "";
  if (_btnConf) {
    _btnConf.disabled = true;
    _btnConf.innerHTML = "⏳ Confirmando...";
    _btnConf.style.opacity = "0.6";
  }

  try {
    const { error } = await supa
      .from("pedidos")
      .update({
        status: "entregue",
        tempo_entregue: new Date().toISOString(),
      })
      .eq("id", parseInt(pedidoId));

    if (error) throw error;

    console.log("✅ Entrega confirmada pelo cliente");

    // Cancela timer automático
    if (autoConfirmTimer) {
      clearTimeout(autoConfirmTimer);
    }
    localStorage.removeItem("locanda_confirmExpiry_" + pedidoId);

    // Atualiza UI
    mostrarMensagemEntregaConfirmada();

    // Fecha tracker após 3 segundos
    setTimeout(() => {
      fecharTracker();
    }, 3000);
  } catch (err) {
    console.error("Erro ao confirmar entrega:", err);
    alert("Erro ao confirmar entrega. Tente novamente.");
    // Reabilita em caso de erro para o cliente poder tentar de novo
    _confirmandoEntrega = false;
    if (_btnConf) {
      _btnConf.disabled = false;
      _btnConf.innerHTML = _txtOrig;
      _btnConf.style.opacity = "1";
    }
  }
}

// Helper: retorna tradução do idioma atual, com interpolação {var}
function _t(key, vars = {}) {
  const lang =
    typeof getCurrentLanguage === "function"
      ? getCurrentLanguage()
      : localStorage.getItem("language") || "es";
  const t =
    typeof translations !== "undefined" && translations[lang]
      ? translations[lang]
      : {};
  let str = t[key];
  if (!str) {
    // Fallback: usa o idioma padrão se a chave não existir
    str = translations?.es?.[key];
  }
  if (!str) return key; // última instância: devolve a chave
  // Interpolação {var}
  Object.entries(vars).forEach(([k, v]) => {
    str = str.replace(new RegExp(`\\{${k}\\}`, "g"), v);
  });
  return str;
}

// ===== MOSTRAR MENSAGEM DE CONFIRMAÇÃO =====
function mostrarMensagemEntregaConfirmada() {
  const tracker = document.getElementById("pedido-tracker");
  if (!tracker) return;

  // Atualiza conteúdo do tracker
  tracker.innerHTML = `
        <div style="text-align:center; padding:20px;">
            <div style="font-size:3rem; margin-bottom:10px;">✅</div>
            <div style="font-weight:700; font-size:1.2rem; color:#27ae60; margin-bottom:5px;">
                Entrega Confirmada!
            </div>
            <div style="font-size:0.9rem; color:#666;">
                Obrigado pela preferência!
            </div>
        </div>
    `;
}

// ===== ATUALIZAR FUNÇÃO mostrarTracker() EXISTENTE =====
// SUBSTITUA a função mostrarTracker() por esta versão atualizada:

async function mostrarTracker(status, uidPedido) {
  // Fix #9: busca dados do motoboy do banco antes de atualizar o visual
  let motoboy = null;
  try {
    const pedidoId = localStorage.getItem("locanda_pedido_id");
    if (pedidoId && (status === "saiu_entrega" || status === "entregue")) {
      const { data: p } = await supa
        .from("pedidos")
        .select("motoboy_id")
        .eq("id", pedidoId)
        .single();
      if (p && p.motoboy_id) {
        const { data: m } = await supa
          .from("motoboys")
          .select("nome, telefone")
          .eq("id", p.motoboy_id)
          .single();
        motoboy = m || null;
      }
    }
  } catch (_) {
    /* falha silenciosa */
  }

  atualizarTrackingVisual(status, motoboy);

  const card = document.getElementById("track-order-card");
  if (card) card.style.display = "block";

  const tn = document.getElementById("track-numero");
  if (tn) tn.textContent = uidPedido;

  const tf = document.getElementById("track-form");
  const tr = document.getElementById("track-result");
  if (tf) tf.style.display = "none";
  if (tr) tr.style.display = "block";

  // Botão confirmar entrega se saiu para entrega
  const pedidoId = localStorage.getItem("locanda_pedido_id");
  if (status === "saiu_entrega" && pedidoId) {
    const tr2 = document.getElementById("track-result");
    if (tr2 && !document.getElementById("btn-confirmar-entrega")) {
      tr2.insertAdjacentHTML(
        "beforeend",
        `
                <button id="btn-confirmar-entrega" onclick="confirmarEntregaCliente()" 
                        style="width:100%; margin-top:12px; padding:12px; background:#27ae60; color:white; 
                               border:none; border-radius:8px; font-weight:600; cursor:pointer; font-size:1rem;">
                    ✅ Confirmar Recebimento
                </button>
            `,
      );
    }
    const tempoExpiracao = localStorage.getItem(
      "locanda_confirmExpiry_" + pedidoId,
    );
    if (!tempoExpiracao) iniciarTimerAutoConfirmacao(pedidoId);
  }

  if (status === "entregue") {
    mostrarMensagemEntregaConfirmada();
    if (autoConfirmTimer) clearTimeout(autoConfirmTimer);
    localStorage.removeItem("locanda_confirmExpiry_" + pedidoId);
  }
}

// Validação de segurança do Supabase
if (typeof supa === "undefined") {
  console.error(
    "ERRO: O arquivo supabaseClient.js não foi carregado antes do app.js",
  );
  // Não bloqueamos o app, mas avisamos no console
}

// ==========================================
// 2. ESTADO DA APLICAÇÃO (Variáveis Globais)
// ==========================================
let carrinho = [];
let freteCalculado = 0;
let freteMotoboy = 0;
let freteACombinar = false; // mantido para compat — sempre false agora
let freteSemGPS = false; // NOVO: cliente negou GPS / usou checkbox
let localCliente = null;
let modoEntrega = "delivery";
let prodAtual = null,
  optAtual = null,
  qtd = 1;
let itensMontagem = {};
let cupomAplicado = null;
let EXTRAS_GLOBAIS = [];
let TABELA_FRETE = null;

// ==========================================
// VARIÁVEIS DE CONTROLE DE HORÁRIO
// ==========================================
let LOJA_CONFIG = null; // Configurações da loja
let EXTENSAO_HORARIO_TEMP = 0; // Extensão temporária do horário (em minutos) - só para hoje
let ALERTA_15MIN_MOSTRADO = false; // Controle para não mostrar o alerta múltiplas vezes
let PROXIMO_FECHAMENTO = null; // Próximo horário de fechamento
let MODO_AGENDAMENTO = false; // Se o pedido é agendado para outra hora
let DATA_AGENDAMENTO = null; // Data/hora do agendamento

// Variável Global de Menu (Preenchida via Banco)
let MENU = {
  promocoes_do_dia: [],
  pratos_especiais: [],
  pizzas: [],
  pratos_quentes: [],
  sobremesas: [],
  bebidas: [],
  upsell: [],
};

// ==========================================
// 3. INICIALIZAÇÃO
// ==========================================
document.addEventListener("DOMContentLoaded", async () => {
  await carregarConfiguracoesLoja();
  // 1. Carrega dados salvos (Nome, Tel, Último Pedido)
  carregarDadosLocal();

  // 2. Renderiza o Menu vindo do Banco de Dados
  await renderMenu();

  // 3. Verifica Horário de Funcionamento e Banner
  await verificarHorario();

  // 4. Restaura tracking se houver pedido ativo
  restaurarTrackingSeExistir();

  // Restaura timer se página foi recarregada durante entrega
  restaurarTimerSeNecessario();

  // 5. Carrega extras globais (adicionais que aparecem em todos os produtos)
  await carregarExtrasGlobais();

  // Restaura backup do carrinho APÓS o menu estar pronto (fix #13)
  restaurarCarrinhoBackup();

  // 6. Inicia Realtime para atualizar formas de pagamento instantaneamente
  _iniciarRealtimeConfiguracoes();

  const overlay = document.getElementById("loading-overlay");
  if (overlay) {
    overlay.style.opacity = "0";
    setTimeout(() => {
      overlay.style.display = "none";
    }, 300);
  }
});

// Carrega os extras globais da tabela configuracoes
// (coluna extras_globais pode não existir ainda — SQL: ALTER TABLE configuracoes ADD COLUMN extras_globais JSONB DEFAULT '[]')
async function carregarExtrasGlobais() {
  try {
    // Tenta buscar com a coluna extras_globais
    const { data, error } = await supa
      .from("configuracoes")
      .select("extras_globais")
      .single();

    // Se der erro de coluna não encontrada, ignora silenciosamente
    if (error) {
      if (error.message && error.message.includes("extras_globais")) {
        console.log(
          "ℹ️ Coluna extras_globais não existe no banco. Usando array vazio.",
        );
      } else if (error.code === "PGRST204" || error.code === "42703") {
        // Código de erro do PostgREST para coluna não encontrada
        console.log(
          "ℹ️ Coluna extras_globais não existe no banco. Usando array vazio.",
        );
      } else {
        console.warn("Erro ao carregar extras globais:", error.message);
      }
      EXTRAS_GLOBAIS = [];
      return;
    }

    if (
      data &&
      Array.isArray(data.extras_globais) &&
      data.extras_globais.length > 0
    ) {
      EXTRAS_GLOBAIS = data.extras_globais;
      console.log(
        "✅ Extras globais carregados:",
        EXTRAS_GLOBAIS.length,
        "itens",
      );
    } else {
      EXTRAS_GLOBAIS = [];
    }
  } catch (e) {
    // Coluna ainda não existe no banco — ignora silenciosamente
    console.log("ℹ️ Extras globais não disponíveis:", e.message);
    EXTRAS_GLOBAIS = [];
  }
}

// ==========================================
// 4. FUNÇÕES DE BANCO DE DADOS E MENU
// ==========================================

// ── Aplica visibilidade das formas de pagamento no checkout do cliente ──
function _aplicarFormasPagamentoCliente(features) {
  // pagamentos_app tem prioridade; fallback para pagamentos (retrocompatibilidade)
  const pags = features?.pagamentos_app ?? features?.pagamentos;
  const select = document.getElementById("forma-pag");
  if (!select || !pags) return;
  Array.from(select.options).forEach((opt) => {
    if (!opt.value) return; // placeholder
    // A chave no JSONB é o próprio opt.value (ex: "Efetivo", "Pix", "CartaoBR")
    // Para retrocompatibilidade com o schema legado (chaves lowercase), verifica ambos
    const legadoMapa = {
      Efetivo: "Efetivo",
      Cartao: "Cartao",
      CartaoBR: "CartaoBR",
      Pix: "Pix",
      Transferencia: "Transferencia",
      QrPy: "QrPy",
      Multipagamento: "Multipagamento",
    };
    const chave = legadoMapa[opt.value] || opt.value;
    if (pags[chave] === false) {
      opt.style.display = "none";
      // Se a opção escondida estava selecionada, reset para vazio
      if (select.value === opt.value) select.value = "";
    } else {
      opt.style.display = "";
    }
  });
}

// Verifica Horário e Atualiza Banner
async function verificarHorario() {
  const { data } = await supa.from("configuracoes").select("*").maybeSingle();
  if (!data) return;

  if (data.cotacao_real) COTACAO_REAL = data.cotacao_real;
  if (data.tabela_frete && Array.isArray(data.tabela_frete))
    TABELA_FRETE = data.tabela_frete;
  if (data.limite_distancia_km != null)
    LIMITE_DISTANCIA_KM = parseFloat(data.limite_distancia_km) || null;
  // Aplica visibilidade das formas de pagamento conforme configuração
  _aplicarFormasPagamentoCliente(data.features_ativas);
  if (data.taxa_debito != null) TAXA_DEBITO_BR = Number(data.taxa_debito);
  if (data.taxa_credito != null) TAXA_CREDITO_BR = Number(data.taxa_credito);

  // ── Dados de pagamento do banco ────────────────────────────────
  if (data.chave_pix) CHAVE_PIX = data.chave_pix;
  if (data.nome_pix) NOME_PIX = data.nome_pix;
  if (data.dados_alias) DADOS_ALIAS = data.dados_alias;
  if (data.nome_alias) ALIAS_PY = data.nome_alias;
  if (data.alias_qr_url) QR_ALIAS_URL = data.alias_qr_url;
  if (data.qr_py_url) QR_PY_URL = data.qr_py_url;
  if (data.whatsapp_loja) WHATSAPP_LOJA_APP = data.whatsapp_loja;

  const agora = new Date();
  const horaAtual = agora.getHours() * 60 + agora.getMinutes();
  // 0=Dom,1=Seg...6=Sab → mapeia para as chaves do objeto
  const diaKeys = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
  const diaKey = diaKeys[agora.getDay()];

  function horaParaMin(str) {
    if (!str) return null;
    const [h, m] = str.split(":").map(Number);
    return h * 60 + m;
  }

  function turnoAtivo(turno) {
    const abre = horaParaMin(turno.abre);
    const fecha = horaParaMin(turno.fecha);
    if (abre === null || fecha === null) return false;
    // Suporte a virada de meia-noite (ex: 18:30 às 01:00)
    if (fecha < abre) return horaAtual >= abre || horaAtual < fecha;
    return horaAtual >= abre && horaAtual < fecha;
  }

  // Lógica de Aberto/Fechado usando grade semanal
  let estaAberto = false;
  if (data.loja_aberta) {
    const hs = data.horarios_semanais;
    if (hs && hs[diaKey]) {
      const diaConfig = hs[diaKey];

      // Dia explicitamente fechado na grade
      if (diaConfig.fechado) {
        estaAberto = false;
      } else {
        // Filtra turnos válidos (exclui {abre:"", fecha:""})
        const turnosValidos = (diaConfig.turnos || []).filter(
          (t) => t.abre && t.fecha,
        );

        if (turnosValidos.length > 0) {
          // Há turnos configurados → segue o horário
          estaAberto = turnosValidos.some(turnoAtivo);
        } else {
          // Dia não está fechado mas não tem horário definido → considera aberto
          estaAberto = true;
        }
      }
    } else if (hs && Object.keys(hs).length > 0) {
      // Grade existe mas não tem entrada para hoje → aberto
      estaAberto = true;
    } else {
      // Sem grade configurada → loja_aberta=true é suficiente para abrir
      estaAberto = true;
    }
  }

  const badge = document.querySelector(".badge-status");
  if (badge) {
    // Obtém o idioma atual para traduzir Aberto/Fechado
    const lang = localStorage.getItem("language") || "es";
    const textos = {
      es: { aberto: "Abierto", fechado: "Cerrado" },
      pt: { aberto: "Aberto", fechado: "Fechado" },
      en: { aberto: "Open", fechado: "Closed" },
      de: { aberto: "Geöffnet", fechado: "Geschlossen" },
    };
    const t = textos[lang] || textos.es;

    if (estaAberto) {
      badge.innerText = t.aberto;
      badge.classList.remove("closed");
      badge.classList.add("open");
    } else {
      badge.innerText = t.fechado;
      badge.classList.remove("open");
      badge.classList.add("closed");
    }
  }

  // Atualiza Banners Promocionais (banner 1 e banner 2)
  const bannerImgs = [
    document.getElementById("banner1-img") ||
      document.querySelectorAll(".banner-track img")[0],
    document.getElementById("banner2-img") ||
      document.querySelectorAll(".banner-track img")[1],
  ];

  // Banner 1
  if (data.banner_imagem && data.banner_produto_id && bannerImgs[0]) {
    bannerImgs[0].src = data.banner_imagem;
    bannerImgs[0].style.display = "block";
    bannerImgs[0].style.cursor = "pointer";
    bannerImgs[0].onclick = function () {
      clicarBanner(data.banner_produto_id);
    };
  } else if (bannerImgs[0] && !data.banner_imagem) {
    bannerImgs[0].style.display = "none";
  }

  // Banner 2
  if (data.banner2_imagem && data.banner2_produto_id && bannerImgs[1]) {
    bannerImgs[1].src = data.banner2_imagem;
    bannerImgs[1].style.display = "block";
    bannerImgs[1].style.cursor = "pointer";
    bannerImgs[1].onclick = function () {
      clicarBanner(data.banner2_produto_id);
    };
  } else if (bannerImgs[1] && !data.banner2_imagem) {
    bannerImgs[1].style.display = "none";
  }

  // Atualiza nome da loja no header
  const nomeVal = data.nome_restaurante || data.nome_loja || "";
  NOME_RESTAURANTE_APP = nomeVal; // ← torna disponível para mensagem WhatsApp
  const nomeEl = document.getElementById("nome-loja-app");
  if (nomeEl && nomeVal) {
    nomeEl.textContent = nomeVal;
    document.title = nomeVal + " — Delivery";
  }

  // Coordenadas da loja (para cálculo de frete)
  // Coordenadas da loja — parseFloat preserva 0 legítimo
  if (data.coord_lat != null && data.coord_lng != null) {
    COORD_LOJA.lat = parseFloat(data.coord_lat) || 0;
    COORD_LOJA.lng = parseFloat(data.coord_lng) || 0;
  }

  // Logo
  const logoEl = document.getElementById("logo-app");
  const logoUrl = data.logo_url || data.icone_url || "";
  CFG_LOGO_URL = logoUrl; // disponível para notificações push
  if (logoEl && logoUrl) {
    logoEl.src = logoUrl;
    logoEl.style.display = "block";
    logoEl.style.objectFit = "contain";
    logoEl.style.width = "44px";
    logoEl.style.height = "44px";
    logoEl.style.borderRadius = "50%";
    logoEl.style.filter = "none";
    logoEl.style.webkitFilter = "none";
  }

  if (data.cor_primaria) {
    document.documentElement.style.setProperty("--primary", data.cor_primaria);
  }
}

// Renderiza o Menu (Categories + Produtos com subcategorias)

// ── Verifica se a loja está aberta para receber pedidos agora ─────────────
// Retorna { aberto: true/false, proximoDia: string|null }
function verificarLojaAbertaParaPedido() {
  const badge = document.querySelector(".badge-status");
  const estaAberto = badge && badge.classList.contains("open");
  // Se não conseguiu determinar pelo badge, assume aberto (evita bloquear por engano)
  if (!badge) return { aberto: true, proximoDia: null };
  return { aberto: estaAberto, proximoDia: null };
}

// ── Mostra alerta quando a loja está fechada ──────────────────────────────
function mostrarAlertaLojaFechada(proximoDia) {
  const lang = localStorage.getItem("language") || "es";
  const msgs = {
    es: "El local está cerrado en este momento. Por favor intente más tarde.",
    pt: "A loja está fechada no momento. Por favor tente mais tarde.",
    en: "The store is currently closed. Please try again later.",
    de: "Das Geschäft ist derzeit geschlossen. Bitte versuchen Sie es später.",
  };
  alert(msgs[lang] || msgs.es);
}

// ── Mostra badge de agendamento no checkout ───────────────────────────────
function mostrarIndicadorAgendamento() {
  let indicador = document.getElementById("indicador-agendamento");
  if (indicador) return; // Já existe

  indicador = document.createElement("div");
  indicador.id = "indicador-agendamento";
  indicador.style.cssText = [
    "background:#fff3cd;border:1.5px solid #f0a500;border-radius:8px",
    "padding:10px 14px;font-size:0.85rem;font-weight:600;color:#856404",
    "margin-bottom:10px;display:flex;align-items:center;gap:8px",
  ].join(";");
  indicador.innerHTML = `📅 Pedido agendado${DATA_AGENDAMENTO ? ` para ${DATA_AGENDAMENTO}` : ""}`;

  const lista = document.getElementById("carrinho-lista");
  if (lista && lista.parentElement) {
    lista.parentElement.insertBefore(indicador, lista);
  }
}

async function renderMenu() {
  const nav = document.getElementById("category-nav");
  const content = document.getElementById("menu-content");

  if (!nav || !content) return;

  nav.innerHTML = "";
  content.innerHTML = "";

  // Busca Categorias, Subcategorias e Produtos ativos
  const { data: categsDb } = await supa
    .from("categorias")
    .select("*")
    .eq("ativo", true)
    .order("ordem");
  let subcatsDb = [];
  try {
    const { data: _subs } = await supa
      .from("subcategorias")
      .select("*")
      .order("categoria_slug,ordem");
    subcatsDb = _subs || [];
  } catch (_) {
    subcatsDb = [];
  }
  const { data: produtos } = await supa
    .from("produtos")
    .select("*")
    .eq("ativo", true)
    .order("categoria_slug", { ascending: true })
    .order("ordem", { ascending: true })
    .limit(5000);

  if (!produtos || !categsDb) {
    console.error("Erro ao carregar menu do banco");
    return;
  }

  // Diagnóstico removido — campo confirmado: 'destaque' no banco

  const subcats = subcatsDb || [];

  // Monta mapa: categoria_slug -> lista de subcategorias
  const subcatPorCat = {};
  subcats.forEach((s) => {
    if (!subcatPorCat[s.categoria_slug]) subcatPorCat[s.categoria_slug] = [];
    subcatPorCat[s.categoria_slug].push(s);
  });

  // Monta mapa: subcategoria_slug -> produtos
  // Monta mapa: categoria_slug -> produtos SEM subcategoria
  const prodPorSubcat = {};
  const prodSemSubcat = {};

  // Mapas globais para acesso por categoria (usados na paginação lazy)
  window._PROD_POR_SUBCAT = {};
  window._PROD_SEM_SUBCAT = {};
  window._SUBCATS = subcats;
  window._SUBCATPORCAT = {};
  subcats.forEach((s) => {
    if (!window._SUBCATPORCAT[s.categoria_slug])
      window._SUBCATPORCAT[s.categoria_slug] = [];
    window._SUBCATPORCAT[s.categoria_slug].push(s);
  });

  produtos.forEach((p) => {
    const cat = p.categoria_slug || ""; // garante string, nunca null
    const sub = p.subcategoria_slug || null;
    const item = {
      id: p.id,
      nome: p.nome,
      desc: p.descricao,
      preco: p.preco,
      preco_original: p.preco_original || null,
      em_promocao: !!(p.em_promocao || p.promo_ativo),
      em_destaque: !!(p.destaque || p.em_destaque || p.featured),
      img: p.imagem_url,
      montagem: p.montagem_config,
      e_montavel: p.e_montavel,
      subcategoria_slug: sub || null,
      categoria_slug: cat || "",
    };

    if (sub) {
      if (!prodPorSubcat[sub]) prodPorSubcat[sub] = [];
      prodPorSubcat[sub].push(item);
      if (!window._PROD_POR_SUBCAT[sub]) window._PROD_POR_SUBCAT[sub] = [];
      window._PROD_POR_SUBCAT[sub].push(item);
    } else {
      if (!prodSemSubcat[cat]) prodSemSubcat[cat] = [];
      prodSemSubcat[cat].push(item);
      if (!window._PROD_SEM_SUBCAT[cat]) window._PROD_SEM_SUBCAT[cat] = [];
      window._PROD_SEM_SUBCAT[cat].push(item);
    }

    // Mantém MENU global para compatibilidade com outros lugares do código
    if (!MENU[cat]) MENU[cat] = [];
    MENU[cat].push(item);
  });

  // Filtro de horário
  const agora = new Date();
  const minAgora = agora.getHours() * 60 + agora.getMinutes();

  function categoriaVisivel(cat) {
    if (Array.isArray(cat.dias_semana) && cat.dias_semana.length > 0) {
      const mapa = { dom: 0, seg: 1, ter: 2, qua: 3, qui: 4, sex: 5, sab: 6 };
      const diaAtual = agora.getDay();
      const diasNum = cat.dias_semana
        .map((d) => mapa[d])
        .filter((n) => n !== undefined);
      if (!diasNum.includes(diaAtual)) return false;
    }
    if (!cat.hora_inicio || !cat.hora_fim) return true;
    const [hI, mI] = cat.hora_inicio.split(":").map(Number);
    const [hF, mF] = cat.hora_fim.split(":").map(Number);
    const inicio = hI * 60 + mI;
    const fim = hF * 60 + mF;
    if (fim < inicio) return minAgora >= inicio || minAgora <= fim;
    return minAgora >= inicio && minAgora <= fim;
  }

  function renderProdutoDiv(item) {
    const img = item.img || "";
    let cfg = item.montagem;
    if (typeof cfg === "string") {
      try {
        cfg = JSON.parse(cfg);
      } catch (_) {
        cfg = null;
      }
    }
    const tipo =
      cfg && !Array.isArray(cfg) && cfg.__tipo
        ? cfg.__tipo
        : item.e_montavel
          ? "montavel"
          : "padrao";

    // ── Pricing label ──────────────────────────────────────────
    let precoLabel = "";
    let discountBadge = "";
    const _brl = (gs) =>
      COTACAO_REAL > 0
        ? `<div class="prod-price-brl">≈ R$ ${(gs / COTACAO_REAL).toFixed(2)}</div>`
        : "";

    if (
      item.em_promocao &&
      item.preco_original &&
      item.preco_original > item.preco
    ) {
      const pct = Math.round(100 - (item.preco / item.preco_original) * 100);
      discountBadge = `<span class="prod-badge-discount">-${pct}%</span>`;
      precoLabel = `
        <div class="prod-promo-row">
          <span class="prod-price-old">Gs ${item.preco_original.toLocaleString("es-PY")}</span>
          <span class="prod-price-promo-label">Promo Gs ${item.preco.toLocaleString("es-PY")}</span>
        </div>
        ${_brl(item.preco)}`;
    } else if (
      tipo === "variacoes" &&
      cfg &&
      cfg.variacoes &&
      cfg.variacoes.length > 0
    ) {
      const precos = cfg.variacoes
        .map((v) => v.preco || 0)
        .filter((p) => p > 0);
      if (precos.length > 0) {
        const min = Math.min(...precos);
        precoLabel = `<div class="prod-price" style="font-size:0.78rem;"><span style="font-size:0.68rem;font-weight:500;opacity:0.7">A partir de</span><br>Gs ${min.toLocaleString("es-PY")}</div>${_brl(min)}`;
      } else {
        precoLabel = `<div class="prod-price">Gs ${item.preco.toLocaleString("es-PY")}</div>${_brl(item.preco)}`;
      }
        } else {
      // ── Verifica se tem faixas configuradas ──
      const faixaCfg = vfBuscarConfigFaixa(item);
      if (faixaCfg && faixaCfg.unitario) {
        // Pega o MENOR preço entre as faixas (geralmente atacado)
        let menorPreco = faixaCfg.unitario;
        let menorGatilho = null;
        if (faixaCfg.faixa1_preco && faixaCfg.faixa1_preco < menorPreco) {
          menorPreco = faixaCfg.faixa1_preco;
          menorGatilho = faixaCfg.faixa1_min;
        }
        if (faixaCfg.faixa2_preco && faixaCfg.faixa2_preco < menorPreco) {
          menorPreco = faixaCfg.faixa2_preco;
          menorGatilho = faixaCfg.faixa2_min;
        }
        precoLabel = `
          <div class="prod-price">Gs ${item.preco.toLocaleString("es-PY")}</div>
          ${
            menorGatilho
              ? `<div style="font-size:0.7rem;font-weight:700;color:#16a34a;background:#f0fdf4;border:1px solid #86efac;padding:3px 8px;border-radius:20px;display:inline-block;margin-top:4px">
                   🏭 ${menorGatilho}+ un: Gs ${menorPreco.toLocaleString("es-PY")}
                 </div>`
              : ""
          }
          ${_brl(item.preco)}`;
      } else {
        precoLabel = `<div class="prod-price">Gs ${item.preco.toLocaleString("es-PY")}</div>${_brl(item.preco)}`;
      }
    }

    // ── Destaque badge — estilo referência (☆ verde) ──────────────
    const destaqueBadge = item.em_destaque
      ? `<span class="prod-badge-destaque">☆ Destaque</span>`
      : "";

    // ── Image section ──────────────────────────────────────────
    const imgHtml = img
      ? `<img src="${img}" class="prod-img" loading="lazy" onerror="this.style.display='none'">`
      : `<div style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#ccc;font-size:2.5rem;background:#f5f5f5;">🛒</div>`;

    const div = document.createElement("div");
    div.className =
      "product-item" + (item.em_promocao ? " product-item--promo" : "");
    div.onclick = function () {
      abrirModal(item);
    };
    div.innerHTML = `
      <div class="prod-img-container">
        ${imgHtml}
        ${destaqueBadge}
        ${discountBadge}
        <button class="prod-btn-fav" onclick="event.stopPropagation();this.classList.toggle('active');this.textContent=this.classList.contains('active')?'❤️':'🤍'" title="Favoritar">🤍</button>
      </div>
      <div class="prod-info">
        <div class="prod-title">${item.nome}</div>
        ${precoLabel}
      </div>
      <button class="prod-btn-add" onclick="event.stopPropagation();abrirModal(${JSON.stringify(item).replace(/"/g, "&quot;")})">
        <i class="fas fa-shopping-cart" style="font-size:0.8rem;"></i> Comprar
      </button>
    `;
    return div;
  }

  // ── Wrapper: create or reuse grid container ─────────────────
  function getOrCreateGrid(parent) {
    let grid = parent.querySelector(".products-grid:last-child");
    if (!grid) {
      grid = document.createElement("div");
      grid.className = "products-grid";
      parent.appendChild(grid);
    }
    return grid;
  }

  function appendToSection(section, item) {
    // Find last grid or create one
    const children = section.childNodes;
    let lastGrid = null;
    for (let i = children.length - 1; i >= 0; i--) {
      if (
        children[i].classList &&
        children[i].classList.contains("products-grid")
      ) {
        lastGrid = children[i];
        break;
      }
    }
    if (!lastGrid) {
      lastGrid = document.createElement("div");
      lastGrid.className = "products-grid";
      section.appendChild(lastGrid);
    }
    lastGrid.appendChild(renderProdutoDiv(item));
  }

  // Expõe renderCategoriaSectionContent para uso em filtrarProdutos (busca global)
  window._renderCatContent = renderCategoriaSectionContent;

  // ── Constante de paginação ──────────────────────────────────────
  const PAGE_SIZE = 20;

  // ── Helper: renderiza controle de paginação ──────────────────────
  function renderPaginacao(container, todosItens, offset, renderFn) {
    // Remove paginação anterior se existir
    const oldPag = container.querySelector(".pagination-ctrl");
    if (oldPag) oldPag.remove();

    const total = todosItens.length;
    if (total <= PAGE_SIZE) return; // não precisa de paginação

    const hasPrev = offset > 0;
    const hasNext = offset + PAGE_SIZE < total;
    const paginaAtual = Math.floor(offset / PAGE_SIZE) + 1;
    const totalPaginas = Math.ceil(total / PAGE_SIZE);

    const ctrl = document.createElement("div");
    ctrl.className = "pagination-ctrl";
    ctrl.innerHTML = `
      <div class="pagination-info">${paginaAtual} / ${totalPaginas} &nbsp;·&nbsp; ${total} itens</div>
      <div class="pagination-btns">
        <button class="pag-btn" ${!hasPrev ? "disabled" : ""} data-dir="prev">← Anterior</button>
        <button class="pag-btn primary" ${!hasNext ? "disabled" : ""} data-dir="next">Próximos →</button>
      </div>`;

    ctrl.querySelector("[data-dir='prev']").onclick = () => {
      renderFn(container, todosItens, offset - PAGE_SIZE);
    };
    ctrl.querySelector("[data-dir='next']").onclick = () => {
      renderFn(container, todosItens, offset + PAGE_SIZE);
      // Scroll suave ao topo da seção
      container
        .closest("section")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    container.appendChild(ctrl);
  }

  // ── Renderiza página de itens dentro de um grid ──────────────────
  function renderPaginaItens(parentSection, todosItens, offset) {
    // Limpa conteúdo paginável (grids + paginação, mas mantém subtítulos fixos)
    parentSection
      .querySelectorAll(".products-grid, .pagination-ctrl")
      .forEach((el) => el.remove());

    const slice = todosItens.slice(offset, offset + PAGE_SIZE);
    const grid = document.createElement("div");
    grid.className = "products-grid";
    slice.forEach((item) => grid.appendChild(renderProdutoDiv(item)));
    parentSection.appendChild(grid);

    renderPaginacao(parentSection, todosItens, offset, renderPaginaItens);
  }

  // ── Renderiza seção de categoria com subcategorias e paginação ──────
  function renderCategoriaSectionContent(section, key) {
    // Limpa conteúdo dinâmico anterior
    section
      .querySelectorAll(
        ".products-grid, .pagination-ctrl, .subcat-title, .subcat-group",
      )
      .forEach((el) => el.remove());

    const subcatsDessaCat = window._SUBCATPORCAT[key] || [];
    const temSubcats = subcatsDessaCat.length > 0;

    if (!temSubcats) {
      const allItems = (window._PROD_SEM_SUBCAT[key] || []).concat(
        Object.keys(window._PROD_POR_SUBCAT)
          .filter((k) =>
            window._SUBCATS.find(
              (s) => s.slug === k && s.categoria_slug === key,
            ),
          )
          .flatMap((k) => window._PROD_POR_SUBCAT[k] || []),
      );
      renderPaginaItens(section, allItems, 0);
    } else {
      // Produtos sem subcategoria
      const semSub = window._PROD_SEM_SUBCAT[key] || [];
      if (semSub.length > 0) {
        const wrapper = document.createElement("div");
        wrapper.className = "subcat-group";
        section.appendChild(wrapper);
        renderPaginaItens(wrapper, semSub, 0);
      }

      // Grupos por subcategoria
      subcatsDessaCat.forEach((subcat) => {
        const itensSub = window._PROD_POR_SUBCAT[subcat.slug] || [];
        if (itensSub.length === 0) return;

        const subtitulo = document.createElement("div");
        subtitulo.className = "subcat-title";
        subtitulo.innerText = subcat.nome_exibicao;
        section.appendChild(subtitulo);

        const wrapper = document.createElement("div");
        wrapper.className = "subcat-group";
        section.appendChild(wrapper);
        renderPaginaItens(wrapper, itensSub, 0);
      });
    }
  }

  // ── Renderiza página de destaques ────────────────────────────────
  function renderPaginaDestaques(container, destaques, offset) {
    container
      .querySelectorAll(".products-grid, .pagination-ctrl")
      .forEach((el) => el.remove());

    const slice = destaques.slice(offset, offset + PAGE_SIZE);
    const grid = document.createElement("div");
    grid.className = "products-grid";
    slice.forEach((item) => grid.appendChild(renderProdutoDiv(item)));
    container.appendChild(grid);

    renderPaginacao(container, destaques, offset, renderPaginaDestaques);
  }

  // ── 1. Seção DESTAQUES — busca direta dos itens já mapeados ──────────────
  // Tenta primeiro pelos mapas globais; se vazio, faz query direta ao banco
  let todosDestaques = Object.values(window._PROD_SEM_SUBCAT)
    .flat()
    .concat(Object.values(window._PROD_POR_SUBCAT).flat())
    .filter((item) => item.em_destaque === true);

  // Fallback: se mapas não encontraram destaques, consulta o banco diretamente
  if (todosDestaques.length === 0) {
    try {
      const { data: destaquesDb } = await supa
        .from("produtos")
        .select(
          "id, nome, descricao, preco, preco_original, em_promocao, imagem_url, categoria_slug, subcategoria_slug, e_montavel, montagem_config, destaque",
        )
        .eq("ativo", true)
        .eq("destaque", true);

      if (destaquesDb && destaquesDb.length > 0) {
        todosDestaques = destaquesDb.map((p) => ({
          id: p.id,
          nome: p.nome,
          desc: p.descricao,
          preco: p.preco,
          preco_original: p.preco_original || null,
          em_promocao: !!p.em_promocao,
          em_destaque: true,
          img: p.imagem_url,
          montagem: p.montagem_config,
          e_montavel: p.e_montavel,
          subcategoria_slug: p.subcategoria_slug || null,
          categoria_slug: p.categoria_slug || "",
        }));
        console.log(`✅ Destaques via query direta: ${todosDestaques.length}`);
      }
    } catch (e) {
      console.warn("Erro ao buscar destaques:", e);
    }
  }

  console.log(
    `✅ Destaques encontrados: ${todosDestaques.length} (campo 'destaque' no banco)`,
  );

  const temDestaques = todosDestaques.length > 0;

  if (temDestaques) {
    // Pill de destaques
    const pillDest = document.createElement("button");
    pillDest.className = "cat-pill active";
    pillDest.id = "pill-destaques";
    pillDest.innerHTML = `<span class="cat-pill-icon">⭐</span>Destaques`;
    pillDest.onclick = () => {
      document
        .querySelectorAll(".cat-pill")
        .forEach((p) => p.classList.remove("active"));
      pillDest.classList.add("active");
      // Mostra seção de destaques e oculta todas as categorias
      const sd = document.getElementById("sec-destaques");
      if (sd) sd.style.display = "";
      document
        .querySelectorAll("#menu-content > section[data-cat]")
        .forEach((s) => (s.style.display = "none"));
      sd?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    nav.appendChild(pillDest);

    // Seção destaques
    const secDest = document.createElement("section");
    secDest.id = "sec-destaques";
    secDest.innerHTML = `
      <div class="section-title-row">
        <h2 class="section-title"><span>⭐</span> Destaques</h2>
      </div>`;
    renderPaginaDestaques(secDest, todosDestaques, 0);
    content.appendChild(secDest);
  }

  // ── 2. Categorias — seções ocultas, reveladas ao clicar na pill ──
  let primeiraCategoria = null; // usado como fallback se não houver destaques

  // Slugs já criados pelas categorias do banco (evita duplicatas no fallback)
  const keysJaCriadas = new Set();

  categsDb.forEach((cat) => {
    if (!categoriaVisivel(cat)) return;
    const key = cat.slug;
    const todosOsProdutos = MENU[key];
    if (!todosOsProdutos || todosOsProdutos.length === 0) return;

    keysJaCriadas.add(key);

    // Pill de navegação
    const pill = document.createElement("button");
    pill.className = "cat-pill";
    pill.dataset.catKey = key;
    const catIcon2 = cat.icone || cat.emoji || "";
    const nomeExibir =
      cat.nome_exibicao ||
      cat.nome ||
      key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    pill.innerHTML = catIcon2
      ? `<span class="cat-pill-icon">${catIcon2}</span>${nomeExibir}`
      : nomeExibir;
    pill.onclick = () => {
      document
        .querySelectorAll(".cat-pill")
        .forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");

      const sec = document.getElementById(key);
      if (!sec) return;

      // Lazy: renderiza o conteúdo da categoria apenas na 1ª vez
      if (!sec.dataset.loaded) {
        sec.dataset.loaded = "1";
        renderCategoriaSectionContent(sec, key);
      }

      // Oculta seção de destaques e exibe só a categoria selecionada
      const sd = document.getElementById("sec-destaques");
      if (sd) sd.style.display = "none";
      document
        .querySelectorAll("#menu-content > section[data-cat]")
        .forEach((s) => {
          s.style.display = s.id === key ? "" : "none";
        });

      sec.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    nav.appendChild(pill);

    // Seção da categoria (inicialmente oculta se houver destaques, visível se não houver)
    const section = document.createElement("section");
    section.id = key;
    section.dataset.cat = key;
    section.style.display = "none"; // sempre oculta inicialmente
    const catIcon = cat.icone || cat.emoji || "";
    section.innerHTML = `
      <div class="section-title-row">
        <h2 class="section-title">${catIcon ? `<span>${catIcon}</span>` : ""} ${nomeExibir}</h2>
      </div>`;

    content.appendChild(section);

    // Registra a primeira categoria para fallback
    if (!primeiraCategoria) primeiraCategoria = { pill, section, key };
  });

  // ── Fallback: categorias presentes nos produtos mas ausentes/inativas na tabela categorias ──
  // Garante que nenhuma categoria com produtos fique invisível por problema de cadastro
  const slugsNomesMap = {
    natura: "Natura Cosméticos",
    mercearia: "Mercearia",
    suplementos: "Suplementos",
    "cacau-show": "Cacau Show",
  };
  const iconesPadrao = {
    natura: "🌿",
    mercearia: "🛒",
    suplementos: "💪",
    "cacau-show": "🍫",
  };
  Object.keys(MENU).forEach((key) => {
    if (keysJaCriadas.has(key)) return; // já criada pelo loop principal
    if (!MENU[key] || MENU[key].length === 0) return;

    const nomeExibicao =
      slugsNomesMap[key] ||
      key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const icone = iconesPadrao[key] || "📦";

    const pill = document.createElement("button");
    pill.className = "cat-pill";
    pill.dataset.catKey = key;
    pill.innerHTML = `<span class="cat-pill-icon">${icone}</span>${nomeExibicao}`;
    pill.onclick = () => {
      document
        .querySelectorAll(".cat-pill")
        .forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");

      const sec = document.getElementById(key);
      if (!sec) return;

      if (!sec.dataset.loaded) {
        sec.dataset.loaded = "1";
        renderCategoriaSectionContent(sec, key);
      }

      const sd = document.getElementById("sec-destaques");
      if (sd) sd.style.display = "none";
      document
        .querySelectorAll("#menu-content > section[data-cat]")
        .forEach((s) => {
          s.style.display = s.id === key ? "" : "none";
        });

      sec.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    nav.appendChild(pill);

    const section = document.createElement("section");
    section.id = key;
    section.dataset.cat = key;
    section.style.display = "none";
    section.innerHTML = `
      <div class="section-title-row">
        <h2 class="section-title"><span>${icone}</span> ${nomeExibicao}</h2>
      </div>`;

    content.appendChild(section);

    if (!primeiraCategoria) primeiraCategoria = { pill, section, key };
  });

  // Pill especial "Início" para voltar à vista de destaques (só se houver destaques)
  if (temDestaques) {
    const pillTodos = document.createElement("button");
    pillTodos.className = "cat-pill";
    pillTodos.id = "pill-todos";
    pillTodos.innerHTML = `<span class="cat-pill-icon">🏠</span>Início`;
    pillTodos.onclick = () => {
      document
        .querySelectorAll(".cat-pill")
        .forEach((p) => p.classList.remove("active"));
      pillTodos.classList.add("active");
      const sd = document.getElementById("sec-destaques");
      if (sd) sd.style.display = "";
      document
        .querySelectorAll("#menu-content > section[data-cat]")
        .forEach((s) => (s.style.display = "none"));
      document
        .getElementById("sec-destaques")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    // Insere como primeiro pill (antes do pill de destaques)
    nav.insertBefore(pillTodos, nav.firstChild);
  } else if (primeiraCategoria) {
    // Sem destaques: exibe a primeira categoria automaticamente com pill ativa
    primeiraCategoria.pill.classList.add("active");
    primeiraCategoria.section.style.display = "";
    primeiraCategoria.section.dataset.loaded = "1";
    renderCategoriaSectionContent(
      primeiraCategoria.section,
      primeiraCategoria.key,
    );
  }

  // ── Nav em duas linhas: distribui pills em grid 2 colunas ──────────────
  if (!document.getElementById("nav-two-row-style")) {
    const navStyle = document.createElement("style");
    navStyle.id = "nav-two-row-style";
    navStyle.textContent = `
      #category-nav {
        display: flex !important;
        flex-wrap: wrap !important;
        overflow-x: unset !important;
        overflow: visible !important;
        white-space: normal !important;
        gap: 6px !important;
        padding: 8px 12px !important;
      }
      #category-nav .cat-pill {
        flex: 1 1 calc(50% - 6px) !important;
        min-width: 0 !important;
        max-width: calc(50% - 3px) !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        justify-content: center !important;
        text-align: center !important;
      }
    `;
    document.head.appendChild(navStyle);
  }
}

// ── Filtro de busca global ────────────────────────────────────────────────
function filtrarProdutos(termo) {
  const t = (termo || "").trim().toLowerCase();
  const content = document.getElementById("menu-content");
  const nav = document.getElementById("category-nav");
  if (!content) return;

  // Remove seção de busca e mensagem de vazio anteriores
  const oldSearchSec = document.getElementById("sec-busca-resultados");
  if (oldSearchSec) oldSearchSec.remove();
  const emptyOld = document.getElementById("search-empty-msg");
  if (emptyOld) emptyOld.remove();

  if (!t) {
    // Sem termo: volta ao estado inicial (destaques visíveis, categorias ocultas)
    const secDest = document.getElementById("sec-destaques");
    if (secDest) secDest.style.display = "";
    content.querySelectorAll("section[data-cat]").forEach((sec) => {
      sec.style.display = "none";
    });
    if (nav) nav.style.display = "";
    // Reativa pill de início/destaques
    document
      .querySelectorAll(".cat-pill")
      .forEach((p) => p.classList.remove("active"));
    const pillInicio =
      document.getElementById("pill-todos") ||
      document.getElementById("pill-destaques");
    if (pillInicio) pillInicio.classList.add("active");
    return;
  }

  // Oculta navegação e seções normais durante busca
  if (nav) nav.style.display = "none";
  const secDest = document.getElementById("sec-destaques");
  if (secDest) secDest.style.display = "none";
  content.querySelectorAll("section[data-cat]").forEach((sec) => {
    sec.style.display = "none";
  });

  // Busca diretamente nos dados em memória (todos os produtos, sem limite de paginação)
  const todosOsProdutos = [];
  if (window._PROD_SEM_SUBCAT) {
    Object.values(window._PROD_SEM_SUBCAT).forEach((arr) =>
      todosOsProdutos.push(...arr),
    );
  }
  if (window._PROD_POR_SUBCAT) {
    Object.values(window._PROD_POR_SUBCAT).forEach((arr) =>
      todosOsProdutos.push(...arr),
    );
  }

  const resultados = todosOsProdutos.filter((item) => {
    const nome = (item.nome || "").toLowerCase();
    const desc = (item.desc || "").toLowerCase();
    return nome.includes(t) || desc.includes(t);
  });

  if (resultados.length === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.id = "search-empty-msg";
    emptyEl.className = "search-empty";
    emptyEl.innerHTML = `<i class="fas fa-search"></i><div>Nenhum produto encontrado para "<strong>${termo}</strong>"</div>`;
    content.prepend(emptyEl);
    return;
  }

  // Renderiza resultados em seção temporária (sem paginação, mostra tudo)
  const secResultados = document.createElement("section");
  secResultados.id = "sec-busca-resultados";
  const grid = document.createElement("div");
  grid.className = "products-grid";

  resultados.forEach((item) => {
    const div = document.createElement("div");
    div.className =
      "product-item" + (item.em_promocao ? " product-item--promo" : "");
    div.onclick = function () {
      abrirModal(item);
    };
    const img = item.img || "";
    const imgHtml = img
      ? `<img src="${img}" class="prod-img" loading="lazy" onerror="this.style.display='none'">`
      : `<div style="position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#ccc;font-size:2.5rem;background:#f5f5f5;">🛒</div>`;
    const destaqueBadge = item.em_destaque
      ? `<span class="prod-badge-destaque">☆ Destaque</span>`
      : "";
    const _brl2 = (gs) =>
      COTACAO_REAL > 0
        ? `<div class="prod-price-brl">≈ R$ ${(gs / COTACAO_REAL).toFixed(2)}</div>`
        : "";
    let precoLabel = "";
    if (
      item.em_promocao &&
      item.preco_original &&
      item.preco_original > item.preco
    ) {
      const pct = Math.round(100 - (item.preco / item.preco_original) * 100);
      precoLabel = `<div class="prod-promo-row"><span class="prod-price-old">Gs ${item.preco_original.toLocaleString("es-PY")}</span><span class="prod-price-promo-label">Promo Gs ${item.preco.toLocaleString("es-PY")}</span></div>${_brl2(item.preco)}`;
    } else {
      precoLabel = `<div class="prod-price">Gs ${item.preco.toLocaleString("es-PY")}</div>${_brl2(item.preco)}`;
    }
    div.innerHTML = `
      <div class="prod-img-container">
        ${imgHtml}
        ${destaqueBadge}
        <button class="prod-btn-fav" onclick="event.stopPropagation();this.classList.toggle('active');this.textContent=this.classList.contains('active')?'❤️':'🤍'" title="Favoritar">🤍</button>
      </div>
      <div class="prod-info">
        <div class="prod-title">${item.nome}</div>
        ${precoLabel}
      </div>
      <button class="prod-btn-add" onclick="event.stopPropagation();abrirModal(${JSON.stringify(item).replace(/"/g, "&quot;")})">
        <i class="fas fa-shopping-cart" style="font-size:0.8rem;"></i> Comprar
      </button>`;
    grid.appendChild(div);
  });

  secResultados.appendChild(grid);
  content.prepend(secResultados);
}

// Variáveis de estado do modal
let _pizzaConfig = {
  tamanhoSelecionado: null,
  bordaSelecionada: false,
  tipoSelecionado: null,
  sabores: [],
};

function _vfAtualizarInfoVarejo(item, qtdAtual) {
  const box = document.getElementById("varejo-info");
  if (!box) return;

  const cfg = vfBuscarConfigFaixa(item);
  if (!cfg || !cfg.unitario) {
    box.style.display = "none";
    return;
  }

  const q = Math.max(1, parseInt(qtdAtual, 10) || 1);
  const { price, tierIndex } = vfGetTierPrice(cfg, q);
  const total = price * q;

  // ── Monta as colunas ──────────────────────────────────────
  const tiers = [];
  // 1) Varejo (sempre existe)
  tiers.push({
    key: 0,
    label: "VAREJO",
    sub: "1 un",
    preco: cfg.unitario,
  });
  // 2) Faixa 1
  if (cfg.faixa1_preco && cfg.faixa1_min) {
    tiers.push({
      key: 1,
      label: `${cfg.faixa1_min}+ un`,
      sub: "Desconto",
      preco: cfg.faixa1_preco,
    });
  }
  // 3) Atacado
  if (cfg.faixa2_preco && cfg.faixa2_min) {
    tiers.push({
      key: 2,
      label: `ATACADO ${cfg.faixa2_min}+`,
      sub: "Maior economia",
      preco: cfg.faixa2_preco,
    });
  }

  const colCount = Math.min(tiers.length, 3);
  const gridCols = `repeat(${colCount}, 1fr)`;

  const elTiers = document.getElementById("varejo-tiers");
  elTiers.style.gridTemplateColumns = gridCols;

  elTiers.innerHTML = tiers
    .map((t) => {
      const ativo  = t.key === tierIndex;
      const precoFmt = vfFmtGs(t.preco).replace("Gs ", "");
      // Destaca faixa ativa com fundo preto (igual referência Vuon)
      const bg     = ativo ? "#1a1a2e" : "#f8fafc";
      const color  = ativo ? "#fff" : "#1a1a2e";
      const subClr = ativo ? "rgba(255,255,255,0.65)" : "#94a3b8";

      // Economia vs. varejo
      const eco = Math.round((1 - t.preco / cfg.unitario) * 100);
      const ecoTxt = eco > 0 && !ativo
        ? `<div style="font-size:0.62rem;color:#16a34a;font-weight:800;margin-top:2px">-${eco}%</div>`
        : "";

      return `
        <div style="background:${bg}; color:${color};
             border:2px solid ${ativo ? "#1a1a2e" : "#e5e7eb"};
             border-radius:10px; padding:10px 8px; text-align:center;
             transition:all .18s; ${ativo ? "box-shadow:0 4px 12px rgba(26,26,46,0.25);" : ""}">
          <div style="font-size:0.65rem; font-weight:800;
                letter-spacing:0.5px; color:${subClr}; text-transform:uppercase">
            ${t.label}
          </div>
          <div style="font-size:0.62rem; color:${subClr}; margin-top:1px">
            ${t.sub}
          </div>
          <div style="font-size:0.62rem; color:${subClr}; margin-top:6px; font-weight:700">
            Gs / un
          </div>
          <div style="font-size:1.15rem; font-weight:900; margin-top:2px">
            ${precoFmt}
          </div>
          ${ecoTxt}
        </div>`;
    })
    .join("");

  // ── Badge de status ───────────────────────────────────────
  const badge = document.getElementById("varejo-badge");
  if (badge) {
    const txt =
      tierIndex === 0 ? "Varejo"
      : tierIndex === 1 ? "Com desconto"
      : "Atacado 🏭";
    badge.textContent = txt;
    badge.style.background =
      tierIndex === 0 ? "#fff"
      : tierIndex === 1 ? "#22c55e"
      : "#dc2626";
    badge.style.color = tierIndex === 0 ? "#1a1a2e" : "#fff";
  }

  // ── Total + unitário ──────────────────────────────────────
  document.getElementById("varejo-unit").textContent = vfFmtGs(price);
  document.getElementById("varejo-total").textContent = total.toLocaleString("es-PY");

  // ── Hint próximo degrau ───────────────────────────────────
  const hint = document.getElementById("varejo-hint");
  const prox = vfGetProximoDegrau(cfg, q);
  if (hint) {
    if (prox) {
      hint.style.display = "block";
      hint.innerHTML = `💡 Adicione mais <b>${prox.faltam}</b> unidade${prox.faltam > 1 ? "s" : ""} e pague <b>${vfFmtGs(prox.preco)}</b> cada`;
    } else {
      hint.style.display = "none";
    }
  }

  box.style.display = "block";
}

function abrirModal(item) {
  prodAtual = item;
  qtd = 1;
  itensMontagem = {};
  _pizzaConfig = {
    p: null,
    tamanhoSelecionado: null,
    numSabores: null,
    sabores: [],
    bordaConfig: null,
  };
  _comboFechadoConfig = { limite: 0, sabores: [], selecao: {} };

  document.getElementById("modal-title").innerText = item.nome;
  document.getElementById("modal-desc").innerText = item.desc || "";
  document.getElementById("modal-obs").value = "";
  document.getElementById("modal-qty").innerText = qtd;

  const divOptions = document.getElementById("modal-options");
  const divMontagem = document.getElementById("modal-montagem");
  divOptions.innerHTML = "";
  divMontagem.innerHTML = "";
  divMontagem.style.display = "none";

  // Detecta tipo do produto
  let cfg = item.montagem; // montagem_config do banco
  // Supabase às vezes retorna JSONB como string — faz parse defensivo
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch (_) {
      cfg = null;
    }
  }
  let tipo = "padrao";
  if (cfg && !Array.isArray(cfg) && cfg.__tipo) tipo = cfg.__tipo;
  else if (item.e_montavel || (cfg && Array.isArray(cfg) && cfg.length > 0))
    tipo = "montavel";

  if (tipo === "shake") {
    _renderShake(cfg, divOptions);
  } else if (tipo === "montavel") {
    _renderMontavel(item, cfg, divOptions);
  } else if (tipo === "pizza") {
    _renderPizza(cfg, divOptions);
  } else if (tipo === "almoco") {
    _renderAlmoco(cfg, divOptions);
  } else if (tipo === "variacoes") {
    _renderVariacoes(item, cfg, divOptions);
  } else if (tipo === "combo_fechado") {
    _renderComboFechado(cfg, divOptions);
  }

  // Extras do produto específico
  const extras = cfg && cfg.extras ? cfg.extras : null;
  if (extras && extras.length > 0) {
    _renderExtras(extras, divOptions);
  }

  // Opções de preparo (ex: "Batata Frita / Mandioca", "Cru / Flambado")
  const preparoOpcoes = cfg && cfg.preparo_opcoes ? cfg.preparo_opcoes : [];
  if (preparoOpcoes.length > 0) {
    _renderPreparo(preparoOpcoes, divOptions);
  }

  // Extras globais (adicionais disponíveis para TODOS os produtos)
  if (EXTRAS_GLOBAIS.length > 0) {
    _renderExtrasGlobais(EXTRAS_GLOBAIS, divOptions);
  }

  // Atualiza preço inicial
  _atualizarPrecoPizza();
  _vfAtualizarInfoVarejo(item, qtd);
  document.getElementById("product-modal").classList.add("active");
}

/* ══════════════════════════════════════════════
   SHAKE RENDERER — passo a passo: tamanho → sabor
   ══════════════════════════════════════════════ */
let _shakeConfig = { tamanhoSelecionado: null, saborSelecionado: null };

// ── Estado global do Combo Fechado ───────────────────────────────
let _comboFechadoConfig = { limite: 0, sabores: [], selecao: {} };

function _renderShake(cfg, container) {
  const shk = cfg && cfg.shake ? cfg.shake : cfg || {};
  _shakeConfig = { tamanhoSelecionado: null, saborSelecionado: null };

  const tamanhos = shk.tamanhos || [];
  const sabores = shk.sabores || [];

  // Passo 1: Tamanho
  const sec1 = document.createElement("section");
  sec1.className = "pizza-step";
  sec1.innerHTML = `
    <div class="pizza-step-header">
      <span class="pizza-step-num">1</span>
      <span>Escolha o tamanho</span>
    </div>
    <div class="shake-size-grid" id="shake-size-grid"></div>`;
  container.appendChild(sec1);

  const sizeGrid = sec1.querySelector("#shake-size-grid");
  tamanhos.forEach((tam) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "pizza-size-card";
    card.innerHTML = `
      <div class="pizza-size-name">${tam.nome}</div>
      ${tam.ml ? `<div class="pizza-size-info">${tam.ml}ml</div>` : ""}
      <div class="pizza-size-price">Gs ${(tam.preco || 0).toLocaleString("es-PY")}</div>`;
    card.onclick = () => {
      sizeGrid
        .querySelectorAll(".pizza-size-card")
        .forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      _shakeConfig.tamanhoSelecionado = tam;
      sec2.style.display = "block";
      _atualizarPrecoShake();
    };
    sizeGrid.appendChild(card);
  });

  // Passo 2: Sabor
  const sec2 = document.createElement("section");
  sec2.className = "pizza-step";
  sec2.style.display = "none";
  sec2.innerHTML = `
    <div class="pizza-step-header">
      <span class="pizza-step-num">2</span>
      <span>Escolha o sabor</span>
    </div>
    <div class="pizza-sabores-lista" id="shake-sabores-lista">
      ${sabores
        .map((s) => {
          const esc = (s.nome || "").replace(/'/g, "\'");
          return `<button type="button" class="pizza-sabor-item" onclick="_selecionarSaborShake('${esc}', ${s.preco || 0}, this)">
          ${s.img ? `<img src="${s.img}" class="pizza-sabor-img" alt="${s.nome}" onerror="this.style.display='none'">` : `<div class="pizza-sabor-emoji">🥤</div>`}
          <div class="pizza-sabor-info">
            <div class="pizza-sabor-nome">${s.nome}</div>
            ${s.preco ? `<div class="pizza-sabor-preco">+ Gs ${s.preco.toLocaleString("es-PY")}</div>` : ""}
          </div>
        </button>`;
        })
        .join("")}
    </div>`;
  container.appendChild(sec2);

  // CSS para o grid de tamanhos (reutiliza pizza-size-grid)
  const style = document.getElementById("shake-size-style");
  if (!style) {
    const s = document.createElement("style");
    s.id = "shake-size-style";
    s.textContent =
      ".shake-size-grid { display:flex; gap:8px; flex-wrap:wrap; margin-top:6px; }";
    document.head.appendChild(s);
  }
}

function _selecionarSaborShake(nome, preco, el) {
  document
    .querySelectorAll("#shake-sabores-lista .pizza-sabor-item")
    .forEach((b) => {
      b.classList.remove("selected");
      b.querySelector(".pizza-fracao-tag")?.remove();
    });
  el.classList.add("selected");
  const tag = document.createElement("span");
  tag.className = "pizza-fracao-tag";
  tag.textContent = "✓";
  el.appendChild(tag);
  _shakeConfig.saborSelecionado = { nome, preco };
  _atualizarPrecoShake();
}

function _atualizarPrecoShake() {
  const tamPreco = _shakeConfig.tamanhoSelecionado?.preco || 0;
  const saborExtra = _shakeConfig.saborSelecionado?.preco || 0;
  const total = tamPreco + saborExtra;
  const el = document.getElementById("modal-price");
  if (el && total > 0) el.textContent = "Gs " + total.toLocaleString("es-PY");
}

function _renderMontavel(item, cfg, container) {
  const etapas = Array.isArray(cfg) ? cfg : cfg && cfg.etapas ? cfg.etapas : [];
  etapas.forEach((etapa, idxEtapa) => {
    const h4 = document.createElement("h4");
    h4.innerText = `${etapa.titulo} (Máx: ${etapa.max})`;
    h4.style.cssText = "margin-top:10px; font-size:0.95rem; color:#555;";
    container.appendChild(h4);

    etapa.itens.forEach((ingrediente) => {
      const label = document.createElement("label");
      label.style.cssText =
        "display:block; padding:7px 10px; margin-bottom:3px; border:1px solid #eee; border-radius:8px; cursor:pointer;";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = ingrediente;
      input.style.marginRight = "8px";
      input.onchange = () => {
        if (!itensMontagem[idxEtapa]) itensMontagem[idxEtapa] = [];
        if (input.checked) {
          if (itensMontagem[idxEtapa].length < etapa.max) {
            itensMontagem[idxEtapa].push(ingrediente);
          } else {
            alert(`Máximo: ${etapa.max} itens para "${etapa.titulo}"`);
            input.checked = false;
          }
        } else {
          const idx = itensMontagem[idxEtapa].indexOf(ingrediente);
          if (idx > -1) itensMontagem[idxEtapa].splice(idx, 1);
        }
      };
      label.appendChild(input);
      label.appendChild(document.createTextNode(ingrediente));
      container.appendChild(label);
    });
  });
}

// ═══════════════════════════════════════════════════════════
//  🍕 PIZZA BUILDER — UX completo (passo a passo)
//  Estado global da pizza:
//  _pizzaConfig = {
//    p:                 cfg.pizza (referência),
//    tamanhoSelecionado: { nome, fatias, cm, preco },
//    numSabores:        1|2|3|4 (escolhido pelo cliente),
//    sabores:           [{ nome, preco }],   // array com sabores escolhidos
//    bordaConfig:       null | { nome, preco }
//  }
// ═══════════════════════════════════════════════════════════

function _renderPizza(cfg, container) {
  if (!cfg) return;
  // Suporta formato antigo (flat: { __tipo, tamanhos, sabores }) e novo (nested: { __tipo, pizza: {...} })
  const p = cfg.pizza || (cfg.tamanhos ? cfg : null);
  if (!p || (!p.tamanhos && !p.sabores)) {
    container.innerHTML =
      '<p style="color:#e74c3c;padding:10px;text-align:center">⚠️ Pizza não configurada ainda.<br>Configure tamanhos e sabores no painel admin.</p>';
    return;
  }
  _pizzaConfig.p = p;

  /* ── PASSO 1: Tamanho ─────────────────────────────── */
  const secTam = document.createElement("section");
  secTam.className = "pizza-step";
  secTam.innerHTML = `
    <div class="pizza-step-header">
      <span class="pizza-step-num">1</span>
      <span>Escolha o tamanho</span>
    </div>
    <div class="pizza-size-grid" id="pizza-size-grid"></div>`;
  container.appendChild(secTam);

  const sizeGrid = secTam.querySelector("#pizza-size-grid");
  (p.tamanhos || []).forEach((tam) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "pizza-size-card";
    card.dataset.nome = tam.nome;
    card.innerHTML = `
      <div class="pizza-size-name">${tam.nome}</div>
      <div class="pizza-size-info">${tam.fatias} fatias</div>
      <div class="pizza-size-info">⌀ ${tam.cm}cm</div>
      <div class="pizza-size-price">Gs ${(tam.preco || 0).toLocaleString("es-PY")}</div>`;
    card.onclick = () => {
      sizeGrid
        .querySelectorAll(".pizza-size-card")
        .forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      _pizzaConfig.tamanhoSelecionado = tam;
      _revelarPasso2(p, container);
      _atualizarPrecoPizza();
    };
    sizeGrid.appendChild(card);
  });

  /* ── Passos 2, 3, 4 aparecerão progressivamente ─── */
  const passo2 = document.createElement("div");
  passo2.id = "pizza-passo2";
  passo2.style.display = "none";
  container.appendChild(passo2);

  const passo3 = document.createElement("div");
  passo3.id = "pizza-passo3";
  passo3.style.display = "none";
  container.appendChild(passo3);

  const passo4 = document.createElement("div");
  passo4.id = "pizza-passo4";
  passo4.style.display = "none";
  container.appendChild(passo4);
}

/* Passo 2: Quantos sabores? */
function _revelarPasso2(p, container) {
  const passo2 =
    container.querySelector("#pizza-passo2") ||
    document.getElementById("pizza-passo2");
  if (!passo2) return;
  _pizzaConfig.numSabores = null;
  _pizzaConfig.sabores = [];

  // max_sabores por tamanho tem prioridade sobre o global do produto
  const maxLoja =
    _pizzaConfig.tamanhoSelecionado?.max_sabores || p.max_sabores || 1;
  const opcoes = Array.from({ length: maxLoja }, (_, i) => i + 1);
  const labels = {
    1: "Inteira",
    2: "Meia a Meia",
    3: "3 Sabores",
    4: "4 Sabores",
  };

  passo2.innerHTML = `
    <section class="pizza-step">
      <div class="pizza-step-header">
        <span class="pizza-step-num">2</span>
        <span>Quantos sabores?</span>
      </div>
      <div class="pizza-divisao-grid">
        ${opcoes
          .map(
            (n) => `
          <button type="button" class="pizza-divisao-btn" data-n="${n}" onclick="_selecionarDivisao(${n})">
            <div class="pizza-divisao-icone">${_iconePizza(n)}</div>
            <div class="pizza-divisao-nome">${labels[n] || n + " Sabores"}</div>
          </button>`,
          )
          .join("")}
      </div>
    </section>`;
  passo2.style.display = "block";
  // Esconde passos seguintes ao reeditar
  const p3 =
    container.querySelector("#pizza-passo3") ||
    document.getElementById("pizza-passo3");
  const p4 =
    container.querySelector("#pizza-passo4") ||
    document.getElementById("pizza-passo4");
  if (p3) {
    p3.innerHTML = "";
    p3.style.display = "none";
  }
  if (p4) {
    p4.innerHTML = "";
    p4.style.display = "none";
  }
}

function _iconePizza(n) {
  const icons = { 1: "🍕", 2: "🍕🍕", 3: "🍕🍕🍕", 4: "🍕🍕🍕🍕" };
  return icons[n] || "🍕";
}

/* Passo 3: Escolher sabores */
function _selecionarDivisao(n) {
  _pizzaConfig.numSabores = n;
  _pizzaConfig.sabores = new Array(n).fill(null);

  // Destaca botão selecionado
  document.querySelectorAll(".pizza-divisao-btn").forEach((b) => {
    b.classList.toggle("selected", parseInt(b.dataset.n) === n);
  });

  const p3 = document.getElementById("pizza-passo3");
  if (!p3) return;
  const p = _pizzaConfig.p;

  // Filtra sabores pausados pelo admin
  const saboresFiltrados = (p.sabores || []).filter((s) => !s.pausado);

  // Gera HTML para escolha de cada slot de sabor
  let html = `<section class="pizza-step">
    <div class="pizza-step-header">
      <span class="pizza-step-num">3</span>
      <span>Escolha ${n === 1 ? "o sabor" : `os ${n} sabores`}</span>
    </div>
    <p class="pizza-step-hint">
      ${n > 1 ? `Selecione ${n} sabores — um por slot.` : ""}
    </p>`;

  for (let slot = 0; slot < n; slot++) {
    const fracLabel =
      n === 1 ? "" : `<span class="pizza-fracao-badge">${slot + 1}/${n}</span>`;
    html += `
    <div class="pizza-slot-header">
      ${fracLabel}
      <span class="pizza-slot-label">${n === 1 ? "Sabor" : `${slot + 1}º sabor`}</span>
    </div>
    <div class="pizza-sabores-lista" id="pizza-slot-${slot}">
      ${saboresFiltrados
        .map((s) => {
          const sfEsc = (s.nome || "").replace(/'/g, "\\'");
          const tipoLower = (s.tipo || "Tradicional").toLowerCase();
          // ── badge de tipo ──
          let tipoBadge = "";
          if (tipoLower === "especial")
            tipoBadge = `<span class="pizza-sabor-tipo-badge tipo-especial">⭐ Especial</span>`;
          else if (tipoLower === "premium")
            tipoBadge = `<span class="pizza-sabor-tipo-badge tipo-especial" style="background:#7c3aed">🏆 Premium</span>`;
          else if (tipoLower === "doce premium")
            tipoBadge = `<span class="pizza-sabor-tipo-badge tipo-doce" style="background:#e91e8c">🎂 Doce Premium</span>`;
          else if (tipoLower === "doce")
            tipoBadge = `<span class="pizza-sabor-tipo-badge tipo-doce">🍫 Doce</span>`;
          // ── ícone (estava faltando!) ──
          const iconHtml = s.img
            ? `<img src="${s.img}" class="pizza-sabor-img" alt="${s.nome}" onerror="this.style.display='none'">`
            : `<div class="pizza-sabor-emoji">🍕</div>`;
          // ── diferença de preço pelo tipo ──
          const tamAtual = _pizzaConfig.tamanhoSelecionado;
          const precoTipo = tamAtual ? _precoPizzaPorTipo(tamAtual, s.tipo) : 0;
          const precoDiff = tamAtual
            ? precoTipo - _precoPizzaPorTipo(tamAtual, "Tradicional")
            : 0;
          return `<button type="button" class="pizza-sabor-item" data-slot="${slot}" data-nome="${s.nome}" data-preco="0" data-tipo="${s.tipo || "Tradicional"}" onclick="_selecionarSaborSlot(${slot}, '${sfEsc}', 0, this, '${s.tipo || "Tradicional"}')">
    ${iconHtml}
    <div class="pizza-sabor-info">
      <div class="pizza-sabor-nome">${s.nome}</div>
      ${s.desc ? `<div class="pizza-sabor-desc">${s.desc}</div>` : ""}
      ${precoDiff > 0 ? `<div class="pizza-sabor-preco">+ Gs ${precoDiff.toLocaleString("es-PY")}</div>` : ""}
    </div>
    ${tipoBadge}
  </button>`;
        })
        .join("")}
    </div>`;
  }
  html += `</section>`;

  p3.innerHTML = html;
  p3.style.display = "block";

  // Borda aparece depois
  const p4 = document.getElementById("pizza-passo4");
  if (p4) {
    p4.innerHTML = "";
    p4.style.display = "none";
  }
  _atualizarPrecoPizza();
}

function _selecionarSaborSlot(slot, nome, preco, el, tipo) {
  tipo = tipo || el?.dataset?.tipo || "Tradicional";
  // Desmarca outros no mesmo slot
  const lista = document.getElementById(`pizza-slot-${slot}`);
  if (lista)
    lista.querySelectorAll(".pizza-sabor-item").forEach((b) => {
      b.classList.remove("selected");
      b.querySelector(".pizza-fracao-tag")?.remove();
    });

  el.classList.add("selected");
  const n = _pizzaConfig.numSabores || 1;
  // Adiciona tag de fração
  const tag = document.createElement("span");
  tag.className = "pizza-fracao-tag";
  tag.textContent = n > 1 ? `${slot + 1}/${n}` : "✓";
  el.appendChild(tag);

  _pizzaConfig.sabores[slot] = { nome, preco, tipo };

  // Verifica se todos slots preenchidos → mostra borda
  const cheios = _pizzaConfig.sabores.filter(Boolean).length;
  if (cheios >= n) {
    _revelarPasso4Borda();
    // Scroll para a borda com pequeno delay (aguarda renderização)
    setTimeout(() => {
      const p4 = document.getElementById("pizza-passo4");
      if (p4) {
        const scrollEl =
          document.querySelector(".modal-scroll-area") ||
          document.querySelector(".options-list");
        if (scrollEl) {
          const top = p4.offsetTop - scrollEl.offsetTop;
          scrollEl.scrollTo({ top: top - 12, behavior: "smooth" });
        }
      }
    }, 80);
  } else {
    // Ainda há slots para preencher — scroll para o próximo slot
    const proximoSlot = slot + 1;
    setTimeout(() => {
      const proxLista = document.getElementById(`pizza-slot-${proximoSlot}`);
      if (proxLista) {
        const scrollEl =
          document.querySelector(".modal-scroll-area") ||
          document.querySelector(".options-list");
        if (scrollEl) {
          // Sobe um pouco para mostrar o header do slot junto
          const header = proxLista.previousElementSibling; // .pizza-slot-header
          const target = header || proxLista;
          const top = target.offsetTop - scrollEl.offsetTop;
          scrollEl.scrollTo({ top: top - 12, behavior: "smooth" });
        }
      }
    }, 80);
  }
  _atualizarPrecoPizza();
  _atualizarResumo();
}

/* Passo 4: Borda */
function _revelarPasso4Borda() {
  const p = _pizzaConfig.p;
  const p4 = document.getElementById("pizza-passo4");
  if (!p4) return;

  // Preço de cada borda = determinado pelo TIPO da borda (Tradicional/Especial/Doce)
  // busca o preço correspondente no tamanho selecionado
  const tam = _pizzaConfig.tamanhoSelecionado || {};

  function _precoBordaPorTipo(tipo) {
    const t = (tipo || "Tradicional").toLowerCase();
    if (t === "especial" && tam.borda_preco_especial > 0)
      return tam.borda_preco_especial;
    if (t === "doce" && tam.borda_preco_doce > 0) return tam.borda_preco_doce;
    return tam.borda_preco || 0;
  }

  const bordasOpcoes =
    p.bordas && p.bordas.length > 0
      ? p.bordas.map((b) => ({
          nome: b.nome,
          tipo: b.tipo || "Tradicional",
          preco: _precoBordaPorTipo(b.tipo),
        }))
      : p.tem_borda
        ? [
            {
              nome: "Borda Recheada",
              tipo: "Tradicional",
              preco: tam.borda_preco || p.borda_preco || 0,
            },
          ]
        : [];

  p4.innerHTML = `<section class="pizza-step">
    <div class="pizza-step-header">
      <span class="pizza-step-num">4</span>
      <span>Borda recheada?</span>
    </div>
    <div class="pizza-opt-row">
      <button type="button" class="pizza-opt-chip selected" id="borda-nao" onclick="_pizzaSelecionarBorda(null)">
        Sem borda
      </button>
      ${bordasOpcoes
        .map(
          (b) => `
        <button type="button" class="pizza-opt-chip" onclick="_pizzaSelecionarBorda('${b.nome.replace(/'/g, "\\'")}', ${b.preco || 0}, this)">
          🧀 ${b.nome} <span style="font-size:0.75rem;opacity:0.85">+Gs ${(b.preco || 0).toLocaleString("es-PY")}</span>
        </button>`,
        )
        .join("")}
    </div>
  </section>`;
  p4.style.display = "block";
}

function _pizzaSelecionarBorda(nome, preco, el) {
  document
    .querySelectorAll("#pizza-passo4 .pizza-opt-chip")
    .forEach((c) => c.classList.remove("selected"));
  if (el) el.classList.add("selected");
  else document.getElementById("borda-nao")?.classList.add("selected");
  _pizzaConfig.bordaConfig = nome ? { nome, preco } : null;
  _atualizarPrecoPizza();
  _atualizarResumo();
}

// compatibilidade
function _selecionarBorda(com) {
  _pizzaSelecionarBorda(
    com ? "Borda Recheada" : null,
    _pizzaConfig.p?.borda_preco || 0,
    null,
  );
}

/* Resumo em tempo real */
function _atualizarResumo() {
  const el = document.getElementById("pizza-resumo");
  if (!el) return;
  const saboresOk = (_pizzaConfig.sabores || []).filter(Boolean);
  if (saboresOk.length === 0) {
    el.style.display = "none";
    return;
  }

  const tam = _pizzaConfig.tamanhoSelecionado;
  const precoBase = _calcularBasePizza(tam, saboresOk);
  const precoBorda = _pizzaConfig.bordaConfig?.preco || 0;
  const tipoLabels = {
    tradicional: "🍕",
    especial: "⭐",
    premium: "🏆",
    doce: "🍫",
    "doce premium": "🎂",
  };

  el.style.display = "block";
  el.innerHTML = `
    <div class="pizza-resumo-header">🍕 Resumo da sua pizza</div>
    ${tam ? `<div class="pizza-resumo-linha"><span>Tamanho</span><span>${tam.nome} (${tam.fatias} fatias · ⌀${tam.cm}cm)</span></div>` : ""}
    ${saboresOk
      .map((s, i) => {
        const tl = (s.tipo || "Tradicional").toLowerCase();
        const icon = tipoLabels[tl] || "🍕";
        return `<div class="pizza-resumo-linha"><span>${_pizzaConfig.numSabores > 1 ? `${i + 1}/${_pizzaConfig.numSabores} Sabor` : "Sabor"}</span><span>${icon} ${s.nome} <span style="font-size:0.75em;opacity:0.7">(${s.tipo || "Tradicional"})</span></span></div>`;
      })
      .join("")}
    ${_pizzaConfig.bordaConfig ? `<div class="pizza-resumo-linha"><span>Borda</span><span>${_pizzaConfig.bordaConfig.nome}</span></div>` : ""}
    <div class="pizza-resumo-total"><span>Total</span><span>Gs ${((precoBase + precoBorda) * (qtd || 1)).toLocaleString("es-PY")}</span></div>`;
}

function _precoPizzaPorTipo(tam, tipo) {
  const t = (tipo || "Tradicional").toLowerCase();
  if (t === "premium" && tam.preco_premium > 0) return tam.preco_premium;
  if (t === "especial" && tam.preco_especial > 0) return tam.preco_especial;
  if (t === "doce premium" && tam.preco_doce_premium > 0)
    return tam.preco_doce_premium;
  if (t === "doce" && tam.preco_doce > 0) return tam.preco_doce;
  return tam.preco_tradicional || tam.preco || 0;
}

// Retorna o maior preço entre os sabores selecionados
function _calcularBasePizza(tam, saboresOk) {
  if (!tam || saboresOk.length === 0)
    return tam ? _precoPizzaPorTipo(tam, "Tradicional") : 0;
  return Math.max(
    ...saboresOk.map((s) => _precoPizzaPorTipo(tam, s.tipo || "Tradicional")),
  );
}

function _atualizarPrecoPizza() {
  const cfg = prodAtual?.montagem;

  // Sempre soma extras (válido para qualquer tipo de produto)
  let extrasTotal = 0;
  document.querySelectorAll(".extra-check-input:checked").forEach((cb) => {
    extrasTotal += parseInt(cb.dataset.preco || 0);
  });

  // Tipo variações: preço controlado pelo click na variação
  const tipo = cfg && !Array.isArray(cfg) && cfg.__tipo ? cfg.__tipo : "padrao";
  if (tipo === "variacoes") {
    const base = _variacaoSelecionada
      ? _variacaoSelecionada.preco || 0
      : prodAtual?.preco || 0;
    const total = (base + extrasTotal) * qtd;
    document.getElementById("modal-price").innerText =
      `Gs ${total.toLocaleString("es-PY")}`;
    _atualizarResumo();
    return;
  }

    // Suporta formato antigo (flat) e novo (nested .pizza)
  const pizzaCfg = cfg && (cfg.pizza || (cfg.tamanhos ? cfg : null));
  if (!pizzaCfg) {
    // ── Se tem faixas, usa o preço da faixa ──
    const faixaCfg = vfBuscarConfigFaixa(prodAtual);
    let baseUnit;
    if (faixaCfg) {
      baseUnit = vfGetTierPrice(faixaCfg, qtd).price;
    } else {
      baseUnit = prodAtual?.preco || 0;
    }
    const total = (baseUnit + extrasTotal) * qtd;
    document.getElementById("modal-price").innerText =
      `Gs ${total.toLocaleString("es-PY")}`;
    _atualizarResumo();
    return;
  }

  const saboresOk = (_pizzaConfig.sabores || []).filter(Boolean);
  const tam = _pizzaConfig.tamanhoSelecionado;
  const precoBase = tam
    ? _calcularBasePizza(tam, saboresOk)
    : prodAtual?.preco || 0;
  const precoBorda = _pizzaConfig.bordaConfig?.preco || 0;
  const total = (precoBase + precoBorda + extrasTotal) * qtd;
  document.getElementById("modal-price").innerText =
    `Gs ${total.toLocaleString("es-PY")}`;
  _atualizarResumo();
}

// ─── VARIAÇÕES DE SABOR ───────────────────────────────────
let _variacaoSelecionada = null; // { nome, preco, img }

function _renderVariacoes(item, cfg, container) {
  _variacaoSelecionada = null;
  const variacoes = cfg && cfg.variacoes ? cfg.variacoes : [];

  if (variacoes.length === 0) return;

  const sec = document.createElement("div");
  sec.className = "var-section";
  sec.innerHTML = `<div class="var-label">Escolha o sabor</div><div class="var-grid" id="var-grid"></div>`;
  container.appendChild(sec);

  const grid = sec.querySelector("#var-grid");
  variacoes.forEach((v) => {
    const card = document.createElement("div");
    card.className = "var-card";
    const imgSrc =
      v.img ||
      item.img ||
      "https://cdn-icons-png.flaticon.com/512/2252/2252075.png";
    card.innerHTML = `
      <img src="${imgSrc}" class="var-card-img" onerror="this.src='https://cdn-icons-png.flaticon.com/512/2252/2252075.png'">
      <div class="var-card-body">
        <div class="var-card-nome">${v.nome}</div>
        <div class="var-card-preco">Gs ${(v.preco || 0).toLocaleString("es-PY")}</div>
      </div>
      <div class="var-card-check">✓</div>
    `;
    card.dataset.preco = v.preco || 0;
    card.onclick = () => {
      grid
        .querySelectorAll(".var-card")
        .forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      _variacaoSelecionada = v;
      // Atualiza preço e imagem do modal
      document.getElementById("modal-price").innerText =
        `Gs ${((v.preco || 0) * qtd).toLocaleString("es-PY")}`;
      // Atualiza imagem do modal se a variação tiver foto própria
      const modalImg =
        document.querySelector(".modal-img") ||
        document.getElementById("modal-img");
      if (modalImg && v.img) modalImg.src = v.img;
    };
    grid.appendChild(card);
  });
}

function _renderAlmoco(cfg, container) {
  if (!cfg || !cfg.almoco || !cfg.almoco.pratos) return;
  const pratos = cfg.almoco.pratos;

  const sec = document.createElement("div");
  sec.innerHTML = `<div class="sabor-slot-label">Escolha o prato</div><div class="almoco-pratos-grid" id="almoco-pratos-grid"></div>`;
  container.appendChild(sec);

  const grid = sec.querySelector("#almoco-pratos-grid");
  pratos.forEach((prato) => {
    const card = document.createElement("div");
    card.className = "almoco-prato-option";
    card.innerHTML = `
      <img src="${prato.img || "https://via.placeholder.com/160x110?text=Prato"}" alt="${prato.nome}">
      <div class="prato-info">
        <div class="prato-nome">${prato.nome}</div>
        <div class="prato-desc">${prato.desc || ""}</div>
        <div class="prato-preco">Gs ${(prato.preco || 0).toLocaleString("es-PY")}</div>
      </div>`;
    card.onclick = () => {
      grid
        .querySelectorAll(".almoco-prato-option")
        .forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      prodAtual._pratoselecionado = prato;
      // Atualiza preço
      const preco = prato.preco || prodAtual.preco || 0;
      document.getElementById("modal-price").innerText =
        `Gs ${(preco * qtd).toLocaleString("es-PY")}`;
    };
    grid.appendChild(card);
  });
}

function _renderExtras(extras, container) {
  const sec = document.createElement("div");
  sec.className = "extras-section";
  sec.innerHTML = `<h5>➕ Adicionais (opcional)</h5>`;
  extras.forEach((ex) => {
    const row = document.createElement("label");
    row.className = "extra-check-row";
    row.innerHTML = `
      <input type="checkbox" class="extra-check-input" data-preco="${ex.preco}" onchange="_atualizarPrecoPizza()">
      <span class="extra-check-label">${ex.nome}</span>
      <span class="extra-check-price">+Gs ${(ex.preco || 0).toLocaleString("es-PY")}</span>`;
    sec.appendChild(row);
  });
  container.appendChild(sec);
}

// Renderiza opções de PREPARO (radio buttons — o cliente escolhe uma opção)
function _renderPreparo(opcoes, container) {
  const sec = document.createElement("div");
  sec.className = "extras-section preparo-section";
  sec.innerHTML = `<h5 style="color:#2980b9">🍳 Como deseja o preparo?</h5>`;

  opcoes.forEach((op, idx) => {
    const label = document.createElement("label");
    label.className = "extra-check-row preparo-row";
    label.style.cssText = "cursor:pointer;";
    label.innerHTML = `
      <input type="radio" class="preparo-radio-input" name="preparo-opcao" value="${op}" style="accent-color:#2980b9;width:18px;height:18px;margin-right:8px;">
      <span class="extra-check-label">${op}</span>`;
    sec.appendChild(label);
  });
  container.appendChild(sec);
}

// Renderiza EXTRAS GLOBAIS (adicionais disponíveis para qualquer produto)
function _renderExtrasGlobais(extras, container) {
  if (!extras || extras.length === 0) return;
  const sec = document.createElement("div");
  sec.className = "extras-section extras-globais-section";
  sec.innerHTML = `<h5 style="color:#8e44ad">⭐ Adicionais extras</h5>`;
  extras.forEach((ex) => {
    const row = document.createElement("label");
    row.className = "extra-check-row";
    row.innerHTML = `
      <input type="checkbox" class="extra-check-input" data-preco="${ex.preco || 0}" onchange="_atualizarPrecoPizza()">
      <span class="extra-check-label">${ex.nome}</span>
      ${ex.preco > 0 ? `<span class="extra-check-price">+Gs ${ex.preco.toLocaleString("es-PY")}</span>` : '<span class="extra-check-price" style="color:#27ae60">Grátis</span>'}`;
    sec.appendChild(row);
  });
  container.appendChild(sec);
}

function fecharModalProduto() {
  document.getElementById("product-modal").classList.remove("active");
}

function mudarQtd(delta) {
  qtd = Math.max(1, qtd + delta);
  document.getElementById("modal-qty").innerText = qtd;
  _atualizarPrecoPizza();
  if (prodAtual) _vfAtualizarInfoVarejo(prodAtual, qtd);
}

function adicionarDoModal() {
  if (!prodAtual) return;

  let cfg = prodAtual.montagem;
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch (_) {
      cfg = null;
    }
  }
  let tipo = "padrao";
  if (cfg && !Array.isArray(cfg) && cfg.__tipo) tipo = cfg.__tipo;
  else if (
    prodAtual.e_montavel ||
    (cfg && Array.isArray(cfg) && cfg.length > 0)
  )
    tipo = "montavel";

  // Validações por tipo — cada tipo tem seu próprio bloco (fix #3)
  if (tipo === "shake") {
    if (!_shakeConfig.tamanhoSelecionado) {
      alert("Escolha um tamanho para o Shake!");
      return;
    }
    if (!_shakeConfig.saborSelecionado) {
      alert("Escolha um sabor para o Shake!");
      return;
    }
  }
  if (tipo === "pizza") {
    if (!_pizzaConfig.tamanhoSelecionado) {
      alert("Selecione o tamanho da pizza!");
      return;
    }
    const saboresOk = (_pizzaConfig.sabores || []).filter(Boolean);
    if (saboresOk.length === 0) {
      alert("Selecione ao menos 1 sabor!");
      return;
    }
    if (_pizzaConfig.numSabores && saboresOk.length < _pizzaConfig.numSabores) {
      alert(
        `Você escolheu ${_pizzaConfig.numSabores} sabores mas selecionou apenas ${saboresOk.length}. Complete a seleção!`,
      );
      return;
    }
  }
  if (tipo === "almoco" && !prodAtual._pratoselecionado) {
    alert("Selecione o prato!");
    return;
  }
  if (tipo === "variacoes" && !_variacaoSelecionada) {
    alert("Escolha o sabor antes de adicionar!");
    return;
  }
  if (tipo === "combo_fechado") {
    const total = Object.values(_comboFechadoConfig.selecao).reduce(
      (a, b) => a + b,
      0,
    );
    if (total !== _comboFechadoConfig.limite) {
      alert(
        `Selecione exatamente ${_comboFechadoConfig.limite} itens para continuar.`,
      );
      return;
    }
  }

  // Monta descrição para o carrinho
  let montagem = [];
  let variacao = "";
  let precoFinal = prodAtual.preco;

  if (tipo === "combo_fechado") {
    const partes = _comboFechadoConfig.sabores
      .filter((s) => (_comboFechadoConfig.selecao[s.id] || 0) > 0)
      .map((s) => `${s.nome} ×${_comboFechadoConfig.selecao[s.id]}`);
    montagem.push(partes.join(", "));
  }

  if (tipo === "montavel") {
    const cfgEtapas = Array.isArray(cfg)
      ? cfg
      : cfg && cfg.etapas
        ? cfg.etapas
        : [];
    for (let k in itensMontagem) {
      if (itensMontagem[k] && itensMontagem[k].length > 0) {
        const titulo = cfgEtapas[k]
          ? cfgEtapas[k].titulo
          : `Etapa ${parseInt(k) + 1}`;
        montagem.push(`${titulo}: ${itensMontagem[k].join(", ")}`);
      }
    }
  }

  if (tipo === "pizza") {
    // ─────────────────────────────────────────────────────────────
    // PREÇO PIZZA:
    //   Base    = tamanho selecionado (sempre — é o preço principal)
    //   Extra   = maior preco individual dos sabores (0 se não há premium)
    //   Borda   = preco da borda escolhida (0 se sem borda)
    //   Total   = (Base + Extra) * qtd + Borda * qtd
    // ─────────────────────────────────────────────────────────────
    const saboresOk = (_pizzaConfig.sabores || []).filter(Boolean);
    const tam = _pizzaConfig.tamanhoSelecionado;
    const precoBorda = _pizzaConfig.bordaConfig?.preco || 0;
    precoFinal = _calcularBasePizza(tam, saboresOk) + precoBorda;

    variacao = "Pizza " + (_pizzaConfig.tamanhoSelecionado?.nome || "").trim();
    const numSab = _pizzaConfig.numSabores || saboresOk.length || 1;
    const saboresStr = saboresOk
      .map((s, i) => {
        const nomeSabor = (s.nome || "").trim();
        if (!nomeSabor) return null;
        return numSab > 1 ? `${i + 1}/${numSab} ${nomeSabor}` : nomeSabor;
      })
      .filter(Boolean)
      .join(" | ");

    // montagem: string legível para exibição no carrinho/cozinha
    // Se saboresStr ficou vazio (nomes em branco no banco), usa fallback genérico
    montagem = saboresStr
      ? [saboresStr]
      : saboresOk.length > 0
        ? [`${saboresOk.length} sabor(es)`]
        : [];
    if (_pizzaConfig.bordaConfig)
      montagem.push(`Borda: ${_pizzaConfig.bordaConfig.nome}`);
  }

  // Shake: monta preço, variação e descrição corretamente (fix #3)
  if (tipo === "shake") {
    const tamPreco = _shakeConfig.tamanhoSelecionado?.preco || 0;
    const sabPreco = _shakeConfig.saborSelecionado?.preco || 0;
    precoFinal = tamPreco + sabPreco;
    variacao = [
      _shakeConfig.tamanhoSelecionado?.nome,
      _shakeConfig.saborSelecionado?.nome,
    ]
      .filter(Boolean)
      .join(" – ");
    montagem = variacao ? [variacao] : [];
  }

  if (tipo === "almoco" && prodAtual._pratoselecionado) {
    const prato = prodAtual._pratoselecionado;
    variacao = prato.nome;
    precoFinal = prato.preco || prodAtual.preco;
    montagem = [prato.desc || ""];
  }

  if (tipo === "variacoes" && _variacaoSelecionada) {
    variacao = _variacaoSelecionada.nome;
    precoFinal = _variacaoSelecionada.preco || prodAtual.preco;
    // Usa imagem da variação se disponível
    if (_variacaoSelecionada.img)
      prodAtual._variacaoImg = _variacaoSelecionada.img;
  }

  // Extras selecionados
    // Extras selecionados
  const extrasEscolhidos = [];
  let extrasSoma = 0;
  document.querySelectorAll(".extra-check-input:checked").forEach((cb) => {
    const nome = cb
      .closest(".extra-check-row")
      .querySelector(".extra-check-label").textContent;
    const preco = parseInt(cb.dataset.preco || 0);
    extrasEscolhidos.push({ nome, preco });
    precoFinal += preco;
    extrasSoma += preco;
  });
  if (extrasEscolhidos.length > 0) {
    montagem.push("Extras: " + extrasEscolhidos.map((e) => e.nome).join(", "));
  }

  // Captura metadados da pizza ANTES de resetar _pizzaConfig
  const pizzaMeta =
    tipo === "pizza"
      ? {
          tamanho: _pizzaConfig.tamanhoSelecionado?.nome || "",
          sabores: (_pizzaConfig.sabores || [])
            .filter(Boolean)
            .map((s) => s.nome),
          borda: _pizzaConfig.bordaConfig?.nome || null,
        }
      : null;

  // Captura preparo selecionado
  const preparoSel = document.querySelector(".preparo-radio-input:checked");
  const preparoEscolhido = preparoSel ? preparoSel.value : "";

  carrinho.push({
    id: Date.now(),
    produto_id: prodAtual.id,
    nome: prodAtual.nome,
    _extrasSoma: extrasSoma,
    variacao: variacao || "", // Guardado separado para não duplicar o nome
    preparo: preparoEscolhido, // Opção de preparo (ex: "Flambado", "Batata Frita")
    preco: precoFinal,
    qtd: qtd,
    montagem: montagem.filter(Boolean),
    obs: document.getElementById("modal-obs").value,
    img: prodAtual._variacaoImg || prodAtual.img,
    categoria_slug: prodAtual.categoria_slug || "", // para filtro de bebidas na rota do motoboy
    ...(pizzaMeta ? { pizzaMeta } : {}),
  });

  // Limpa estado após push
  _pizzaConfig = {
    p: null,
    tamanhoSelecionado: null,
    numSabores: null,
    sabores: [],
    bordaConfig: null,
  };
  _variacaoSelecionada = null;
  _comboFechadoConfig = { limite: 0, sabores: [], selecao: {} };
  if (prodAtual) prodAtual._variacaoImg = null;

  updateUI();
  fecharModalProduto();
}

// ==========================================
// 6. ATUALIZAÇÃO DA UI (Carrinho)
// ==========================================
function updateUI() {
  const cartBar = document.getElementById("cart-bar");
  const count = document.getElementById("cart-count");
  const total = document.getElementById("cart-total");

  // ── Aplica faixas de preço ANTES de calcular totais ──
  vfRecalcularCarrinho(carrinho, (pid) => {
    for (const key in MENU) {
      const found = MENU[key].find((p) => p.id == pid);
      if (found) return found;
    }
    return null;
  });

  const totalItens = carrinho.reduce((a, i) => a + i.qtd, 0);
  const totalDinheiro = carrinho.reduce((a, i) => a + i.preco * i.qtd, 0);

  count.innerText = totalItens;
  total.innerText = `Gs ${totalDinheiro.toLocaleString("es-PY")}`;
  cartBar.classList.toggle("show", totalItens > 0);

  // ── Atualiza sidebar desktop ──────────────────────────────
  const desktopItems = document.getElementById("desktop-cart-items");
  const desktopEmpty = document.getElementById("desktop-cart-empty");
  const desktopTotalRow = document.getElementById("desktop-cart-total-row");
  const desktopTotalVal = document.getElementById("desktop-cart-total-val");
  const desktopBtn = document.getElementById("desktop-cart-btn");

  if (desktopItems) {
    desktopItems.innerHTML = "";
    if (carrinho.length === 0) {
      if (desktopEmpty) desktopEmpty.style.display = "block";
      if (desktopTotalRow) desktopTotalRow.style.display = "none";
      if (desktopBtn) desktopBtn.disabled = true;
    } else {
      if (desktopEmpty) desktopEmpty.style.display = "none";
      if (desktopTotalRow) desktopTotalRow.style.display = "flex";
      if (desktopBtn) desktopBtn.disabled = false;

      carrinho.forEach((item, idx) => {
        const div = document.createElement("div");
        div.className = "desktop-cart-item";
        div.innerHTML = `
          <span class="desktop-cart-item-name">${item.qtd}x ${item.nome}</span>
          <span class="desktop-cart-item-price">Gs ${(item.preco * item.qtd).toLocaleString("es-PY")}</span>`;
        desktopItems.appendChild(div);
      });

      if (desktopTotalVal)
        desktopTotalVal.innerText = `Gs ${totalDinheiro.toLocaleString("es-PY")}`;
    }
  }

  // Atualiza lista no checkout se estiver aberto
  const modalCheckout = document.getElementById("checkout-modal");
  if (modalCheckout && modalCheckout.classList.contains("active")) {
    renderCarrinho();
  }
}

function limparCarrinho() {
  if (confirm("Deseja limpar o carrinho?")) {
    carrinho = [];
    cupomAplicado = null;
    updateUI();
  }
}

// ==========================================
// VALIDAÇÃO DE FORMULÁRIOS
// ==========================================
function validarCampo(campoId, regras = {}) {
  const campo = document.getElementById(campoId);
  if (!campo) return { valido: false, mensagem: "Campo não encontrado" };

  const valor = campo.value.trim();

  if (regras.obrigatorio && !valor) {
    marcarErro(campo, "Este campo é obrigatório");
    return { valido: false, mensagem: "Campo obrigatório" };
  }

  if (regras.minimo && valor.length < regras.minimo) {
    marcarErro(campo, `Mínimo de ${regras.minimo} caracteres`);
    return { valido: false, mensagem: `Mínimo de ${regras.minimo} caracteres` };
  }

  if (regras.telefone && valor) {
    const telefoneLimpo = valor.replace(/\D/g, "");
    if (telefoneLimpo.length < 8) {
      marcarErro(campo, "Telefone inválido");
      return { valido: false, mensagem: "Telefone inválido" };
    }
  }

  removerErro(campo);
  return { valido: true, valor: valor };
}

function marcarErro(campo, mensagem) {
  campo.classList.add("erro-validacao");
  campo.style.borderColor = "#e74c3c";

  // Procura ou cria mensagem de erro
  let msgEl = campo.parentElement.querySelector(".msg-erro");
  if (!msgEl) {
    msgEl = document.createElement("span");
    msgEl.className = "msg-erro";
    msgEl.style.cssText =
      "color: #e74c3c; font-size: 0.8rem; margin-top: 4px; display: block;";
    campo.parentElement.appendChild(msgEl);
  }
  msgEl.textContent = mensagem;
}

function removerErro(campo) {
  campo.classList.remove("erro-validacao");
  campo.style.borderColor = "";
  const msgEl = campo.parentElement.querySelector(".msg-erro");
  if (msgEl) msgEl.remove();
}

function limparTodosErros() {
  document.querySelectorAll(".erro-validacao").forEach((campo) => {
    removerErro(campo);
  });
}

// ==========================================
// ==========================================
// 7. CHECKOUT E VALIDAÇÃO
// ==========================================
function abrirCheckout() {
  if (carrinho.length === 0) return alert("Carrinho vazio!");

  // Verifica se a loja está aberta (se não estiver em modo agendamento)
  if (!MODO_AGENDAMENTO) {
    const statusLoja = verificarLojaAbertaParaPedido();
    if (!statusLoja.aberto) {
      mostrarAlertaLojaFechada(statusLoja.proximoDia);
      return;
    }
  }

  renderCarrinho();
  renderUpsell();

  // Mostra indicador de agendamento se ativo
  if (MODO_AGENDAMENTO) {
    mostrarIndicadorAgendamento();
  }

  document.getElementById("checkout-modal").classList.add("active");
}

function fecharCheckout() {
  document.getElementById("checkout-modal").classList.remove("active");
}

function renderCarrinho() {
  const lista = document.getElementById("carrinho-lista");
  lista.innerHTML = "";

  carrinho.forEach((item, idx) => {
    const totalItem = item.preco * item.qtd;
    let detalhes = "";
    if (item.pizzaMeta) {
      const m = item.pizzaMeta;
      const partes = [];
      if (m.tamanho) partes.push(`📐 ${m.tamanho}`);
      if (m.sabores && m.sabores.length > 0)
        partes.push(`🍕 ${m.sabores.join(" / ")}`);
      if (m.borda) partes.push(`🧀 ${m.borda}`);
      detalhes = `<br><small style="color:#888">${partes.join(" · ")}</small>`;
    } else {
      // Variação (ex: "Combo Grande") — aparece como badge separado, não duplica o nome
      if (item.variacao) {
        detalhes += `<br><small style="color:#FF441F;font-weight:600">▸ ${item.variacao}</small>`;
      }
      // Preparo (ex: "Flambado", "Batata Frita")
      if (item.preparo) {
        detalhes += `<br><small style="color:#2980b9;font-weight:600">🍳 ${item.preparo}</small>`;
      }
      if (item.montagem && item.montagem.length > 0) {
        detalhes += `<br><small style="color:#888">${item.montagem.join(", ")}</small>`;
      }
    }
    const obs = item.obs
      ? `<br><small style="color:#666"><strong>Obs:</strong> ${item.obs}</small>`
      : "";

        // ── Badge de faixa (varejo/atacado) ───────────────────────
    let faixaBadge = "";
    if (item._faixaTier !== undefined && item._faixaAplicada) {
      const tier = item._faixaTier;
      const label = tier === 0 ? "Varejo" : tier === 1 ? "Com desconto" : "Atacado";
      const cor   = tier === 0 ? "#3b82f6" : tier === 1 ? "#16a34a" : "#dc2626";
      const bg    = tier === 0 ? "#eff6ff" : tier === 1 ? "#f0fdf4" : "#fef2f2";
      faixaBadge = `<br><small style="display:inline-block;background:${bg};color:${cor};font-weight:800;padding:2px 8px;border-radius:10px;font-size:0.7rem;margin-top:3px">${tier === 2 ? "🏭 " : ""}${label} · Gs ${item._faixaAplicada.toLocaleString("es-PY")}/un</small>`;
    }

    lista.innerHTML += `
      <div class="cart-item-row">
        ${item.img ? `<img src="${item.img}" class="cart-thumb">` : ""}
        <div class="cart-details">
          <div class="cart-title">${item.nome}</div>
          ${detalhes}
          ${faixaBadge}
          ${obs}
          <div class="cart-item-price">Gs ${totalItem.toLocaleString("es-PY")}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;">
          <div class="qty-mini">
            <button onclick="mudarQtdCarrinho(${idx}, -1)">−</button>
            <span>${item.qtd}</span>
            <button onclick="mudarQtdCarrinho(${idx}, 1)">+</button>
          </div>
          <button onclick="removerItemCarrinho(${idx})" title="Remover item"
            class="btn-remover-item">🗑 Remover</button>
        </div>
      </div>
    `;
  });

  atualizarTotalCheckout();
}

function mudarQtdCarrinho(idx, delta) {
  if (idx < 0 || idx >= carrinho.length) return;
  carrinho[idx].qtd = Math.max(1, carrinho[idx].qtd + delta);
  renderCarrinho();
  updateUI();
}

function removerItemCarrinho(idx) {
  if (idx < 0 || idx >= carrinho.length) return;
  carrinho.splice(idx, 1);
  renderCarrinho();
  updateUI();
}

function renderUpsell() {
  const upsellDiv = document.getElementById("lista-upsell");
  if (!upsellDiv) return;

  upsellDiv.innerHTML = "";
  const upsellItems = MENU["bebidas"] || [];

  upsellItems.slice(0, 5).forEach((item) => {
    const img = item.img || "https://via.placeholder.com/80?text=🥤";
    upsellDiv.innerHTML += `
      <div class="upsell-item" style="min-width:100px;text-align:center;cursor:pointer;" onclick='adicionarUpsell(${JSON.stringify(item).replace(/'/g, "&#39;")})'>
        <img src="${img}" style="width:70px;height:70px;object-fit:cover;border-radius:8px;margin-bottom:5px;">
        <div style="font-size:0.75rem;font-weight:600">${item.nome}</div>
        <div style="font-size:0.7rem;color:var(--primary)">Gs ${item.preco.toLocaleString("es-PY")}</div>
      </div>
    `;
  });
}

function adicionarUpsell(item) {
  // Se o item tem variações/montagem, abre o modal de escolha em vez de adicionar direto
  const cfg = item.montagem;
  const temVariacao =
    cfg &&
    ((cfg.__tipo && cfg.__tipo !== "padrao") ||
      (cfg.variacoes && cfg.variacoes.length > 0) ||
      cfg.pizza ||
      (cfg.tamanhos && cfg.tamanhos.length > 0) ||
      cfg.shake);
  if (temVariacao || item.e_montavel) {
    abrirModal(item);
    return;
  }
  carrinho.push({
    ...item,
    produto_id: item.id,
    qtd: 1,
    montagem: [],
    obs: "",
  });
  renderCarrinho();
  updateUI();
}

// ==========================================
// CUPOM DE DESCONTO
// ==========================================
// aplicarCupom() — versão async que busca do banco está abaixo (~linha 2765)
// A versão síncrona com cupons hardcoded foi removida (bug #1)

function atualizarTotalCheckout() {
  const totalItens = carrinho.reduce((a, i) => a + i.preco * i.qtd, 0);
  let desconto = 0;
  let freteAplicado = freteCalculado; // não tem mais sentinela -1

  if (cupomAplicado) {
    if (cupomAplicado.tipo === "percentual") {
      desconto = Math.round(totalItens * (cupomAplicado.valor / 100));
    } else if (cupomAplicado.tipo === "frete") {
      freteAplicado = 0;
    }
  }

  const totalGeral =
    totalItens - desconto + (modoEntrega === "delivery" ? freteAplicado : 0);

  let html = `
    <div style="display:flex;justify-content:space-between;margin:5px 0;font-size:0.9rem">
      <span>Subtotal:</span>
      <span>Gs ${totalItens.toLocaleString("es-PY")}</span>
    </div>
  `;

  if (desconto > 0) {
    html += `
      <div style="display:flex;justify-content:space-between;margin:5px 0;font-size:0.9rem;color:#27ae60">
        <span>Desconto (${cupomAplicado.codigo}):</span>
        <span>- Gs ${desconto.toLocaleString("es-PY")}</span>
      </div>
    `;
  }

  if (modoEntrega === "delivery") {
    let freteLabel;
    if (freteACombinar) {
      freteLabel = `<span style="color:#e67e22;font-weight:700">🤝 A combinar</span>`;
    } else if (freteSemGPS) {
      freteLabel = `<span style="color:#e67e22">Taxa padrão — Gs ${freteAplicado.toLocaleString("es-PY")}</span>`;
    } else {
      freteLabel = `Gs ${freteAplicado.toLocaleString("es-PY")}`;
    }
    html += `
        <div style="display:flex;justify-content:space-between;margin:5px 0;font-size:0.9rem">
          <span>Frete:</span>
          <span>${freteLabel}</span>
        </div>
      `;
  }

  const totalEl = document.getElementById("total-final-checkout");
  if (totalEl) {
    totalEl.innerHTML = `
      <div style="border-top:2px solid #eee;padding-top:10px;margin-top:10px">
        ${html}
        <div style="display:flex;justify-content:space-between;font-size:1.2rem;font-weight:bold;margin-top:10px">
          <span>Total:</span>
          <span>Gs ${totalGeral.toLocaleString("es-PY")}</span>
        </div>
      </div>
    `;
  }
}

function mudarModoEntrega(modo) {
  modoEntrega = modo;
  document
    .getElementById("btn-delivery")
    .classList.toggle("active", modo === "delivery");
  document
    .getElementById("btn-retirada")
    .classList.toggle("active", modo === "retirada");
  const btnLocal = document.getElementById("btn-local");
  if (btnLocal) btnLocal.classList.toggle("active", modo === "local");
  document.getElementById("box-endereco").style.display =
    modo === "delivery" ? "block" : "none";
  atualizarTotalCheckout();
}

function toggleFactura() {
  const checked = document.getElementById("check-factura").checked;
  document.getElementById("box-ruc").classList.toggle("hidden", !checked);
}

function verificarPagamento() {
  const pag = document.getElementById("forma-pag").value;
  const infoDiv = document.getElementById("info-pagamento-extra");
  const boxTroco = document.getElementById("box-troco");
  const boxMulti = document.getElementById("box-multipagamento");
  const selectPag = document.getElementById("forma-pag");

  infoDiv.style.display = "none";
  boxTroco.classList.add("hidden");
  if (boxMulti) boxMulti.style.display = "none";

  if (pag === "Efetivo") {
    boxTroco.classList.remove("hidden");
  } else if (pag === "Pix") {
    infoDiv.style.display = "block";
    const totalItens = carrinho.reduce((a, i) => a + i.preco * i.qtd, 0);
    let freteAplicado =
      modoEntrega === "delivery" ? Math.max(0, freteCalculado) : 0;
    let desconto = 0;
    if (cupomAplicado) {
      if (cupomAplicado.tipo === "percentual")
        desconto = Math.round(totalItens * (cupomAplicado.valor / 100));
      else if (cupomAplicado.tipo === "frete") freteAplicado = 0;
    }
    const totalGs = totalItens - desconto + freteAplicado;
    const totalBrl =
      COTACAO_REAL > 0 ? (totalGs / COTACAO_REAL).toFixed(2) : "---";
    infoDiv.innerHTML = `<strong>💳 Chave Pix:</strong><br>${CHAVE_PIX}<br><small>Titular: ${NOME_PIX}</small><br><strong style="color:#27ae60;font-size:1rem">💰 Valor: R$ ${totalBrl}</strong>`;
  } else if (pag === "Transferencia") {
    infoDiv.style.display = "block";
    infoDiv.innerHTML = `<strong>🏦 Dados para Transferência:</strong><br>${DADOS_ALIAS}<br>${ALIAS_PY}`;
  } else if (pag === "QR_PY") {
    infoDiv.style.display = "block";
    infoDiv.innerHTML = `<strong>📲 Pague via QR Paraguai</strong><br><small style="color:#555">Bi-Pago · Wepa · Zimple · Tigo Money · Billetera Personal</small><br><span style="color:#1a7a2e;font-weight:700">Mostre o QR ao operador ou escaneie o QR da loja</span>`;
  } else if (pag === "Multipagamento") {
    if (boxMulti) {
      boxMulti.style.display = "block";
      // Esconde o select enquanto está no modo multi
      selectPag.style.display = "none";
      // Inicializa com 2 formas se ainda não há nenhuma
      const partes = document.getElementById("multi-partes");
      if (partes && partes.children.length === 0) {
        adicionarPartePagamento(); // 1ª forma
        adicionarPartePagamento(); // 2ª forma
      }
      atualizarRestanteMulti();
    }
    return; // Não chama atualizarRestanteMulti de novo
  }

  // Garante que o select volte a aparecer se não for Multipagamento
  if (selectPag) selectPag.style.display = "";
}

// ==========================================
// MULTIPAGAMENTO
// ==========================================
let _multiContador = 0;

const METODOS_PAG = [
  { value: "Efetivo", label: "💵 Efectivo" },
  { value: "Cartao", label: "💳 Tarjeta" },
  { value: "Pix", label: "🟢 Pix (BR)" },
  { value: "Transferencia", label: "🏦 Alias/Transferencia" },
  { value: "QR_PY", label: "📲 QR Paraguai (Bi-Pago/Wepa)" },
];

function _getTotalPedidoAtual() {
  const totalItens = carrinho.reduce((a, i) => a + i.preco * i.qtd, 0);
  let freteAplicado =
    modoEntrega === "delivery" ? Math.max(0, freteCalculado) : 0;
  let desconto = 0;
  if (cupomAplicado) {
    if (cupomAplicado.tipo === "percentual")
      desconto = Math.round(totalItens * (cupomAplicado.valor / 100));
    else if (cupomAplicado.tipo === "frete") freteAplicado = 0;
  }
  return totalItens - desconto + freteAplicado;
}

function voltarPagamentoUnico() {
  // Reseta o select para "nada selecionado" e esconde o painel multi
  document.getElementById("forma-pag").value = "";
  document.getElementById("box-multipagamento").style.display = "none";
  // Limpa as partes
  document.getElementById("multi-partes").innerHTML = "";
  _multiContador = 0;
  verificarPagamento();
}

function adicionarPartePagamento() {
  const container = document.getElementById("multi-partes");
  if (!container) return;
  _multiContador++;
  const id = _multiContador;
  const ordinal = ["1ª", "2ª", "3ª", "4ª", "5ª"][id - 1] || `${id}ª`;

  const metodoOptions = METODOS_PAG.map(
    (m) => `<option value="${m.value}">${m.label}</option>`,
  ).join("");

  const card = document.createElement("div");
  card.id = `multi-parte-${id}`;
  card.style.cssText = `
    background: white;
    border: 1.5px solid #e0e0e0;
    border-radius: 12px;
    padding: 14px;
    margin-bottom: 10px;
    position: relative;
  `;
  card.innerHTML = `
    <div style="font-size:0.78rem; font-weight:700; color:#888; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:10px;">
      ${ordinal} FORMA
    </div>
    <div style="display:flex; gap:10px; align-items:flex-start;">
      <select id="multi-metodo-${id}" onchange="verificarPartePix(${id})"
          style="flex:1.5; padding:10px; border:1.5px solid #e0e0e0; border-radius:8px; font-size:0.9rem; background:white; font-weight:600;">
        <option value="">Selecionar forma...</option>
        ${metodoOptions}
      </select>
      <div style="flex:1; position:relative;">
        <span style="position:absolute; left:10px; top:50%; transform:translateY(-50%); color:#888; font-size:0.85rem; pointer-events:none;">Gs</span>
        <input type="number" id="multi-valor-${id}" placeholder="0" min="0" step="1000"
            oninput="atualizarRestanteMulti()"
            style="width:100%; padding:10px 10px 10px 30px; border:1.5px solid #e0e0e0; border-radius:8px; font-size:0.95rem; font-weight:700; box-sizing:border-box;">
      </div>
      ${
        id > 2
          ? `<button type="button" onclick="removerPartePagamento(${id})"
          style="background:#ffeaea; color:#e74c3c; border:none; padding:10px 12px; border-radius:8px; cursor:pointer; font-size:0.9rem; flex-shrink:0;">✕</button>`
          : ""
      }
    </div>
    <!-- Info Efetivo (troco) -->
    <div id="multi-troco-${id}" style="display:none; margin-top:8px;">
      <input type="number" id="multi-troco-val-${id}" placeholder="Troco para (Gs)" min="0" step="1000"
          style="width:100%; padding:9px; border:1.5px solid #f0a500; border-radius:8px; font-size:0.87rem; box-sizing:border-box;">
    </div>
    <!-- Info Pix -->
    <div id="multi-pix-info-${id}" style="display:none; margin-top:8px; font-size:0.83rem; color:#27ae60; font-weight:600; text-align:right;"></div>
  `;
  container.appendChild(card);
  atualizarRestanteMulti();
}

// Chamado quando muda o SELECT de método — mostra/esconde troco e info Pix
// NÃO chama atualizarRestanteMulti (evita loop infinito)
function verificarPartePix(id) {
  const metodo = document.getElementById(`multi-metodo-${id}`)?.value;
  const trocoBox = document.getElementById(`multi-troco-${id}`);
  if (trocoBox)
    trocoBox.style.display = metodo === "Efetivo" ? "block" : "none";
  // Atualiza info pix sem recursar
  _atualizarPixInfo(id, metodo);
  // Só chama atualizar ao mudar método, sem recursão
  atualizarRestanteMulti(false);
}

// Atualiza o bloco de info Pix para um card específico (sem chamar atualizarRestanteMulti)
function _atualizarPixInfo(id, metodo) {
  const pixInfo = document.getElementById(`multi-pix-info-${id}`);
  if (!pixInfo) return;
  if (metodo === "Pix") {
    const valor =
      parseFloat(document.getElementById(`multi-valor-${id}`)?.value) || 0;
    if (valor > 0 && COTACAO_REAL > 0) {
      const brl = (valor / COTACAO_REAL).toFixed(2);
      pixInfo.style.display = "block";
      pixInfo.innerHTML = `💠 Pix: <strong>R$ ${brl}</strong> &nbsp;·&nbsp; Chave: ${CHAVE_PIX}`;
    } else {
      pixInfo.style.display = "none";
    }
  } else {
    pixInfo.style.display = "none";
  }
}

function removerPartePagamento(id) {
  const el = document.getElementById(`multi-parte-${id}`);
  if (el) el.remove();
  atualizarRestanteMulti(false);
}

// skipPixUpdate evita recursão: quando chamado DE verificarPartePix, passa false
function atualizarRestanteMulti(atualizarPix = true) {
  const total = _getTotalPedidoAtual();
  const inputs = [...document.querySelectorAll('[id^="multi-valor-"]')];
  let soma = 0;
  inputs.forEach((inp) => {
    soma += parseFloat(inp.value) || 0;
  });

  const restante = total - soma;
  const bar = document.getElementById("multi-status-bar");
  const el = document.getElementById("multi-restante");

  // ── AUTO-FILL: se há exatamente 1 input vazio e ainda sobra valor, preenche ──
  const inputsVazios = inputs.filter(
    (inp) => !inp.value || parseFloat(inp.value) === 0,
  );
  if (inputsVazios.length === 1 && restante > 0) {
    inputsVazios[0].value = restante;
    // Recalcula com o novo valor preenchido
    soma = total;
  }

  if (!el || !bar) return;
  bar.style.display = "block";

  const diff = total - soma;
  if (Math.abs(diff) < 1) {
    bar.style.background = "#eafaf1";
    bar.style.borderColor = "#27ae60";
    el.innerHTML = `<span style="color:#27ae60">✅ Total coberto: Gs ${total.toLocaleString("es-PY")}</span>`;
  } else if (diff > 0) {
    bar.style.background = "#fff8e6";
    bar.style.borderColor = "#f0a500";
    el.innerHTML = `<span style="color:#e67e22">⚠️ Faltam: Gs ${diff.toLocaleString("es-PY")}</span>`;
  } else {
    bar.style.background = "#fdf3f3";
    bar.style.borderColor = "#e74c3c";
    el.innerHTML = `<span style="color:#e74c3c">❌ Excede: Gs ${Math.abs(diff).toLocaleString("es-PY")}</span>`;
  }

  // Atualiza info de Pix — SEM chamar verificarPartePix (que chamaria atualizarRestanteMulti de volta)
  if (atualizarPix) {
    inputs.forEach((inp) => {
      const idNum = inp.id.replace("multi-valor-", "");
      const metodo = document.getElementById(`multi-metodo-${idNum}`)?.value;
      _atualizarPixInfo(idNum, metodo || "");
    });
  }
}

function _coletarMultiPagamento() {
  const partes = [];
  document.querySelectorAll('[id^="multi-parte-"]').forEach((div) => {
    const idStr = div.id.replace("multi-parte-", "");
    const metodo =
      document.getElementById(`multi-metodo-${idStr}`)?.value || "";
    const valor =
      parseFloat(document.getElementById(`multi-valor-${idStr}`)?.value) || 0;
    const troco =
      document.getElementById(`multi-troco-val-${idStr}`)?.value || "";
    if (metodo && valor > 0)
      partes.push({ metodo, valor, troco: troco || null });
  });
  return partes;
}

async function calcularFrete() {
  const btn     = document.getElementById("btn-gps");
  const msg     = document.getElementById("frete-msg");
  const boxErro = document.getElementById("box-erro-gps");

  // ── Guard 0: elementos essenciais existem? ────────────────────────
  if (!btn || !msg || !boxErro) {
    console.warn("[calcularFrete] ❌ Elementos do DOM não encontrados",
      { btn: !!btn, msg: !!msg, boxErro: !!boxErro });
    return;
  }

  // ── Log de diagnóstico ────────────────────────────────────────────
  console.log("[calcularFrete] 🔵 Clique recebido");
  console.log("[calcularFrete] COORD_LOJA =", COORD_LOJA);
  console.log("[calcularFrete] TABELA_FRETE =", TABELA_FRETE);
  console.log("[calcularFrete] protocol =", location.protocol);
  console.log("[calcularFrete] geolocation support =", !!navigator.geolocation);

  // ── Estado de loading ────────────────────────────────────────────
  btn.innerText   = "⏳ Localizando...";
  btn.disabled    = true;
  msg.style.color = "";
  msg.innerHTML   = '<span style="color:#888">⏳ Obtendo sua localização...</span>';
  boxErro.style.display = "none";

  // Helper para restaurar o botão em qualquer caminho de saída
  const _restaurarBotao = (texto = "📍 Calcular Envio") => {
    btn.innerText = texto;
    btn.disabled  = false;
  };

  // ── Guard 1: loja precisa ter coordenadas configuradas ────────────
  const _temCoordLoja =
    Number.isFinite(COORD_LOJA?.lat) && Number.isFinite(COORD_LOJA?.lng) &&
    (COORD_LOJA.lat !== 0 || COORD_LOJA.lng !== 0);

  if (!_temCoordLoja) {
    msg.innerHTML = '<span style="color:#e74c3c">⚠️ Loja sem coordenadas configuradas. Contate o suporte.</span>';
    _restaurarBotao();
    return;
  }

  // ── Guard 2: HTTPS obrigatório para Geolocation API ───────────────
  const _protocoloSeguro =
    location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";

  if (!_protocoloSeguro) {
    msg.innerHTML = '<span style="color:#e74c3c">⚠️ GPS requer HTTPS. Acesse o site via <code>https://</code></span>';
    boxErro.innerHTML = `
      <p><strong><i class="fas fa-info-circle"></i> Sem HTTPS o GPS não funciona</strong></p>
      <p style="margin-top:6px">Você pode aplicar a <strong>taxa padrão de entrega</strong> ou combinar o valor pelo WhatsApp.</p>
      <label style="display:flex;align-items:center;gap:10px;margin-top:8px;cursor:pointer;">
        <input type="checkbox" id="check-sem-gps" style="width:20px;height:20px;" onchange="aplicarFreteFixo()">
        <span>Aplicar taxa padrão de entrega</span>
      </label>`;
    boxErro.style.display = "block";
    _restaurarBotao();
    return;
  }

  // ── Guard 3: API de geolocalização disponível? ────────────────────
  if (!navigator.geolocation) {
    msg.innerHTML = '<span style="color:#e74c3c">GPS não disponível neste dispositivo.</span>';
    _restaurarBotao();
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  //  WATCHDOG — se nenhum callback disparar em 15s, destrava o botão.
  //  O timeout nativo do browser NÃO é confiável em iOS Safari com
  //  permissão pendente — este é o backup que garante destravamento.
  // ═══════════════════════════════════════════════════════════════
  let _gpsFinalizado = false;

  const _mostrarFallbackManual = (titulo, texto) => {
    boxErro.innerHTML = `
      <p><strong><i class="fas fa-info-circle"></i> ${titulo}</strong></p>
      <p style="margin-top:6px">${texto}</p>
      <label style="display:flex;align-items:center;gap:10px;margin-top:8px;cursor:pointer;">
        <input type="checkbox" id="check-sem-gps" style="width:20px;height:20px;" onchange="aplicarFreteFixo()">
        <span>Aplicar taxa padrão de entrega</span>
      </label>`;
    boxErro.style.display = "block";
    _restaurarBotao("📍 Tentar Novamente");
  };

  const _watchdog = setTimeout(() => {
    if (_gpsFinalizado) return;
    _gpsFinalizado = true;
    console.warn("[calcularFrete] ⏰ Watchdog disparou — geolocation não respondeu em 15s");
    msg.innerHTML = '<span style="color:#e74c3c">⚠️ GPS não respondeu. Verifique se a localização está ativa no navegador.</span>';
    _mostrarFallbackManual(
      "GPS não respondeu?",
      "Isso pode acontecer se você negou a permissão ou se a localização está desativada no dispositivo."
    );
  }, 15000);

  // ═══════════════════════════════════════════════════════════════
  //  Solicita posição do cliente
  // ═══════════════════════════════════════════════════════════════
  navigator.geolocation.getCurrentPosition(
    // ── Sucesso ──────────────────────────────────────────────────
    async (position) => {
      if (_gpsFinalizado) return;
      _gpsFinalizado = true;
      clearTimeout(_watchdog);

      localCliente = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };

      console.log("[calcularFrete] 📍 Cliente em:", localCliente);

      msg.style.color = "";
      msg.innerHTML   = '<span style="color:#888">⏳ Calculando rota real...</span>';

      // ── Chama OSRM com timeout interno ─────────────────────────
      let dist = null;
      try {
        dist = await obterDistanciaPelaRota(
          COORD_LOJA.lat, COORD_LOJA.lng,
          localCliente.lat, localCliente.lng
        );
        console.log("[calcularFrete] 📏 Distância OSRM:", dist, "km");
      } catch (e) {
        console.warn("[calcularFrete] OSRM falhou:", e.message);
        dist = null;
      }

      // ── OSRM falhou ou retornou valor inválido → taxa padrão ───
      if (dist === null || !Number.isFinite(dist) || dist <= 0) {
        const r = calcularFreteSemLocalizacao(TABELA_FRETE);
        freteCalculado = r.loja;
        freteMotoboy   = r.motoboy;
        freteSemGPS    = true;
        freteACombinar = r.acombinar === true;

        if (freteACombinar) {
          msg.innerHTML = `<span style="color:#e67e22">⚠️ Rota indisponível — Frete <strong>a combinar</strong></span>`;
        } else {
          msg.innerHTML = `<span style="color:#e67e22">⚠️ Rota indisponível. Aplicada taxa padrão: Gs ${r.loja.toLocaleString("es-PY")}</span>`;
        }
      }
      // ── OSRM OK → aplica faixa real (ou "a combinar") ──────────
      else {
        const r = calcularFretePorDistancia(dist, TABELA_FRETE);
        freteCalculado = r.loja;
        freteMotoboy   = r.motoboy;
        freteACombinar = r.acombinar === true;
        freteSemGPS    = false;

        if (freteACombinar) {
          msg.innerHTML = `<span style="color:#e67e22">✅ Rota: ${dist.toFixed(1)}km — Frete <strong>a combinar</strong></span>`;
        } else {
          msg.innerHTML = `<span style="color:#27ae60">✅ Rota: ${dist.toFixed(1)}km — Frete: Gs ${r.loja.toLocaleString("es-PY")}</span>`;
        }
      }

      boxErro.style.display = "none";
      btn.innerText         = "✅ Localização OK";
      btn.disabled          = true;
      atualizarTotalCheckout();
    },

    // ── Erro ─────────────────────────────────────────────────────
    (err) => {
      if (_gpsFinalizado) return;
      _gpsFinalizado = true;
      clearTimeout(_watchdog);

      console.warn("[calcularFrete] ❌ Erro geolocation:", err.code, err.message);

      let errMsg = "Não foi possível obter sua localização.";
      if (err.code === 1)      errMsg = "⚠️ Permissão de GPS negada.";
      else if (err.code === 2) errMsg = "⚠️ Localização indisponível. Verifique se o GPS está ativo.";
      else if (err.code === 3) errMsg = "⚠️ Tempo esgotado ao obter localização.";

      msg.innerHTML = `<span style="color:#e74c3c">${errMsg}</span>`;
      _mostrarFallbackManual(
        "GPS não funcionou?",
        "Você pode aplicar a <strong>taxa padrão de entrega</strong> (equivalente a 2–3 km) e prosseguir."
      );
    },

    // ── Opções ───────────────────────────────────────────────────
    { timeout: 10000, maximumAge: 60000, enableHighAccuracy: true }
  );
}

/**
 * Aplica frete fixo (faixa 2,1–3 km) quando o cliente NÃO informa localização.
 * Disparado pelo checkbox #check-sem-gps no bloco de erro do GPS.
 */
function aplicarFreteFixo() {
  const chk = document.getElementById("check-sem-gps");
  const msg = document.getElementById("frete-msg");

  // Desmarcou → limpa estado
  if (!chk?.checked) {
    freteCalculado = 0;
    freteMotoboy = 0;
    freteSemGPS = false;
    if (msg) msg.innerHTML = "";
    atualizarTotalCheckout();
    return;
  }

  const r = calcularFreteSemLocalizacao(TABELA_FRETE);
  freteCalculado = r.loja;
  freteMotoboy = r.motoboy;
  freteSemGPS = true;
  freteACombinar = false;

  if (msg) {
    msg.innerHTML = `<span style="color:#e67e22">📦 Taxa padrão aplicada: Gs ${r.loja.toLocaleString("es-PY")}</span>`;
  }
  atualizarTotalCheckout();
}

// ==========================================
// 8. ENVIO DO PEDIDO
// ==========================================
// ── Trava global anti-duplo-clique ──────────────────────────────
let _enviandoPedido = false;

async function enviarZap() {
  if (_enviandoPedido) return;
  _enviandoPedido = true;

  const _btnEnviar =
    document.querySelector('[onclick="enviarZap()"]') ||
    document.querySelector("[onclick='enviarZap()']");
  const _textoOriginal = _btnEnviar ? _btnEnviar.innerHTML : "";
  if (_btnEnviar) {
    _btnEnviar.disabled = true;
    _btnEnviar.style.opacity = "0.6";
    _btnEnviar.innerHTML = "⏳ Processando...";
  }
  const _liberarBotao = () => {
    _enviandoPedido = false;
    if (_btnEnviar) {
      _btnEnviar.disabled = false;
      _btnEnviar.style.opacity = "1";
      _btnEnviar.innerHTML = _textoOriginal;
    }
  };
  const _timerLiberar = setTimeout(_liberarBotao, 60000);

  try {
    const nome = document.getElementById("cli-nome").value.trim();
    const ddi = document.getElementById("cli-ddi").value;
    const tel = document.getElementById("cli-tel").value.trim();
    const pag = document.getElementById("forma-pag").value;

    if (!nome || !tel || !pag)
      return alert("Preencha todos os campos obrigatórios!");

    // Troco obrigatório quando pagamento em Efetivo
    if (pag === "Efetivo") {
      const trocoVal = document.getElementById("troco-valor").value.trim();
      if (!trocoVal || parseFloat(trocoVal.replace(/[^\d]/g, "")) <= 0) {
        document.getElementById("troco-valor").focus();
        document.getElementById("troco-valor").style.borderColor = "#e74c3c";
        return alert("⚠️ Informe o valor em dinheiro para cálculo do troco!");
      }
      document.getElementById("troco-valor").style.borderColor = "";
    }

    // Promoções do dia: bloquear pagamento com Cartão
    const temPromoItem = carrinho.some((item) => {
      for (const key in MENU) {
        if (key === "promocoes_do_dia") {
          const found = MENU[key].find(
            (m) => m.id === item.id || m.nome === item.nome,
          );
          if (found) return true;
        }
      }
      return false;
    });
    if (temPromoItem && pag === "Cartao") {
      return alert(
        '⚠️ Produtos da "Promoção do Dia" não aceitam pagamento com Cartão.',
      );
    }

    // Anti-duplicata do lado do cliente: bloqueia reenvio do MESMO carrinho
    // em até 1h. A chave enviada ao servidor é diferente — esta é só UX.
    const _agora = Date.now();
    const _ultimoHash = localStorage.getItem("locanda_last_hash");
    const _ultimoTs = parseInt(localStorage.getItem("locanda_last_ts") || "0");
    const _hashAtual = carrinho
      .map((i) => i.nome + i.qtd)
      .sort()
      .join("|");
    if (_ultimoHash === _hashAtual && _agora - _ultimoTs < 3600000) {
      return alert(
        "🚫 Seu pedido anterior foi computado, estamos bloqueando esta segunda tentativa.",
      );
    }
    localStorage.setItem("locanda_last_hash", _hashAtual);
    localStorage.setItem("locanda_last_ts", _agora.toString());

    // Valida multipagamento
    if (pag === "Multipagamento") {
      const partes = _coletarMultiPagamento();
      if (partes.length < 2)
        return alert(
          "Adicione pelo menos 2 formas de pagamento para o multipagamento.",
        );
      const somaPartes = partes.reduce((s, p) => s + p.valor, 0);
      const totalCheck =
        carrinho.reduce((a, i) => a + i.preco * i.qtd, 0) -
        (cupomAplicado?.tipo === "percentual"
          ? Math.round(
              carrinho.reduce((a, i) => a + i.preco * i.qtd, 0) *
                (cupomAplicado.valor / 100),
            )
          : 0) +
        (modoEntrega === "delivery"
          ? cupomAplicado?.tipo === "frete"
            ? 0
            : Math.max(0, freteCalculado)
          : 0);
      if (Math.abs(somaPartes - totalCheck) > 1) {
        return alert(
          `A soma dos pagamentos (Gs ${somaPartes.toLocaleString("es-PY")}) não confere com o total do pedido (Gs ${totalCheck.toLocaleString("es-PY")}). Ajuste os valores.`,
        );
      }
    }

    if (
      modoEntrega === "delivery" &&
      !localCliente &&
      !document.getElementById("check-sem-gps")?.checked
    ) {
      alert(
        "Por favor, calcule o frete ou marque a opção de enviar localização pelo WhatsApp",
      );
      return;
    }

    if (modoEntrega === "delivery" && freteCalculado === null) {
      alert(
        "Sua localização está fora da área de entrega da loja. Não é possível finalizar o pedido.",
      );
      return;
    }

    const usouPlanoB = document.getElementById("check-sem-gps")?.checked;
    const ref = document.getElementById("cli-ref").value || "";
    const telSanitizado = tel.replace(/[^\d]/g, "");
    const telCompleto = ddi + telSanitizado;

    const totalItens = carrinho.reduce((a, i) => a + i.preco * i.qtd, 0);
    let desconto = 0;
    let freteAplicado = freteCalculado;
    let freteACombinarLocal = freteACombinar;

    if (cupomAplicado) {
      if (cupomAplicado.tipo === "percentual") {
        desconto = Math.round(totalItens * (cupomAplicado.valor / 100));
      } else if (cupomAplicado.tipo === "frete") {
        freteAplicado = 0;
      }
    }

    const totalGeral =
      totalItens - desconto + (modoEntrega === "delivery" ? freteAplicado : 0);

    // ─────────────────────────────────────────────────────────────────
    //  INSERE VIA EDGE FUNCTION (validação server-side autoritativa)
    //  Fallback: se a função não estiver deployada (404), faz INSERT
    //  direto para não quebrar a operação em produção.
    // ─────────────────────────────────────────────────────────────────
    let pedidoDbId = null;
    let numeroPedido = null;
    let _dupResposta = false;

    if (typeof supa !== "undefined") {
      // Chave de idempotência com bucket de 2 MINUTOS.
      // - Retries dentro da janela → mesma chave → servidor deduplica
      // - Compras futuras legítimas → novo bucket → nova chave → UNIQUE ok
      const _pdvTimeBucket = Math.floor(Date.now() / 120000);
      const _iKey = btoa(
        encodeURIComponent(
          _hashAtual + "|" + telCompleto + "|" + _pdvTimeBucket,
        ),
      ).slice(0, 64);

      const pedidoDb = {
        status: "pendente",
        idempotency_key: _iKey,
        tipo_entrega: modoEntrega,
        subtotal: totalItens,
        frete_cobrado_cliente: modoEntrega === "delivery" ? freteAplicado : 0,
        frete_motoboy: modoEntrega === "delivery" ? freteMotoboy : 0,
        frete_a_combinar: modoEntrega === "delivery" ? freteACombinarLocal : false,
        desconto_cupom: desconto,
        cupom_codigo: cupomAplicado?.codigo || null,
        total_geral: totalGeral,
        forma_pagamento: pag,
        obs_pagamento:
          pag === "Efetivo"
            ? document.getElementById("troco-valor").value
            : pag === "Multipagamento"
              ? JSON.stringify(_coletarMultiPagamento())
              : "",
        itens: carrinho.map((i) => ({
          produto_id: i.produto_id || i.id,
          n: i.nome,
          nome: i.nome,
          p: i.preco,
          q: i.qtd,
          qtd: i.qtd,
          t: i.variacao || "",
          pr: i.preparo || "",
          m: i.montagem,
          o: i.obs,
          categoria_slug: i.categoria_slug || i.cat || "",
          _tier: i._faixaTier ?? null,
          _faixaAplicada: i._faixaAplicada ?? null,
          _extrasSoma: i._extrasSoma ?? 0,
        })),
        endereco_entrega: ref,
        geo_lat: localCliente ? localCliente.lat.toString() : null,
        geo_lng: localCliente ? localCliente.lng.toString() : null,
        cliente_nome: nome,
        cliente_telefone: telCompleto,
        dados_factura: document.getElementById("check-factura").checked
          ? {
              ruc: document.getElementById("cli-ruc").value,
              razao: document.getElementById("cli-zao").value,
            }
          : null,
        // ⚡ NOVO (push): inclui a subscription da Push API no payload.
        // Se o usuário não ativou notificações, o valor é null e o
        // cliente simplesmente não receberá push deste pedido.
        push_subscription: _pushSubscriptionCache || null,
      };

      // 1ª tentativa: Edge Function autoritativa
      let _fnOk = false;
      try {
        const { data: _fnRes, error: _fnErr } = await supa.functions.invoke(
          "validar-pedido",
          { body: pedidoDb },
        );

        if (_fnErr) {
          // Extrai mensagem do corpo (o invoke retorna FunctionsHttpError em non-2xx)
          let _msg = "Erro ao processar pedido";
          try {
            const _ctx = _fnErr.context;
            if (_ctx && typeof _ctx.json === "function") {
              const _j = await _ctx.clone().json();
              _msg = _j?.error || _msg;
            } else if (_fnErr.message) {
              _msg = _fnErr.message;
            }
          } catch (_) {
            if (_fnErr.message) _msg = _fnErr.message;
          }

          // 404 = Edge Function não deployada → fallback para INSERT direto
          const _is404 =
            _fnErr.context?.status === 404 ||
            /not found/i.test(_fnErr.message || "");
          if (_is404) {
            console.warn(
              "[enviarZap] validar-pedido não deployada — usando INSERT direto",
            );
          } else {
            alert("❌ " + _msg);
            return;
          }
        } else if (_fnRes?.error) {
          alert("❌ " + _fnRes.error);
          return;
        } else if (_fnRes?.id) {
          pedidoDbId = _fnRes.id;
          numeroPedido = _fnRes.id;
          _dupResposta = _fnRes.duplicate === true;
          // Atualiza frete com o valor autoritativo do servidor
          if (_fnRes.frete_cobrado_cliente != null)
            freteAplicado = _fnRes.frete_cobrado_cliente;
          if (_fnRes.frete_a_combinar != null)
            freteACombinarLocal = _fnRes.frete_a_combinar;
          _fnOk = true;
        }
      } catch (_e) {
        console.warn(
          "[enviarZap] Falha ao invocar Edge Function, usando INSERT direto:",
          _e.message,
        );
      }

      // Fallback: INSERT direto quando a Edge Function não respondeu
      if (!_fnOk) {
        const { data: pedidoSalvo, error } = await supa
          .from("pedidos")
          .insert([pedidoDb])
          .select()
          .single();

        if (error) {
          if (
            error.code === "23505" ||
            /duplicate key/i.test(error.message || "")
          ) {
            alert(
              "⚠️ Este pedido já foi registrado. Verifique o histórico de pedidos.",
            );
            return;
          }
          console.error("Erro ao salvar pedido:", error);
          alert("⚠️ Erro ao salvar pedido no sistema. Tente novamente.");
          return;
        }

        if (pedidoSalvo) {
          pedidoDbId = pedidoSalvo.id;
          numeroPedido = pedidoSalvo.id;
        }
      }

      // Incrementa contador de usos do cupom (só se pedido realmente criado)
      if (!_dupResposta && cupomAplicado?.id && pedidoDbId) {
        const novosUsos = (cupomAplicado.usos_realizados || 0) + 1;
        await supa
          .from("cupons")
          .update({ usos_realizados: novosUsos })
          .eq("id", cupomAplicado.id);
      }

      // Se foi duplicado, avisa o cliente e mostra o tracking
      if (_dupResposta) {
        alert(
          `✅ Seu pedido já havia sido registrado (#${numeroPedido}). Redirecionando para o acompanhamento.`,
        );
        carrinho = [];
        cupomAplicado = null;
        updateUI();
        fecharCheckout();
        mostrarCardTracking(numeroPedido);
        return;
      }
    }

    // Salva localmente para "Repetir Pedido"
    localStorage.setItem("locanda_last", JSON.stringify(carrinho));
    localStorage.setItem("locanda_user", JSON.stringify({ nome, tel }));

    // 2. Usa o número real do pedido na mensagem
    const idDisplay = numeroPedido || "TEMP";

    // 3. Monta Mensagem WhatsApp
    const _nomeLojaMsg = (NOME_RESTAURANTE_APP || "").trim() || "LOJA";
    let msg = `🛒 PEDIDO #${idDisplay} - ${_nomeLojaMsg.toUpperCase()}\n`;
    msg += `--------------------------\n`;
    msg += `👤 Cliente: ${nome}\n`;
    msg += `📱 Tel: ${telCompleto}\n`;
    msg += `🛵 Tipo: ${modoEntrega === "delivery" ? "DELIVERY" : modoEntrega === "local" ? "COMER NO LOCAL 🍽️" : "RETIRADA"}\n`;

    if (modoEntrega === "delivery") {
      if (localCliente) {
        msg += `📍 Maps: https://maps.google.com/?q=${localCliente.lat},${localCliente.lng}\n`;
      } else if (usouPlanoB) {
        msg += `📍 *Localização:* Enviarei aqui no WhatsApp 📎\n`;
      }

      if (freteACombinarLocal) {
        msg += `🛵 *Delivery:* 🤝 A COMBINAR (motoboy + cliente combinam)\n`;
      } else if (freteSemGPS) {
        msg += `🛵 *Delivery:* Gs ${freteAplicado.toLocaleString("es-PY")} (taxa padrão)\n`;
      } else if (freteAplicado === 0) {
        msg += `🛵 *Delivery:* Grátis\n`;
      } else {
        msg += `🛵 *Delivery:* Gs ${freteAplicado.toLocaleString("es-PY")}\n`;
      }
      msg += `🏠 Ref: ${ref}\n`;
    }

    msg += `--------------------------\n`;
    carrinho.forEach((item) => {
      msg += `${item.qtd}x ${item.nome}`;
      if (item.variacao) msg += ` — ${item.variacao}`;
      if (item.preparo) msg += ` [${item.preparo}]`;
      msg += `\n`;
      if (item.montagem && item.montagem.length > 0)
        msg += `   + ${item.montagem.join(", ")}\n`;
      if (item.obs) msg += `   Obs: ${item.obs}\n`;
    });

    msg += `--------------------------\n`;
    msg += `Subtotal: Gs ${totalItens.toLocaleString("es-PY")}\n`;

    if (desconto > 0) {
      msg += `Desconto (${cupomAplicado.codigo}): -Gs ${desconto.toLocaleString("es-PY")}\n`;
    }

    // Recalcula totalGeral com os valores autoritativos do servidor
    const totalGeralFinal =
      totalItens - desconto + (modoEntrega === "delivery" ? freteAplicado : 0);

    if (modoEntrega === "delivery" && !usouPlanoB) {
      if (freteACombinarLocal) {
        msg += `Delivery: 🤝 A COMBINAR\n`;
        msg += `TOTAL (sem frete): Gs ${totalGeralFinal.toLocaleString("es-PY")}\n`;
      } else {
        msg += `Delivery: Gs ${freteAplicado.toLocaleString("es-PY")}\n`;
        msg += `TOTAL: Gs ${totalGeralFinal.toLocaleString("es-PY")}\n`;
      }
    } else {
      msg += `TOTAL: Gs ${totalGeralFinal.toLocaleString("es-PY")}\n`;
    }
    msg += `--------------------------\n`;

    // Pagamento e Troco
    if (pag === "Efetivo") {
      const trocoVal = document.getElementById("troco-valor").value;
      msg += `💰 Pagamento: Efetivo (Troco p/: ${trocoVal})\n`;
    } else if (pag === "Multipagamento") {
      const partes = _coletarMultiPagamento();
      msg += `💰 Pagamento dividido (${partes.length} formas):\n`;
      partes.forEach((p, i) => {
        msg += `   ${i + 1}. ${p.metodo}: Gs ${p.valor.toLocaleString("es-PY")}`;
        if (p.troco)
          msg += ` (Troco p/ Gs ${parseFloat(p.troco).toLocaleString("es-PY")})`;
        msg += "\n";
      });
    } else {
      msg += `💰 Pagamento: ${pag}\n`;
    }

    // Avisos de Pix/Alias
    if (pag === "Pix" || pag === "Transferencia") {
      if (pag === "Pix") {
        const totalBrl =
          COTACAO_REAL > 0 ? (totalGeralFinal / COTACAO_REAL).toFixed(2) : "---";
        msg += `\n💠 Chave Pix: ${CHAVE_PIX}\n`;
        msg += `💰 Valor em Reais: R$ ${totalBrl}\n`;
      }
      if (pag === "Transferencia") msg += `\n📎 Alias: ${ALIAS_PY}\n`;
      msg += `\n⚠️ *Envie o comprovante após o pagamento!*\n`;
    }

    if (pag === "Multipagamento") {
      const partes = _coletarMultiPagamento();
      partes.forEach((p, idx) => {
        if (p.metodo === "Pix") {
          const valBrl =
            COTACAO_REAL > 0 ? (p.valor / COTACAO_REAL).toFixed(2) : "---";
          msg += `\n💠 Pix (forma ${idx + 1}): Chave ${CHAVE_PIX} — R$ ${valBrl}\n`;
        }
        if (p.metodo === "Transferencia") {
          msg += `\n📎 Alias (forma ${idx + 1}): ${ALIAS_PY}\n`;
        }
      });
      const temDigital = partes.some(
        (p) => p.metodo === "Pix" || p.metodo === "Transferencia",
      );
      if (temDigital)
        msg += `\n⚠️ *Envie o(s) comprovante(s) após o pagamento!*\n`;
    }

    if (document.getElementById("check-factura").checked) {
      msg += `\n📄 RUC: ${document.getElementById("cli-ruc").value}\nRazão: ${document.getElementById("cli-zao").value}\n`;
    }

    const _precisaZap = (() => {
      if (pag === "Pix" || pag === "Transferencia") return true;
      if (pag === "Multipagamento") {
        const partes = _coletarMultiPagamento();
        return partes.some(
          (p) => p.metodo === "Pix" || p.metodo === "Transferencia",
        );
      }
      return false;
    })();

    if (_precisaZap) {
      await _mostrarModalEnvio(msg, numeroPedido);
    } else {
      _mostrarConfirmacaoPedido(numeroPedido);
      carrinho = [];
      cupomAplicado = null;
      MODO_AGENDAMENTO = false;
      DATA_AGENDAMENTO = null;
      const indicadorAg = document.getElementById("indicador-agendamento");
      if (indicadorAg) indicadorAg.remove();
      try {
        localStorage.removeItem("locanda_carrinho_backup");
        localStorage.removeItem("locanda_carrinho_backup_time");
      } catch (e) {}
      updateUI();
      fecharCheckout();
      if (numeroPedido) mostrarCardTracking(numeroPedido);
    }
  } catch (err) {
    console.error("[enviarZap] Erro:", err);
    alert("Ocorreu um erro ao processar o pedido. Tente novamente.");
  } finally {
    clearTimeout(_timerLiberar);
    _liberarBotao();
  }
}

// Modal: "Seu pedido será validado somente após enviar no WhatsApp"
function _mostrarModalEnvio(msg, numeroPedido) {
  return new Promise((resolve) => {
    const _old = document.getElementById("modal-envio-zap");
    if (_old) _old.remove();

    // Injeta animação de pulsar (só uma vez)
    if (!document.getElementById("zap-pulse-style")) {
      const st = document.createElement("style");
      st.id = "zap-pulse-style";
      st.textContent = `
        @keyframes zapPulse {
          0%   { box-shadow: 0 0 0 0 rgba(37,211,102,0.7); transform: scale(1); }
          50%  { box-shadow: 0 0 0 14px rgba(37,211,102,0); transform: scale(1.03); }
          100% { box-shadow: 0 0 0 0 rgba(37,211,102,0); transform: scale(1); }
        }
        #btn-abrir-zap { animation: zapPulse 1.2s ease-in-out infinite; }
      `;
      document.head.appendChild(st);
    }

    const modal = document.createElement("div");
    modal.id = "modal-envio-zap";
    modal.style.cssText = [
      "position:fixed;inset:0;z-index:99999",
      "background:rgba(0,0,0,0.75)",
      "display:flex;align-items:center;justify-content:center",
      "padding:20px;box-sizing:border-box",
    ].join(";");
    modal.innerHTML = `
      <div style="background:white;border-radius:20px;padding:30px 24px;max-width:380px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.4)">
        <div style="font-size:3.5rem;margin-bottom:10px">📱</div>
        <h3 style="margin:0 0 8px;font-size:1.2rem;color:#1a1a2e">Pedido registrado! ✅</h3>
        <div style="background:#fff3cd;border:1.5px solid #ffc107;border-radius:12px;padding:12px 14px;margin-bottom:18px;text-align:left;">
          <div style="font-size:1rem;margin-bottom:4px;">📎 <strong>Pagamento via transferência / Pix</strong></div>
          <div style="font-size:0.85rem;color:#555;line-height:1.5;">
            Após realizar o pagamento, <strong>envie o comprovante</strong> pelo WhatsApp.<br>
            <span style="color:#e74c3c;font-weight:700;">⚠️ O pedido só será preparado após confirmação do comprovante.</span>
          </div>
        </div>
        <button id="btn-abrir-zap"
          style="width:100%;padding:18px;background:#25D366;color:white;border:none;border-radius:14px;font-size:1.05rem;font-weight:800;cursor:pointer;letter-spacing:0.3px;display:flex;align-items:center;justify-content:center;gap:8px;">
          <i class="fab fa-whatsapp" style="font-size:1.3rem;"></i> Enviar pedido + comprovante
        </button>
        <p style="margin:12px 0 0;font-size:0.75rem;color:#aaa;">Este aviso não fecha sozinho. Envie a mensagem para continuar.</p>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById("btn-abrir-zap").onclick = () => {
      _abrirZapEFechar(msg, numeroPedido, modal, resolve);
    };
  });
}

function _abrirZapEFechar(msg, numeroPedido, modal, resolve) {
  window.open(
    `https://wa.me/${FONE_LOJA}?text=${encodeURIComponent(msg)}`,
    "_blank",
  );
  if (modal) modal.remove();

  // Limpa carrinho e fecha checkout
  carrinho = [];
  cupomAplicado = null;
  MODO_AGENDAMENTO = false;
  DATA_AGENDAMENTO = null;
  const indicador = document.getElementById("indicador-agendamento");
  if (indicador) indicador.remove();

  // Limpa backup imediatamente para não restaurar na próxima visita
  try {
    localStorage.removeItem("locanda_carrinho_backup");
    localStorage.removeItem("locanda_carrinho_backup_time");
  } catch (e) {}

  updateUI();
  fecharCheckout();

  // Card de tracking
  if (numeroPedido) mostrarCardTracking(numeroPedido);

  resolve();
}

// Confirmação simples (sem WhatsApp) para pagamentos em dinheiro/cartão/QR
function _mostrarConfirmacaoPedido(numeroPedido) {
  const _old = document.getElementById("modal-confirmacao-pedido");
  if (_old) _old.remove();

  const modal = document.createElement("div");
  modal.id = "modal-confirmacao-pedido";
  modal.style.cssText = [
    "position:fixed;inset:0;z-index:99999",
    "background:rgba(0,0,0,0.75)",
    "display:flex;align-items:center;justify-content:center",
    "padding:20px;box-sizing:border-box",
  ].join(";");
  modal.innerHTML = `
    <div style="background:white;border-radius:20px;padding:30px 24px;max-width:380px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.4)">
      <div style="font-size:3.5rem;margin-bottom:10px">✅</div>
      <h3 style="margin:0 0 8px;font-size:1.2rem;color:#1a1a2e">Pedido confirmado!</h3>
      <p style="margin:0 0 6px;font-size:1rem;color:#27ae60;font-weight:700">Pedido #${numeroPedido || ""}</p>
      <p style="margin:0 0 20px;font-size:0.93rem;color:#555;line-height:1.55">
        Seu pedido foi registrado com sucesso. Acompanhe o status abaixo.
      </p>
      <button onclick="document.getElementById('modal-confirmacao-pedido').remove()"
        style="width:100%;padding:16px;background:var(--primary);color:white;border:none;border-radius:14px;font-size:1rem;font-weight:700;cursor:pointer;">
        OK, acompanhar pedido
      </button>
    </div>`;
  document.body.appendChild(modal);
}

function carregarDadosLocal() {
  try {
    const user = JSON.parse(localStorage.getItem("locanda_user") || "null");
    if (user) {
      if (document.getElementById("cli-nome"))
        document.getElementById("cli-nome").value = user.nome || "";
      if (document.getElementById("cli-tel"))
        document.getElementById("cli-tel").value = user.tel || "";
    }
  } catch (e) {
    console.warn("Dados de usuário corrompidos no localStorage:", e);
    localStorage.removeItem("locanda_user");
  }

  try {
    const last = JSON.parse(localStorage.getItem("locanda_last") || "null");
    const box = document.getElementById("buy-again-container");

    if (last && Array.isArray(last) && last.length > 0) {
      if (box) {
        box.style.display = "block";
        const ul = document.getElementById("last-order-list");
        if (ul) {
          ul.innerHTML = "";
          last.forEach((i) => {
            const li = document.createElement("li");
            li.style.cssText = "border-bottom:1px dashed #eee;padding:5px 0";
            li.innerHTML = `<b>${i.qtd}x</b> `;
            li.appendChild(document.createTextNode(i.nome || ""));
            ul.appendChild(li);
          });
        }
      }
    } else {
      if (box) box.style.display = "none";
    }
  } catch (e) {
    console.warn("Último pedido corrompido no localStorage:", e);
    localStorage.removeItem("locanda_last");
  }
}

function repetirPedido() {
  const last = JSON.parse(localStorage.getItem("locanda_last"));
  if (last && Array.isArray(last) && last.length > 0) {
    carrinho = last;
    updateUI();
    abrirCheckout();
  }
}

function clicarBanner(idProduto) {
  let produtoEncontrado = null;
  for (const key in MENU) {
    const item = MENU[key].find((i) => i.id == idProduto);
    if (item) {
      produtoEncontrado = item;
      break;
    }
  }

  if (produtoEncontrado) {
    abrirModal(produtoEncontrado);
  } else {
    console.error("Produto do banner não encontrado no menu carregado.");
    // Não damos alert para não incomodar caso o menu ainda esteja carregando
  }
}
// ==========================================
// 10. TRACKING DE PEDIDO — POLLING GARANTIDO
// ==========================================
// ARQUITETURA: polling a cada 5s como BASE (funciona sempre).
// Realtime como BÔNUS (mais rápido, mas fecha no plano free).
// O erro "CLOSED" no console é normal — o polling cobre.
let _trackingChannel = null; // canal Realtime (bônus)
let _pollingTracker = null; // setInterval de 5s (garantia)
let _lastTrackedSt = ""; // evita re-render sem mudança
let _trackedId = null; // id do pedido em tracking

// ── Realtime: ouve mudanças em configuracoes para atualizar formas de pagamento ──
let _cfgChannel = null;
function _iniciarRealtimeConfiguracoes() {
  try {
    if (_cfgChannel) {
      _cfgChannel.unsubscribe();
      _cfgChannel = null;
    }
    _cfgChannel = supa
      .channel("cfg-pagamentos-app")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "configuracoes" },
        (payload) => {
          const novasFeatures = payload.new?.features_ativas;
          if (novasFeatures) {
            _aplicarFormasPagamentoCliente(novasFeatures);
          }
        },
      )
      .subscribe((status) => {
        if (status === "CLOSED" || status === "CHANNEL_ERROR") {
          _cfgChannel = null;
        }
      });
  } catch (e) {
    /* Realtime indisponível — polling em verificarHorario() cobre */
  }
}

const TRACKER_STEPS = {
  pendente: {
    step: 1,
    icon: "📥",
    msg: "Pedido recebido! Aguardando confirmação...",
  },
  em_preparo: { step: 2, icon: "🛍", msg: "Seu pedido está sendo separado!" },
  pronto_entrega: { step: 3, icon: "📦", msg: "Pronto! Aguardando motoboy..." },
  saiu_entrega: { step: 3, icon: "🛵", msg: "Seu pedido saiu para entrega!" },
  entregue: {
    step: 4,
    icon: "✅",
    msg: "Pedido entregue! Obrigado por sua compra 🛒!",
  },
  cancelado: {
    step: 0,
    icon: "❌",
    msg: "Pedido cancelado. Entre em contato conosco.",
  },
};

function iniciarTracking(pedidoDbId, uidTemporal) {
  if (!pedidoDbId) return;
  _trackedId = pedidoDbId;
  const uid = uidTemporal || pedidoDbId;

  try {
    localStorage.setItem("locanda_pedido_id", pedidoDbId);
    localStorage.setItem("locanda_pedido_uid", uid);
  } catch (e) {}

  _lastTrackedSt = "pendente";
  mostrarTracker("pendente", uid);

  _iniciarPollingTracking(pedidoDbId, uid); // GARANTIA (sempre funciona)
  _tentarCanalRealtime(pedidoDbId, uid); // BÔNUS (mais rápido quando disponível)

  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

// ── POLLING: consulta o banco a cada 5s ──
function _iniciarPollingTracking(pedidoId, uid) {
  if (_pollingTracker) {
    clearInterval(_pollingTracker);
    _pollingTracker = null;
  }

  _pollingTracker = setInterval(async () => {
    try {
      const { data } = await supa
        .from("pedidos")
        .select("status, motoboy_id")
        .eq("id", pedidoId)
        .single();

      if (!data || data.status === _lastTrackedSt) return; // sem mudança
      _lastTrackedSt = data.status;

      mostrarTracker(data.status, uid);

      // Atualiza também o card de busca se visível
      if (typeof atualizarTrackingVisual === "function") {
        let motoboy = null;
        if (data.motoboy_id) {
          const { data: m } = await supa
            .from("motoboys")
            .select("nome, telefone")
            .eq("id", data.motoboy_id)
            .single();
          motoboy = m;
        }
        atualizarTrackingVisual(data.status, motoboy);
      }

      // Notificação push
      if (
        "Notification" in window &&
        Notification.permission === "granted" &&
        TRACKER_STEPS[data.status]
      ) {
        new Notification(NOME_RESTAURANTE_APP || "Seu Pedido", {
          body: TRACKER_STEPS[data.status].msg,
          icon: CFG_LOGO_URL || "",
        });
      }

      if (data.status === "entregue" || data.status === "cancelado") {
        clearInterval(_pollingTracker);
        _pollingTracker = null;
        if (_trackingChannel) {
          _trackingChannel.unsubscribe();
          _trackingChannel = null;
        }
        setTimeout(() => {
          try {
            localStorage.removeItem("locanda_pedido_id");
            localStorage.removeItem("locanda_pedido_uid");
          } catch (e) {}
        }, 10000);
      }
    } catch (e) {
      /* falha silenciosa de rede */
    }
  }, 5000);
}

// ── REALTIME: bônus quando disponível ──
function _tentarCanalRealtime(pedidoId, uid) {
  try {
    if (_trackingChannel) {
      _trackingChannel.unsubscribe();
      _trackingChannel = null;
    }
    _trackingChannel = supa
      .channel(`pizzeria-track-${pedidoId}-${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "pedidos",
          filter: `id=eq.${pedidoId}`,
        },
        (payload) => {
          const ns = payload.new?.status;
          if (ns && ns !== _lastTrackedSt) {
            _lastTrackedSt = ns;
            mostrarTracker(ns, uid);
          }
        },
      )
      .subscribe((st) => {
        // CLOSED é normal no plano free — polling já cobre
        if (st === "CLOSED" || st === "CHANNEL_ERROR") {
          _trackingChannel = null;
        }
      });
  } catch (e) {
    /* Realtime indisponível */
  }
}

// [Sistema legado mostrarTracker removido — usando versão track-order-card em L161]

function fecharTracker() {
  // Fecha tanto o tracker antigo quanto o novo card
  const tracker = document.getElementById("pedido-tracker");
  if (tracker) tracker.style.display = "none";
  const card = document.getElementById("track-order-card");
  if (card) card.style.display = "none";
  if (_trackingChannel) {
    _trackingChannel.unsubscribe();
    _trackingChannel = null;
  }
  if (_pollingTracker) {
    clearInterval(_pollingTracker);
    _pollingTracker = null;
  }
}

// Alias para o botão × do card de tracking no index.html
function fecharCardTracking() {
  fecharTracker();
}

// Restaura tracking ao recarregar a página
function restaurarTrackingSeExistir() {
  // Card de rastreio oculto por padrão - só aparece se houver pedido ativo
  const card = document.getElementById("track-order-card");
  if (card) card.style.display = "none";

  const savedId = localStorage.getItem("locanda_pedido_id");
  const savedUid = localStorage.getItem("locanda_pedido_uid");
  if (!savedId) return;

  console.log("🔄 Restaurando tracking para pedido:", savedId);
  if (typeof supa === "undefined") return;

  supa
    .from("pedidos")
    .select("status, motoboy_id, created_at")
    .eq("id", savedId)
    .single()
    .then(async ({ data, error }) => {
      if (error || !data) return;
      // Se já foi entregue ou cancelado, limpa e não mostra tracker
      if (data.status === "entregue" || data.status === "cancelado") {
        try {
          localStorage.removeItem("locanda_pedido_id");
          localStorage.removeItem("locanda_pedido_uid");
        } catch (e) {}
        return;
      }

      // REGRA 6H: tracker só aparece se o pedido tem menos de 6 horas
      if (data.created_at) {
        const diffHoras =
          (Date.now() - new Date(data.created_at).getTime()) / 3600000;
        if (diffHoras > 6) {
          try {
            localStorage.removeItem("locanda_pedido_id");
            localStorage.removeItem("locanda_pedido_uid");
          } catch (e) {}
          return;
        }
      }

      // Só mostra o card se houver pedido ativo
      if (card) card.style.display = "block";

      // Preenche input e abre resultado direto
      const input = document.getElementById("track-pedido-input");
      if (input) input.value = savedId;
      const tf = document.getElementById("track-form");
      if (tf) tf.style.display = "none";
      const tr = document.getElementById("track-result");
      if (tr) tr.style.display = "block";
      const tn = document.getElementById("track-numero");
      if (tn) tn.textContent = savedId;

      let motoboy = null;
      if (data.motoboy_id) {
        const { data: m } = await supa
          .from("motoboys")
          .select("nome, telefone")
          .eq("id", data.motoboy_id)
          .single();
        motoboy = m;
      }

      atualizarTrackingVisual(data.status, motoboy);
      _lastTrackedSt = data.status;
      _trackedId = savedId;

      _iniciarPollingTracking(savedId, savedUid);
      _tentarCanalRealtime(savedId, savedUid);
    });
}

async function aplicarCupom() {
  const codigo = document
    .getElementById("cupom-codigo")
    ?.value?.trim()
    .toUpperCase();
  const msgBox = document.getElementById("cupom-msg");

  if (!codigo) {
    msgBox.innerHTML = '<span style="color:#e74c3c">Digite um código</span>';
    msgBox.style.display = "block";
    return;
  }

  // Busca no banco
  const { data: cupom, error } = await supa
    .from("cupons")
    .select("*")
    .eq("codigo", codigo)
    .eq("ativo", true)
    .single();

  if (error || !cupom) {
    msgBox.innerHTML =
      '<span style="color:#e74c3c">❌ Cupom inválido ou inativo</span>';
    msgBox.style.display = "block";
    cupomAplicado = null;
    atualizarTotalCheckout();
    return;
  }

  // Verifica validade
  if (cupom.validade) {
    const vDate = new Date(cupom.validade + "T23:59:59");
    if (vDate < new Date()) {
      msgBox.innerHTML = '<span style="color:#e74c3c">❌ Cupom expirado</span>';
      msgBox.style.display = "block";
      cupomAplicado = null;
      atualizarTotalCheckout();
      return;
    }
  }

  // Verifica limite de usos
  if (cupom.limite_uso && cupom.limite_uso > 0) {
    const usados = cupom.usos_realizados || 0;
    if (usados >= cupom.limite_uso) {
      msgBox.innerHTML = `<span style="color:#e74c3c">❌ Este cupom atingiu o limite de ${cupom.limite_uso} usos</span>`;
      msgBox.style.display = "block";
      cupomAplicado = null;
      atualizarTotalCheckout();
      return;
    }
  }

  const subtotal = carrinho.reduce((a, i) => a + i.preco * i.qtd, 0);
  // Fix #41: tratar minimo NULL como 0 (sem valor mínimo exigido)
  const minimoExigido = parseFloat(cupom.minimo) || 0;
  if (minimoExigido > 0 && subtotal < minimoExigido) {
    msgBox.innerHTML = `<span style="color:#e74c3c">Valor mínimo: Gs ${minimoExigido.toLocaleString("es-PY")}</span>`;
    msgBox.style.display = "block";
    cupomAplicado = null;
  } else {
    cupomAplicado = cupom;
    const restante = cupom.limite_uso
      ? ` (${cupom.limite_uso - (cupom.usos_realizados || 0)} restantes)`
      : "";
    msgBox.innerHTML = `<span style="color:#27ae60">✅ Cupom aplicado!${restante}</span>`;
    msgBox.style.display = "block";
  }

  atualizarTotalCheckout();
}
// =============================================
// NOVO SISTEMA DE TRACKING - CARD FIXO
// =============================================

// Mostrar card de tracking automaticamente após enviar pedido
function mostrarCardTracking(numeroPedido) {
  const card = document.getElementById("track-order-card");
  const input = document.getElementById("track-pedido-input");

  if (card && input) {
    card.style.display = "block";
    input.value = numeroPedido;
    buscarPedido(); // Busca automaticamente

    // Scroll suave até o card
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// Voltar para busca
function voltarBusca() {
  document.getElementById("track-form").style.display = "block";
  document.getElementById("track-result").style.display = "none";
  document.getElementById("track-pedido-input").value = "";
}

// Buscar pedido por número
async function buscarPedido() {
  const input = document.getElementById("track-pedido-input");
  const numeroPedido = input ? input.value.trim() : "";

  if (!numeroPedido) {
    alert("Por favor, digite o número do pedido");
    return;
  }

  // Esconde form, mostra resultado
  document.getElementById("track-form").style.display = "none";
  document.getElementById("track-result").style.display = "block";
  document.getElementById("track-numero").textContent = numeroPedido;
  document.getElementById("track-status-msg").textContent = "Buscando...";

  try {
    // Busca no Supabase
    const { data: pedido, error } = await supa
      .from("pedidos")
      .select("*, motoboys(nome, telefone)")
      .eq("id", parseInt(numeroPedido))
      .single();

    if (error || !pedido) {
      document.getElementById("track-status-msg").textContent =
        "Pedido não encontrado";
      document.getElementById("track-icon").textContent = "❌";
      return;
    }

    // Atualiza status visual
    atualizarTrackingVisual(pedido.status, pedido.motoboys);

    // Inscreve no Realtime para atualizações
    iniciarTrackingRealtime(pedido.id);
  } catch (err) {
    console.error("Erro ao buscar pedido:", err);
    document.getElementById("track-status-msg").textContent =
      "Erro ao buscar pedido";
  }
}

// Atualizar visual do tracking
function atualizarTrackingVisual(status, motoboy) {
  const statusMap = {
    pendente: { msg: "Aguardando confirmação...", icon: "⏳", step: 1 },
    em_preparo: { msg: "🔥 Separando seu pedido!", icon: "🔥", step: 2 },
    pronto_entrega: {
      msg: "📦 Pronto! Aguardando motoboy...",
      icon: "📦",
      step: 3,
    },
    saiu_entrega: {
      msg: "🛵 Seu pedido saiu para entrega!",
      icon: "🛵",
      step: 3,
    },
    entregue: { msg: "✅ Pedido entregue!", icon: "✅", step: 4 },
    cancelado: {
      msg: "❌ Pedido cancelado. Fale conosco.",
      icon: "❌",
      step: 0,
    },
  };

  const info = statusMap[status] || statusMap["pendente"];

  document.getElementById("track-status-msg").textContent = info.msg;
  document.getElementById("track-icon").textContent = info.icon;

  // Ativa steps
  for (let i = 1; i <= 4; i++) {
    const step = document.getElementById(`track-step-${i}`);
    if (step) {
      if (i <= info.step) {
        step.classList.add("active");
      } else {
        step.classList.remove("active");
      }
    }
  }

  // Mostra info do motoboy se saiu para entrega
  const motoInfo = document.getElementById("track-motoboy-info");
  if (motoInfo) {
    if ((status === "saiu_entrega" || status === "entregue") && motoboy) {
      motoInfo.style.display = "block";
      document.getElementById("track-motoboy-nome").textContent =
        motoboy.nome || "Não informado";
      const telLink = document.getElementById("track-motoboy-tel");
      if (telLink && motoboy.telefone) {
        telLink.textContent = motoboy.telefone;
        telLink.href = `https://wa.me/${motoboy.telefone.replace(/\D/g, "")}`;
      }
    } else {
      motoInfo.style.display = "none";
    }
  }

  // Limpa botões dinâmicos anteriores
  const _trackResult = document.getElementById("track-result");
  ["btn-confirmar-entrega", "btn-editar-pedido", "btn-cancelar-pedido"].forEach(
    (id) => {
      const el = document.getElementById(id);
      if (el) el.remove();
    },
  );

  if (status === "saiu_entrega") {
    // Botão confirmar recebimento
    if (_trackResult) {
      const _btn = document.createElement("button");
      _btn.id = "btn-confirmar-entrega";
      _btn.onclick = confirmarEntregaCliente;
      _btn.style.cssText =
        "width:100%;margin-top:14px;padding:14px 0;background:linear-gradient(135deg,#27ae60,#2ecc71);color:white;border:none;border-radius:12px;font-weight:700;font-size:1rem;cursor:pointer;letter-spacing:0.3px;box-shadow:0 4px 12px rgba(39,174,96,0.35)";
      _btn.innerHTML = "✅ Confirmar Recebimento do Pedido";
      _trackResult.appendChild(_btn);
    }
    // Inicia timer auto-confirm se ainda não iniciado
    const _pedidoLocal = localStorage.getItem("locanda_pedido_id");
    if (_pedidoLocal && typeof iniciarTimerAutoConfirmacao === "function") {
      if (!localStorage.getItem("locanda_confirmExpiry_" + _pedidoLocal)) {
        iniciarTimerAutoConfirmacao(_pedidoLocal);
      }
    }
  } else if (status === "pendente") {
    // Botão editar pedido (só enquanto pendente)
    if (_trackResult) {
      const _btnEdit = document.createElement("button");
      _btnEdit.id = "btn-editar-pedido";
      _btnEdit.onclick = abrirEdicaoPedido;
      _btnEdit.style.cssText =
        "width:100%;margin-top:10px;padding:12px 0;background:linear-gradient(135deg,#f39c12,#e67e22);color:white;border:none;border-radius:12px;font-weight:700;font-size:0.95rem;cursor:pointer;box-shadow:0 4px 12px rgba(243,156,18,0.35)";
      _btnEdit.innerHTML = "✏️ Editar Pedido";
      _trackResult.appendChild(_btnEdit);
    }
  }

  // Botão cancelar — disponível em pendente e em_preparo
  if (["pendente", "em_preparo"].includes(status) && _trackResult) {
    const _btnCancel = document.createElement("button");
    _btnCancel.id = "btn-cancelar-pedido";
    _btnCancel.onclick = solicitarCancelamentoCliente;
    _btnCancel.style.cssText =
      "width:100%;margin-top:8px;padding:10px 0;background:transparent;color:#e74c3c;border:1.5px solid #e74c3c;border-radius:12px;font-weight:600;font-size:0.85rem;cursor:pointer;";
    _btnCancel.innerHTML = "🚫 Solicitar Cancelamento";
    _trackResult.appendChild(_btnCancel);
  }
}

// ── EDIÇÃO DE PEDIDO PELO CLIENTE ────────────────────────────────
function abrirEdicaoPedido() {
  const pedidoId = localStorage.getItem("locanda_pedido_id");
  if (!pedidoId) return;

  // Fecha tracking e abre carrinho com itens atuais
  const modal = document.createElement("div");
  modal.id = "modal-edicao-pedido";
  modal.style.cssText =
    "position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;";
  modal.innerHTML = `
      <div style="background:white;border-radius:20px;padding:28px 22px;max-width:400px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.4)">
        <div style="font-size:2.5rem;margin-bottom:12px">✏️</div>
        <h3 style="margin:0 0 10px;font-size:1.1rem;color:#1a1a2e">Editar Pedido</h3>
        <p style="margin:0 0 16px;font-size:0.88rem;color:#555;line-height:1.5">
          Seu pedido ainda não foi aceito. Você pode:<br>
          <strong>• Adicionar ou remover itens</strong><br>
          <strong>• Alterar observações</strong>
        </p>
        <div style="background:#fff8e6;border:1.5px solid #f0a500;border-radius:10px;padding:12px;margin-bottom:18px;font-size:0.82rem;color:#855;text-align:left">
          ⚠️ Ao editar, a nova versão do pedido será enviada via WhatsApp para confirmação da loja. O pedido atual permanece registrado até a loja confirmar a alteração.
        </div>
        <button onclick="iniciarEdicaoCarrinho(${pedidoId})" style="width:100%;padding:13px;background:linear-gradient(135deg,#f39c12,#e67e22);color:white;border:none;border-radius:12px;font-weight:700;cursor:pointer;font-size:0.95rem;margin-bottom:10px">
          ✏️ Editar meu pedido
        </button>
        <button onclick="document.getElementById('modal-edicao-pedido').remove()" style="width:100%;padding:10px;background:transparent;color:#999;border:1.5px solid #ddd;border-radius:12px;cursor:pointer;font-size:0.85rem">
          Cancelar
        </button>
      </div>`;
  document.body.appendChild(modal);
}

async function iniciarEdicaoCarrinho(pedidoId) {
  document.getElementById("modal-edicao-pedido")?.remove();

  // Busca o pedido atual para pré-carregar itens
  const { data: p } = await supa
    .from("pedidos")
    .select("itens,obs_geral")
    .eq("id", pedidoId)
    .single();

  if (!p) return alert("Pedido não encontrado.");

  // Pré-carrega itens no carrinho atual
  if (p.itens && Array.isArray(p.itens)) {
    carrinho = p.itens.map((i) => ({
      nome: i.nome || i.n,
      preco: i.preco || i.p || 0,
      qtd: i.qtd || i.q || 1,
      variacao: i.variacao || i.t || "",
      preparo: i.preparo || i.pr || "",
      montagem: i.montagem || i.m || [],
      obs: i.obs || i.o || "",
      img: i.img || "",
      categoria_slug: i.categoria_slug || "",
    }));
    updateUI();
  }

  // Abre o checkout com nota de edição
  abrirCheckout();

  // Adiciona banner de aviso no topo do checkout
  setTimeout(() => {
    const checkout =
      document.getElementById("checkout-panel") ||
      document.querySelector(".checkout-container");
    if (checkout) {
      const banner = document.createElement("div");
      banner.id = "banner-edicao";
      banner.style.cssText =
        "background:#fff3cd;border:1.5px solid #f0a500;border-radius:10px;padding:10px 14px;margin-bottom:12px;font-size:0.82rem;color:#7a5100;font-weight:600";
      banner.innerHTML =
        "✏️ <strong>Modo Edição</strong> — Modifique seus itens e clique em Enviar Pedido. A loja receberá a versão atualizada.";
      checkout.insertBefore(banner, checkout.firstChild);
    }
  }, 100);
}

// ── SOLICITAR CANCELAMENTO PELO CLIENTE (via tracking) ──────────
async function solicitarCancelamentoCliente() {
  const pedidoId = localStorage.getItem("locanda_pedido_id");
  if (!pedidoId) return;

  const motivo = prompt("Motivo do cancelamento (obrigatório):");
  if (!motivo || !motivo.trim()) return;

  const { error } = await supa
    .from("pedidos")
    .update({
      cancelamento_solicitado: true,
      cancelamento_motivo: motivo.trim(),
      cancelamento_solicitado_por: "cliente",
      cancelamento_solicitado_em: new Date().toISOString(),
    })
    .eq("id", parseInt(pedidoId));

  if (error) {
    alert("Erro ao solicitar cancelamento. Contate a loja pelo WhatsApp.");
  } else {
    alert("✅ Solicitação enviada! A loja irá avaliar e responder em breve.");
  }
}

// iniciarTrackingRealtime — usado pelo card de busca do index
// Delega para o sistema central (polling + realtime bônus)
function iniciarTrackingRealtime(pedidoId) {
  _trackedId = pedidoId;
  _lastTrackedSt = ""; // força re-render na primeira leitura do polling
  localStorage.setItem("locanda_pedido_id", pedidoId);
  localStorage.setItem("locanda_pedido_uid", pedidoId);
  _iniciarPollingTracking(pedidoId, pedidoId);
  _tentarCanalRealtime(pedidoId, pedidoId);
}

let saboresSelecionados = []; // Array global para guardar a pizza atual

// Função auxiliar para calcular preço da pizza
function calcularTotalPizza() {
  if (saboresSelecionados.length === 0) return 0;

  // 1. Encontra o sabor mais caro (REGRA DE OURO)
  let maiorPreco = 0;
  saboresSelecionados.forEach((sabor) => {
    if (sabor.preco > maiorPreco) maiorPreco = sabor.preco;
  });

  // 2. Verifica se tem borda
  const bordaPreco = produtoAtual.bordaSelecionada
    ? produtoAtual.bordaSelecionada.preco
    : 0;

  // 3. Atualiza botão
  const total = maiorPreco + bordaPreco;
  document.getElementById("btn-add-carrinho").innerText =
    `Adicionar Gs ${total.toLocaleString("es-PY")}`;

  return total;
}

// Função para adicionar sabor (deve ser ligada aos checkboxes/cards da UI)
function toggleSaborPizza(saborObj, maxSabores) {
  const index = saboresSelecionados.findIndex((s) => s.id === saborObj.id);

  if (index > -1) {
    // Se já tá, remove
    saboresSelecionados.splice(index, 1);
  } else {
    // Se não tá, verifica limite (1/2, 1/3, 1/4)
    if (saboresSelecionados.length < maxSabores) {
      saboresSelecionados.push(saborObj);
    } else {
      alert(
        `Você escolheu uma pizza de ${maxSabores} sabores. Remova um para trocar.`,
      );
      return;
    }
  }

  // Recalcula visual
  renderizarSaboresSelecionados(); // Função que pinta a pizza
  calcularTotalPizza();
}

// ==========================================
// DETECÇÃO DE CONEXÃO
// ==========================================
// ==========================================
// TOAST — NOTIFICAÇÕES VISUAIS (Bug #4 fix)
// ==========================================
function mostrarToast(msg, tipo = "info", duracao = 3000) {
  const CORES = {
    success: "#27ae60",
    warning: "#e67e22",
    error: "#e74c3c",
    info: "#2980b9",
  };
  const existing = document.getElementById("locanda-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "locanda-toast";
  toast.style.cssText = [
    "position:fixed;bottom:90px;left:50%;transform:translateX(-50%)",
    "background:" + (CORES[tipo] || CORES.info),
    "color:white;padding:12px 22px;border-radius:10px",
    "z-index:99999;font-weight:600;font-size:0.9rem",
    "box-shadow:0 4px 14px rgba(0,0,0,0.25)",
    "max-width:90vw;text-align:center",
    "transition:opacity 0.3s",
  ].join(";");
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 300);
  }, duracao);
}

function initDeteccaoConexao() {
  // Mostra alerta quando fica offline
  window.addEventListener("offline", () => {
    mostrarToast(
      "⚠️ Sem conexão com a internet. Algumas funcionalidades podem não funcionar.",
      "warning",
      5000,
    );
  });

  // Mostra alerta quando volta online
  window.addEventListener("online", () => {
    mostrarToast("✅ Conexão restaurada!", "success", 3000);
    // Recarrega dados
    verificarHorario();
  });
}

// Inicializa detecção de conexão
initDeteccaoConexao();

// ==========================================

// ==========================================
// AUTO-SALVAMENTO DO CARRINHO
// ==========================================
function salvarCarrinhoLocal() {
  try {
    if (carrinho && carrinho.length > 0) {
      localStorage.setItem("locanda_carrinho_backup", JSON.stringify(carrinho));
      localStorage.setItem(
        "locanda_carrinho_backup_time",
        new Date().toISOString(),
      );
    } else {
      localStorage.removeItem("locanda_carrinho_backup");
      localStorage.removeItem("locanda_carrinho_backup_time");
    }
  } catch (e) {
    console.warn("Não foi possível salvar backup do carrinho:", e);
  }
}

function restaurarCarrinhoBackup() {
  try {
    const backup = localStorage.getItem("locanda_carrinho_backup");
    const backupTime = localStorage.getItem("locanda_carrinho_backup_time");

    if (backup && backupTime) {
      const tempoBackup = new Date(backupTime);
      const agora = new Date();
      const diffHoras = (agora - tempoBackup) / (1000 * 60 * 60);

      // Só restaura se o backup tiver menos de 24 horas
      if (diffHoras < 24) {
        const carrinhoSalvo = JSON.parse(backup);
        if (carrinhoSalvo && carrinhoSalvo.length > 0) {
          if (
            confirm(
              "Você tem itens no carrinho de uma sessão anterior. Deseja restaurá-los?",
            )
          ) {
            carrinho = carrinhoSalvo;
            updateUI();
            mostrarToast("✅ Carrinho restaurado!", "success");
          }
        }
      }
    }
  } catch (e) {
    console.warn("Não foi possível restaurar backup do carrinho:", e);
  }
}

// Salva carrinho a cada mudança
setInterval(salvarCarrinhoLocal, 5000); // A cada 5 segundos

// Bug #13 fix: Não disparar confirm() no meio do render assíncrono do menu.
// restaurarCarrinhoBackup() agora é chamada após renderMenu() no DOMContentLoaded.
// O setTimeout foi removido daqui.

// ==========================================
// ══════════════════════════════════════════════════════════════
//  COMBO FECHADO — render + stepper (cliente)
// ══════════════════════════════════════════════════════════════

function _renderComboFechado(cfg, container) {
  if (!cfg || cfg.__tipo !== "combo_fechado") return;
  const limite = cfg.limite_total || 0;
  const sabores = cfg.sabores || [];

  _comboFechadoConfig.limite = limite;
  _comboFechadoConfig.sabores = sabores;
  _comboFechadoConfig.selecao = {};
  sabores.forEach((s) => (_comboFechadoConfig.selecao[s.id] = 0));

  const wrap = document.createElement("div");
  wrap.style.cssText = "padding:4px 0";

  const instrucao = document.createElement("p");
  instrucao.style.cssText =
    "font-size:0.85rem;color:#64748b;margin:0 0 12px;line-height:1.45";
  instrucao.textContent = `Distribua ${limite} ${limite === 1 ? "item" : "itens"} entre os sabores disponíveis.`;
  wrap.appendChild(instrucao);

  const contador = document.createElement("div");
  contador.id = "combo-contador";
  contador.style.cssText =
    "font-size:0.85rem;font-weight:600;color:#475569;text-align:center;" +
    "padding:8px 12px;background:#f8fafc;border:1.5px solid #e2e8f0;" +
    "border-radius:8px;margin-bottom:12px;transition:background .2s,color .2s,border-color .2s";
  contador.textContent = `0 / ${limite} selecionados`;
  wrap.appendChild(contador);

  const lista = document.createElement("div");
  lista.style.cssText =
    "border:1px solid #f1f5f9;border-radius:10px;overflow:hidden";

  sabores.forEach((sabor) => {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;" +
      "gap:12px;padding:11px 14px;border-bottom:1px solid #f1f5f9;background:#fff";

    const nome = document.createElement("span");
    nome.textContent = sabor.nome;
    nome.style.cssText =
      "flex:1;font-size:0.95rem;color:#1e293b;font-weight:500";

    const stepper = document.createElement("div");
    stepper.style.cssText =
      "display:flex;align-items:center;gap:0;border:1.5px solid #e5e7eb;" +
      "border-radius:8px;overflow:hidden;flex-shrink:0";

    const btnDec = document.createElement("button");
    btnDec.type = "button";
    btnDec.dataset.btnDec = sabor.id;
    btnDec.textContent = "−";
    btnDec.style.cssText =
      "width:34px;height:34px;background:#f8fafc;border:none;font-size:1.1rem;" +
      "font-weight:700;cursor:pointer;color:#374151;line-height:1";
    btnDec.disabled = true;
    btnDec.onclick = () => _cfDecrementar(sabor.id);

    const qty = document.createElement("span");
    qty.id = "cf-qty-" + sabor.id;
    qty.textContent = "0";
    qty.style.cssText =
      "min-width:36px;text-align:center;font-size:0.95rem;font-weight:700;" +
      "color:#1e293b;padding:0 4px;background:#fff;" +
      "border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;line-height:34px";

    const btnInc = document.createElement("button");
    btnInc.type = "button";
    btnInc.dataset.btnInc = sabor.id;
    btnInc.textContent = "+";
    btnInc.style.cssText =
      "width:34px;height:34px;background:#f8fafc;border:none;font-size:1.1rem;" +
      "font-weight:700;cursor:pointer;color:#374151;line-height:1";
    btnInc.onclick = () => _cfIncrementar(sabor.id);

    stepper.appendChild(btnDec);
    stepper.appendChild(qty);
    stepper.appendChild(btnInc);
    row.appendChild(nome);
    row.appendChild(stepper);
    lista.appendChild(row);
  });

  const lastRow = lista.lastElementChild;
  if (lastRow) lastRow.style.borderBottom = "none";

  wrap.appendChild(lista);
  container.appendChild(wrap);
  _cfAtualizarUI();
}

function _cfIncrementar(id) {
  const sel = _comboFechadoConfig.selecao;
  const total = Object.values(sel).reduce((a, b) => a + b, 0);
  if (total >= _comboFechadoConfig.limite) return;
  if (!(id in sel)) return;
  sel[id]++;
  _cfAtualizarUI();
}

function _cfDecrementar(id) {
  const sel = _comboFechadoConfig.selecao;
  if (!(id in sel) || sel[id] <= 0) return;
  sel[id]--;
  _cfAtualizarUI();
}

function _cfAtualizarUI() {
  const sel = _comboFechadoConfig.selecao;
  const limite = _comboFechadoConfig.limite;
  const total = Object.values(sel).reduce((a, b) => a + b, 0);
  const cheio = total >= limite;
  const exato = total === limite;

  Object.entries(sel).forEach(([id, qty]) => {
    const el = document.getElementById("cf-qty-" + id);
    if (el) el.textContent = qty;
  });

  const contador = document.getElementById("combo-contador");
  if (contador) {
    contador.textContent = `${total} / ${limite} selecionados`;
    contador.style.background = exato ? "#f0fdf4" : "#f8fafc";
    contador.style.borderColor = exato ? "#86efac" : "#e2e8f0";
    contador.style.color = exato ? "#166534" : "#475569";
  }

  document.querySelectorAll("[data-btn-inc]").forEach((btn) => {
    btn.disabled = cheio;
    btn.style.color = cheio ? "#cbd5e1" : "#374151";
    btn.style.cursor = cheio ? "not-allowed" : "pointer";
  });

  document.querySelectorAll("[data-btn-dec]").forEach((btn) => {
    const qty = sel[btn.dataset.btnDec] || 0;
    btn.disabled = qty <= 0;
    btn.style.color = qty <= 0 ? "#cbd5e1" : "#374151";
    btn.style.cursor = qty <= 0 ? "not-allowed" : "pointer";
  });

  const btnAdd = document.querySelector(".btn-add");
  if (btnAdd) {
    btnAdd.disabled = !exato;
    btnAdd.style.opacity = exato ? "1" : "0.45";
    btnAdd.style.cursor = exato ? "pointer" : "not-allowed";
  }
}

function _pdvParseQtyPrefix(input) {
  const s = (input || "").trim();
  const m = s.match(/^(\d+)\s*[x+]\s*(.+)$/i);
  if (m) return { qty: parseInt(m[1], 10) || 1, code: m[2].trim() };
  return { qty: 1, code: s };
}

// ═══════════════════════════════════════════════════════════════════
//  WEB PUSH — Notificações do status do pedido em tempo real
//
//  Fluxo:
//    1. _pushInicializar() roda no DOMContentLoaded
//    2. Se já autorizado, revalida a subscription silenciosamente
//    3. Se não, mostra banner de ativação após 4s
//    4. Usuário clica em "Ativar" → _pushSolicitarPermissao()
//    5. _pushRegistrar() captura a PushSubscription e guarda em cache
//    6. enviarZap() inclui _pushSubscriptionCache no payload do pedido
//    7. Edge Function notificar-cliente usa a subscription para enviar push
// ═══════════════════════════════════════════════════════════════════

let _pushSubscriptionCache = null;
let _vapidKeyCache = null;

/**
 * Converte chave VAPID Base64 URL-safe → Uint8Array.
 * Formato exigido pelo PushManager.subscribe().
 */
function _pushUrlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64  = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/**
 * Verifica suporte do navegador a Push API.
 */
function _pushSuportado() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Carrega a chave pública VAPID de configuracoes (cache em memória).
 * Retorna "" se não configurada.
 */
async function _pushCarregarVapidKey() {
  if (_vapidKeyCache !== null) return _vapidKeyCache;
  try {
    const { data } = await supa
      .from("configuracoes")
      .select("vapid_public_key")
      .maybeSingle();
    _vapidKeyCache = (data?.vapid_public_key || "").trim();
  } catch (_) {
    _vapidKeyCache = "";
  }
  return _vapidKeyCache;
}

/**
 * Registra a PushSubscription no navegador e guarda em _pushSubscriptionCache.
 * Só executa se o usuário concedeu permissão.
 *
 * Se houver um pedido ativo em tracking (localStorage.locanda_pedido_id),
 * vincula a subscription a esse pedido — assim o cliente recebe notificações
 * do pedido mesmo ativando as notificações APÓS finalizar a compra.
 *
 * Retorna { ok: boolean, subscription?: object, erro?: string }.
 */
async function _pushRegistrar() {
  if (!_pushSuportado()) {
    return { ok: false, erro: "Navegador sem suporte a notificações push." };
  }

  const vapidKey = await _pushCarregarVapidKey();
  if (!vapidKey) {
    console.warn("[Push] vapid_public_key não configurada em `configuracoes`.");
    return { ok: false, erro: "VAPID pública não configurada." };
  }

  if (Notification.permission !== "granted") {
    return { ok: false, erro: "Permissão não concedida." };
  }

  try {
    const reg = await navigator.serviceWorker.ready;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: _pushUrlBase64ToUint8Array(vapidKey),
      });
    }

    _pushSubscriptionCache = sub.toJSON();
    console.log("[Push] Subscription registrada:", _pushSubscriptionCache.endpoint);

    // Se há um pedido ativo sendo rastreado, vincula a subscription a ele
    const pedidoIdAtivo = localStorage.getItem("locanda_pedido_id");
    if (pedidoIdAtivo) {
      try {
        const { error } = await supa
          .from("pedidos")
          .update({ push_subscription: _pushSubscriptionCache })
          .eq("id", parseInt(pedidoIdAtivo, 10));
        if (!error) {
          console.log(`[Push] Subscription vinculada ao pedido #${pedidoIdAtivo}`);
        }
      } catch (_) {
        /* silencioso — não bloqueia a ativação */
      }
    }

    return { ok: true, subscription: _pushSubscriptionCache };
  } catch (e) {
    console.warn("[Push] Falha ao registrar subscription:", e.message);
    return { ok: false, erro: e.message };
  }
}

/**
 * Solicita permissão ao usuário e registra a subscription.
 * Chamada pelo botão "Ativar" do banner.
 */
async function _pushSolicitarPermissao() {
  if (!_pushSuportado()) {
    if (typeof mostrarToast === "function") {
      mostrarToast("Este navegador não suporta notificações.", "warning", 3500);
    }
    return;
  }

  const vapidKey = await _pushCarregarVapidKey();
  if (!vapidKey) {
    if (typeof mostrarToast === "function") {
      mostrarToast(
        "Notificações ainda não configuradas pela loja.",
        "warning",
        4000,
      );
    }
    return;
  }

  let perm = Notification.permission;
  if (perm === "default") {
    perm = await Notification.requestPermission();
  }

  if (perm !== "granted") {
    _pushFecharBanner();
    return;
  }

  const r = await _pushRegistrar();
  if (r.ok) {
    _pushFecharBanner();
    if (typeof mostrarToast === "function") {
      mostrarToast("✅ Notificações ativadas!", "success", 3500);
    }
  } else {
    if (typeof mostrarToast === "function") {
      mostrarToast("⚠️ Não foi possível ativar as notificações.", "warning", 3500);
    }
  }
}

/**
 * Mostra o banner de ativação de notificações.
 * Só aparece se: suportado, não autorizado, e ainda não exibido.
 */
function _pushMostrarBanner() {
  if (!_pushSuportado()) return;
  if (Notification.permission === "granted") return;
  if (document.getElementById("push-banner")) return;

  // Injeta a animação uma única vez
  if (!document.getElementById("_push-banner-style")) {
    const s = document.createElement("style");
    s.id = "_push-banner-style";
    s.textContent =
      "@keyframes _pushSlideUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}";
    document.head.appendChild(s);
  }

  const banner = document.createElement("div");
  banner.id = "push-banner";
  banner.style.cssText = [
    "position:fixed",
    "bottom:88px",
    "left:16px",
    "right:16px",
    "max-width:480px",
    "margin:0 auto",
    "z-index:96",
    "background:#fff",
    "border-radius:14px",
    "padding:14px 16px",
    "box-shadow:0 8px 28px rgba(0,0,0,0.18)",
    "display:flex",
    "align-items:center",
    "gap:12px",
    "border-left:4px solid var(--primary,#1a7a2e)",
    "animation:_pushSlideUp 0.3s ease",
  ].join(";");

  banner.innerHTML = `
    <div style="font-size:1.6rem;flex-shrink:0">🔔</div>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;font-size:0.9rem;color:#1a1a1a">Ativar notificações?</div>
      <div style="font-size:0.78rem;color:#777;margin-top:2px;line-height:1.35">
        Receba atualizações do status do seu pedido em tempo real.
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
      <button id="_push-btn-sim"
        style="padding:7px 14px;background:var(--primary,#1a7a2e);color:#fff;border:none;border-radius:8px;font-weight:700;font-size:0.78rem;cursor:pointer">
        Ativar
      </button>
      <button id="_push-btn-nao"
        style="padding:6px 12px;background:transparent;color:#999;border:none;font-size:0.72rem;cursor:pointer">
        Agora não
      </button>
    </div>
  `;

  document.body.appendChild(banner);

  banner
    .querySelector("#_push-btn-sim")
    .addEventListener("click", _pushSolicitarPermissao);
  banner
    .querySelector("#_push-btn-nao")
    .addEventListener("click", _pushFecharBanner);
}

/**
 * Fecha o banner de ativação com animação.
 */
function _pushFecharBanner() {
  const el = document.getElementById("push-banner");
  if (!el) return;
  el.style.opacity = "0";
  el.style.transform = "translateY(16px)";
  el.style.transition = "opacity .2s, transform .2s";
  setTimeout(() => el.remove(), 220);
}

/**
 * Inicializa o sistema de push:
 *  - Se já autorizado → revalida a subscription silenciosamente
 *  - Se não autorizado → mostra o banner após 4s
 */
async function _pushInicializar() {
  if (!_pushSuportado()) return;
  if (typeof supa === "undefined") return;

  // Já autorizado em sessões anteriores → recaptura silenciosamente
  if (Notification.permission === "granted") {
    await _pushRegistrar();
    return;
  }

  // Se o usuário já disse "Agora não" nessa sessão, não incomoda de novo
  if (sessionStorage.getItem("push_dismissed") === "1") return;

  // Mostra o banner depois de 4s (dá tempo do app terminar de carregar)
  setTimeout(_pushMostrarBanner, 4000);
}

// Auto-inicializa quando o DOM estiver pronto
(function _pushAutoInit() {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _pushInicializar, { once: true });
  } else {
    _pushInicializar();
  }
})();
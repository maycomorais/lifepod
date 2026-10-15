// Fallback para t() caso admin-i18n.js não esteja carregado ainda
if (typeof t === "undefined") {
  window.t = function (key, fallback) {
    return fallback || key;
  };
}

// =========================================
// 1. CONSTANTES E INICIALIZAÇÃO
// =========================================
// ── Globals carregados do banco (configuracoes) ──────────────────
let TAXA_MOTOBOY = 0; // taxa_motoboy_base
let AJUDA_COMBUSTIVEL = 0; // ajuda_combustivel
let COORD_LOJA = { lat: 0, lng: 0 }; // coord_lat / coord_lng
let CHAVE_PIX_CFG = ""; // chave_pix
let NOME_PIX_CFG = ""; // nome_pix
let DADOS_ALIAS_CFG = ""; // dados_alias
let QR_PY_URL = ""; // URL do QR Paraguay
let NOME_ALIAS_CFG = ""; // nome_alias
let WHATSAPP_LOJA_CFG = ""; // whatsapp_loja (dígitos)
let NOME_RESTAURANTE = ""; // nome_restaurante
let FEATURES_ATIVAS = null; // features_ativas JSONB
let TABELA_FRETE_ADMIN = null; // tabela_frete (carregada do banco para calcularFretePDV)

let perfilUsuario = null;
let _perfilId = null; // UUID do usuário logado
let _perfilNome = null; // nome_display do usuário logado
let audioHabilitado = false; // Controle de permissão do navegador

const ADMIN_APP_VERSION = "2026-04-17-v1";
const ADMIN_APP_STORAGE_KEYS = [
  "app_lastTab",
  "app_lastSubTab",
  "app_pdv_aba",
  "app_sidebar_collapsed",
];

function resetAdminStorageOnVersionChange() {
  const storedVersion = localStorage.getItem("admin_app_version");
  if (storedVersion !== ADMIN_APP_VERSION) {
    ADMIN_APP_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    localStorage.setItem("admin_app_version", ADMIN_APP_VERSION);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  resetAdminStorageOnVersionChange();
  // Recupera a última aba — mas só restaura depois do auth carregar
  // Para não disparar alert('Acesso restrito') antes de perfilUsuario estar definido,
  // começa sempre no dashboard e restaura a aba real após o login
  let lastTab = localStorage.getItem("app_lastTab");
  const _restrictedTabs = [
    "inventario",
    "financeiro",
    "adminmaster",
    "estatisticas",
    "ficha-tecnica",
    "crm",
  ];
  if (
    !lastTab ||
    !document.getElementById(lastTab) ||
    _restrictedTabs.includes(lastTab)
  ) {
    lastTab = "dashboard";
  }
  showTab(lastTab);

  // Timeout de segurança: se o overlay travar por mais de 8s, remove forçado
  setTimeout(() => {
    const overlay = document.getElementById("auth-overlay");
    if (overlay) {
      console.warn("⏰ Timeout de auth — removendo overlay forçado");
      overlay.remove();
      // Se perfilUsuario ainda não carregou, define padrão para não travar o painel
      if (!perfilUsuario) perfilUsuario = "dono";
    }
  }, 8000);

  // Inicia Monitoramento Realtime
  iniciarRealtime();

  // === SISTEMA DE AUTO-REFRESH (10 SEGUNDOS) ===
  // Backup caso o Realtime falhe
  setInterval(() => {
    const abaAtual = localStorage.getItem("app_lastTab");
    // true = modo silencioso (sem recarregar som se já estiver tocando)
    if (abaAtual === "pedidos") carregarPedidos(true);
    if (abaAtual === "cozinha") carregarCozinha();
    if (abaAtual === "pdv") carregarMonitorMesas();
    // if (abaAtual === 'financeiro') calcularFinanceiro();
    if (abaAtual === "dashboard") carregarDashboard();

    // Badge do PDV: sempre atualiza, independente da aba
    _atualizarBadgePedidosPendentes();
  }, 60000);

  // Verifica Login e Permissões
  if (typeof checkUser === "function") {
    let session;
    try {
      session = await checkUser();
    } catch (e) {
      window.location.href = "login.html";
      return;
    }
    if (!session) return; // checkUser já redirecionou

    // Verifica se o usuário aceitou o contrato de serviços
    await verificarContratoAdmin(session);

    // Remove overlay IMEDIATAMENTE após sessão confirmada
    const overlay = document.getElementById("auth-overlay");
    if (overlay) overlay.remove();

    const { data: perfil } = await supa
      .from("perfis_acesso")
      .select("cargo, nome_display")
      .eq("id", session.user.id)
      .single();

    _perfilId = session.user.id;
    _perfilNome = perfil?.nome_display || session.user.email || "Admin";
    perfilUsuario = perfil ? perfil.cargo : "dono";

    // Atualiza sidebar: nome, cargo e email
    const elNomeDisplay = document.getElementById("user-nome-display");
    const elCargo = document.getElementById("user-cargo");
    const elEmail = document.getElementById("user-email");
    if (elNomeDisplay) elNomeDisplay.textContent = _perfilNome;
    if (elEmail) elEmail.textContent = session.user.email;

    const cargoBadges = {
      adminMaster: "🎮 ADMIN MASTER",
      dono: "🔑 DONO",
      gerente: "👔 GERENTE",
      socio: "🤝 SÓCIO",
      funcionario: "👷 FUNCIONÁRIO",
      garcom: "🍽️ GARÇOM",
    };
    if (elCargo)
      elCargo.textContent =
        cargoBadges[perfilUsuario] || perfilUsuario.toUpperCase();

    // Carrega features e aplica visibilidade das abas
    await _carregarFeaturesGlobais();

    // Sócio: carrega suas permissões individuais ANTES de aplicar visibilidade
    if (perfilUsuario === "socio") {
      await _carregarPermissoesSocio();
    }

    // Atualiza brand com nome do restaurante (carregado em _carregarFeaturesGlobais)
    const elBrand = document.getElementById("brand-text");
    if (elBrand) elBrand.textContent = (NOME_RESTAURANTE || "ADMIN") + " ADMIN";

    _aplicarVisibilidadeAbas();

    if (perfilUsuario === "adminMaster") {
      // adminMaster vê tudo + aba exclusiva de administração
      document
        .querySelectorAll(".menu-item")
        .forEach((m) => (m.style.display = "flex"));
      const menuAM = document.getElementById("menu-adminmaster");
      if (menuAM) menuAM.style.display = "flex";
      const menuFil = document.getElementById("menu-filiais");
      if (menuFil) menuFil.style.display = "flex";
      // Exibe opção Dono no select de equipe
      const optDono = document.getElementById("opt-cargo-dono");
      if (optDono) optDono.style.display = "";
    }
    if (
      perfilUsuario === "dono" ||
      perfilUsuario === "adminMaster" ||
      perfilUsuario === "gerente"
    ) {
      const menuFin = document.getElementById("menu-financeiro");
      if (menuFin) menuFin.style.display = "flex";
    }
    if (
      perfilUsuario === "dono" ||
      perfilUsuario === "gerente" ||
      perfilUsuario === "adminMaster"
    ) {
      const menuEst = document.getElementById("menu-inventario");
      if (menuEst) menuEst.style.display = "flex";
    }

    // ── Mostrar menus novos para dono/gerente/adminMaster ──
    if (
      perfilUsuario === "dono" ||
      perfilUsuario === "gerente" ||
      perfilUsuario === "adminMaster"
    ) {
      [
        "menu-estatisticas",
        "menu-ficha-tecnica",
        "menu-crm",
        "menu-mensalistas",
      ].forEach((id) => {
        const m = document.getElementById(id);
        if (m) m.style.display = "flex";
      });
    }

    carregarDashboard();
    carregarMotoboysSelect();

    // ── Controle de Assinatura (barra de aviso / bloqueio) ──
    // Passa `perfil` explicitamente — sem isso, SubscriptionUI depende
    // de window.perfilUsuario, que pode estar null no momento do init.
    if (typeof SubscriptionUI !== "undefined") {
      SubscriptionUI.inicializar({
        supabaseUrl: typeof _SUPABASE_URL !== "undefined" ? _SUPABASE_URL : "",
        supabaseKey: typeof _SUPABASE_KEY !== "undefined" ? _SUPABASE_KEY : "",
        contatoFone: "595976771714",
        contatoNome: "SuporteLinkPY",
        perfil: perfilUsuario,   // ← garante que adminMaster não seja bloqueado
      });
    }

    // Exibe menu Assinatura somente para adminMaster
    const menuAssin = document.getElementById("menu-assinatura");
    if (menuAssin)
      menuAssin.style.display =
        perfilUsuario === "adminMaster" ? "flex" : "none";
  }

  let _lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth !== _lastWidth) {
      _lastWidth = window.innerWidth;
      if (document.getElementById("pdv")?.classList.contains("active")) {
        pdvIniciarTabs();
        _pdvRealocarBuscaParaTopo();
      }
    }
  });

  // === DESBLOQUEIO DE SOM — AudioContext (sem AbortError) ===
  // play().then(pause()) SEMPRE gera AbortError no Chrome. Usamos buffer silencioso.
  document.body.addEventListener(
    "click",
    () => {
      if (!audioHabilitado) {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const buf = ctx.createBuffer(
            1,
            ctx.sampleRate * 0.001,
            ctx.sampleRate,
          );
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(ctx.destination);
          src.start(0);
          src.onended = () => {
            audioHabilitado = true;
            ctx.close();
          };
        } catch (e) {
          audioHabilitado = true;
        }
      }
    },
    { once: true },
  );
});

// Diagnóstico: rode testarCloudinary() no console do navegador para verificar se o preset está OK
window.testarStorage = async function () {
  // Cria um pixel 1x1 PNG mínimo para testar o upload
  const pixel =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const blob = await fetch(pixel).then((r) => r.blob());
  const file = new File([blob], "test.png", { type: "image/png" });
  try {
    const url = await uploadImageToSupabase(file, 'produtos');
    console.log("✅ Supabase Storage OK! URL de teste:", url);
    alert("✅ Supabase Storage funcionando!\nURL: " + url);
  } catch (e) {
    console.error("❌ Supabase Storage ERRO:", e.message);
    alert("❌ Supabase Storage com problema:\n\n" + e.message);
  }
};

// ========================================
// SUPABASE STORAGE — UPLOAD DE IMAGENS
// ========================================
const SUPABASE_STORAGE_BUCKET = 'produtos';
const IMAGE_MAX_SIZE    = 500;  // lado maior em px
const IMAGE_WEBP_QUALITY = 80;  // qualidade WebP (0–100)

/**
 * Converte um File/Blob para WebP com redimensionamento proporcional.
 * O lado maior da imagem é limitado a `maxSize` px. Se a imagem for
 * menor, mantém o tamanho original (nunca faz upscale).
 *
 * @param {File} file
 * @param {number} maxSize  - lado maior máximo em px (default 500)
 * @param {number} quality  - qualidade WebP 0-100 (default 80)
 * @returns {Promise<Blob>}
 */
function convertToWebP(file, maxSize = IMAGE_MAX_SIZE, quality = IMAGE_WEBP_QUALITY) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        // Calcula dimensões mantendo proporção
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          if (width >= height) {
            height = Math.round(height * (maxSize / width));
            width = maxSize;
          } else {
            width = Math.round(width * (maxSize / height));
            height = maxSize;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        // Fundo branco — WebP transparente pode renderizar preto em impressão
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Falha na conversão para WebP'))),
          'image/webp',
          quality / 100,
        );
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Faz upload de uma imagem para o Supabase Storage.
 * - Valida tipo e tamanho bruto (≤ 10 MB)
 * - Redimensiona para 500px no lado maior e converte para WebP q80
 * - Salva em `produtos/{folder}/{timestamp}-{random}.webp`
 * - Retorna a URL pública (CDN do Supabase)
 *
 * @param {File}   file
 * @param {string} folder - subpasta: 'produtos' | 'sabores' | 'banners' | 'icones' | 'logos'
 * @returns {Promise<string>}
 */
async function uploadImageToSupabase(file, folder = 'produtos') {
  // ── 1. Validações ─────────────────────────────────────────
  const tiposPermitidos = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!tiposPermitidos.includes(file.type)) {
    throw new Error('Formato inválido. Use JPG, PNG, WEBP ou GIF.');
  }
  if (file.size > 10 * 1024 * 1024) {
    throw new Error('Imagem muito grande. Máximo 10MB antes da compressão.');
  }

  // ── 2. Converte para WebP redimensionado ──────────────────
  const webpBlob = await convertToWebP(file);

  // ── 3. Gera nome único ────────────────────────────────────
  const ts   = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${folder}/${ts}-${rand}.webp`;

  // ── 4. Upload para o Supabase Storage ─────────────────────
  const { data, error } = await supa.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .upload(path, webpBlob, {
      contentType: 'image/webp',
      cacheControl: '31536000', // 1 ano
      upsert: false,
    });

  if (error) {
    // Diagnóstico amigável quando o bucket ainda não foi criado
    if (error.message?.includes('Bucket not found') || error.statusCode === 404) {
      throw new Error(
        'Bucket "' + SUPABASE_STORAGE_BUCKET + '" não existe no Supabase Storage.\n\n' +
        'Crie-o em: Dashboard → Storage → New bucket → nome "' + SUPABASE_STORAGE_BUCKET + '" → marque "Public bucket".'
      );
    }
    throw new Error('Supabase Storage: ' + error.message);
  }

  // ── 5. Retorna URL pública ────────────────────────────────
  const { data: { publicUrl } } = supa.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .getPublicUrl(data.path);

  return publicUrl;
}

/**
 * @deprecated Use `uploadImageToSupabase(file, folder)` — mantido só para retrocompatibilidade.
 */
async function uploadImageToImgbb(file) {
  return uploadImageToSupabase(file, 'produtos');
}

/**
 * @deprecated Use `uploadImageToSupabase(file, folder)` — mantido só para retrocompatibilidade.
 */
async function uploadImageToCloudinary(file) {
  return uploadImageToSupabase(file, 'produtos');
}

// =========================================
// 2. CONTROLE DE ABAS
// =========================================
function showTab(tabId, event) {
  console.log("Tentando abrir aba:", tabId);
  console.log("Event:", event);

  // 1. O 'de-para' para garantir que IDs como 'categorias' ou 'motoboys'
  // abram a aba pai correta no seu novo HTML
  let realTabId = tabId;
  if (tabId === "categorias" || tabId === "motoboys") {
    realTabId = "produtos";
  }

  let target = document.getElementById(realTabId);
  if (!target) {
    console.log("Target not found for", realTabId);
    target = document.getElementById("pedidos");
    realTabId = "pedidos";
  } else {
    console.log("Target found:", target);
  }

  localStorage.setItem("app_lastTab", realTabId);

  // 2. Reset visual
  document.querySelectorAll(".tab-content").forEach((t) => {
    t.classList.remove("active");
    t.style.display = "none";
  });
  document
    .querySelectorAll(".menu-item")
    .forEach((m) => m.classList.remove("active"));

  // 3. Ativa a aba pai
  target.classList.add("active");
  target.style.display = "block";
  console.log("Added active class to", realTabId);

  // 4. Ativa o botão no menu lateral
  if (event && event.currentTarget) {
    event.currentTarget.classList.add("active");
  } else {
    // Restaura highlight ao carregar página (sem evento de clique)
    document.querySelectorAll(".menu-item").forEach((m) => {
      const oc = m.getAttribute("onclick") || "";
      if (oc.includes(`'${realTabId}'`) || oc.includes(`'${tabId}'`)) {
        m.classList.add("active");
      }
    });
  }

  // 5. PULO DO GATO: Se a aba for produtos, categorias ou motoboys,
  // precisamos ativar a SUB-ABA correspondente
  if (realTabId === "produtos") {
    console.log("Calling showSubTab for produtos");
    if (tabId === "categorias") showSubTab("lista-categorias-wrapper");
    else if (tabId === "motoboys") showSubTab("lista-motos-wrapper");
    else {
      // Clique direto em "Produtos": sempre abre a lista de produtos,
      // ignorando qualquer sub-aba salva de navegação anterior (ex: Categorias).
      showSubTab("lista-produtos-wrapper");
    }
  }

  // 6. Carregamento de dados
  if (realTabId === "pedidos") {
    carregarPedidos();
    carregarStatusDelivery();
  }
  if (realTabId === "cozinha") carregarCozinha();
  if (realTabId === "financeiro") calcularFinanceiro();
  if (realTabId === "dashboard") carregarDashboard();
  if (realTabId === "pdv") carregarPDV();
  if (realTabId === "equipe") carregarEquipe();
  if (realTabId === "adminmaster") {
    amCarregarUsuarios();
    renderPainelFeatures();
  }
  if (realTabId === "assinatura") carregarPainelAssinatura();
  if (realTabId === "estatisticas") {
    initEstatisticas();
    _estPopularCategorias();
  }
  if (realTabId === "ficha-tecnica") {
    initFichaTecnica();
  }
  if (realTabId === "crm") {
    initCRM();
  }
  if (realTabId === "filiais") {
    initFiliais();
  }
  if (realTabId === "mensalistas") {
    initMensalistas();
  }
  if (realTabId === "estoque") {
    veRenderizarPainelEstoque();
  }
  if (realTabId === "configuracoes") {
    carregarConfiguracoes();
    if (perfilUsuario === "dono" || perfilUsuario === "gerente") {
      carregarCupons();
    }
  }
  if (realTabId === "inventario") {
    if (!perfilUsuario) return; // auth not loaded yet — wait
    if (
      perfilUsuario === "dono" ||
      perfilUsuario === "gerente" ||
      perfilUsuario === "adminMaster"
    )
      carregarInventario();
    else {
      alert("Acesso restrito.");
      showTab("pedidos", null);
    }
  }
}

const SUBTABS_VALIDAS = [
  "lista-produtos-wrapper",
  "lista-categorias-wrapper",
  "lista-motos-wrapper",
];

function showSubTab(subId) {
  console.log("Alternando para sub-aba:", subId);

  if (!SUBTABS_VALIDAS.includes(subId)) {
    subId = "lista-produtos-wrapper";
  }

  localStorage.setItem("app_lastSubTab", subId);

  // 1. Seleciona todas as sub-abas e esconde TODAS
  const subtabs = document.querySelectorAll(".subtab-content");
  console.log("Hiding all subtabs, found:", subtabs.length);
  subtabs.forEach((tab) => {
    tab.style.display = "none";
  });

  // 2. Mostra apenas a que foi clicada
  const target = document.getElementById(subId);
  if (target) {
    console.log("Showing subtab:", subId);
    target.style.display = "block";
  } else {
    console.log("Subtab not found:", subId);
  }

  // 3. Carrega os dados específicos
  if (subId === "lista-produtos-wrapper") carregarProdutos();
  if (subId === "lista-categorias-wrapper") carregarCategorias();
  if (subId === "lista-motos-wrapper") carregarMotoboys();
}

// =========================================
// 3. REALTIME E ALARME (LOOP)
// =========================================
// ── Features globais (controladas pelo adminMaster) ────────────
async function _carregarFeaturesGlobais() {
  const { data } = await supa
    .from("configuracoes")
    .select(
      "features_ativas, nome_restaurante, whatsapp_loja, coord_lat, coord_lng, taxa_motoboy_base, ajuda_combustivel, chave_pix, nome_pix, dados_alias, nome_alias, tabela_frete",
    )
    .maybeSingle();
  if (!data) return;
  FEATURES_ATIVAS = data.features_ativas || null;
  // Globals operacionais
  if (data.nome_restaurante) NOME_RESTAURANTE = data.nome_restaurante;
  if (data.whatsapp_loja) WHATSAPP_LOJA_CFG = data.whatsapp_loja;
  if (data.coord_lat) COORD_LOJA.lat = parseFloat(data.coord_lat);
  if (data.coord_lng) COORD_LOJA.lng = parseFloat(data.coord_lng);
  if (data.taxa_motoboy_base != null) TAXA_MOTOBOY = data.taxa_motoboy_base;
  if (data.ajuda_combustivel != null)
    AJUDA_COMBUSTIVEL = data.ajuda_combustivel;
  if (data.chave_pix) CHAVE_PIX_CFG = data.chave_pix;
  if (data.nome_pix) NOME_PIX_CFG = data.nome_pix;
  if (data.dados_alias) DADOS_ALIAS_CFG = data.dados_alias;
  if (data.nome_alias) NOME_ALIAS_CFG = data.nome_alias;
  if (data.tabela_frete && Array.isArray(data.tabela_frete))
    TABELA_FRETE_ADMIN = data.tabela_frete;
}

// ── Filtra formas de pagamento no PDV conforme features_ativas.pagamentos ──────
function _aplicarFormasPagamentoPDV(features) {
  const pags = features?.pagamentos;
  const select = document.getElementById("balcao-pag");
  if (!select) return;
  Array.from(select.options).forEach((opt) => {
    if (!opt.value) return;
    if (!pags) {
      opt.style.display = "";
      return;
    }
    if (pags[opt.value] === false) {
      opt.style.display = "none";
      // Se a opção oculta estava selecionada, reset para Efetivo
      if (select.value === opt.value) select.value = "Efetivo";
    } else {
      opt.style.display = "";
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  Permissões do perfil Sócio (cache em memória)
//  Formato do cache: { abas: ["dashboard","pdv",...] }
//  Populado por _carregarPermissoesSocio() no boot do painel.
// ─────────────────────────────────────────────────────────────
let _permissoesSocio = null;

/**
 * Consulta o banco e cacheia a lista de abas que o Sócio
 * logado pode ver. Chamar 1x no boot do painel.
 * Usa a RPC get_minhas_abas() que já resolve:
 *   - adminMaster/dono → todas as abas
 *   - socio → apenas permissoes_customizadas.abas
 *   - demais → todas (features_ativas filtra no front)
 */
async function _carregarPermissoesSocio() {
  try {
    const { data, error } = await supa.rpc("get_minhas_abas");
    if (error) {
      console.warn("[Sócio] RPC get_minhas_abas falhou:", error.message);
      _permissoesSocio = { abas: [] };  // nega tudo por padrão
      return;
    }
    _permissoesSocio = {
      abas: Array.isArray(data) ? data : [],
    };
    console.log("[Sócio] Permissões carregadas:", _permissoesSocio.abas);
  } catch (e) {
    console.warn("[Sócio] Erro ao carregar permissões:", e.message);
    _permissoesSocio = { abas: [] };
  }
}


function _feat(categoria, chave) {
  if (!FEATURES_ATIVAS) return true; // sem config = tudo ativo
  const cat = FEATURES_ATIVAS[categoria];
  if (!cat) return true;
  return cat[chave] !== false;
}

function _aplicarVisibilidadeAbas() {
  const mapa = {
    "menu-pedidos":        "pedidos",
    "menu-cozinha":        "cozinha",
    "menu-pdv":            "pdv",
    "menu-financeiro":     "financeiro",
    "menu-inventario":     "inventario",
    "menu-equipe":         "equipe",
    "menu-configuracoes":  "configuracoes",
    "menu-dashboard":      "dashboard",
    "menu-estatisticas":   "estatisticas",
    "menu-ficha-tecnica":  "ficha-tecnica",
    "menu-crm":            "crm",
    "menu-turnos":         "turnos",
    "menu-produtos":       "produtos",
    "menu-mensalistas":    "mensalistas",
    "menu-filiais":        "filiais",
  };

  // adminMaster: vê tudo, ignora features e permissões
  if (perfilUsuario === "adminMaster") return;

  // ── Sócio: aplica DOIS filtros em conjunto ────────────────
  //  1. features_ativas (bloqueio global da loja)
  //  2. permissoes_customizadas.abas (bloqueio individual do sócio)
  if (perfilUsuario === "socio") {
    const permitidas = _permissoesSocio?.abas || [];

    Object.entries(mapa).forEach(([menuId, chave]) => {
      const el = document.getElementById(menuId);
      if (!el) return;

      const bloqueadoPorFeature = !_feat("tabs", chave);
      const naoPermitidoAoSocio  = !permitidas.includes(chave);

      if (bloqueadoPorFeature || naoPermitidoAoSocio) {
        el.style.display = "none";
      }
    });
    return;
  }

  // ── Demais cargos (gerente/funcionario/garcom) ────────────
  //  Só o filtro global de features_ativas se aplica
  Object.entries(mapa).forEach(([menuId, chave]) => {
    const el = document.getElementById(menuId);
    if (el && !_feat("tabs", chave)) el.style.display = "none";
  });
}
// Salva features (adminMaster only)
async function salvarFeatures() {
  if (perfilUsuario !== "adminMaster") return alert(t("alert.acesso_negado"));
  const tabs = {},
    tipos = {},
    funcs = {};
  document.querySelectorAll("[data-feat-tab]").forEach((el) => {
    tabs[el.dataset.featTab] = el.checked;
  });
  document.querySelectorAll("[data-feat-tipo]").forEach((el) => {
    tipos[el.dataset.featTipo] = el.checked;
  });
  document.querySelectorAll("[data-feat-func]").forEach((el) => {
    funcs[el.dataset.featFunc] = el.checked;
  });
  const pagamentos = {};
  document.querySelectorAll("[data-feat-pag]").forEach((el) => {
    pagamentos[el.dataset.featPag] = el.checked;
  });
  const features = {
    tabs,
    tipos_produto: tipos,
    funcionalidades: funcs,
    pagamentos,
  };
  const { error } = await supa
    .from("configuracoes")
    .update({ features_ativas: features })
    .gt("id", 0);
  if (error) return alert("Erro: " + error.message);
  FEATURES_ATIVAS = features;
  alert(t("alert.features_salvas"));
}

// Renderiza painel de features (adminMaster)
//
// ─────────────────────────────────────────────────────────────
//  ARQUITETURA (fix do conflito entre abas):
//
//  O painel completo é renderizado APENAS em
//  #painel-features-master (aba Admin Master).
//
//  O card #card-adminmaster-cfg (dentro de Configurações) NÃO
//  duplica os checkboxes — vira um atalho visual que redireciona
//  para a aba Admin Master.
//
//  Por quê:
//  Antes, os mesmos atributos data-feat-* eram renderizados em
//  DOIS lugares (#painel-features E #painel-features-master).
//  salvarFeatures() usava document.querySelectorAll() global, que
//  capturava AMBAS as cópias — o valor final dependia da ordem do
//  DOM (o último sobrescrevia), silenciosamente descartando as
//  edições feitas no outro painel.
// ─────────────────────────────────────────────────────────────
async function renderPainelFeatures() {
  const master   = document.getElementById("painel-features-master");
  const shortcut = document.getElementById("painel-features");
  if (!master && !shortcut) return;

  await _carregarFeaturesGlobais();
  const f      = FEATURES_ATIVAS || {};
  const tabs   = f.tabs            || {};
  const tipos  = f.tipos_produto   || {};
  const funcs  = f.funcionalidades || {};
  const pags   = f.pagamentos      || {};

  const chkTabs = [
    ["pedidos",         "Pedidos"],
    ["cozinha",         "Cozinha/KDS"],
    ["pdv",             "PDV Balcão"],
    ["financeiro",      "Financeiro"],
    ["inventario",      "Inventário"],
    ["equipe",          "Equipe"],
    ["configuracoes",   "Configurações"],
    ["dashboard",       "Dashboard"],
    ["turnos",          "Painel Turnos/TV"],
    ["estatisticas",    "Estatísticas"],
    ["ficha-tecnica",   "Ficha Técnica"],
    ["crm",             "CRM Clientes"],
    ["mensalistas",     "Mensalistas"],
    ["filiais",         "Filiais"],
  ]
    .map(
      ([k, l]) => `<label style="display:flex;align-items:center;gap:8px;padding:6px;background:#f9f9f9;border-radius:6px">
    <input type="checkbox" data-feat-tab="${k}" ${tabs[k] !== false ? "checked" : ""} style="width:18px;height:18px">
    <span>${l}</span></label>`,
    )
    .join("");

  const chkTipos = [
    ["padrao",     "Simples"],
    ["bebida",     "Bebida"],
    ["lanche",     "Lanche"],
    ["pizza",      "Pizza"],
    ["acai",       "Açaí"],
    ["shake",      "Shake"],
    ["suco",       "Suco"],
    ["sorvete",    "Sorvete"],
    ["montavel",   "Montável"],
    ["combo",      "Combo"],
    ["variacoes",  "Variações"],
    ["kg",         "⚖️ Venda Kg"],
  ]
    .map(
      ([k, l]) => `<label style="display:flex;align-items:center;gap:8px;padding:6px;background:#f9f9f9;border-radius:6px">
    <input type="checkbox" data-feat-tipo="${k}" ${tipos[k] !== false ? "checked" : ""} style="width:18px;height:18px">
    <span>${l}</span></label>`,
    )
    .join("");

  const chkFuncs = [
    ["delivery",         "Delivery"],
    ["retirada",         "Retirada"],
    ["local",            "Comer no Local"],
    ["balcao",           "Balcão/PDV"],
    ["cupons",           "Cupons"],
    ["factura",          "Factura"],
    ["multipagamento",   "Multipagamento"],
    ["agendamento",      "Agendamento"],
  ]
    .map(
      ([k, l]) => `<label style="display:flex;align-items:center;gap:8px;padding:6px;background:#f9f9f9;border-radius:6px">
    <input type="checkbox" data-feat-func="${k}" ${funcs[k] !== false ? "checked" : ""} style="width:18px;height:18px">
    <span>${l}</span></label>`,
    )
    .join("");

  const chkPags = [
    ["Efetivo",         "💵 Efectivo/Dinheiro"],
    ["Cartao",          "💳 Tarjeta PY"],
    ["CartaoBR",        "💳🇧🇷 Cartão Brasileiro (R$)"],
    ["Pix",             "🟢 Pix (BR)"],
    ["Transferencia",   "🏦 Alias/Transferência PY"],
    ["QrPy",            "📱 QR Paraguay"],
    ["Multipagamento",  "🔀 Dividir Pagamento"],
  ]
    .map(
      ([k, l]) =>
        `<label style="display:flex;align-items:center;gap:8px;padding:6px;background:#f9f9f9;border-radius:6px">
      <input type="checkbox" data-feat-pag="${k}" ${pags[k] !== false ? "checked" : ""} style="width:18px;height:18px">
      <span>${l}</span></label>`,
    )
    .join("");

  const html = `
    <div style="display:grid;gap:20px">
      <div>
        <h4 style="margin-bottom:10px;color:#2c3e50">📂 Abas visíveis</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">${chkTabs}</div>
      </div>
      <div>
        <h4 style="margin-bottom:10px;color:#2c3e50">💳 Formas de Pagamento</h4>
        <p style="font-size:0.8rem;color:#888;margin-bottom:8px">Controla o que aparece no app do cliente <strong>e</strong> no PDV</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">${chkPags}</div>
      </div>
      <div>
        <h4 style="margin-bottom:10px;color:#2c3e50">🏷️ Tipos de produto permitidos</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px">${chkTipos}</div>
      </div>
      <div>
        <h4 style="margin-bottom:10px;color:#2c3e50">⚙️ Funcionalidades</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px">${chkFuncs}</div>
      </div>
      <button class="btn btn-primary" onclick="salvarFeatures()"><i class="fas fa-save"></i> Salvar Features</button>
    </div>`;

  // ── Painel autoritativo: aba Admin Master ──
  if (master) master.innerHTML = html;

  // ── Configurações: vira atalho (não duplica checkboxes) ──
  if (shortcut) {
    shortcut.innerHTML = `
      <div style="background:#fff5f5;border:1.5px dashed #fca5a5;border-radius:10px;padding:22px 20px;text-align:center">
        <div style="font-size:1.8rem;margin-bottom:8px">🛡️</div>
        <div style="font-weight:700;font-size:0.95rem;color:#991b1b;margin-bottom:8px">
          Controle de Features
        </div>
        <div style="font-size:0.83rem;color:#7f1d1d;line-height:1.55;margin-bottom:16px">
          O gerenciamento de features agora é feito em um lugar único —<br>
          aba <b>Admin Master</b> — para evitar conflito de estado<br>
          entre painéis duplicados.
        </div>
        <button onclick="showTab('adminmaster', { currentTarget: document.getElementById('menu-adminmaster') })"
          class="btn btn-danger"
          style="font-size:0.86rem;padding:10px 20px;background:#e74c3c;border-color:#e74c3c;font-weight:700">
          <i class="fas fa-arrow-right"></i> Ir para Admin Master
        </button>
      </div>`;
  }
}

function iniciarRealtime() {
  supa
    .channel("tabela-pedidos-admin")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pedidos" },
      (payload) => {
        // Som só para pedido NOVO pendente (nunca para cancelamento ou update)
        if (
          payload.eventType === "INSERT" &&
          payload.new.status === "pendente"
        ) {
          tocarAlarme();
        }
        // Atualiza tela — silencioso=true em updates para não re-tocar alarme
        const silencioso = payload.eventType === "UPDATE";
        const abaAtual = localStorage.getItem("app_lastTab");
        if (abaAtual === "pedidos") carregarPedidos(silencioso);
        if (abaAtual === "cozinha") carregarCozinha();
        if (abaAtual === "dashboard") carregarDashboard();

        // Atualiza badge do PDV em QUALQUER aba (independe de estar no PDV)
        _atualizarBadgePedidosPendentes();
      },
    )
    .subscribe();
}

let loopAlarme = null;
let _alarmePlaying = false;

function tocarAlarme() {
  const audio = document.getElementById("som-campainha");
  if (!audio || loopAlarme) return; // já está tocando

  const _tocar = () => {
    if (!_alarmePlaying) {
      _alarmePlaying = true;
      audio.currentTime = 0;
      audio
        .play()
        .then(() => {
          _alarmePlaying = false;
        })
        .catch(() => {
          _alarmePlaying = false;
        });
    }
  };

  _tocar();
  loopAlarme = setInterval(_tocar, 4000);
}

function pararAlarme() {
  if (loopAlarme) {
    clearInterval(loopAlarme);
    loopAlarme = null;
  }
  const audio = document.getElementById("som-campainha");
  if (audio && !audio.paused) {
    audio.pause();
    audio.currentTime = 0;
  }
  _alarmePlaying = false;
}

// =========================================
// 4. GESTÃO DE PEDIDOS (COM IMPRESSÃO)
// =========================================
async function carregarPedidos(silencioso = false) {
  // === TRAVA DE SEGURANÇA (Para não limpar sua seleção) ===
  if (silencioso) {
    const selecionados = document.querySelectorAll(".check-pedido:checked");
    if (selecionados.length > 0) {
      console.log("Atualização pausada: Usuário está montando rota.");
      return;
    }
  }

  // 1. Som e Notificação
  const { count, error: countError } = await supa
    .from("pedidos")
    .select("*", { count: "exact", head: true })
    .eq("status", "pendente");

  if (countError) {
    console.warn("Erro ao contar pedidos pendentes:", countError.message);
  }

  if (count > 0) {
    if (!silencioso && typeof tocarAlarme === "function") tocarAlarme();
  } else {
    if (typeof pararAlarme === "function") pararAlarme();
  }

  // 2. Busca Dados - inclui cancelamento_solicitado para badge
  const { data: pedidos } = await supa
    .from("pedidos")
    .select("*")
    .or(
      "status.eq.pendente,status.eq.em_preparo,status.eq.pronto_entrega,status.eq.saiu_entrega",
    )
    .order("id", { ascending: false });

  const tbody = document.getElementById("lista-pedidos");
  if (!tbody) return;
  tbody.innerHTML = "";

  // Container de cards mobile
  const cardsDiv = document.getElementById("lista-pedidos-cards");
  if (cardsDiv) cardsDiv.innerHTML = "";

  // ── AUTO-CONFIRM: pedidos saiu_entrega há mais de 4h ──────────────────────
  const _QUATRO_HORAS_MS = 4 * 60 * 60 * 1000;
  const _agora = Date.now();
  const pedidosParaAutoConfirmar = (pedidos || []).filter(
    (p) =>
      p.status === "saiu_entrega" &&
      p.tempo_saiu_entrega &&
      _agora - new Date(p.tempo_saiu_entrega).getTime() > _QUATRO_HORAS_MS,
  );
  for (const p of pedidosParaAutoConfirmar) {
    console.log(
      `⏰ Auto-confirmando entrega do pedido #${p.id} (mais de 4h em saiu_entrega)`,
    );
    await supa
      .from("pedidos")
      .update({
        status: "entregue",
        tempo_entregue: new Date().toISOString(),
      })
      .eq("id", p.id);
  }
  // ───────────────────────────────────────────────────────────────────────────

  // Badge de cancelamento pendente para o dono / adminMaster
  const _podeCancel = ["dono", "adminMaster", "gerente"].includes(
    perfilUsuario,
  );
  const badgeCancelPendente = _podeCancel
    ? `<span style="background:#e74c3c;color:white;font-size:0.7rem;padding:2px 7px;border-radius:10px;margin-left:6px;vertical-align:middle;">CANC. PENDENTE</span>`
    : "";

  if (pedidos && pedidos.length > 0) {
    pedidos.forEach((p) => {
      let acoes = "";
      let linhaCor = "";
      let checkbox = "";

      const btnPrint = `<button class="btn btn-sm btn-info" onclick="imprimirPedido(${p.id})" title="Imprimir"><i class="fas fa-print"></i></button>`;
      const temSolicitacaoCancelamento = p.cancelamento_solicitado;

      // Badge cancelamento (dono + gerente veem)
      const badgeCancelRow =
        temSolicitacaoCancelamento &&
        ["dono", "gerente", "adminMaster"].includes(perfilUsuario)
          ? `<div style="background:#fff0f0;border:1px solid #e74c3c;border-radius:6px;padding:4px 8px;font-size:0.75rem;margin-top:4px;color:#c0392b">
                     🚫 <strong>Cancelamento solicitado:</strong> ${p.cancelamento_motivo || "-"}
                     <br><button class="btn btn-danger btn-sm" onclick="aprovarCancelamento(${p.id})" style="margin-top:4px;font-size:0.7rem">✅ Aprovar</button>
                     <button class="btn btn-secondary btn-sm" onclick="negarCancelamento(${p.id})" style="margin-top:4px;font-size:0.7rem">❌ Negar</button>
                   </div>`
          : "";

      // PENDENTE
      if (p.status === "pendente") {
        linhaCor = "background-color: #fff3cd;";
        acoes = `
                    ${btnPrint}
                    <button class="btn btn-success btn-sm" onclick="mudarStatus(${p.id}, 'em_preparo')"><i class="fas fa-fire"></i> Separação</button>
                    ${
                      _podeCancel
                        ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
                        : `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i> Solicitar Cancelamento</button>`
                    }
                `;
      }

      // EM PREPARO (na cozinha — visível para acompanhamento)
      if (p.status === "em_preparo") {
        linhaCor = "background-color: #fff8e6;";
        const _btnCancelPreparo = _podeCancel
          ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')" title="Cancelar"><i class="fas fa-times"></i></button>`
          : !temSolicitacaoCancelamento
            ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i></button>`
            : `<span style="font-size:0.72rem;color:#e67e22;font-weight:600">⏳ Cancel. Pendente</span>`;
        acoes = `${btnPrint} <button class="btn btn-sm" style="background:#e67e22;color:#fff" onclick="mudarStatus(${p.id}, 'pronto_entrega')"><i class="fas fa-check"></i> Pronto</button> ${_btnCancelPreparo}`;
      }

      if (p.status === "saiu_entrega") {
        linhaCor = "background-color: #ddf0ff;";
        const _btnCancelSaiu = _podeCancel
          ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')" title="Cancelar"><i class="fas fa-times"></i></button>`
          : !temSolicitacaoCancelamento
            ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})" title="Solicitar cancelamento"><i class="fas fa-ban"></i> Cancelar</button>`
            : `<span style="font-size:0.72rem;color:#e67e22;font-weight:600">⏳ Cancel. Pendente</span>`;
        acoes = `${btnPrint} <button class="btn btn-success btn-sm" onclick="confirmarEntregaFuncionario(${p.id})"><i class="fas fa-check-circle"></i> Confirmar</button> ${_btnCancelSaiu}`;
      }
      // PRONTO
      else if (p.status === "pronto_entrega") {
        linhaCor = "background-color: #d4edda;";

        // Botão cancelamento para pronto_entrega
        const btnCancelar = _podeCancel
          ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')" title="Cancelar"><i class="fas fa-times"></i></button>`
          : !temSolicitacaoCancelamento
            ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i></button>`
            : "";

        if (p.tipo_entrega === "delivery") {
          const jsonSeguro = encodeURIComponent(JSON.stringify(p));
          checkbox = `<input type="checkbox" class="check-pedido" value="${jsonSeguro}" style="width:20px; height:20px;">`;
          acoes = `${btnPrint} ${btnCancelar} <button class="btn btn-sm" style="background:#25D366;color:#fff" onclick="avisarClientePronto(${p.id})" title="Avisar cliente via WhatsApp"><i class="fab fa-whatsapp"></i></button> <span style="color:#155724; font-weight:bold; font-size:0.9rem; margin-left:5px;"><i class="fas fa-motorcycle"></i> Aguardando Rota</span>`;
        } else {
          const icone =
            p.tipo_entrega === "balcao" ? "fa-store" : "fa-hand-holding";
          const tipo = p.tipo_entrega === "balcao" ? "BALCÃO" : "RETIRADA";
          checkbox = `<div style="text-align:center; color:#e67e22; font-size:1.2rem"><i class="fas ${icone}" title="${tipo}"></i></div>`;
          acoes = `${btnPrint} ${btnCancelar} <button class="btn btn-sm" style="background:#25D366;color:#fff" onclick="avisarClientePronto(${p.id})" title="Avisar cliente via WhatsApp"><i class="fab fa-whatsapp"></i></button> <button class="btn btn-success btn-sm" onclick="finalizarMesa(${p.id})">Baixar</button>`;
        }
      }

      // Linha da tabela (desktop)
      tbody.innerHTML += `
                <tr style="${linhaCor}">
                    <td style="text-align:center; vertical-align: middle;">${checkbox}</td>
                    <td><strong>#${p.uid_temporal || p.id}</strong></td>
                    <td>
                        <div style="font-weight:bold">${p.cliente_nome || "Cliente"}</div>
                        <div style="font-size:0.8rem; color:#666">${p.endereco_entrega || ""}</div>
                        ${badgeCancelRow}
                    </td>
                    <td><span class="status-badge st-${p.status}">${p.status.toUpperCase().replace("_", " ")}</span>
                    ${temSolicitacaoCancelamento && _podeCancel ? badgeCancelPendente : ""}</td>
                    <td>Gs ${(p.total_geral || 0).toLocaleString("es-PY")}</td>
                    <td class="actions-cell">${acoes}</td>
                </tr>`;

      // Card mobile
      if (cardsDiv) {
        const statusLabel =
          p.status === "pendente"
            ? "🔔 Novo"
            : p.status === "em_preparo"
              ? "🔥 Em Separação"
              : p.status === "pronto_entrega"
                ? "✅ Pronto"
                : p.status.replace("_", " ");
        const cardBg =
          p.status === "pendente"
            ? "#fff3cd"
            : p.status === "pronto_entrega"
              ? "#d4edda"
              : p.status === "saiu_entrega"
                ? "#ddf0ff"
                : "#fff";
        const jsonSeguro = encodeURIComponent(JSON.stringify(p));
        let cardAcoes = "";
        const cardBgSaiu = p.status === "saiu_entrega" ? "#ddf0ff" : "";
        if (p.status === "saiu_entrega") {
          const _btnCancelSaiuCard = _podeCancel
            ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
            : !temSolicitacaoCancelamento
              ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i> Cancelar</button>`
              : `<span style="font-size:0.7rem;color:#e67e22;font-weight:600">⏳ Pendente</span>`;
          cardAcoes = `
                        <button class="btn btn-success btn-sm" onclick="confirmarEntregaFuncionario(${p.id})"><i class="fas fa-check-circle"></i> Confirmar</button>
                        <button class="btn btn-info btn-sm" onclick="imprimirPedido(${p.id})"><i class="fas fa-print"></i> Imprimir</button>
                        ${_btnCancelSaiuCard}`;
        } else if (p.status === "pendente") {
          cardAcoes = `
                        <button class="btn btn-success btn-sm" onclick="mudarStatus(${p.id}, 'em_preparo')"><i class="fas fa-fire"></i> Seáração</button>
                        <button class="btn btn-info btn-sm" onclick="imprimirPedido(${p.id})"><i class="fas fa-print"></i> Imprimir</button>
                        ${
                          _podeCancel
                            ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
                            : `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i> Cancelar</button>`
                        }`;
        } else if (p.status === "em_preparo") {
          const _btnCancelPreparoCard = _podeCancel
            ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
            : !temSolicitacaoCancelamento
              ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i> Cancelar</button>`
              : `<span style="font-size:0.7rem;color:#e67e22;font-weight:600">⏳ Pendente</span>`;
          cardAcoes = `
                        <button class="btn btn-sm" style="background:#e67e22;color:#fff" onclick="mudarStatus(${p.id}, 'pronto_entrega')"><i class="fas fa-check"></i> Pronto</button>
                        <button class="btn btn-info btn-sm" onclick="imprimirPedido(${p.id})"><i class="fas fa-print"></i> Imprimir</button>
                        ${_btnCancelPreparoCard}`;
        } else if (
          p.status === "pronto_entrega" &&
          p.tipo_entrega === "balcao"
        ) {
          const _btnCancelBalcao = _podeCancel
            ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
            : !temSolicitacaoCancelamento
              ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i> Cancelar</button>`
              : "";
          cardAcoes = `<button class="btn btn-success btn-sm" onclick="finalizarMesa(${p.id})"><i class="fas fa-check"></i> Entregar</button>
                        <button class="btn btn-sm" style="background:#25D366;color:#fff" onclick="avisarClientePronto(${p.id})"><i class="fab fa-whatsapp"></i></button>
                        <button class="btn btn-info btn-sm" onclick="imprimirPedido(${p.id})"><i class="fas fa-print"></i></button>
                        ${_btnCancelBalcao}`;
        } else if (p.status === "pronto_entrega") {
          const _btnCancelPronto = _podeCancel
            ? `<button class="btn btn-danger btn-sm" onclick="mudarStatus(${p.id}, 'cancelado')"><i class="fas fa-times"></i></button>`
            : !temSolicitacaoCancelamento
              ? `<button class="btn btn-warning btn-sm" onclick="solicitarCancelamento(${p.id})"><i class="fas fa-ban"></i></button>`
              : "";
          cardAcoes = `<label style="display:flex;align-items:center;gap:6px;font-size:0.8rem;color:#155724;font-weight:600;">
                        <input type="checkbox" class="check-pedido" value="${jsonSeguro}" style="width:18px;height:18px;"> Incluir na Rota
                    </label>
                    <button class="btn btn-sm" style="background:#25D366;color:#fff" onclick="avisarClientePronto(${p.id})"><i class="fab fa-whatsapp"></i> Avisar</button>
                    <button class="btn btn-info btn-sm" onclick="imprimirPedido(${p.id})"><i class="fas fa-print"></i></button>
                    ${_btnCancelPronto}`;
        }

        const badgeCancelCard =
          temSolicitacaoCancelamento && _podeCancel
            ? `
                    <div style="background:#fff0f0;border:1px solid #e74c3c;border-radius:6px;padding:6px 8px;font-size:0.75rem;color:#c0392b;margin-top:6px">
                        🚫 Cancel. solicitado: ${p.cancelamento_motivo || "-"}
                        <br><button class="btn btn-danger btn-sm" onclick="aprovarCancelamento(${p.id})" style="font-size:0.7rem;margin-top:4px">✅ Aprovar</button>
                        <button class="btn btn-secondary btn-sm" onclick="negarCancelamento(${p.id})" style="font-size:0.7rem;margin-top:4px">❌ Negar</button>
                    </div>`
            : "";

        // ── Lista de itens do pedido para o card mobile ──────────────────
        const _itensCardHtml = (p.itens || []).map((item) => {
          const _q  = item.qtd || item.q || 1;
          const _n  = item.nome || item.n || "?";
          const _v  = item.variacao || item.t || "";
          return `<div style="font-size:0.75rem;color:#444;line-height:1.4">
            <span style="font-weight:700;color:#1a7a2e">${_q}×</span> ${_n}${_v && _v !== _n ? ` <span style="color:#e67e22">▸ ${_v}</span>` : ""}
          </div>`;
        }).join("");

        cardsDiv.innerHTML += `
                    <div style="background:${cardBg}; border-radius:10px; padding:14px 16px; box-shadow:0 2px 8px rgba(0,0,0,0.07); border-left:4px solid ${p.status === "pendente" ? "#f59e0b" : p.status === "pronto_entrega" ? "#22c55e" : p.status === "saiu_entrega" ? "#3498db" : "#94a3b8"};">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
                            <div>
                                <div style="font-weight:700;font-size:1rem">Pedido #${p.id} — ${p.cliente_nome || "Cliente"}</div>
                                <div style="font-size:0.78rem;color:#666;margin-top:2px">${p.endereco_entrega || (p.tipo_entrega === "balcao" ? "🏪 Balcão" : "")}</div>
                            </div>
                            <span class="status-badge st-${p.status}" style="font-size:0.7rem">${statusLabel}</span>
                        </div>
                        ${_itensCardHtml ? `<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:7px;padding:7px 10px;margin-bottom:8px">${_itensCardHtml}</div>` : ""}
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <div>
                              <strong style="font-size:1rem;color:var(--dark)">Gs ${(p.total_geral || 0).toLocaleString("es-PY")}</strong>
                              ${p.frete_motoboy ? `<div style="font-size:0.72rem;color:#27ae60;margin-top:2px">🛵 Motoboy: Gs ${p.frete_motoboy.toLocaleString("es-PY")}</div>` : ""}
                            </div>
                            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${cardAcoes}</div>
                        </div>
                        ${badgeCancelCard}
                    </div>`;
      }
    });
  } else {
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center; padding:20px; color:#999;">Nenhum pedido ativo.</td></tr>';
    if (cardsDiv)
      cardsDiv.innerHTML =
        '<div style="text-align:center;padding:30px;color:#aaa;font-size:0.95rem">Nenhum pedido ativo no momento.</div>';
  }
}

// === CANCELAMENTO WORKFLOW ===
async function solicitarCancelamento(pedidoId) {
  const motivo = prompt(t("prompt.motivo_cancel"));
  if (!motivo || !motivo.trim()) return;

  const user = await supa.auth.getUser();
  const email = user?.data?.user?.email || "desconhecido";

  const { error } = await supa
    .from("pedidos")
    .update({
      cancelamento_solicitado: true,
      cancelamento_motivo: motivo.trim(),
      cancelamento_solicitado_por: email,
      cancelamento_solicitado_em: new Date().toISOString(),
    })
    .eq("id", pedidoId);

  if (error) {
    alert("❌ Erro: " + error.message);
    return;
  }

  // Registra na tabela de solicitações (falha silenciosa não bloqueia o fluxo)
  const { error: errSol } = await supa
    .from("solicitacoes_cancelamento")
    .insert([
      {
        pedido_id: pedidoId,
        motivo: motivo.trim(),
        solicitado_por: email,
      },
    ]);
  if (errSol) console.warn("solicitacoes_cancelamento insert:", errSol.message);

  alert(t("alert.cancel_enviado"));
  carregarPedidos();
}

async function aprovarCancelamento(pedidoId) {
  if (
    !confirm(
      "⚠️ Confirma o CANCELAMENTO deste pedido?\nEsta ação não pode ser desfeita.",
    )
  )
    return;

  const user = await supa.auth.getUser();
  const email = user?.data?.user?.email || "dono" || "gerente";

  // Verifica ANTES do update se o estoque deste pedido já tinha sido
  // descontado. Pedidos ainda "pendente" (nunca passaram por em_preparo,
  // PDV balcão, ou mesa) nunca tiveram estoque baixado — repor nesse caso
  // criaria estoque fantasma (a mais).
  const { data: _pedAntesCancelamento } = await supa
    .from("pedidos")
    .select("estoque_descontado")
    .eq("id", pedidoId)
    .single();

  const { error } = await supa
    .from("pedidos")
    .update({
      status: "cancelado",
      cancelamento_aprovado_por: email,
      cancelamento_aprovado_em: new Date().toISOString(),
    })
    .eq("id", pedidoId);

  if (error) {
    alert("❌ Erro: " + error.message);
    return;
  }

  // Bug #7 corrigido: repõe estoque ao aprovar cancelamento —
  // SOMENTE se o estoque deste pedido tinha sido efetivamente descontado.
  if (_pedAntesCancelamento?.estoque_descontado) {
    const _resReporAprov = await _reporEstoqueCancelamento(pedidoId);
    // 🔧 Só zera a flag se a reposição realmente confirmou sucesso em tudo —
    // do contrário mantém true, sinalizando que ainda há estoque "devendo"
    // ser reposto (em vez de mascarar como se já estivesse tudo ok).
    await supa
      .from("pedidos")
      .update({ estoque_descontado: !_resReporAprov.ok })
      .eq("id", pedidoId);
    await _alertarFalhaEstoque(_resReporAprov, `Cancelamento aprovado — Pedido #${pedidoId}`);
  }
  // Bug #6 corrigido: estorna cashback ao aprovar cancelamento
  await _estornarCashbackCancelamento(pedidoId);

  // Marca como aprovada na tabela de solicitações
  await supa
    .from("solicitacoes_cancelamento")
    .update({
      aprovado: true,
      aprovado_por: email,
      aprovado_em: new Date().toISOString(),
    })
    .eq("pedido_id", pedidoId)
    .eq("aprovado", false);

  alert(t("alert.cancelado"));
  carregarPedidos();
}

async function negarCancelamento(pedidoId) {
  const obs = prompt(t("prompt.negar_cancel")) || "";
  const user = await supa.auth.getUser();
  const email = user?.data?.user?.email || "dono" || "gerente";

  await supa
    .from("pedidos")
    .update({
      cancelamento_solicitado: false,
      cancelamento_motivo: null,
    })
    .eq("id", pedidoId);

  await supa
    .from("solicitacoes_cancelamento")
    .update({
      negado: true,
      negado_por: email,
      negado_em: new Date().toISOString(),
      observacoes: obs,
    })
    .eq("pedido_id", pedidoId)
    .eq("aprovado", false);

  alert(t("alert.cancel_negado"));
  carregarPedidos();
}

async function mudarStatus(id, novoStatus) {
  // Registra o timestamp do novo status no campo correspondente
  const camposTimestamp = {
    em_preparo: ["tempo_confirmado", "tempo_preparo_iniciado"], // aceita E começa a preparar
    pronto_entrega: "tempo_pronto",
    saiu_entrega: "tempo_saiu_entrega",
    entregue: "tempo_entregue",
  };

  // Se for cancelamento, verifica ANTES se o estoque deste pedido já foi
  // descontado — necessário para decidir se deve repor depois do update.
  let _estoqueJaDescontadoAntes = false;
  if (novoStatus === "cancelado") {
    const { data: _pedAntesCancel } = await supa
      .from("pedidos")
      .select("estoque_descontado")
      .eq("id", id)
      .single();
    _estoqueJaDescontadoAntes = !!_pedAntesCancel?.estoque_descontado;
  }

  const updateData = { status: novoStatus };
  const campos = camposTimestamp[novoStatus];
  if (campos) {
    const agora = new Date().toISOString();
    if (Array.isArray(campos)) campos.forEach((c) => (updateData[c] = agora));
    else updateData[campos] = agora;
  }
  // Status 'cancelado' mantém os timestamps existentes

  const { error } = await supa.from("pedidos").update(updateData).eq("id", id);
  if (error) {
    console.error("Erro ao atualizar:", error);
    alert("Erro ao mudar status");
    return;
  }

    if (novoStatus === "em_preparo") {
    // ⚠️ GUARD anti-duplo-desconto:
    // Se o pedido JÁ teve estoque descontado (ex: veio do PDV balcão com
    // `estoque_descontado = true`, ou um operador já clicou em Preparar
    // antes), não desconta de novo.
    const { data: _pedCheck } = await supa
      .from("pedidos")
      .select("estoque_descontado")
      .eq("id", id)
      .single();

    if (_pedCheck?.estoque_descontado) {
      console.log(
        `[Estoque] Pedido #${id} já teve estoque descontado — pulando.`,
      );
    } else {
      const _resDesc = await _descontarEstoqueVenda(id, null);
      await supa
        .from("pedidos")
        .update({ estoque_descontado: _resDesc.ok })
        .eq("id", id);
      await _alertarFalhaEstoque(_resDesc, `Pedido #${id} → Separação`);
    }
  }

  // Bug #7 corrigido: repõe estoque ao cancelar — SOMENTE se já tinha
  // sido descontado antes (pedidos "pendente" cancelados direto nunca
  // descontaram, então não devem repor nada).
  if (novoStatus === "cancelado" && _estoqueJaDescontadoAntes) {
    const _resRepor = await _reporEstoqueCancelamento(id);
    // 🔧 Só marca como "não descontado mais" (false) se a reposição
    // realmente confirmou sucesso em tudo. Se falhou parcialmente, mantém
    // true — o estoque ainda está "devendo" reposição, e isso fica visível
    // pra quem for reconciliar depois, em vez de sumir como se estivesse ok.
    await supa.from("pedidos").update({ estoque_descontado: !_resRepor.ok }).eq("id", id);
    await _alertarFalhaEstoque(_resRepor, `Pedido #${id} → Cancelamento`);
  }

  // Bug #6 corrigido: estorna cashback gerado ao cancelar
  if (novoStatus === "cancelado") await _estornarCashbackCancelamento(id);

  if (typeof pararAlarme === "function") pararAlarme();

  // Notifica o cliente via Web Push (ignora silenciosamente se falhar)
  _notificarClientePush(id, novoStatus);

  const abaAtual = localStorage.getItem("app_lastTab");
  if (abaAtual === "cozinha") carregarCozinha();
  else if (abaAtual === "pedidos") carregarPedidos();
  else if (abaAtual === "pdv") carregarMonitorMesas();
}

// Dispara a Edge Function notificar-cliente de forma fire-and-forget
async function _notificarClientePush(pedidoId, status) {
  try {
    const supaUrl =
      window._SUPABASE_URL ||
      (typeof _SUPABASE_URL !== "undefined" ? _SUPABASE_URL : "");
    if (!supaUrl) return;
    const fnUrl =
      supaUrl.replace("/rest/v1", "").replace(/\/+$/, "") +
      "/functions/v1/notificar-cliente";
    // Usa a chave anon — a Edge Function usa service role internamente
    const { data: session } = await supa.auth.getSession();
    const token = session?.session?.access_token;
    if (!token) return;
    fetch(fnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ pedido_id: pedidoId, status }),
    }).catch(() => {}); // fire-and-forget, nunca bloqueia
  } catch (_) {
    /* silencioso */
  }
}

// === FUNÇÃO DE IMPRESSÃO (RESTAURADA) ===
async function imprimirPedido(id) {
  const { data: p } = await supa
    .from("pedidos")
    .select("*")
    .eq("id", id)
    .single();
  if (!p) return;

  const dados = {
    id: p.id,
    cliente: { nome: p.cliente_nome, tel: p.cliente_telefone },
    entrega: { tipo: p.tipo_entrega, ref: p.endereco_entrega },
    // Imprime apenas itens pendentes (sem status ou status 'pendente')
    itens: (p.itens || [])
      .filter((i) => !i.status_item || i.status_item === "pendente")
      .map((i) => ({
        q: i.qtd || i.q || 1,
        n: i.nome || i.n,
        p: i.preco || i.p || 0,
        t: i.variacao || i.t || "",
        pr: i.preparo || i.pr || "",
        m: i.montagem || i.m,
        o: i.obs || i.o,
        // Kg — necessário para imprimir.html mostrar peso em vez de qtd
        _isKg: i._isKg || false,
        _tier: i._tier ?? null,
        _faixaAplicada: i._faixaAplicada ?? null,
        peso_gramas: i.peso_gramas || 0,
      })),
    valores: {
      sub: p.subtotal,
      frete: p.frete_cobrado_cliente,
      total: p.total_geral,
    },
    pagamento: { metodo: p.forma_pagamento, obs: p.obs_pagamento },
    factura: p.dados_factura,
    data: new Date(p.created_at || Date.now()).toLocaleString("pt-BR"),
  };

  const jsonStr = JSON.stringify(dados);
  // Base64 URL-safe: substitui +, / e = que quebram a URL
  const base64 = btoa(unescape(encodeURIComponent(jsonStr)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Abre a janela de impressão
  window.open(`imprimir.html?d=${base64}`, "Print", "width=420,height=700");
}

// =========================================
// 5. TELA COZINHA
// =========================================
// ══════════════════════════════════════════════════════════════
//  LISTA DE SEPARAÇÃO — substitui o KDS de cozinha
//  Exibe pedidos com checkboxes por item, impressão e resumo
//  consolidado de todos os produtos a separar.
// ══════════════════════════════════════════════════════════════

let _sepPedidos = []; // pedidos carregados do banco
let _sepChecks = {}; // { "pedidoId-itemIdx": true/false } — estado dos checks

// ── carregarCozinha — mantém o nome para compatibilidade com showTab ──
async function carregarCozinha() {
  await sepRecarregar();
}

async function sepRecarregar() {
  const sel = document.getElementById("sep-filtro-status");
  const status = (sel?.value || "em_preparo,pronto_entrega").split(",");

  const cont = document.getElementById("sep-lista-pedidos");
  if (cont)
    cont.innerHTML = `
    <div style="text-align:center;padding:40px;color:#aaa">
      <i class="fas fa-spinner fa-spin" style="font-size:2rem"></i>
      <p style="margin-top:12px">Carregando pedidos…</p>
    </div>`;

  const { data, error } = await supa
    .from("pedidos")
    .select(
      "id, uid_temporal, cliente_nome, cliente_telefone, endereco_entrega, itens, status, created_at, forma_pagamento, obs_pagamento, total_geral",
    )
    .in("status", status)
    .order("id", { ascending: true });

  if (error) {
    if (cont)
      cont.innerHTML = `<p style="color:#e74c3c;padding:20px">Erro: ${error.message}</p>`;
    return;
  }

  _sepPedidos = data || [];
  _sepRenderizar();
}

function _sepRenderizar() {
  const cont = document.getElementById("sep-lista-pedidos");
  const agrupar = document.getElementById("sep-agrupar")?.checked !== false;
  if (!cont) return;

  if (!_sepPedidos.length) {
    cont.innerHTML = `
      <div style="text-align:center;padding:50px;color:#aaa">
        <div style="font-size:3rem;margin-bottom:12px">✅</div>
        <div style="font-size:1.1rem;font-weight:600">Nenhum pedido pendente de separação!</div>
      </div>`;
    _sepRenderizarResumo([]);
    return;
  }

  if (agrupar) {
    cont.innerHTML = _sepPedidos.map((p) => _sepHtmlPedido(p)).join("");
  } else {
    // Visão consolidada — todos os itens de todos os pedidos numa lista só
    cont.innerHTML = _sepHtmlConsolidado(_sepPedidos);
  }

  _sepRenderizarResumo(_sepPedidos);
}

// ──────────────────────────────────────────────────────────────
//  HTML de um card de pedido com checkboxes
// ──────────────────────────────────────────────────────────────
function _sepHtmlPedido(p) {
  const num = p.uid_temporal || p.id;
  const cliente = p.cliente_nome || "Cliente";
  const hora = new Date(p.created_at).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const itens = Array.isArray(p.itens) ? p.itens : [];
  const statusCor =
    {
      em_preparo: "#f59e0b",
      pronto_entrega: "#22c55e",
      saiu_entrega: "#3b82f6",
    }[p.status] || "#94a3b8";

  const statusLabel =
    {
      em_preparo: "Em separação",
      pronto_entrega: "Pronto p/ envio",
      saiu_entrega: "Saiu p/ entrega",
    }[p.status] || p.status;

  // Verifica se todos os itens estão marcados
  const todosChecked = itens.every((_, i) => _sepChecks[`${p.id}-${i}`]);

  const itensHtml = itens
    .map((item, idx) => {
      const checkId = `sep-chk-${p.id}-${idx}`;
      const checked = _sepChecks[`${p.id}-${idx}`] ? "checked" : "";
      const qtd = item.qtd || item.q || 1;
      const nome = item.nome || item.n || "Item";
      const variacao = item.variacao || item.t || "";
      const obs = item.obs || item.o || "";
      const unidade = item.unidade_venda || "";

      const varTag = variacao
        ? `<span class="sep-variacao">▸ ${variacao}</span>`
        : "";
      const unidTag = unidade
        ? `<span class="sep-unidade">${unidade}</span>`
        : "";
      const obsTag = obs ? `<div class="sep-obs">⚠️ ${obs}</div>` : "";

      return `
      <label class="sep-item-row ${checked ? "sep-item-checked" : ""}"
        for="${checkId}" onclick="sepToggleItem('${p.id}', ${idx}, this)">
        <input type="checkbox" id="${checkId}" class="sep-checkbox" ${checked}
          onclick="event.stopPropagation(); sepToggleItem('${p.id}', ${idx}, this.closest('label'))">
        <div class="sep-item-body">
          <div class="sep-item-nome">
            <strong>${qtd}×</strong> ${nome} ${varTag} ${unidTag}
          </div>
          ${obsTag}
        </div>
      </label>`;
    })
    .join("");

  return `
    <div class="sep-card" id="sep-card-${p.id}" data-pedido-id="${p.id}">

      <!-- Cabeçalho do card -->
      <div class="sep-card-header" style="border-left-color:${statusCor}">
        <div class="sep-card-info">
          <span class="sep-num">#${num}</span>
          <span class="sep-cliente">${cliente}</span>
          <span class="sep-hora">🕐 ${hora}</span>
        </div>
        <div class="sep-card-badges">
          <span class="sep-status-badge" style="background:${statusCor}20;color:${statusCor};border:1px solid ${statusCor}40">
            ${statusLabel}
          </span>
          ${
            p.forma_pagamento
              ? `<span class="sep-pgto-badge">${_sepIconePgto(p.forma_pagamento)} ${p.forma_pagamento}</span>`
              : ""
          }
        </div>
      </div>

      <!-- Endereço se houver -->
      ${
        p.endereco_entrega
          ? `
        <div class="sep-endereco">
          <i class="fas fa-location-dot"></i> ${p.endereco_entrega}
        </div>`
          : ""
      }

      <!-- Lista de itens com checkboxes -->
      <div class="sep-itens-lista">
        ${itensHtml}
      </div>

      <!-- Rodapé: ações -->
      <div class="sep-card-footer">
        <div class="sep-total">
          Total: <strong>Gs ${Math.round(p.total_geral || 0).toLocaleString("es-PY")}</strong>
        </div>
        <div class="sep-acoes">
          <button class="btn btn-sm sep-btn-print" onclick="sepImprimirPedido(${p.id})"
            title="Imprimir este pedido">
            <i class="fas fa-print"></i>
          </button>
          <button class="btn btn-sm sep-btn-limpar" onclick="sepLimparChecks(${p.id})"
            title="Desmarcar tudo">
            <i class="fas fa-rotate-left"></i>
          </button>
          ${
            p.status === "em_preparo"
              ? `
          <button class="btn btn-sm sep-btn-pronto"
            onclick="mudarStatus(${p.id}, 'pronto_entrega').then(()=>sepRecarregar())"
            title="Marcar como pronto para envio">
            <i class="fas fa-check"></i> Pronto p/ envio
          </button>`
              : ""
          }
          ${
            p.status === "pronto_entrega"
              ? `
          <button class="btn btn-sm sep-btn-saiu"
            onclick="mudarStatus(${p.id}, 'saiu_entrega').then(()=>sepRecarregar())"
            title="Saiu para entrega">
            <i class="fas fa-motorcycle"></i> Saiu p/ entrega
          </button>`
              : ""
          }
        </div>
      </div>

    </div>`;
}

// ──────────────────────────────────────────────────────────────
//  HTML consolidado (sem agrupamento — lista única)
// ──────────────────────────────────────────────────────────────
function _sepHtmlConsolidado(pedidos) {
  // Agrega todos os itens de todos os pedidos
  const mapa = {}; // "nome|variacao" → { nome, variacao, qtd, pedidos[] }

  pedidos.forEach((p) => {
    (p.itens || []).forEach((item) => {
      const nome = item.nome || item.n || "Item";
      const variacao = item.variacao || item.t || "";
      const qtd = item.qtd || item.q || 1;
      const chave = `${nome}|||${variacao}`;
      if (!mapa[chave]) mapa[chave] = { nome, variacao, qtd: 0, pedidos: [] };
      mapa[chave].qtd += qtd;
      mapa[chave].pedidos.push(`#${p.uid_temporal || p.id}`);
    });
  });

  const linhas = Object.values(mapa)
    .sort((a, b) => a.nome.localeCompare(b.nome))
    .map((it, idx) => {
      const checkId = `sep-cons-${idx}`;
      const varTag = it.variacao
        ? `<span class="sep-variacao">▸ ${it.variacao}</span>`
        : "";
      return `
        <label class="sep-item-row" for="${checkId}"
          onclick="this.classList.toggle('sep-item-checked')">
          <input type="checkbox" id="${checkId}" class="sep-checkbox"
            onclick="event.stopPropagation();this.closest('label').classList.toggle('sep-item-checked')">
          <div class="sep-item-body">
            <div class="sep-item-nome">
              <strong>${it.qtd}×</strong> ${it.nome} ${varTag}
            </div>
            <div style="font-size:0.72rem;color:#888;margin-top:2px">
              Pedidos: ${it.pedidos.join(", ")}
            </div>
          </div>
        </label>`;
    })
    .join("");

  return `
    <div class="sep-card">
      <div class="sep-card-header" style="border-left-color:#8b5cf6">
        <div class="sep-card-info">
          <span class="sep-num">Lista Consolidada</span>
          <span class="sep-cliente">${pedidos.length} pedidos — ${Object.keys(mapa).length} itens distintos</span>
        </div>
        <button class="btn btn-sm sep-btn-print" onclick="sepImprimirTudo()" style="margin-left:auto">
          <i class="fas fa-print"></i> Imprimir
        </button>
      </div>
      <div class="sep-itens-lista">${linhas}</div>
    </div>`;
}

// ──────────────────────────────────────────────────────────────
//  Resumo consolidado no topo da aba
// ──────────────────────────────────────────────────────────────
function _sepRenderizarResumo(pedidos) {
  const wrap = document.getElementById("sep-resumo-global");
  const listEl = document.getElementById("sep-resumo-lista");
  if (!wrap || !listEl) return;

  if (!pedidos.length) {
    wrap.style.display = "none";
    return;
  }

  // Contabiliza itens
  const mapa = {};
  pedidos.forEach((p) => {
    (p.itens || []).forEach((item) => {
      const nome = item.nome || item.n || "Item";
      const v = item.variacao || item.t || "";
      const k = `${nome}|||${v}`;
      if (!mapa[k]) mapa[k] = { nome, variacao: v, qtd: 0 };
      mapa[k].qtd += item.qtd || item.q || 1;
    });
  });

  const sorted = Object.values(mapa).sort((a, b) =>
    a.nome.localeCompare(b.nome),
  );

  listEl.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:8px">
      ${sorted
        .map(
          (it) => `
        <span style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;
          padding:4px 10px;font-size:0.8rem;font-weight:600;color:#374151">
          <strong style="color:#1a7a2e">${it.qtd}×</strong>
          ${it.nome}${it.variacao ? ` <span style="color:#888;font-weight:400">▸ ${it.variacao}</span>` : ""}
        </span>`,
        )
        .join("")}
    </div>`;

  wrap.style.display = "block";
}

// ──────────────────────────────────────────────────────────────
//  Interação: check/uncheck de item
// ──────────────────────────────────────────────────────────────
function sepToggleItem(pedidoId, idx, labelEl) {
  const key = `${pedidoId}-${idx}`;
  _sepChecks[key] = !_sepChecks[key];
  labelEl.classList.toggle("sep-item-checked", !!_sepChecks[key]);
  const chk = labelEl.querySelector("input[type=checkbox]");
  if (chk) chk.checked = !!_sepChecks[key];

  // Atualiza progresso do card
  _sepAtualizarProgresso(pedidoId);
}

function sepLimparChecks(pedidoId) {
  const p = _sepPedidos.find((x) => x.id === pedidoId);
  if (!p) return;
  (p.itens || []).forEach((_, i) => {
    _sepChecks[`${pedidoId}-${i}`] = false;
  });
  // Re-renderiza só o card afetado
  const card = document.getElementById(`sep-card-${pedidoId}`);
  if (card) card.outerHTML = _sepHtmlPedido(p);
}

function _sepAtualizarProgresso(pedidoId) {
  const p = _sepPedidos.find((x) => x.id === pedidoId);
  if (!p) return;
  const total = (p.itens || []).length;
  const marcados = (p.itens || []).filter(
    (_, i) => _sepChecks[`${pedidoId}-${i}`],
  ).length;
  // Visual feedback: card fica esverdeado quando tudo marcado
  const card = document.getElementById(`sep-card-${pedidoId}`);
  if (!card) return;
  if (marcados === total && total > 0) {
    card.style.borderColor = "#22c55e";
    card.style.background = "#f0fdf4";
  } else {
    card.style.borderColor = "";
    card.style.background = "";
  }
}

// ──────────────────────────────────────────────────────────────
//  Busca inline (filtra cards sem ir ao banco)
// ──────────────────────────────────────────────────────────────
function sepFiltrarBusca(termo) {
  const t = termo.toLowerCase().trim();
  document.querySelectorAll(".sep-card[data-pedido-id]").forEach((card) => {
    const pid = card.dataset.pedidoId;
    const p = _sepPedidos.find((x) => String(x.id) === pid);
    if (!p) return;
    const texto = [
      p.uid_temporal,
      p.id,
      p.cliente_nome,
      p.cliente_telefone,
      ...(p.itens || []).map((i) => i.nome || i.n || ""),
    ]
      .join(" ")
      .toLowerCase();
    card.style.display = !t || texto.includes(t) ? "" : "none";
  });
}

// ──────────────────────────────────────────────────────────────
//  Impressão
// ──────────────────────────────────────────────────────────────
function _sepGerarHtmlImpressao(pedidos) {
  const data = new Date().toLocaleString("pt-BR");

  const blocos = pedidos
    .map((p) => {
      const num = p.uid_temporal || p.id;
      const itens = (p.itens || [])
        .map((item, idx) => {
          const qtd = item.qtd || item.q || 1;
          const nome = item.nome || item.n || "Item";
          const var_ = item.variacao || item.t || "";
          const obs = item.obs || item.o || "";
          const unid = item.unidade_venda || "";
          return `
        <tr>
          <td style="width:28px;text-align:center">
            <span style="display:inline-block;width:16px;height:16px;border:2px solid #333;border-radius:3px"></span>
          </td>
          <td style="padding:5px 8px;font-size:13px">
            <strong>${qtd}×</strong> ${nome}
            ${var_ ? `<em style="color:#555"> ▸ ${var_}</em>` : ""}
            ${unid ? `<span style="background:#e0f2fe;color:#075985;border-radius:3px;padding:0 5px;font-size:11px;margin-left:4px">${unid}</span>` : ""}
            ${obs ? `<div style="color:#dc2626;font-size:11px;margin-top:2px">⚠️ ${obs}</div>` : ""}
          </td>
        </tr>`;
        })
        .join("");

      return `
      <div style="page-break-inside:avoid;border:1.5px solid #ddd;border-radius:8px;
        margin-bottom:16px;overflow:hidden">
        <div style="background:#1a7a2e;color:#fff;padding:8px 14px;display:flex;
          justify-content:space-between;align-items:center">
          <div>
            <strong style="font-size:16px">#${num}</strong>
            <span style="margin-left:10px;font-size:13px">${p.cliente_nome || "Cliente"}</span>
          </div>
          <div style="font-size:12px;opacity:.85">
            ${new Date(p.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          </div>
        </div>
        ${
          p.endereco_entrega
            ? `
          <div style="background:#f9fafb;padding:5px 14px;font-size:12px;color:#555;
            border-bottom:1px dashed #e5e7eb">
            📍 ${p.endereco_entrega}
          </div>`
            : ""
        }
        <table style="width:100%;border-collapse:collapse;padding:6px">
          <tbody>${itens}</tbody>
        </table>
        <div style="border-top:1px dashed #e5e7eb;padding:6px 14px;font-size:12px;
          display:flex;justify-content:space-between;color:#555">
          <span>${p.forma_pagamento || ""}</span>
          <strong>Gs ${Math.round(p.total_geral || 0).toLocaleString("es-PY")}</strong>
        </div>
      </div>`;
    })
    .join("");

  return `
    <!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <title>Lista de Separação</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 16px; color: #111; }
      @media print {
        body { padding: 0; }
        .no-print { display: none; }
      }
    </style>
    </head><body>
    <div class="no-print" style="margin-bottom:16px;display:flex;gap:10px">
      <button onclick="window.print()"
        style="padding:10px 20px;background:#1a7a2e;color:#fff;border:none;
        border-radius:8px;font-size:1rem;cursor:pointer;font-weight:700">
        🖨️ Imprimir
      </button>
      <button onclick="window.close()"
        style="padding:10px 20px;background:#6b7280;color:#fff;border:none;
        border-radius:8px;font-size:1rem;cursor:pointer">
        ✕ Fechar
      </button>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:16px;
      border-bottom:2px solid #1a7a2e;padding-bottom:10px">
      <h2 style="margin:0;color:#1a7a2e">📦 Lista de Separação</h2>
      <div style="font-size:12px;color:#888;text-align:right">
        Impresso em: ${data}<br>
        ${pedidos.length} pedido(s)
      </div>
    </div>
    ${blocos}
    </body></html>`;
}

function sepImprimirPedido(pedidoId) {
  const p = _sepPedidos.find((x) => x.id === pedidoId);
  if (!p) return;
  const win = window.open("", "_blank", "width=800,height=700");
  win.document.write(_sepGerarHtmlImpressao([p]));
  win.document.close();
}

function sepImprimirTudo() {
  if (!_sepPedidos.length) {
    alert("Nenhum pedido para imprimir.");
    return;
  }
  const win = window.open("", "_blank", "width=800,height=700");
  win.document.write(_sepGerarHtmlImpressao(_sepPedidos));
  win.document.close();
}

// Ícone por forma de pagamento
function _sepIconePgto(forma) {
  const m = {
    efectivo: "💵",
    dinheiro: "💵",
    cartao: "💳",
    pix: "⚡",
    transferencia: "🏦",
    qr_py: "📱",
  };
  return m[(forma || "").toLowerCase().replace(/\s/g, "")] || "💰";
}

// =========================================
// 6. FINANCEIRO
// =========================================
// Estado persistente do último cálculo financeiro
let _caixaState = {
  faturamento: 0,
  custoEntregas: 0,
  totalSaidas: 0,
  totalEntradas: 0,
  totalPix: 0,
  totalTransf: 0,
  totalCartao: 0,
  totalEfetivo: 0,
  totalQrPy: 0,
  totalCartaoBR: 0,
  totalMultiOutros: 0,
  qtdPedidos: 0,
};

// Sessão de caixa ativa (carregada ao abrir a aba financeiro)
let _sessaoCaixaAtiva = null;
// { id, usuario_email, aberto_em, fechado_em, valor_abertura }

// ─────────────────────────────────────────────────────────────
// GERENCIAMENTO DE SESSÃO DE CAIXA
// ─────────────────────────────────────────────────────────────

/**
 * Carrega a sessão de caixa ativa para o usuário corrente.
 * Gestores veem qualquer sessão aberta (ou a mais recente).
 * Funcionário vê apenas a sua própria.
 */
async function _carregarSessaoCaixa() {
  const ehGestor = ["dono", "gerente", "adminMaster"].includes(perfilUsuario);
  const emailAtual = document.getElementById("user-email")?.innerText || "";

  let q = supa
    .from("sessoes_caixa")
    .select("*")
    .is("fechado_em", null) // só sessões ABERTAS
    .order("aberto_em", { ascending: false })
    .limit(1);

  if (!ehGestor) q = q.eq("usuario_email", emailAtual);

  const { data } = await q;
  _sessaoCaixaAtiva = data?.[0] || null;

  // Atualiza o indicador visual de status do caixa (se existir no HTML)
  const elStatus = document.getElementById("status-sessao-caixa");
  if (elStatus) {
    if (_sessaoCaixaAtiva) {
      const dAbr = new Date(_sessaoCaixaAtiva.aberto_em).toLocaleString(
        "pt-BR",
        {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        },
      );
      elStatus.innerHTML = `<span style="color:#27ae60">🟢 Caixa aberto desde ${dAbr}</span>`;
    } else {
      elStatus.innerHTML = `<span style="color:#e74c3c">🔴 Nenhum caixa aberto</span>`;
    }
  }
}

/**
 * Exibe alerta de abertura de caixa e abre o modal para registro.
 */
function _exibirAlertaAberturaCaixa() {
  const ehGestor = ["dono", "gerente", "adminMaster"].includes(perfilUsuario);
  const msg = ehGestor
    ? "⚠️ Nenhuma sessão de caixa está aberta no momento.\n\nDeseja abrir o caixa agora?"
    : "⚠️ Você ainda não abriu o caixa hoje.\n\nÉ necessário registrar a abertura para contabilizar as vendas nesta sessão.\n\nDeseja abrir o caixa agora?";

  if (confirm(msg)) {
    abrirModalCaixa("abertura");
  }
}

/**
 * Abre nova sessão de caixa no Supabase e carrega em _sessaoCaixaAtiva.
 * Chamado ao salvar uma movimentação do tipo "abertura".
 */
async function _abrirSessaoCaixa(valorAbertura, descricao) {
  const emailAtual = document.getElementById("user-email")?.innerText || "";
  const nome =
    document.getElementById("user-nome-display")?.innerText || emailAtual;

  const { data, error } = await supa
    .from("sessoes_caixa")
    .insert([
      {
        usuario_email: emailAtual,
        usuario_nome: nome,
        aberto_em: new Date().toISOString(),
        valor_abertura: valorAbertura || 0,
        observacao: descricao || null,
      },
    ])
    .select()
    .single();

  if (error) throw error;
  _sessaoCaixaAtiva = data;
  return data;
}

// ─────────────────────────────────────────────────────────────
// HELPER — offset UTC de Assunção em ms para uma data específica
// Desde 2024 o Paraguai adotou UTC-3 permanente (sem horário de verão).
// Usamos Intl.DateTimeFormat com "America/Asuncion" para que a IANA tz
// database reflita automaticamente qualquer futura mudança de lei.
// ─────────────────────────────────────────────────────────────
function _getAsuncionOffsetMs(date) {
  try {
    // Determina o offset real comparando UTC com o horário local de Assunção
    const utc = date.getTime();
    const localStr = new Intl.DateTimeFormat("sv-SE", {
      // sv-SE = formato ISO sem vírgula
      timeZone: "America/Asuncion",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
    const local = new Date(localStr);
    return utc - local.getTime();
  } catch (_) {
    return 3 * 60 * 60 * 1000; // fallback UTC-3 (permanente desde 2024)
  }
}

async function calcularFinanceiro() {
  const abaFin = document.getElementById("financeiro");
  if (!abaFin || !abaFin.classList.contains("active")) return;

  const elInicio = document.getElementById("fin-inicio");
  const elFim = document.getElementById("fin-fim");
  const elTipo = document.getElementById("fin-tipo");
  const elFactura = document.getElementById("fin-factura");
  if (!elInicio || !elFim || !elTipo) return;

  const ehGestor = ["dono", "gerente", "adminMaster"].includes(perfilUsuario);
  const emailAtual = document.getElementById("user-email")?.innerText || "";

  // ── 1. Carrega/verifica sessão ativa ─────────────────────────────
  await _carregarSessaoCaixa();

  // // ── 2. Se não houver sessão aberta, exibe alerta de abertura ─────
  // if (!_sessaoCaixaAtiva) {
  //   _exibirAlertaAberturaCaixa();
  //   return; // não renderiza nada enquanto não houver sessão
  // }

  // ── 3. Define intervalo de tempo baseado na SESSÃO, não no calendário ─
  const hoje = new Date().toISOString().split("T")[0];
  const sessaoInicio = (elInicio.value || hoje) + "T00:00:00";
  const sessaoFim    = (elFim.value   || hoje) + "T23:59:59";

  // Gestores podem sobrepor o intervalo com o filtro de datas da tela.
  // NOTA DE FUSO: o Supabase armazena UTC. Assunção é UTC-3 permanente desde 2024.
  // Ao converter a data local do filtro, usamos _getAsuncionOffsetMs para obter UTC correto.
  let utcI = sessaoInicio;
  let utcF = sessaoFim;
  if (ehGestor && elInicio.value && elFim.value) {
    // Determina o offset de Assunção dinamicamente via Intl
    const _refDate = new Date(elInicio.value + "T12:00:00");
    const _asunOffset = _getAsuncionOffsetMs(_refDate);
    utcI = new Date(
      new Date(elInicio.value + "T00:00:00").getTime() + _asunOffset,
    ).toISOString();
    utcF = new Date(
      new Date(elFim.value + "T23:59:59").getTime() + _asunOffset,
    ).toISOString();
  } else if (!elInicio.value || !elFim.value) {
    const hoje = new Date().toISOString().split("T")[0];
    if (!elInicio.value) elInicio.value = hoje;
    if (!elFim.value) elFim.value = hoje;
  }

  const tipoFiltro = elTipo.value;
  const facturaFiltro = elFactura ? elFactura.value : "todos";

  // ── 4. Busca pedidos dentro da janela da sessão ───────────────────
  // Inclui TODOS os status exceto cancelado — pedidos do app chegam como
  // "pendente" ou "em_preparo" e devem ser contabilizados no caixa do dia.
  let query = supa
    .from("pedidos")
    .select("*, motoboys(nome)")
    .neq("status", "cancelado")
    .gte("created_at", utcI)
    .lte("created_at", utcF);

  if (tipoFiltro !== "todos") query = query.eq("forma_pagamento", tipoFiltro);

  // Funcionário: filtra apenas pedidos relacionados ao seu usuário
  // (via mesa/operador, se seu schema tiver esse campo — ajuste o campo se necessário)
  // if (!ehGestor) query = query.eq("operador_email", emailAtual);

  const { data: pedidos } = await query;
  let peds = pedidos || [];

  if (facturaFiltro === "com_factura")
    peds = peds.filter((p) => p.dados_factura?.ruc || p.dados_factura?.ci);
  else if (facturaFiltro === "sem_factura")
    peds = peds.filter((p) => !p.dados_factura?.ruc && !p.dados_factura?.ci);

  // ── 5. Movimentações de caixa da SESSÃO ──────────────────────────
let caixa = [];
if (_sessaoCaixaAtiva) {
  let caixaQuery = supa
    .from("movimentacoes_caixa")
    .select("*")
    .eq("sessao_id", _sessaoCaixaAtiva.id);
  if (!ehGestor) caixaQuery = caixaQuery.eq("usuario_email", emailAtual);
  const { data: caixaData } = await caixaQuery;
  caixa = caixaData || [];
}

  // Verifica bloqueio de caixa (sangria limite)
  _verificarBloqueioCaixa(emailAtual);

  // ── 6. Cálculos (inalterado) ──────────────────────────────────────
  const safeNum = (v) => {
    if (!v) return 0;
    if (typeof v === "number") return v;
    return (
      parseFloat(
        v
          .toString()
          .replace(/[^\d.,-]/g, "")
          .replace(",", "."),
      ) || 0
    );
  };
  const fmt = (n) => "Gs " + n.toLocaleString("es-PY");

  let faturamento = 0,
    totalPix = 0,
    totalTransf = 0,
    totalCartao = 0,
    totalEfetivo = 0,
    totalQrPy = 0,
    totalCartaoBR = 0,
    totalMultiOutros = 0;
  let custoEntregas = 0,
    qtdPedidos = 0;
  const motoMap = {};

  peds.forEach((p) => {
    const val = safeNum(p.total_geral);
    faturamento += val;
    qtdPedidos++;
    const pag = (p.forma_pagamento || "").toLowerCase();
    const obsPag = p.obs_pagamento || "";

    // ── Multipagamento: distribui pelos métodos reais gravados em obs_pagamento ──
    if (pag === "multipagamento" && obsPag) {
      try {
        const partes = JSON.parse(obsPag); // [{ metodo, valor }, ...] — campo legado: forma
        if (Array.isArray(partes)) {
          partes.forEach((parte) => {
            const pf = (parte.metodo || parte.forma || "").toLowerCase();
            const pv = Math.round(Number(parte.valor) || 0);
            if (pf.includes("pix"))                                   totalPix     += pv;
            else if (pf.includes("transfer"))                         totalTransf  += pv;
            else if (pf.includes("qrpy") || pf.includes("qr"))       totalQrPy    += pv;
            else if (pf.includes("cartaobr") || pf.includes("br"))   totalCartaoBR+= pv;
            else if (pf.includes("cartao") || pf.includes("cartão")) totalCartao  += pv;
            else                                                       totalEfetivo += pv;
          });
        } else {
          totalMultiOutros += val; // JSON malformado — conta separado
        }
      } catch (_) {
        totalMultiOutros += val; // obs_pagamento não é JSON (texto livre)
      }
    }
    // ── Pagamentos simples ──────────────────────────────────────────────────
    else if (pag.includes("pix"))                                    totalPix     += val;
    else if (pag.includes("transfer") || pag.includes("alias"))     totalTransf  += val;
    else if (pag === "qrpy")                                         totalQrPy    += val;
    else if (pag === "cartaobr")                                     totalCartaoBR+= val;
    else if (pag.includes("cartao") || pag.includes("cartão"))      totalCartao  += val;
    else if (pag.includes("efetivo") || pag.includes("dinheiro"))   totalEfetivo += val;
    else                                                             totalMultiOutros += val;
    if (p.tipo_entrega === "delivery") {
      const taxa = safeNum(p.frete_motoboy) || TAXA_MOTOBOY || 0;
      custoEntregas += taxa;
      const nm = p.motoboys?.nome || "Sem Motoboy";
      if (!motoMap[nm]) motoMap[nm] = { entregas: 0, frete_total: 0 };
      motoMap[nm].entregas++;
      motoMap[nm].frete_total += taxa;
    }
  });

  const qtdMotoboyUnicos = Object.keys(motoMap).filter(
    (n) => n !== "Sem Motoboy",
  ).length;
  custoEntregas += (AJUDA_COMBUSTIVEL || 0) * qtdMotoboyUnicos;

  // ── Lucro sobre Vendas (usando preco_compra cadastrado nos produtos) ──
  // ATENÇÃO: este cálculo só considera itens cujo produto tem preco_compra
  // cadastrado. Itens SEM preco_compra são excluídos do cálculo (não dá
  // pra estimar lucro sem custo) — mas isso significa que o markup exibido
  // é uma média APENAS dos produtos com custo cadastrado, não de 100% das
  // vendas. Por isso agora rastreamos e exibimos a cobertura (% do
  // faturamento que entrou no cálculo), para não dar falsa precisão.
  let lucroBrutoVendas = 0;
  let markupMedioVendas = null;
  let faturamentoComCusto = 0;
  let faturamentoSemCusto = 0;
  let qtdItensSemCusto = 0;
  try {
    const prodIdsSet = new Set();
    peds.forEach((p) => {
      (p.itens || []).forEach((i) => {
        const pid = i.produto_id || i.id || i.pid;
        if (pid) prodIdsSet.add(Number(pid));
      });
    });
    const prodIds = Array.from(prodIdsSet);
    let precosCompra = {};
    if (prodIds.length > 0) {
      const { data: prods } = await supa
        .from("produtos")
        .select("id, preco_compra")
        .in("id", prodIds);
      (prods || []).forEach((pr) => {
        if (pr.preco_compra) precosCompra[pr.id] = pr.preco_compra;
      });
    }
    let custoTotal = 0;
        peds.forEach((p) => {
      (p.itens || []).forEach((i) => {
        const pid = Number(i.produto_id || i.id || i.pid || 0);
        const qtd = i.qtd || i.q || 1;
        const precoVenda = safeNum(i.preco || i.p || 0);
        const precoCompraKg = precosCompra[pid] || 0;

        // 🔧 Item vendido por peso: `preco` já é o TOTAL cobrado
        // (preco_kg × peso_gramas / 1000), mas `preco_compra` é por kg.
        // Precisa converter o custo para a mesma fração de peso antes
        // de subtrair — senão o lucro vira um prejuízo fictício.
        const _isItemKg = i._isKg === true || Number(i.peso_gramas) > 0;
        const _fracaoKg = _isItemKg
          ? Number(i.peso_gramas || 0) / 1000
          : 1;
        const precoCompra = precoCompraKg * _fracaoKg;

        const valorItem = precoVenda * qtd;
        if (precoVenda > 0 && precoCompra > 0) {
          lucroBrutoVendas += (precoVenda - precoCompra) * qtd;
          custoTotal += precoCompra * qtd;
          faturamentoComCusto += valorItem;
        } else if (precoVenda > 0) {
          // Item vendido mas sem preco_compra cadastrado — fica de fora
          // do cálculo de lucro. Contabiliza para mostrar a cobertura real.
          faturamentoSemCusto += valorItem;
          qtdItensSemCusto++;
        }
      });
    });
    if (custoTotal > 0)
      markupMedioVendas = Math.round((lucroBrutoVendas / custoTotal) * 100);
  } catch (e) {
    console.warn("Erro calcular lucro vendas:", e);
  }

  // % do faturamento de itens que efetivamente entrou no cálculo de lucro
  const _baseCobertura = faturamentoComCusto + faturamentoSemCusto;
  const coberturaLucroPct =
    _baseCobertura > 0
      ? Math.round((faturamentoComCusto / _baseCobertura) * 100)
      : null;

  let totalSaidas = 0,
    totalEntradas = 0,
    totalSangria = 0;
  (caixa || []).forEach((c) => {
    const v = safeNum(c.valor);
    if (c.tipo === "despesa") totalSaidas += v;
    if (c.tipo === "sangria") {
      totalSaidas += v;
      totalSangria += v;
    }
    if (c.tipo === "suprimento" || c.tipo === "abertura") totalEntradas += v;
  });

  _caixaState = {
    faturamento,
    custoEntregas,
    totalSaidas,
    totalEntradas,
    totalPix,
    totalTransf,
    totalCartao,
    totalEfetivo,
    totalQrPy,
    totalCartaoBR,
    totalMultiOutros,
    qtdPedidos,
    totalSangria,
    lucroBrutoVendas: lucroBrutoVendas || 0,
    markupMedioVendas,
    coberturaLucroPct,
    faturamentoSemCusto,
    qtdItensSemCusto,
  };

  const lucro = faturamento + totalEntradas - custoEntregas - totalSaidas;
  const setV = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.innerText = v;
  };

  setV("card-faturamento", fmt(faturamento));
  setV("card-custo-moto", fmt(custoEntregas));
  setV("card-lucro", fmt(lucro));
  setV("card-lucro-vendas", fmt(lucroBrutoVendas || 0));
  const elLvPct = document.getElementById("card-lucro-vendas-pct");
  if (elLvPct) {
    // Avisa quando o markup foi calculado sobre só uma fração das vendas
    // (produtos sem preco_compra cadastrado ficam fora da conta) — isso
    // evita comparar números de cobertura diferente entre lojas/sistemas
    // e achar que o lucro "não bate" quando na verdade é a base de cálculo
    // que é diferente.
    const avisoCobertura =
      coberturaLucroPct !== null && coberturaLucroPct < 95
        ? ` · cálculo cobre só ${coberturaLucroPct}% das vendas (${qtdItensSemCusto} item(s) sem custo cadastrado)`
        : "";
    if (lucroBrutoVendas > 0 && markupMedioVendas !== null) {
      elLvPct.style.color = coberturaLucroPct !== null && coberturaLucroPct < 95 ? "#d97706" : "#388e3c";
      elLvPct.textContent = `markup médio ${markupMedioVendas}%${avisoCobertura}`;
      elLvPct.title = avisoCobertura
        ? `Faturamento sem custo cadastrado: ${fmt(faturamentoSemCusto)}. Cadastre o "preço de compra" nesses produtos para um markup mais preciso.`
        : "";
    } else if (lucroBrutoVendas > 0) {
      elLvPct.textContent = `com base nos custos${avisoCobertura}`;
    } else {
      elLvPct.style.color = "#9ca3af";
      elLvPct.textContent = "cadastre o preço de compra nos produtos";
    }
  }
  setV("total-pix", fmt(totalPix));
  setV("total-transf", fmt(totalTransf));
  setV("total-cartao", fmt(totalCartao));
  setV("total-efetivo", fmt(totalEfetivo));
  setV("total-qrpy", fmt(totalQrPy));
  setV("total-cartaobr", fmt(totalCartaoBR));
  setV("total-multi-outros", fmt(totalMultiOutros));
  setV("card-qtd-pedidos", qtdPedidos);
  setV("card-ticket-medio", fmt(qtdPedidos > 0 ? faturamento / qtdPedidos : 0));

  // Badge do operador / info da sessão
  const badgeCaixa = document.getElementById("badge-caixa-operador");
if (badgeCaixa) {
  if (_sessaoCaixaAtiva) {
    const dAbr = new Date(_sessaoCaixaAtiva.aberto_em).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const dFch = _sessaoCaixaAtiva.fechado_em
      ? new Date(_sessaoCaixaAtiva.fechado_em).toLocaleString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "em aberto";
    badgeCaixa.textContent = ehGestor
      ? `📊 Visão geral — sessão ${_sessaoCaixaAtiva.id} (${_sessaoCaixaAtiva.usuario_email}) · ${dAbr} → ${dFch}`
      : `💼 Seu caixa — aberto ${dAbr} → ${dFch}`;
  } else {
    badgeCaixa.textContent = "📊 Sem sessão de caixa ativa — exibindo todos os pedidos do período";
  }
}

  // Tabelas de despesas e motoboys (código original preservado)
  const tbD = document.getElementById("lista-despesas-caixa");
  if (tbD) {
    const despesas = (caixa || []).filter((c) => c.tipo === "despesa");
    const _DLABELS = {
      despesas_gerais: "📦 Despesas Gerais",
      contas_fixas: "🏠 Contas Fixas",
      pagamento_fornecedor: "🤝 Fornecedor",
      pagamento_funcionario: "👷 Funcionário",
      pagamento_terceiros: "👥 Terceiros",
      manutencao: "🔧 Manutenção",
      retirada: "💵 Retirada",
      motoboy: "🛵 Motoboy",
      outro: "✏️ Outro",
    };
    if (!despesas.length) {
      tbD.innerHTML =
        '<tr><td colspan="5" style="text-align:center;color:#999;padding:16px">Nenhuma despesa nesta sessão</td></tr>';
    } else {
      tbD.innerHTML = despesas
        .map((d) => {
          const dt = new Date(d.created_at).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
          const tipoLabel = _DLABELS[d.tipo_despesa] || d.tipo_despesa || "—";
          const descExtra =
            d.tipo_despesa === "outro" && d.descricao_outro
              ? ` (${d.descricao_outro})`
              : "";
          const obs = d.descricao || "";
          const enc = encodeURIComponent(
            JSON.stringify({
              id: d.id,
              valor: d.valor,
              tipo_despesa: d.tipo_despesa || "despesas_gerais",
              descricao: d.descricao || "",
              descricao_outro: d.descricao_outro || "",
            }),
          );
          return `<tr>
          <td style="white-space:nowrap;color:#666;font-size:0.82rem">${dt}</td>
          <td><span style="background:#fdecea;color:#a93226;padding:2px 7px;border-radius:10px;font-size:0.78rem">${tipoLabel}${descExtra}</span></td>
          <td style="color:#555;font-size:0.85rem">${obs}</td>
          <td style="text-align:right;font-weight:700;color:#c0392b;white-space:nowrap">${fmt(d.valor)}</td>
          <td style="text-align:center;white-space:nowrap">
            <button onclick="abrirEditarDespesa('${enc}')" style="background:#3498db;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.8rem;margin-right:4px">✏️</button>
            <button onclick="excluirDespesa(${d.id})" style="background:#e74c3c;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.8rem">🗑️</button>
          </td></tr>`;
        })
        .join("");
    }
  }

  const tbM = document.getElementById("lista-financeiro-motoboys");
  if (tbM) {
    tbM.innerHTML = "";
    if (!Object.keys(motoMap).length) {
      tbM.innerHTML =
        '<tr><td colspan="4" style="text-align:center;color:#999">Nenhuma entrega nesta sessão</td></tr>';
    } else {
      for (const [nome, d] of Object.entries(motoMap)) {
        const semNome = nome === "Sem Motoboy";
        const comb = semNome ? 0 : AJUDA_COMBUSTIVEL || 0;
        const tot = d.frete_total + comb;
        const combLabel = semNome
          ? '<span style="color:#aaa;font-size:0.78rem">sem combustível</span>'
          : `+ comb. ${fmt(comb)}`;
        tbM.innerHTML += `<tr><td>${nome}</td><td>${d.entregas}</td>
          <td style="font-size:0.82rem">Frete: ${fmt(d.frete_total)} ${combLabel}</td>
          <td><strong>${fmt(tot)}</strong></td></tr>`;
      }
    }
  }

  // ── Relatório Detalhado de Vendas: popula com os pedidos já carregados ──
  // Não faz nova query ao banco — reutiliza `peds` (já filtrados por data e forma de pagamento).
  _finRelPopular(peds);

  // ── Histórico de Boletins de Fechamento (card novo) ──
  carregarHistoricoFechamentos();
}

// ══════════════════════════════════════════════════════════════════
// RELATÓRIO DETALHADO DE VENDAS  (aba Financeiro)
// ── Integrado com calcularFinanceiro(): reutiliza utcI/utcF e
//    tipoFiltro já resolvidos; chamado no final de calcularFinanceiro.
// ══════════════════════════════════════════════════════════════════

/** Estado interno do relatório — isolado do restante do módulo */
const _finRel = {
  linhas: [],          // todas as linhas expandidas (1 por item × pedido)
  linhasFiltradas: [], // subconjunto após busca livre
  pagina: 0,
  PAGE_SIZE: 50,
  aberto: false,       // painel colapsado por padrão
};

/**
 * Ponto de entrada: chamado ao final de calcularFinanceiro().
 * Recebe os mesmos pedidos já carregados para evitar segunda query.
 *
 * @param {Array}  peds     - array de pedidos já filtrados
 * @param {string} utcI     - ISO string início (UTC)
 * @param {string} utcF     - ISO string fim (UTC)
 */
function _finRelPopular(peds) {
  // Expande cada pedido em N linhas (uma por item)
  const fmt = (n) => "Gs " + Math.round(n).toLocaleString("es-PY");

  const linhas = [];
  (peds || []).forEach((p) => {
    const itens = Array.isArray(p.itens) ? p.itens : [];
    const dataHora = new Date(p.created_at).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    const pedidoLabel = `#${p.id}`;
    const cliente    = p.cliente_nome || "—";

    // Forma de pagamento — resolve multipagamento
    let pgtoLabel;
    const pag    = (p.forma_pagamento || "").toLowerCase();
    const obsPag = p.obs_pagamento || "";
    if (pag === "multipagamento" && obsPag) {
      try {
        const partes = JSON.parse(obsPag);
        if (Array.isArray(partes)) {
          pgtoLabel = partes
            .map((pt) => { const m = pt.metodo || pt.forma || "—"; return `${_sepIconePgto(m)} ${m} (Gs ${Math.round(Number(pt.valor) || 0).toLocaleString("es-PY")})`; })
            .join(" + ");
        } else {
          pgtoLabel = p.forma_pagamento || "—";
        }
      } catch (_) {
        pgtoLabel = p.forma_pagamento || "—";
      }
    } else {
      pgtoLabel = `${_sepIconePgto(p.forma_pagamento)} ${p.forma_pagamento || "—"}`;
    }

    if (!itens.length) {
      // Pedido sem itens — inclui uma linha representando o total
      linhas.push({
        pedidoLabel, dataHora, cliente,
        nome: "(sem itens)", qtd: "—",
        vlUnit: "—", subtotal: fmt(p.total_geral || 0),
        pgtoLabel, pedidoId: p.id,
        _subtotalNum: p.total_geral || 0,
      });
      return;
    }

    itens.forEach((item) => {
      const qtd     = item.qtd  || item.q  || 1;
      const nome    = item.nome || item.n  || "Item";
      const vlUnit  = item.preco || item.p  || 0;
      const variacao = item.variacao ? ` (${item.variacao})` : "";
      linhas.push({
        pedidoLabel, dataHora, cliente,
        nome: nome + variacao,
        qtd,
        vlUnit: fmt(vlUnit),
        subtotal: fmt(vlUnit * qtd),
        pgtoLabel, pedidoId: p.id,
        _subtotalNum: vlUnit * qtd,
      });
    });
  });

  _finRel.linhas = linhas;
  _finRel.pagina = 0;

  // Aplica filtro de busca livre (mantém o que o usuário já digitou)
  _finRelFiltrarTabela();

  // Atualiza o badge com a contagem total de linhas
  const elContador = document.getElementById("fin-rel-contador");
  if (elContador) {
    elContador.textContent = `${linhas.length} linha${linhas.length !== 1 ? "s" : ""}`;
    elContador.style.display = linhas.length ? "inline" : "none";
  }
}

/**
 * Filtra _finRel.linhas pela busca livre e re-renderiza.
 * Chamada pelo oninput do campo de busca e por _finRelPopular.
 */
function _finRelFiltrarTabela() {
  const busca = (document.getElementById("fin-rel-busca")?.value || "").toLowerCase().trim();

  _finRel.linhasFiltradas = busca
    ? _finRel.linhas.filter(
        (l) =>
          l.nome.toLowerCase().includes(busca) ||
          l.cliente.toLowerCase().includes(busca) ||
          l.pedidoLabel.toLowerCase().includes(busca)
      )
    : [..._finRel.linhas];

  _finRel.pagina = 0;
  _finRelRenderizar();
}

/**
 * Renderiza a página atual da tabela e atualiza os totalizadores.
 */
function _finRelRenderizar() {
  const tbody   = document.getElementById("fin-rel-tbody");
  const elInfo  = document.getElementById("fin-rel-pag-info");
  const btnPrev = document.getElementById("fin-rel-btn-prev");
  const btnNext = document.getElementById("fin-rel-btn-next");
  if (!tbody) return;

  const { linhasFiltradas, pagina, PAGE_SIZE } = _finRel;
  const total  = linhasFiltradas.length;
  const inicio = pagina * PAGE_SIZE;
  const fim    = Math.min(inicio + PAGE_SIZE, total);
  const slice  = linhasFiltradas.slice(inicio, fim);

  if (!total) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#bbb;padding:24px;font-size:0.85rem;">
      Nenhum item encontrado para os filtros aplicados.
    </td></tr>`;
    if (elInfo)  elInfo.textContent = "";
    if (btnPrev) btnPrev.disabled = true;
    if (btnNext) btnNext.disabled = true;
    _finRelAtualizarTotais([]);
    return;
  }

  // Agrupa linhas por pedido para zebrar visualmente por pedido
  let lastPedido = null;
  let zebraClass = "rel-row-a";

  tbody.innerHTML = slice.map((l) => {
    if (l.pedidoId !== lastPedido) {
      lastPedido = l.pedidoId;
      zebraClass = zebraClass === "rel-row-a" ? "rel-row-b" : "rel-row-a";
    }
    const bg = zebraClass === "rel-row-a" ? "#fff" : "#f9fafb";
    return `
      <tr style="background:${bg};">
        <td style="white-space:nowrap; font-size:0.78rem; color:#888;">${l.pedidoLabel}</td>
        <td style="white-space:nowrap; font-size:0.78rem; color:#888;">${l.dataHora}</td>
        <td style="font-size:0.82rem; max-width:130px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${l.cliente}">${l.cliente}</td>
        <td style="font-size:0.85rem; font-weight:500;">${l.nome}</td>
        <td style="text-align:center; font-size:0.85rem;">${l.qtd}</td>
        <td style="text-align:right; white-space:nowrap; font-size:0.85rem;">${l.vlUnit}</td>
        <td style="text-align:right; white-space:nowrap; font-size:0.85rem; font-weight:700; color:#2d6a4f;">${l.subtotal}</td>
        <td style="font-size:0.78rem; color:#555; white-space:nowrap;">${l.pgtoLabel}</td>
      </tr>`;
  }).join("");

  // Paginação
  const totalPags = Math.ceil(total / PAGE_SIZE);
  if (elInfo)  elInfo.textContent = `Exibindo ${inicio + 1}–${fim} de ${total} linha${total !== 1 ? "s" : ""} (pág. ${pagina + 1}/${totalPags})`;
  if (btnPrev) btnPrev.disabled = pagina === 0;
  if (btnNext) btnNext.disabled = fim >= total;

  // Totalizadores
  _finRelAtualizarTotais(linhasFiltradas);
}

/** Atualiza os totalizadores do cabeçalho do painel */
function _finRelAtualizarTotais(linhas) {
  const fmt = (n) => "Gs " + Math.round(n).toLocaleString("es-PY");
  const receita = linhas.reduce((s, l) => s + (l._subtotalNum || 0), 0);
  const qtdItens = linhas.reduce((s, l) => s + (typeof l.qtd === "number" ? l.qtd : 0), 0);
  const ticket   = qtdItens > 0 ? receita / qtdItens : 0;

  const el = (id) => document.getElementById(id);
  if (el("fin-rel-tot-itens"))   el("fin-rel-tot-itens").textContent   = qtdItens.toLocaleString("es-PY");
  if (el("fin-rel-tot-receita")) el("fin-rel-tot-receita").textContent = fmt(receita);
  if (el("fin-rel-tot-ticket"))  el("fin-rel-tot-ticket").textContent  = fmt(ticket);
}

/** Navega entre páginas: delta = -1 (anterior) ou +1 (próxima) */
function _finRelPagina(delta) {
  const total    = _finRel.linhasFiltradas.length;
  const maxPag   = Math.max(0, Math.ceil(total / _finRel.PAGE_SIZE) - 1);
  _finRel.pagina = Math.min(maxPag, Math.max(0, _finRel.pagina + delta));
  _finRelRenderizar();
}

/** Expande / colapsa o painel do relatório */
function _finRelToggle(btn) {
  const body = document.getElementById("fin-rel-body");
  if (!body) return;
  _finRel.aberto = !_finRel.aberto;

  if (_finRel.aberto) {
    body.style.display = "block";
    btn.innerHTML = '<i class="fas fa-chevron-up"></i> Recolher';
    btn.style.background = "#495057";
    // Renderiza pela primeira vez ao expandir
    _finRelRenderizar();
  } else {
    body.style.display = "none";
    btn.innerHTML = '<i class="fas fa-chevron-down"></i> Expandir';
    btn.style.background = "#6c757d";
  }
}

/** Exporta as linhas filtradas como CSV UTF-8 com BOM (abre corretamente no Excel) */
function _finRelExportarCSV() {
  const linhas = _finRel.linhasFiltradas;
  if (!linhas.length) { alert("Nenhum dado para exportar."); return; }

  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["Pedido", "Data/Hora", "Cliente", "Produto", "Qtd", "Vl. Unit. (Gs)", "Subtotal (Gs)", "Pagamento"];

  const rows = linhas.map((l) => [
    l.pedidoLabel, l.dataHora, l.cliente, l.nome, l.qtd,
    Math.round(parseFloat(String(l.vlUnit).replace(/[^\d.]/g, "")) || 0),
    Math.round(l._subtotalNum || 0),
    l.pgtoLabel,
  ].map(escape).join(";"));

  const csv  = "\uFEFF" + [header.map(escape).join(";"), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  const hoje = new Date().toISOString().split("T")[0];
  a.href     = url;
  a.download = `relatorio_vendas_${hoje}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Verifica bloqueio por sangria limite ───────────────────────────
async function _verificarBloqueioCaixa(emailAtual) {
  const { data: cfg } = await supa
    .from("configuracoes")
    .select("sangria_limite, caixa_status")
    .maybeSingle();
  if (!cfg?.sangria_limite) return;

  const hoje = new Date();
  const dStr = hoje.toISOString().split("T")[0];
  const { data: movs } = await supa
    .from("movimentacoes_caixa")
    .select("tipo, valor")
    .eq("usuario_email", emailAtual)
    .gte("created_at", dStr + " 00:00:00")
    .lte("created_at", dStr + " 23:59:59");

  let efetivo = 0;
  (movs || []).forEach((m) => {
    const v = parseFloat(m.valor) || 0;
    if (
      m.tipo === "efetivo" ||
      m.tipo === "abertura" ||
      m.tipo === "suprimento"
    )
      efetivo += v;
    if (m.tipo === "sangria") efetivo -= v;
  });

  const status = cfg.caixa_status || {};
  const bloqueado = status[emailAtual]?.bloqueado;
  const banner = document.getElementById("banner-caixa-bloqueado");

  if (!bloqueado && efetivo >= cfg.sangria_limite) {
    // Bloqueia
    const novoStatus = {
      ...status,
      [emailAtual]: {
        bloqueado: true,
        bloqueado_em: new Date().toISOString(),
        autorizado_por: null,
      },
    };
    await supa
      .from("configuracoes")
      .update({ caixa_status: novoStatus })
      .gt("id", 0);
    if (banner) {
      banner.style.display = "block";
      banner.querySelector("#banner-sangria-msg").textContent =
        `Caixa bloqueado: efetivo atingiu o limite de sangria (Gs ${cfg.sangria_limite.toLocaleString("es-PY")}). Solicite autorização de um gestor.`;
    }
    return;
  }
  if (banner) banner.style.display = bloqueado ? "block" : "none";
}

async function autorizarReaberturaCaixa(emailAlvo) {
  if (!["dono", "gerente", "adminMaster"].includes(perfilUsuario)) {
    alert(t("alert.acesso_negado"));
    return;
  }
  if (!confirm(`Autorizar reabertura do caixa de ${emailAlvo}?`)) return;
  const { data: cfg } = await supa
    .from("configuracoes")
    .select("caixa_status")
    .maybeSingle();
  const status = { ...(cfg?.caixa_status || {}) };
  const emailGestor = document.getElementById("user-email")?.innerText || "";
  status[emailAlvo] = {
    bloqueado: false,
    autorizado_por: emailGestor,
    autorizado_em: new Date().toISOString(),
  };
  await supa.from("configuracoes").update({ caixa_status: status }).gt("id", 0);
  alert(t("alert.caixa_reaberto"));
  calcularFinanceiro();
}

async function exportarFinanceiro() {
  // 1. Pega os mesmos filtros da tela
  const elInicio = document.getElementById("fin-inicio");
  const elFim = document.getElementById("fin-fim");
  const elTipo = document.getElementById("fin-tipo");
  const elFactura = document.getElementById("fin-factura");

  const inicio = elInicio.value;
  const fim = elFim.value;
  const tipoFiltro = elTipo ? elTipo.value : "todos";
  const facturaFiltro = elFactura ? elFactura.value : "todos";

  // Define período
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = String(hoje.getMonth() + 1).padStart(2, "0");
  const dia = String(hoje.getDate()).padStart(2, "0");

  // Define período — corrige fuso: Assunção é UTC-3 permanente desde 2024
  // O Supabase armazena UTC, então desloca o intervalo local para UTC via helper
  const _refDate = new Date(); // data de referência para calcular o offset atual
  const _TZ_OFFSET_MS = _getAsuncionOffsetMs(_refDate); // UTC-3 = 3h em ms
  let dataInicio, dataFim;
  if (inicio && fim) {
    dataInicio = new Date(
      new Date(inicio + "T00:00:00").getTime() + _TZ_OFFSET_MS,
    ).toISOString();
    dataFim = new Date(
      new Date(fim + "T23:59:59").getTime() + _TZ_OFFSET_MS,
    ).toISOString();
  } else {
    dataInicio = new Date(
      new Date(`${ano}-${mes}-${dia}T00:00:00`).getTime() + _TZ_OFFSET_MS,
    ).toISOString();
    dataFim = new Date(
      new Date(`${ano}-${mes}-${dia}T23:59:59`).getTime() + _TZ_OFFSET_MS,
    ).toISOString();
  }

  // 2. Busca os dados
  let query = supa
    .from("pedidos")
    .select("*")
    .neq("status", "cancelado")
    .gte("created_at", dataInicio)
    .lte("created_at", dataFim);

  if (tipoFiltro !== "todos") {
    query = query.eq("forma_pagamento", tipoFiltro);
  }

  const { data: pedidos, error } = await query;

  if (error) {
    alert("Erro ao buscar dados: " + error.message);
    return;
  }

  if (!pedidos || pedidos.length === 0) {
    alert("Nenhum pedido encontrado no período selecionado.");
    return;
  }

  // 3. Filtra por factura se necessário
  let pedidosFiltrados = pedidos;
  if (facturaFiltro === "com_factura") {
    pedidosFiltrados = pedidos.filter(
      (p) => p.dados_factura && (p.dados_factura.ruc || p.dados_factura.ci),
    );
  } else if (facturaFiltro === "sem_factura") {
    pedidosFiltrados = pedidos.filter(
      (p) => !p.dados_factura || (!p.dados_factura.ruc && !p.dados_factura.ci),
    );
  }

  // 4. Prepara dados para CSV
  let csv =
    "ID Pedido,Data/Hora,Cliente,Telefone,Tipo Entrega,Forma Pagamento,Subtotal,Frete,Total,RUC/CI,Razão Social\n";

  pedidosFiltrados.forEach((p) => {
    const data = new Date(p.created_at).toLocaleString("pt-BR");
    const cliente = (p.cliente_nome || "").replace(/,/g, " "); // Remove vírgulas
    const telefone = p.cliente_telefone || "";
    const tipo = p.tipo_entrega || "";
    const pagamento = p.forma_pagamento || "";
    const subtotal = p.subtotal || 0;
    const frete = p.frete_cobrado_cliente || 0;
    const total = p.total_geral || 0;
    const ruc = p.dados_factura?.ruc || p.dados_factura?.ci || "";
    const razao = (p.dados_factura?.razao || "").replace(/,/g, " ");

    csv += `${p.id},${data},${cliente},${telefone},${tipo},${pagamento},${subtotal},${frete},${total},${ruc},${razao}\n`;
  });

  // 5. Cria arquivo e faz download
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);

  link.setAttribute("href", url);
  link.setAttribute(
    "download",
    `Relatorio_Financeiro_${ano}-${mes}-${dia}.csv`,
  );
  link.style.visibility = "hidden";

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  alert(
    `✅ Relatório exportado com sucesso!\n\nTotal de pedidos: ${pedidosFiltrados.length}`,
  );
}

// =====================================================
// ALTERNATIVA: EXPORTAR PARA EXCEL REAL (XLSX)
// =====================================================
// Se quiser usar biblioteca SheetJS para Excel verdadeiro:

async function exportarFinanceiroXLSX() {
  // Aviso: Requer biblioteca SheetJS
  if (typeof XLSX === "undefined") {
    alert("Biblioteca XLSX não carregada. Usando CSV simples.");
    exportarFinanceiro();
    return;
  }

  // Busca os dados (mesmo código acima)
  // ... código de busca ...

  // Cria planilha
  const ws = XLSX.utils.json_to_sheet(
    pedidosFiltrados.map((p) => ({
      ID: p.id,
      Data: new Date(p.created_at).toLocaleString("pt-BR"),
      Cliente: p.cliente_nome,
      Telefone: p.cliente_telefone,
      Tipo: p.tipo_entrega,
      Pagamento: p.forma_pagamento,
      Subtotal: p.subtotal,
      Frete: p.frete_cobrado_cliente,
      Total: p.total_geral,
      "RUC/CI": p.dados_factura?.ruc || p.dados_factura?.ci || "",
      Razão: p.dados_factura?.razao || "",
    })),
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Vendas");

  const hoje = new Date();
  XLSX.writeFile(
    wb,
    `Relatorio_${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}-${String(hoje.getDate()).padStart(2, "0")}.xlsx`,
  );
}

// =====================================================
// RELATÓRIO DETALHADO DE PEDIDOS
// =====================================================
async function abrirRelatorio() {
  const modal = document.getElementById("modal-relatorio");
  if (modal) {
    modal.style.display = "flex";
    await carregarRelatorio();
  }
}

async function carregarRelatorio() {
  const filtroNum = document.getElementById("rel-filtro-numero")?.value?.trim();
  const filtroInicio = document.getElementById("rel-filtro-inicio")?.value;
  const filtroFim = document.getElementById("rel-filtro-fim")?.value;
  const hoje = new Date().toISOString().split("T")[0];
  let query = supa
    .from("pedidos")
    .select("*")
    .order("id", { ascending: false })
    .limit(100);
  if (filtroNum) {
    query = query.eq("id", parseInt(filtroNum));
  } else {
    const ini = filtroInicio || hoje;
    const fim = filtroFim || hoje;
    // Assunção UTC-3 permanente desde 2024: desloca datas locais para UTC
    const _off = _getAsuncionOffsetMs(new Date(ini + "T00:00:00"));
    const utcIni = new Date(
      new Date(ini + "T00:00:00").getTime() + _off,
    ).toISOString();
    const utcFim = new Date(
      new Date(fim + "T23:59:59").getTime() + _off,
    ).toISOString();
    query = query.gte("created_at", utcIni).lte("created_at", utcFim);
  }
  const { data: pedidos, error } = await query;
  if (error) {
    console.error(error);
    return;
  }
  const tbody = document.getElementById("rel-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const fmtDiff = (t1, t2) => {
    if (!t1 || !t2) return "-";
    const diff = Math.round((new Date(t2) - new Date(t1)) / 60000);
    if (diff < 60) return diff + " min";
    return Math.floor(diff / 60) + "h " + (diff % 60) + "m";
  };
  const fmtHora = (t) =>
    t
      ? new Date(t).toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "America/Asuncion",
        })
      : "-";
  const scMap = {
    pendente: { bg: "#fff3cd", color: "#856404", label: "⏳ Pendente" },
    em_preparo: { bg: "#ffe5d0", color: "#a63c06", label: "🔥 Em Preparo" },
    pronto_entrega: { bg: "#d1ecf1", color: "#0c5460", label: "📦 Pronto" },
    saiu_entrega: { bg: "#d4edda", color: "#155724", label: "🛵 Saiu" },
    entregue: { bg: "#d4edda", color: "#155724", label: "✅ Entregue" },
    cancelado: { bg: "#f8d7da", color: "#721c24", label: "❌ Cancelado" },
  };

  (pedidos || []).forEach((p) => {
    const sc = scMap[p.status] || {
      bg: "#f0f0f0",
      color: "#333",
      label: p.status,
    };
    const isPDV = p.tipo_entrega === "balcao";

    const itensList = (p.itens || [])
      .map((i) => {
        const qtd = i.qtd || i.q || 1;
        const nome = i.nome || i.n || "?";
        const variacao = i.variacao || i.t || "";
        const montagem = i.montagem || i.m || [];
        let lbl = `<strong>${qtd}x</strong> ${nome}`;
        if (variacao && variacao !== nome)
          lbl += ` <span style="color:#e67e22">▸ ${variacao}</span>`;
        if (montagem.length > 0) {
          const montagemHtml = montagem
            .map((linha) => {
              const idx = linha.indexOf(":");
              if (idx > 0)
                return `<strong>${linha.slice(0, idx)}:</strong> ${linha.slice(idx + 1).trim()}`;
              return linha;
            })
            .join(" · ");
          lbl += ` <span style="color:#555;font-size:0.78em">(${montagemHtml})</span>`;
        }
        return lbl;
      })
      .join("<br>");

    // Cancelamento info
    let cancelInfo = "";
    if (p.status === "cancelado") {
      const quem = p.cancelamento_solicitado_por || "admin";
      cancelInfo = `<div style="margin-top:5px;padding:5px 7px;background:#fde;border-radius:6px;font-size:0.72rem;color:#a00">
        🚫 <strong>Por:</strong> ${quem}${p.cancelamento_motivo ? "<br><em>" + p.cancelamento_motivo + "</em>" : ""}</div>`;
    } else if (p.cancelamento_solicitado) {
      cancelInfo = `<div style="margin-top:4px;font-size:0.7rem;color:#e74c3c">
        🚫 Solicitado por: ${p.cancelamento_solicitado_por || "?"}</div>`;
    }

    // Tipo badge
    const tipoBadges = {
      balcao:
        '<span style="background:#e8f4f8;color:#1a6e8a;border-radius:10px;padding:2px 7px;font-size:0.68rem;font-weight:700">🏪 PDV</span>',
      delivery:
        '<span style="background:#e8f7e8;color:#1a6e2e;border-radius:10px;padding:2px 7px;font-size:0.68rem;font-weight:700">🛵 Delivery</span>',
      retirada:
        '<span style="background:#f7f0e8;color:#6e4a1a;border-radius:10px;padding:2px 7px;font-size:0.68rem;font-weight:700">🚶 Retirada</span>',
    };
    const tipoBadge = tipoBadges[p.tipo_entrega] || "";
    const _podeCancelRel = ["dono", "adminMaster", "gerente", "funcionario"].includes(perfilUsuario);
    const jaCancelado = p.status === "cancelado";

    // Timeline — PDV tem etapas diferentes
    const tl = isPDV
      ? [
          {
            icon: "🏪",
            label: "Abertura",
            val: fmtHora(p.tempo_recebido || p.created_at),
            diff: null,
          },
          {
            icon: "🔥",
            label: "Separação",
            val: fmtHora(p.tempo_preparo_iniciado),
            diff: null,
          },
          {
            icon: "📦",
            label: "Pronto",
            val: fmtHora(p.tempo_pronto),
            diff: fmtDiff(p.tempo_preparo_iniciado, p.tempo_pronto),
          },
          {
            icon: "✅",
            label: "Fechado",
            val: fmtHora(p.tempo_entregue),
            diff: fmtDiff(p.tempo_recebido || p.created_at, p.tempo_entregue),
          },
        ]
      : [
          {
            icon: "📥",
            label: "Recebido",
            val: fmtHora(p.tempo_recebido),
            diff: null,
          },
          {
            icon: "✅",
            label: "Aceite",
            val: fmtHora(p.tempo_confirmado),
            diff: fmtDiff(p.tempo_recebido, p.tempo_confirmado),
          },
          {
            icon: "🔥",
            label: "Separação",
            val: fmtHora(p.tempo_preparo_iniciado),
            diff: null,
          },
          {
            icon: "📦",
            label: "Pronto",
            val: fmtHora(p.tempo_pronto),
            diff: fmtDiff(p.tempo_preparo_iniciado, p.tempo_pronto),
          },
          {
            icon: "🛵",
            label: "Saiu",
            val: fmtHora(p.tempo_saiu_entrega),
            diff: null,
          },
          {
            icon: "🏠",
            label: "Entregue",
            val: fmtHora(p.tempo_entregue),
            diff: fmtDiff(p.tempo_saiu_entrega, p.tempo_entregue),
          },
        ];

    const tlHtml = tl
      .map((t) => {
        const vazio = t.val === "-";
        return `<div style="display:flex;align-items:baseline;gap:5px;padding:2px 0;border-bottom:1px solid #f5f5f5">
        <span style="min-width:18px;font-size:0.85em">${t.icon}</span>
        <span style="min-width:64px;font-size:0.72rem;color:#888">${t.label}:</span>
        <span style="font-size:0.78rem;font-weight:${vazio ? "400" : "600"};color:${vazio ? "#ccc" : "#222"}">${t.val}</span>
        ${t.diff && t.diff !== "-" ? `<span style="font-size:0.68rem;color:#999">(${t.diff})</span>` : ""}
      </div>`;
      })
      .join("");

    const totalTime = isPDV
      ? fmtDiff(p.tempo_recebido || p.created_at, p.tempo_entregue)
      : fmtDiff(p.tempo_recebido, p.tempo_entregue);

    const _tz = { timeZone: "America/Asuncion" };
    tbody.innerHTML += `<tr style="border-bottom:1px solid #eee;vertical-align:top">
      <td style="padding:10px 8px;white-space:nowrap">
        <div style="font-size:1rem;font-weight:700;color:#1a1a2e">#${p.id}</div>
        <div style="font-size:0.73rem;color:#aaa">${new Date(p.created_at).toLocaleDateString("pt-BR", _tz)}</div>
        <div style="font-size:0.78rem;color:#666">${new Date(p.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", ..._tz })}</div>
      </td>
      <td style="padding:10px 8px">
        <div style="font-weight:700;color:#1a1a2e">${p.cliente_nome || "-"}</div>
        <div style="font-size:0.73rem;color:#999">📞 ${p.cliente_telefone || "-"}</div>
        <div style="margin-top:4px">${tipoBadge}</div>
      </td>
      <td style="padding:10px 8px;font-size:0.82rem;max-width:260px;line-height:1.6">${itensList || "-"}</td>
      <td style="padding:10px 8px;white-space:nowrap">
        <span style="display:inline-block;padding:4px 10px;border-radius:20px;font-size:0.73rem;font-weight:700;background:${sc.bg};color:${sc.color}">${sc.label}</span>
        ${cancelInfo}
      </td>
      <td style="padding:10px 8px;white-space:nowrap;text-align:right">
        <div style="font-size:0.95rem;font-weight:700;color:#1a1a2e">Gs ${(p.total_geral || 0).toLocaleString("es-PY")}</div>
        <div style="font-size:0.7rem;color:#aaa;margin-top:2px">${p.forma_pagamento || ""}</div>
      </td>
      <td style="padding:10px 8px;min-width:175px">
        ${tlHtml}
        ${totalTime !== "-" ? `<div style="margin-top:5px;padding:3px 7px;background:#f0f4ff;border-radius:6px;font-size:0.75rem;font-weight:700;color:#3a4db7;text-align:center">⏱ ${totalTime}</div>` : ""}
      </td>
      <td style="padding:10px 8px;white-space:nowrap;text-align:center;min-width:90px">
        ${(!jaCancelado && _podeCancelRel) ? `<button class="btn btn-danger btn-sm" onclick="cancelarPedidoRelatorio(${p.id})" title="Cancelar este pedido" style="font-size:0.7rem;padding:4px 8px">
          <i class="fas fa-times"></i> Cancelar
        </button>` : (jaCancelado ? '<span style="color:#aaa;font-size:0.7rem">Cancelado</span>' : '')}
      </td>
    </tr>`;
  });
  if (!pedidos || pedidos.length === 0)
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center;padding:40px;color:#aaa">Nenhum pedido encontrado.</td></tr>';
  const el = document.getElementById("rel-total-count");
  if (el) el.textContent = (pedidos || []).length + " pedidos encontrados";
}

async function cancelarPedidoRelatorio(pedidoId) {
  if (!confirm("⚠️ Tem certeza que deseja CANCELAR este pedido?\n\nEsta ação não pode ser desfeita e irá repor o estoque (se já tiver sido baixado).")) {
    return;
  }
  // Chama a função existente, que já faz todo o tratamento
  await mudarStatus(pedidoId, 'cancelado');
  // Recarrega o relatório para atualizar a lista
  carregarRelatorio();
}

function abrirModalCaixa(tipo) {
  document.getElementById("modal-caixa").style.display = "flex";
  document.getElementById("tipo-caixa").value = tipo;

  const titulos = {
    abertura: "🟢 Abrir Caixa",
    suprimento: "➕ Suprimento",
    sangria: "💸 Sangria",
    despesa: "🧾 Despesa",
  };
  document.getElementById("titulo-caixa").innerText =
    titulos[tipo] || "Operação";
  document.getElementById("valor-caixa").value = "";
  document.getElementById("desc-caixa").value = "";

  // Mostra/oculta seletor de tipo de despesa
  const despesaBox = document.getElementById("box-tipo-despesa");
  if (despesaBox)
    despesaBox.style.display = tipo === "despesa" ? "block" : "none";
  document.getElementById("valor-caixa").focus();
}

async function salvarMovimentacaoCaixa() {
  const tipo = document.getElementById("tipo-caixa").value;
  const valor = parseFloat(document.getElementById("valor-caixa").value);
  const desc = document.getElementById("desc-caixa").value.trim();

  if (!valor || valor <= 0) {
    alert("Digite um valor válido.");
    return;
  }

  const emailAtual = document.getElementById("user-email")?.innerText || "";

  // Bloquear se caixa bloqueado
  const { data: cfg } = await supa
    .from("configuracoes")
    .select("caixa_status")
    .maybeSingle();
  const status = cfg?.caixa_status || {};
  if (status[emailAtual]?.bloqueado && tipo !== "sangria") {
    alert(
      "⛔ Caixa bloqueado por sangria. Solicite autorização de um gestor para reabrir.",
    );
    return;
  }

  let tipoDespesa = null,
    descOutro = null;
  if (tipo === "despesa") {
    tipoDespesa =
      document.getElementById("tipo-despesa-sel")?.value || "despesas_gerais";
    if (tipoDespesa === "outro") {
      descOutro =
        document.getElementById("desc-outro-despesa")?.value?.trim() || "";
      if (!descOutro) {
        alert("Descreva o tipo da despesa.");
        return;
      }
    }
  }

  // ── Se for ABERTURA, cria a sessão primeiro ───────────────────────
  if (tipo === "abertura") {
    try {
      await _abrirSessaoCaixa(valor, desc);
      alert(
        `✅ Caixa aberto com fundo de Gs ${valor.toLocaleString("es-PY")}!`,
      );
      fecharModal("modal-caixa");
      _pdvAtualizarPainelCaixa(); // sincroniza painel no PDV
      calcularFinanceiro();
      return;
    } catch (e) {
      alert("Erro ao abrir caixa: " + e.message);
      return;
    }
  }

  // ── Para outros tipos, verifica se há sessão aberta ───────────────
  if (!_sessaoCaixaAtiva) {
    alert(
      "⚠️ Nenhum caixa aberto. Abra o caixa antes de registrar movimentações.",
    );
    return;
  }

  const insert = {
    tipo,
    valor,
    descricao: desc,
    usuario_email: emailAtual,
    tipo_despesa: tipoDespesa,
    descricao_outro: descOutro,
    sessao_id: _sessaoCaixaAtiva.id, // ← vínculo com a sessão
  };

  const { error } = await supa.from("movimentacoes_caixa").insert([insert]);
  if (error) {
    alert("Erro: " + error.message);
    return;
  }

  alert(t("alert.operacao_registrada"));
  fecharModal("modal-caixa");
  calcularFinanceiro();
}

/**
 * Recalcula o resumo de uma sessão de caixa direto do banco.
 *
 * ⚠️ CORREÇÕES CRÍTICAS:
 *
 * 1. FATURAMENTO = SUM(subtotal - descontos) — NÃO inclui frete.
 *    O frete é repasse ao motoboy, não receita da loja.
 *
 * 2. CUSTO_ENTREGAS: se o operador registrou pagamentos aos motoboys
 *    (despesas com tipo_despesa='motoboy'), usamos o VALOR REAL pago.
 *    Caso contrário, caímos no auto-calculado (soma de frete_motoboy).
 *    Isso evita contagem dupla quando ambos existem.
 *
 * 3. DINHEIRO_GAVETA: apenas motoboy pago em EFECTIVO reduz a gaveta.
 *    Pix/Transferência/Cartão não passam pela gaveta.
 */
async function _calcularResumoSessao(sessaoId, inicioISO, fimISO) {
  const safeNum = (v) => {
    if (!v) return 0;
    if (typeof v === "number") return v;
    return (
      parseFloat(String(v).replace(/[^\d.,-]/g, "").replace(",", ".")) || 0
    );
  };

  // ── 1. Busca em paralelo ────────────────────────────────────────
  const [
    { data: rows, error },
    { data: pedidosBrutos },
    { data: movs },
  ] = await Promise.all([
    supa.from("vw_sessao_resumo").select("*").eq("sessao_id", sessaoId).limit(1),
    supa
      .from("pedidos")
      .select(
        "subtotal, total_geral, frete_cobrado_cliente, frete_motoboy, " +
        "desconto_cupom, desconto_pdv_valor, cashback_valor, " +
        "forma_pagamento, tipo_entrega, motoboy_id, motoboys(nome)",
      )
      .neq("status", "cancelado")
      .gte("created_at", inicioISO)
      .lte("created_at", fimISO),
    supa
      .from("movimentacoes_caixa")
      .select("tipo, valor, tipo_despesa, descricao_outro")
      .eq("sessao_id", sessaoId),
  ]);

  const peds = pedidosBrutos || [];
  const movsArr = movs || [];

  // ═══════════════════════════════════════════════════════════════
  //  🔧 CORREÇÃO CRÍTICA #1 — Faturamento = total_geral (inclui frete)
  //
  //  Antes: faturamentoReal = subtotal − descontos (SEM frete)
  //         → frete entrava na gaveta mas não era receita,
  //           porém o pagamento ao motoboy era subtraído como despesa,
  //           gerando diferença = soma dos fretes.
  //
  //  Agora:  faturamentoReal = total_geral (inclui frete).
  //          O repasse ao motoboy é despesa real → desconta do lucro.
  //          Resultado: cliente paga Gs X (produto) + Gs Y (frete);
  //          loja paga Gs Y ao motoboy; lucro = X + Y − Y = X. ✓
  // ═══════════════════════════════════════════════════════════════
  let faturamentoReal   = 0;
  let freteCobradoTotal = 0;
  let freteEmEspecie    = 0;
  let freteMotoboyAuto  = 0;
  let descontoTotal     = 0;
  const motoMap = {};

  peds.forEach((p) => {
    const sub = safeNum(p.subtotal);
    const dc  = safeNum(p.desconto_cupom);
    const dp  = safeNum(p.desconto_pdv_valor);
    const cb  = safeNum(p.cashback_valor);
    const freteVal = safeNum(p.frete_cobrado_cliente);

    descontoTotal     += dc + dp + cb;
    freteCobradoTotal += freteVal;

    // Faturamento = subtotal − descontos + frete cobrado
    faturamentoReal += Math.max(0, sub - dc - dp - cb) + freteVal;

    if (p.tipo_entrega === "delivery") {
      freteMotoboyAuto += safeNum(p.frete_motoboy);
      const nm = p.motoboys?.nome || "Sem Motoboy";
      if (!motoMap[nm]) motoMap[nm] = true;

      const forma = (p.forma_pagamento || "").toLowerCase();
      if (forma.includes("efetivo") || forma.includes("dinheiro")) {
        freteEmEspecie += freteVal;
      }
    }
  });
  delete motoMap["Sem Motoboy"];
  const custoCombustivel = (AJUDA_COMBUSTIVEL || 0) * Object.keys(motoMap).length;

  // ── 3. Separa despesas motoboy vs. outras ──────────────────────
  let motoboyTotal     = 0;
  let motoboyEfetivo   = 0;
  let outrasDespesas   = 0;
  let totalSangrias    = 0;
  let totalSuprimentos = 0;

  movsArr.forEach((m) => {
    const v = safeNum(m.valor);
    if (m.tipo === "despesa") {
      if (m.tipo_despesa === "motoboy") {
        motoboyTotal += v;
        const forma = (m.descricao_outro || "").toLowerCase();
        if (forma.includes("efetivo") || forma.includes("dinheiro")) {
          motoboyEfetivo += v;
        }
      } else {
        outrasDespesas += v;
      }
    }
    if (m.tipo === "sangria") totalSangrias += v;
    if (m.tipo === "suprimento" || m.tipo === "abertura") totalSuprimentos += v;
  });

  // ── 4. Custo de entregas real ──────────────────────────────────
  let custoEntregas;
  if (motoboyTotal > 0) {
    custoEntregas = motoboyTotal + custoCombustivel;
  } else {
    custoEntregas = freteMotoboyAuto + custoCombustivel;
  }

  const totalDespesas = motoboyTotal + outrasDespesas;
  const totalSaidas   = totalDespesas + totalSangrias;
  const lucroOperacional = faturamentoReal + totalSuprimentos - totalSaidas;

  // ── 5. Totais por forma de pagamento (incluindo frete) ─────────
  let totalEfetivo = 0, totalPix = 0, totalCartao = 0;
  let totalCartaoBR = 0, totalTransf = 0, totalQrPy = 0, totalMulti = 0;

  peds.forEach((p) => {
    const base = Math.max(
      0,
      safeNum(p.subtotal) - safeNum(p.desconto_cupom) -
      safeNum(p.desconto_pdv_valor) - safeNum(p.cashback_valor),
    );
    // 🔧 Inclui frete no valor que efetivamente passou por cada meio de pagamento
    const val = base + safeNum(p.frete_cobrado_cliente);
    const pag = (p.forma_pagamento || "").toLowerCase();
    if (pag.includes("efetivo") || pag.includes("dinheiro")) totalEfetivo += val;
    else if (pag.includes("pix")) totalPix += val;
    else if (pag === "cartaobr") totalCartaoBR += val;
    else if (pag.includes("cartao") || pag.includes("cartão")) totalCartao += val;
    else if (pag.includes("transfer") || pag.includes("alias")) totalTransf += val;
    else if (pag === "qrpy") totalQrPy += val;
    else totalMulti += val;
  });

  // ── 6. Dinheiro na gaveta ──────────────────────────────────────
  const saidasEfetivo =
    motoboyTotal > 0
      ? motoboyEfetivo + outrasDespesas + totalSangrias
      : freteEmEspecie + outrasDespesas + totalSangrias;

  const valorAbertura = safeNum(_sessaoCaixaAtiva?.valor_abertura) ||
                        (rows?.[0] ? safeNum(rows[0].valor_abertura) : 0);

  const dinheiroGaveta =
    valorAbertura + totalSuprimentos + totalEfetivo - saidasEfetivo;

  // ── 7. Retorno ──────────────────────────────────────────────────
  if (!error && rows && rows.length > 0) {
    const r = rows[0];
    return {
      sessao_id:         r.sessao_id,
      usuario_email:     r.usuario_email,
      usuario_nome:      r.usuario_nome,
      aberto_em:         r.aberto_em,
      fechado_em:        r.fechado_em,
      valor_abertura:    valorAbertura,

      faturamento:       faturamentoReal,
      frete_cobrado:     freteCobradoTotal,
      frete_em_especie:  freteEmEspecie,
      desconto_total:    descontoTotal,
      qtd_pedidos:       safeNum(r.qtd_pedidos) || peds.length,

      custo_entregas:    custoEntregas,
      custo_combustivel: custoCombustivel,
      motoboy_total:     motoboyTotal,
      motoboy_efetivo:   motoboyEfetivo,
      outras_despesas:   outrasDespesas,

      total_despesas:    totalDespesas,
      total_sangrias:    totalSangrias,
      total_suprimentos: totalSuprimentos,
      total_saidas:      totalSaidas,
      total_entradas:    totalSuprimentos,

      lucro_operacional: lucroOperacional,
      dinheiro_gaveta:   dinheiroGaveta,

      total_efetivo:       totalEfetivo,
      total_pix:           totalPix,
      total_cartao:        totalCartao,
      total_cartao_br:     totalCartaoBR,
      total_transferencia: totalTransf,
      total_qr_py:         totalQrPy,
      total_multi_outros:  totalMulti,
    };
  }

  return {
    sessao_id:           sessaoId,
    aberto_em:           inicioISO,
    fechado_em:          fimISO,
    valor_abertura:      valorAbertura,
    faturamento:         faturamentoReal,
    frete_cobrado:       freteCobradoTotal,
    frete_em_especie:    freteEmEspecie,
    desconto_total:      descontoTotal,
    qtd_pedidos:         peds.length,
    custo_entregas:      custoEntregas,
    custo_combustivel:   custoCombustivel,
    motoboy_total:       motoboyTotal,
    motoboy_efetivo:     motoboyEfetivo,
    outras_despesas:     outrasDespesas,
    total_despesas:      totalDespesas,
    total_sangrias:      totalSangrias,
    total_suprimentos:   totalSuprimentos,
    total_saidas:        totalSaidas,
    total_entradas:      totalSuprimentos,
    lucro_operacional:   lucroOperacional,
    dinheiro_gaveta:     dinheiroGaveta,
    total_efetivo:       totalEfetivo,
    total_pix:           totalPix,
    total_cartao:        totalCartao,
    total_cartao_br:     totalCartaoBR,
    total_transferencia: totalTransf,
    total_qr_py:         totalQrPy,
    total_multi_outros:  totalMulti,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  PAGAMENTO AOS MOTOBOYS — registro de despesas no fechamento
//  Chama antes de fecharCaixaResumo(). Retorna:
//    - Array  → pagamentos a registrar (pode ser vazio = "pular")
//    - null   → operador cancelou o fechamento inteiro
// ═══════════════════════════════════════════════════════════════════

const _MOTOBOY_METODOS_PGTO = [
  { value: "Efectivo",      label: "💵 Efectivo" },
  { value: "Pix",           label: "🟢 Pix" },
  { value: "Transferencia", label: "🏦 Transferencia" },
  { value: "Cartao",        label: "💳 Tarjeta" },
  { value: "QrPy",          label: "📱 QR Paraguay" },
  { value: "Outro",         label: "✏️ Outro" },
];

async function _abrirModalPagamentoMotoboys(sessaoId, inicioISO, fimISO) {
  // ── Se a sessão JÁ tem despesas de motoboy registradas, não mostra
  //    o modal de novo (evita duplo lançamento). ────────────────────
  const { data: existentes } = await supa
    .from("movimentacoes_caixa")
    .select("id")
    .eq("sessao_id", sessaoId)
    .eq("tipo", "despesa")
    .eq("tipo_despesa", "motoboy")
    .limit(1);

  if (existentes && existentes.length > 0) {
    console.log("[Motoboy] Despesas já registradas nesta sessão — pulando modal.");
    return [];
  }

  // ── Busca motoboys com entregas na janela da sessão ────────────
  const { data: peds } = await supa
    .from("pedidos")
    .select("motoboy_id, frete_motoboy, motoboys(id, nome)")
    .neq("status", "cancelado")
    .eq("tipo_entrega", "delivery")
    .gte("created_at", inicioISO)
    .lte("created_at", fimISO);

  const mapa = {};
  (peds || []).forEach((p) => {
    const id = p.motoboy_id;
    if (!id) return;
    const nome = p.motoboys?.nome || "Motoboy";
    if (!mapa[id]) {
      mapa[id] = { motoboy_id: id, nome, entregas: 0, freteTotal: 0 };
    }
    mapa[id].entregas++;
    mapa[id].freteTotal += Number(p.frete_motoboy) || 0;
  });

  const motoboys = Object.values(mapa).sort((a, b) =>
    a.nome.localeCompare(b.nome),
  );

  // Sem motoboys com entrega → não mostra modal, retorna vazio
  if (motoboys.length === 0) return [];

  // Calcula combustível por motoboy (rateio igualitário)
  const combustivelPorMotoboy =
    motoboys.length > 0 ? (AJUDA_COMBUSTIVEL || 0) : 0;

  motoboys.forEach((m) => {
    m.valorSugerido = m.freteTotal + combustivelPorMotoboy;
  });

  // ── Cria o modal ───────────────────────────────────────────────
  return new Promise((resolve) => {
    document.getElementById("_modal-pgto-motoboys")?.remove();

    const overlay = document.createElement("div");
    overlay.id = "_modal-pgto-motoboys";
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:100000;" +
      "display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto";

    const motoboysHtml = motoboys
      .map((m, idx) => {
        const nomeEsc = String(m.nome).replace(/</g, "&lt;");
        const optsHtml = _MOTOBOY_METODOS_PGTO.map(
          (o) =>
            `<option value="${o.value}"${o.value === "Efectivo" ? " selected" : ""}>${o.label}</option>`,
        ).join("");
        return `
          <div style="background:#fff;border:1.5px solid #e5e7eb;border-radius:12px;
               padding:12px 14px;margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:8px">
              <div style="min-width:0">
                <div style="font-weight:700;color:#1e293b;font-size:0.95rem">${nomeEsc}</div>
                <div style="font-size:0.75rem;color:#94a3b8;margin-top:2px">
                  ${m.entregas} entrega${m.entregas > 1 ? "s" : ""} ·
                  Sugerido: Gs ${m.valorSugerido.toLocaleString("es-PY")}
                </div>
              </div>
              <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:#475569;cursor:pointer;flex-shrink:0">
                <input type="checkbox" data-idx="${idx}" data-role="pagar" checked
                  style="width:16px;height:16px;accent-color:#1a7a2e"
                  onchange="_motoboyTogglePagar(this)">
                Pagar
              </label>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div>
                <label style="display:block;font-size:0.7rem;font-weight:600;color:#94a3b8;
                       text-transform:uppercase;letter-spacing:0.3px;margin-bottom:3px">
                  Valor (Gs)
                </label>
                <input type="number" data-idx="${idx}" data-role="valor"
                  value="${m.valorSugerido}" min="0" step="1000"
                  style="width:100%;padding:8px 10px;border:1.5px solid #e5e7eb;
                         border-radius:8px;font-size:0.9rem;font-weight:600;
                         box-sizing:border-box;outline:none"
                  oninput="_motoboyRecalcularTotal()">
              </div>
              <div>
                <label style="display:block;font-size:0.7rem;font-weight:600;color:#94a3b8;
                       text-transform:uppercase;letter-spacing:0.3px;margin-bottom:3px">
                  Forma de Pagamento
                </label>
                <select data-idx="${idx}" data-role="metodo"
                  style="width:100%;padding:8px 10px;border:1.5px solid #e5e7eb;
                         border-radius:8px;font-size:0.9rem;background:#fff;
                         box-sizing:border-box;outline:none"
                  onchange="_motoboyRecalcularTotal()">
                  ${optsHtml}
                </select>
              </div>
            </div>
          </div>`;
      })
      .join("");

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:18px;max-width:540px;width:100%;
                  max-height:92vh;overflow:hidden;display:flex;flex-direction:column;
                  box-shadow:0 24px 80px rgba(0,0,0,0.4)">
        <div style="background:linear-gradient(135deg,#1e40af,#1e3a8a);color:#fff;
                    padding:20px 24px;flex-shrink:0">
          <div style="display:flex;align-items:center;gap:10px">
            <div style="font-size:1.6rem">🏍️</div>
            <div>
              <div style="font-size:1.15rem;font-weight:800">Pagamento aos Motoboys</div>
              <div style="font-size:0.8rem;opacity:0.85;margin-top:2px">
                Confirme o valor e a forma de pagamento de cada um. Os valores
                entram como <b>despesas</b> na sessão.
              </div>
            </div>
          </div>
        </div>

        <div style="padding:18px 20px;overflow-y:auto;flex:1">
          <div id="_pgto-motoboys-lista">${motoboysHtml}</div>
        </div>

        <div style="padding:14px 20px;border-top:2px solid #e2e8f0;background:#f8fafc;flex-shrink:0">
          <div style="display:flex;justify-content:space-between;font-size:0.85rem;color:#475569;margin-bottom:6px">
            <span>🏍️ Total a pagar (motoboys)</span>
            <strong id="_pgto-motoboys-total" style="color:#1e40af">Gs 0</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.82rem;color:#dc2626;margin-bottom:10px">
            <span>💵 Em efectivo (sai da gaveta)</span>
            <strong id="_pgto-motoboys-efetivo">Gs 0</strong>
          </div>
          <div style="display:flex;gap:10px">
            <button id="_pgto-motoboys-pular"
              style="flex:1;padding:13px;background:#fff;color:#64748b;
                     border:1.5px solid #e2e8f0;border-radius:10px;font-weight:700;
                     font-size:0.88rem;cursor:pointer">
              Pular
            </button>
            <button id="_pgto-motoboys-confirmar"
              style="flex:2;padding:13px;background:linear-gradient(135deg,#1a7a2e,#145a22);
                     color:#fff;border:none;border-radius:10px;font-weight:800;
                     font-size:0.92rem;cursor:pointer;box-shadow:0 4px 14px rgba(26,122,46,0.35)">
              ✅ Registrar Pagamentos
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Expõe função para o onchange dos inputs
    window._motoboyRecalcularTotal = function () {
      const inputs  = overlay.querySelectorAll('[data-role="valor"]');
      const selects = overlay.querySelectorAll('[data-role="metodo"]');
      const checks  = overlay.querySelectorAll('[data-role="pagar"]');
      let total = 0;
      let efetivo = 0;
      inputs.forEach((inp, i) => {
        const pagar = checks[i]?.checked;
        if (!pagar) return;
        const v = parseFloat(inp.value) || 0;
        total += v;
        if ((selects[i]?.value || "") === "Efectivo") efetivo += v;
      });
      const totalEl = overlay.querySelector("#_pgto-motoboys-total");
      const efetivoEl = overlay.querySelector("#_pgto-motoboys-efetivo");
      if (totalEl) totalEl.textContent = "Gs " + total.toLocaleString("es-PY");
      if (efetivoEl) efetivoEl.textContent = "Gs " + efetivo.toLocaleString("es-PY");
    };

    window._motoboyTogglePagar = function (checkbox) {
      const idx = checkbox.dataset.idx;
      const valorEl = overlay.querySelector(`input[data-role="valor"][data-idx="${idx}"]`);
      const selEl = overlay.querySelector(`select[data-role="metodo"][data-idx="${idx}"]`);
      if (valorEl) {
        valorEl.disabled = !checkbox.checked;
        valorEl.style.opacity = checkbox.checked ? "1" : "0.4";
      }
      if (selEl) {
        selEl.disabled = !checkbox.checked;
        selEl.style.opacity = checkbox.checked ? "1" : "0.4";
      }
      window._motoboyRecalcularTotal();
    };

    // Inicializa totais
    window._motoboyRecalcularTotal();

    // Handlers dos botões
    overlay.querySelector("#_pgto-motoboys-pular").addEventListener("click", () => {
      overlay.remove();
      resolve([]);
    });

    overlay.querySelector("#_pgto-motoboys-confirmar").addEventListener("click", () => {
      const checks  = overlay.querySelectorAll('[data-role="pagar"]');
      const inputs  = overlay.querySelectorAll('[data-role="valor"]');
      const selects = overlay.querySelectorAll('[data-role="metodo"]');

      const resultado = [];
      inputs.forEach((inp, i) => {
        if (!checks[i]?.checked) return;
        const valor = parseFloat(inp.value) || 0;
        if (valor <= 0) return;
        resultado.push({
          motoboy_id: motoboys[i].motoboy_id,
          nome: motoboys[i].nome,
          valor,
          metodo: selects[i]?.value || "Efectivo",
        });
      });

      overlay.remove();
      resolve(resultado);
    });
  });
}

async function fecharCaixaResumo() {
  // ── Guard: existe sessão aberta? ────────────────────────────────
  if (!_sessaoCaixaAtiva) {
    alert("Nenhum caixa aberto para fechar.");
    return;
  }

  if (
    !confirm(
      "Fechar o caixa desta sessão?\nIsso encerra a sessão e registra o fechamento no histórico.",
    )
  )
    return;

  // ── 1. Captura dados da sessão ANTES de qualquer operação ────────
  const sessaoId      = _sessaoCaixaAtiva.id;
  const abertoEm      = _sessaoCaixaAtiva.aberto_em;
  const valorAbertura = Number(_sessaoCaixaAtiva.valor_abertura || 0);
  const emailAtual    = document.getElementById("user-email")?.innerText || "admin";
  const nomeAtual     = document.getElementById("user-nome-display")?.innerText || emailAtual;
  const fechadoEm     = new Date().toISOString();

  // ══════════════════════════════════════════════════════════════
  //  NOVO: modal de pagamento aos motoboys ANTES do cálculo.
  //  - retorna array (pode ser vazio = "pular")
  //  - retorna null se o operador cancelou o fechamento inteiro
  // ══════════════════════════════════════════════════════════════
  let pagamentosMotoboys = [];
  try {
    pagamentosMotoboys = await _abrirModalPagamentoMotoboys(
      sessaoId,
      abertoEm,
      fechadoEm,
    );
  } catch (e) {
    console.warn("[fecharCaixaResumo] Erro no modal motoboy:", e);
    pagamentosMotoboys = [];
  }

  if (pagamentosMotoboys === null) {
    console.log("[fecharCaixaResumo] Operador cancelou o fechamento.");
    return;
  }

  if (pagamentosMotoboys.length > 0) {
    await _inserirPagamentosMotoboys(pagamentosMotoboys, sessaoId);
  }

  // ── 2. Feedback visual durante o cálculo ────────────────────────
  const _btnFechar = document.querySelector('[onclick="fecharCaixaResumo()"]');
  const _textOrigBtn = _btnFechar ? _btnFechar.innerHTML : "";
  if (_btnFechar) {
    _btnFechar.disabled = true;
    _btnFechar.innerHTML = "⏳ Calculando fechamento...";
    _btnFechar.style.opacity = "0.65";
  }

  const fmt = (n) => "Gs " + Math.round(n).toLocaleString("es-PY");

  try {
    // ── 3. Recalcula tudo do banco (fonte autoritativa) ───────────
    const r = await _calcularResumoSessao(sessaoId, abertoEm, fechadoEm);

    // ── 4. Salva snapshot em caixa_fechamentos ────────────────────
    const detalhesJSON = {
      gerado_por: "admin.js:fecharCaixaResumo",
      versao:     "1.1",
      calculo:    "view_vw_sessao_resumo + ajuste_frete",
      motoboy_pagamentos: pagamentosMotoboys.map((p) => ({
        nome: p.nome, valor: p.valor, metodo: p.metodo,
      })),
    };

    const { error: errSnap } = await supa
      .from("caixa_fechamentos")
      .insert([{
        sessao_id:          sessaoId,
        usuario_email:      emailAtual,
        usuario_nome:       nomeAtual,
        aberto_em:          abertoEm,
        fechado_em:         fechadoEm,
        valor_abertura:     valorAbertura,
        faturamento:        r.faturamento,
        qtd_pedidos:        r.qtd_pedidos,
        custo_entregas:     r.custo_entregas,
        total_despesas:     r.total_despesas,
        total_sangrias:     r.total_sangrias,
        total_suprimentos:  r.total_suprimentos,
        lucro_operacional:  r.lucro_operacional,
        dinheiro_gaveta:    r.dinheiro_gaveta,
        total_efetivo:      r.total_efetivo,
        total_pix:          r.total_pix,
        total_cartao:       r.total_cartao,
        total_cartao_br:    r.total_cartao_br,
        total_transferencia:r.total_transferencia,
        total_qr_py:        r.total_qr_py,
        total_multi_outros: r.total_multi_outros,
        detalhes:           detalhesJSON,
      }]);

    if (errSnap) {
      console.error("[fecharCaixaResumo] Erro ao salvar snapshot:", errSnap.message);
      alert(
        "⚠️ Sessão será fechada, mas não foi possível salvar o snapshot do fechamento:\n\n" +
        errSnap.message +
        "\n\nVerifique se a migration SQL da tabela caixa_fechamentos foi executada."
      );
    }

    // ── 5. Marca a sessão como fechada em sessoes_caixa ───────────
    const { error: errSess } = await supa
      .from("sessoes_caixa")
      .update({
        fechado_em:       fechadoEm,
        valor_fechamento: r.lucro_operacional,
        observacao:
          `Fat: ${fmt(r.faturamento)} | Res: ${fmt(r.lucro_operacional)}`,
      })
      .eq("id", sessaoId);

    if (errSess) {
      console.error("[fecharCaixaResumo] Erro ao fechar sessão:", errSess.message);
      alert("❌ Não foi possível fechar a sessão: " + errSess.message);
      return;
    }

    // ── 6. Registra movimentação de fechamento ────────────────────
    await supa
      .from("movimentacoes_caixa")
      .insert([{
        tipo:          "fechamento",
        valor:         r.lucro_operacional,
        descricao:
          `Fechamento ${new Date().toLocaleDateString("pt-BR")} | Fat: ${fmt(r.faturamento)} | Res: ${fmt(r.lucro_operacional)}`,
        usuario_email: emailAtual,
        sessao_id:     sessaoId,
      }]);

    // ── 7. Modal de fechamento com botão de impressão explícito ───
    _mostrarModalFechamentoCaixa({
      sessao_id:           sessaoId,
      usuario_email:       emailAtual,
      usuario_nome:        nomeAtual,
      aberto_em:           abertoEm,
      fechado_em:          fechadoEm,
      valor_abertura:      valorAbertura,
      faturamento:         r.faturamento,
      frete_cobrado:       r.frete_cobrado,
      frete_em_especie:    r.frete_em_especie,
      qtd_pedidos:         r.qtd_pedidos,
      custo_entregas:      r.custo_entregas,
      total_despesas:      r.total_despesas,
      total_sangrias:      r.total_sangrias,
      total_suprimentos:   r.total_suprimentos,
      lucro_operacional:   r.lucro_operacional,
      dinheiro_gaveta:     r.dinheiro_gaveta,
      total_efetivo:       r.total_efetivo,
      total_pix:           r.total_pix,
      total_cartao:        r.total_cartao,
      total_cartao_br:     r.total_cartao_br,
      total_transferencia: r.total_transferencia,
      total_qr_py:         r.total_qr_py,
      total_multi_outros:  r.total_multi_outros,
      motoboy_pagamentos:  pagamentosMotoboys,
    });

    // ── 8. Limpa estado local e atualiza UI ───────────────────────
    _sessaoCaixaAtiva = null;

    [
      "card-faturamento",
      "card-custo-moto",
      "card-lucro",
      "card-lucro-vendas",
      "total-pix",
      "total-transf",
      "total-cartao",
      "total-efetivo",
      "card-ticket-medio",
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.innerText = "Gs 0";
    });
    const _clvPctReset = document.getElementById("card-lucro-vendas-pct");
    if (_clvPctReset) {
      _clvPctReset.textContent = "—";
      _clvPctReset.style.color = "";
    }
    const qEl = document.getElementById("card-qtd-pedidos");
    if (qEl) qEl.innerText = "0";

    _caixaState = {
      faturamento: 0,
      custoEntregas: 0,
      totalSaidas: 0,
      totalEntradas: 0,
      totalPix: 0,
      totalTransf: 0,
      totalCartao: 0,
      totalEfetivo: 0,
      totalQrPy: 0,
      totalCartaoBR: 0,
      totalMultiOutros: 0,
      qtdPedidos: 0,
      lucroBrutoVendas: 0,
      markupMedioVendas: null,
    };

    // Atualiza indicadores globais
    const elStatusGlobal = document.getElementById("status-sessao-caixa");
    if (elStatusGlobal) {
      elStatusGlobal.innerHTML =
        `<span style="color:#e74c3c">🔴 Nenhum caixa aberto</span>`;
    }
    _pdvAtualizarPainelCaixa();

    // Recarrega o financeiro
    await calcularFinanceiro();

  } catch (e) {
    console.error("[fecharCaixaResumo] Erro inesperado:", e);
    alert("❌ Erro inesperado ao fechar caixa: " + e.message);
  } finally {
    if (_btnFechar) {
      _btnFechar.disabled = false;
      _btnFechar.innerHTML = _textOrigBtn;
      _btnFechar.style.opacity = "1";
    }
  }
}

/**
 * Insere os pagamentos aos motoboys como despesas na sessão.
 * Guarda o método de pagamento em `descricao_outro` (compatível com o
 * schema atual — não exige ALTER TABLE).
 */
async function _inserirPagamentosMotoboys(pagamentos, sessaoId) {
  if (!pagamentos?.length) return;

  const emailAtual = document.getElementById("user-email")?.innerText || "sistema";
  const rows = pagamentos.map((p) => ({
    tipo:             "despesa",
    valor:            p.valor,
    descricao:        `Pagamento Motoboy — ${p.nome}`,
    usuario_email:    emailAtual,
    tipo_despesa:     "motoboy",
    descricao_outro:  p.metodo, // guarda a forma de pagamento
    sessao_id:        sessaoId,
  }));

  const { error } = await supa.from("movimentacoes_caixa").insert(rows);
  if (error) {
    console.error("[Motoboy] Erro ao inserir despesas:", error);
    alert("⚠️ Não foi possível registrar os pagamentos aos motoboys:\n" + error.message);
    return;
  }
  console.log(`✅ ${pagamentos.length} pagamento(s) de motoboy registrado(s).`);
}

/* ══════════════════════════════════════════════════════════════
   MODAL DE FECHAMENTO DE CAIXA
   Substitui o antigo alert() + confirm() no fim de fecharCaixaResumo().
   Motivo: o confirm() disparado logo após um alert() muito longo era
   auto-descartado por alguns navegadores, e o window.open() que vinha
   depois perdia o "user gesture context" — o popup blocker matava a
   janela de impressão silenciosamente.

   Aqui o operador CLICA no botão "Imprimir Boletim", o que restaura
   o user gesture e faz o window.open() abrir 100% das vezes.
   ══════════════════════════════════════════════════════════════ */
function _mostrarModalFechamentoCaixa(f) {
  document.getElementById("_modal-fechamento")?.remove();

  const fmt = (n) => "Gs " + Math.round(Number(n) || 0).toLocaleString("es-PY");
  const fmtDt = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Asuncion",
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  };
  const linha = (label, valor, cor) =>
    `<div style="display:flex;justify-content:space-between;font-size:0.85rem;color:${cor || "#555"};padding:3px 0">
       <span>${label}</span>
       <span style="font-weight:600;color:${cor || "#334155"}">${fmt(valor)}</span>
     </div>`;

  // ── Bloco de pagamentos aos motoboys (se registrados) ─────────
  const pagamentos = Array.isArray(f.motoboy_pagamentos) ? f.motoboy_pagamentos : [];
  let motoboyBloco = "";
  if (pagamentos.length > 0) {
    const itens = pagamentos.map((p) => {
      const iconPgto = {
        Efectivo: "💵", Pix: "🟢", Transferencia: "🏦",
        Cartao: "💳", QrPy: "📱", Outro: "✏️",
      }[p.metodo] || "💰";
      const nomeEsc = String(p.nome).replace(/</g, "&lt;");
      return `<div style="display:flex;justify-content:space-between;font-size:0.82rem;color:#475569;padding:3px 0">
        <span>${iconPgto} ${nomeEsc} <span style="color:#94a3b8;font-size:0.75rem">(${p.metodo})</span></span>
        <span style="font-weight:700;color:#1e40af">${fmt(p.valor)}</span>
      </div>`;
    }).join("");

    const totalPag = pagamentos.reduce((a, p) => a + (Number(p.valor) || 0), 0);
    const totalEfet = pagamentos
      .filter((p) => (p.metodo || "").toLowerCase().includes("efetivo"))
      .reduce((a, p) => a + (Number(p.valor) || 0), 0);

    motoboyBloco = `
      <div style="background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:10px;padding:12px 14px;margin-bottom:16px">
        <div style="font-size:0.75rem;font-weight:700;color:#1e40af;text-transform:uppercase;
             letter-spacing:0.5px;margin-bottom:8px">
          🏍️ Pagamento aos Motoboys
        </div>
        ${itens}
        <div style="display:flex;justify-content:space-between;font-size:0.88rem;font-weight:800;
             color:#1e3a8a;padding-top:8px;margin-top:6px;border-top:1px dashed #93c5fd">
          <span>Total pago</span>
          <span>${fmt(totalPag)}</span>
        </div>
        ${totalEfet > 0
          ? `<div style="display:flex;justify-content:space-between;font-size:0.78rem;
               color:#dc2626;margin-top:4px">
               <span>💵 Saído da gaveta (efectivo)</span>
               <span style="font-weight:700">${fmt(totalEfet)}</span>
             </div>`
          : ""}
      </div>`;
  }

  const overlay = document.createElement("div");
  overlay.id = "_modal-fechamento";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:99999;" +
    "display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto";

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:18px;max-width:480px;width:100%;max-height:92vh;
                overflow:hidden;display:flex;flex-direction:column;
                box-shadow:0 24px 80px rgba(0,0,0,0.4)">
      <div style="background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;padding:20px 24px;text-align:center">
        <div style="font-size:2.2rem;margin-bottom:4px">✅</div>
        <div style="font-size:1.15rem;font-weight:800">Caixa Fechado!</div>
        <div style="font-size:0.82rem;opacity:0.9;margin-top:4px">Sessão #${f.sessao_id}</div>
      </div>

      <div style="padding:20px 24px;overflow-y:auto;flex:1">
        <div style="background:#f0f9ff;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:0.82rem;color:#0369a1">
          <b>Período:</b> ${fmtDt(f.aberto_em)} → ${fmtDt(f.fechado_em)}
        </div>

        <div style="margin-bottom:16px">
          <div style="font-size:0.78rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">
            💰 Receita da Loja
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.9rem;margin-bottom:4px">
            <span style="color:#555">Faturamento (sem frete)</span>
            <strong>${fmt(f.faturamento)}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;font-size:0.9rem">
            <span style="color:#555">📦 Pedidos</span>
            <strong>${f.qtd_pedidos}</strong>
          </div>
          ${(f.frete_cobrado || 0) > 0
            ? `<div style="display:flex;justify-content:space-between;font-size:0.82rem;margin-top:6px;padding-top:6px;border-top:1px dashed #e5e7eb;color:#94a3b8">
                 <span>🛵 Frete cobrado (repasse motoboy)</span>
                 <span style="font-weight:600">${fmt(f.frete_cobrado)}</span>
               </div>`
            : ""}
        </div>

        <div style="margin-bottom:16px">
          <div style="font-size:0.78rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">
            💳 Por Forma de Pagamento
          </div>
          ${linha("💵 Dinheiro", f.total_efetivo)}
          ${linha("📱 Pix", f.total_pix)}
          ${linha("💳 Cartão PY", f.total_cartao)}
          ${linha("💳 Cartão BR", f.total_cartao_br)}
          ${linha("🏦 Transferência", f.total_transferencia)}
          ${linha("📱 QR Paraguay", f.total_qr_py)}
          ${(f.total_multi_outros || 0) > 0 ? linha("🔀 Multi/Outros", f.total_multi_outros) : ""}
        </div>

        ${motoboyBloco}

        <div style="margin-bottom:16px">
          <div style="font-size:0.78rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">
            📋 Movimentações
          </div>
          ${linha("💸 Outras Despesas", f.total_despesas - (f.motoboy_total || 0))}
          ${linha("💸 Sangrias", f.total_sangrias)}
          ${linha("➕ Suprimentos", f.total_suprimentos)}
        </div>

        <div style="background:#f0fdf4;border:2px solid #86efac;border-radius:12px;padding:14px 16px;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;font-size:1rem;font-weight:800;color:#166534">
            <span>💵 Resultado Operacional</span>
            <span>${fmt(f.lucro_operacional)}</span>
          </div>
        </div>

        <div style="background:#fff7ed;border:2px solid #fdba74;border-radius:12px;padding:14px 16px">
          <div style="display:flex;justify-content:space-between;font-size:1rem;font-weight:800;color:#9a3412">
            <span>💰 Dinheiro na Gaveta</span>
            <span>${fmt(f.dinheiro_gaveta)}</span>
          </div>
        </div>
      </div>

      <div style="padding:16px 24px;display:flex;gap:10px;border-top:1px solid #f0f0f0;background:#fafafa">
        <button id="_btn-fechar-modal-fech"
          style="flex:1;padding:14px;background:#fff;color:#64748b;border:1.5px solid #e2e8f0;border-radius:10px;font-weight:700;font-size:0.9rem;cursor:pointer">
          Fechar
        </button>
        <button id="_btn-imprimir-fech"
          style="flex:2;padding:14px;background:linear-gradient(135deg,#1a7a2e,#145a22);color:#fff;border:none;border-radius:10px;font-weight:700;font-size:0.95rem;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;box-shadow:0 4px 14px rgba(26,122,46,0.35)">
          <i class="fas fa-print"></i> Imprimir Boletim
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.querySelector("#_btn-fechar-modal-fech").onclick = () => overlay.remove();
  overlay.querySelector("#_btn-imprimir-fech").onclick = () => {
    overlay.remove();
    _abrirJanelaImpressaoFechamento(f);
  };
}

// ══════════════════════════════════════════════════════════════
// HISTÓRICO DE BOLETINS DE FECHAMENTO DE CAIXA
// ══════════════════════════════════════════════════════════════

async function carregarHistoricoFechamentos() {
  const tbody    = document.getElementById("hist-fech-tbody");
  const contador = document.getElementById("hist-fech-contador");
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#aaa;padding:20px"><i class="fas fa-spinner fa-spin"></i> Carregando...</td></tr>';

  const { data, error } = await supa
    .from("caixa_fechamentos")
    .select("*")
    .order("fechado_em", { ascending: false })
    .limit(100);

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#e74c3c;padding:20px;font-size:0.85rem">
      Erro: ${error.message}<br>
      <small style="color:#888">Verifique se a tabela <code>caixa_fechamentos</code> existe no Supabase.</small>
    </td></tr>`;
    if (contador) contador.style.display = "none";
    return;
  }

  if (contador) {
    const n = (data || []).length;
    contador.textContent = `${n} boletim${n !== 1 ? "s" : ""}`;
    contador.style.display = n ? "inline" : "none";
  }

  if (!data || !data.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#bbb;padding:24px;font-size:0.85rem">Nenhum fechamento registrado ainda.</td></tr>';
    return;
  }

  const fmt = (n) => "Gs " + Math.round(Number(n) || 0).toLocaleString("es-PY");
  const fmtDt = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Asuncion",
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
  };

  tbody.innerHTML = data.map((f) => `
    <tr>
      <td style="font-weight:700;color:#1a1a2e">#${f.sessao_id}</td>
      <td style="font-size:0.78rem;color:#666;white-space:nowrap">
        ${fmtDt(f.aberto_em)}<br>
        <span style="color:#aaa">→ ${fmtDt(f.fechado_em)}</span>
      </td>
      <td style="font-size:0.82rem">
        ${f.usuario_nome || "—"}<br>
        <small style="color:#999">${f.usuario_email || ""}</small>
      </td>
      <td style="text-align:right;font-weight:600">${fmt(f.faturamento)}</td>
      <td style="text-align:right;font-weight:700;color:${(f.lucro_operacional || 0) >= 0 ? "#16a34a" : "#dc2626"}">
        ${fmt(f.lucro_operacional)}
      </td>
      <td style="text-align:right;font-weight:600">${fmt(f.dinheiro_gaveta)}</td>
      <td style="text-align:center;white-space:nowrap">
        <button onclick="imprimirFechamento(${f.id})"
          style="background:#1a7a2e;color:#fff;border:none;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:0.78rem;font-weight:700;display:inline-flex;align-items:center;gap:4px">
          <i class="fas fa-print"></i> Imprimir
        </button>
      </td>
    </tr>
  `).join("");
}

async function imprimirFechamento(id) {
  const { data, error } = await supa
    .from("caixa_fechamentos")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    alert("Erro ao buscar boletim: " + (error?.message || "não encontrado"));
    return;
  }
  _abrirJanelaImpressaoFechamento(data);
}

function _abrirJanelaImpressaoFechamento(f) {
  const win = window.open("", "_blank", "width=520,height=800");
  if (!win) {
    alert("Permita pop-ups neste site para imprimir o boletim.");
    return;
  }
  win.document.open();
  win.document.write(_gerarHtmlFechamentoTermico(f));
  win.document.close();
  setTimeout(() => {
    try { win.focus(); win.print(); } catch (_) {}
  }, 700);
}

function _gerarHtmlFechamentoTermico(f) {
  const fmtGs = (n) => "Gs " + Math.round(Number(n) || 0).toLocaleString("es-PY");
  const fmtDt = (iso) => {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/Asuncion",
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  };
  const nomeLoja = (typeof NOME_RESTAURANTE !== "undefined" && NOME_RESTAURANTE) ? NOME_RESTAURANTE : "LOJA";
  const impressoEm = new Date().toLocaleString("pt-BR", { timeZone: "America/Asuncion" });

  const linha = (label, valor, bold) =>
    `<div class="linha"${bold ? ' style="font-weight:700"' : ""}><span>${label}</span><span>${valor}</span></div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>Boletim de Fechamento — Sessão #${f.sessao_id}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, sans-serif; font-size:12px; color:#000; background:#d0d0d0; padding:16px; }
  .ticket { background:#fff; max-width:300px; margin:0 auto; padding:10px; box-shadow:0 4px 12px rgba(0,0,0,0.2); color:#000; }
  .topo { text-align:center; margin-bottom:6px; }
  .topo h2 { font-size:15px; font-weight:900; letter-spacing:0.5px; color:#000; }
  .topo h3 { font-size:12px; font-weight:700; margin-top:2px; color:#000; }
  .topo small { font-size:10px; color:#000; }
  .bloco { font-size:12px; line-height:1.5; color:#000; }
  .bloco-title { font-weight:800; font-size:11px; letter-spacing:0.5px; padding:3px 0; color:#000; text-transform:uppercase; }
  .linha { display:flex; justify-content:space-between; padding:2px 0; color:#000; }
  .sep { border-top:1px dashed #000; margin:6px 0; }
  .sep-dup { border-top:2px solid #000; margin:6px 0; }
  .assinatura { margin-top:20px; text-align:center; font-size:11px; color:#000; }
  .assinatura .linha-ass { border-top:1px solid #000; width:80%; margin:24px auto 4px; }
  .rodape { text-align:center; font-size:10px; color:#000; margin-top:8px; }
  .btn-print { display:block; width:100%; max-width:300px; margin:16px auto 0; padding:14px; background:#1a7a2e; color:#fff; border:none; font-size:15px; font-weight:700; cursor:pointer; border-radius:8px; font-family:Arial, sans-serif; }
  @media print {
    body { background:none; padding:0; font-size:12px; }
    .btn-print { display:none; }
    .ticket { box-shadow:none; max-width:100%; width:100%; padding:2mm; }
    @page { margin:2mm; size:80mm auto; }
    * { color:#000 !important; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  }
</style>
</head>
<body>
  <div class="ticket">
    <div class="topo">
      <h2>${nomeLoja.toUpperCase()}</h2>
      <h3>BOLETIM DE FECHAMENTO</h3>
      <small>Sessão #${f.sessao_id}</small>
    </div>

    <div class="sep-dup"></div>

    <div class="bloco">
      <div class="linha"><span>Operador:</span><span>${f.usuario_nome || "—"}</span></div>
      <div class="linha"><span>E-mail:</span><span style="font-size:10px">${f.usuario_email || "—"}</span></div>
      <div class="linha"><span>Aberto:</span><span>${fmtDt(f.aberto_em)}</span></div>
      <div class="linha"><span>Fechado:</span><span>${fmtDt(f.fechado_em)}</span></div>
    </div>

    <div class="sep"></div>
    <div class="bloco-title">Resumo de Vendas</div>
    <div class="bloco">
      ${linha("Faturamento total:", fmtGs(f.faturamento), true)}
      ${linha("Pedidos:", (f.qtd_pedidos || 0).toString())}
    </div>

    <div class="sep"></div>
    <div class="bloco-title">Por Forma de Pagamento</div>
    <div class="bloco">
      ${linha("Dinheiro:", fmtGs(f.total_efetivo))}
      ${linha("Pix:", fmtGs(f.total_pix))}
      ${linha("Cartão PY:", fmtGs(f.total_cartao))}
      ${linha("Cartão BR:", fmtGs(f.total_cartao_br))}
      ${linha("Transferência:", fmtGs(f.total_transferencia))}
      ${linha("QR Paraguay:", fmtGs(f.total_qr_py))}
      ${(f.total_multi_outros || 0) > 0 ? linha("Multi/Outros:", fmtGs(f.total_multi_outros)) : ""}
    </div>

    <div class="sep"></div>
    <div class="bloco-title">Movimentações de Caixa</div>
    <div class="bloco">
      ${linha("Abertura:", fmtGs(f.valor_abertura))}
      ${linha("Suprimentos:", fmtGs(f.total_suprimentos))}
      ${linha("Despesas:", "- " + fmtGs(f.total_despesas))}
      ${linha("Sangrias:", "- " + fmtGs(f.total_sangrias))}
      ${linha("Custo entregas:", "- " + fmtGs(f.custo_entregas))}
    </div>

    <div class="sep-dup"></div>
    <div class="bloco-title">Resultado</div>
    <div class="bloco" style="font-size:13px">
      ${linha("Lucro operacional:", fmtGs(f.lucro_operacional), true)}
      ${linha("Dinheiro na gaveta:", fmtGs(f.dinheiro_gaveta), true)}
    </div>

    <div class="sep-dup"></div>

    <div class="assinatura">
      <div class="linha-ass"></div>
      Assinatura do Operador
    </div>

    <div class="rodape">Impresso em: ${impressoEm}</div>
  </div>

  <button class="btn-print" onclick="window.print()">🖨️ IMPRIMIR</button>
</body>
</html>`;
}

// =========================================
// EXPORTAÇÕES: CSV (Power BI) e PDF
// =========================================

async function _buscarDadosRelatorio() {
  const elI = document.getElementById("fin-inicio");
  const elF = document.getElementById("fin-fim");
  const hoje = new Date().toISOString().split("T")[0];
  const ini = (elI?.value || hoje) + "T00:00:00";
  const fim = (elF?.value || hoje) + "T23:59:59";
  const { data } = await supa
    .from("pedidos")
    .select("*")
    .in("status", ["entregue", "em_preparo", "pronto_entrega", "saiu_entrega"])
    .gte("created_at", ini)
    .lte("created_at", fim);
  return data || [];
}

// ── CSV rico para Power BI ────────────────────────────────
async function exportarCSVPowerBI() {
  const pedidos = await _buscarDadosRelatorio();
  if (!pedidos.length) {
    alert("Nenhum pedido no período.");
    return;
  }

  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const cols = [
    "id",
    "uid_temporal",
    "status",
    "tipo_entrega",
    "created_at",
    "cliente_nome",
    "cliente_telefone",
    "endereco_entrega",
    "forma_pagamento",
    "obs_pagamento",
    "subtotal",
    "desconto_cupom",
    "frete_cobrado_cliente",
    "total_geral",
    "cupom_codigo",
    "frete_motoboy",
    "garcom_nome",
    "tempo_recebido",
    "tempo_confirmado",
    "tempo_preparo_iniciado",
    "tempo_pronto",
    "tempo_saiu_entrega",
    "tempo_entregue",
    "itens_qtd",
    "itens_nomes",
    "ruc_factura",
    "razao_factura",
  ];

  const rows = pedidos.map((p) => {
    const itens = Array.isArray(p.itens) ? p.itens : [];
    const itensQtd = itens.reduce((a, i) => a + (i.qtd || i.q || 1), 0);
    const itensNomes = itens
      .map((i) => `${i.qtd || i.q || 1}x ${i.nome || i.n}`)
      .join(" | ");
    const f = p.dados_factura || {};
    return [
      p.id,
      p.uid_temporal || "",
      p.status,
      p.tipo_entrega,
      p.created_at ? new Date(p.created_at).toLocaleString("pt-BR") : "",
      p.cliente_nome || "",
      p.cliente_telefone || "",
      p.endereco_entrega || "",
      p.forma_pagamento || "",
      p.obs_pagamento || "",
      p.subtotal || 0,
      p.desconto_cupom || 0,
      p.frete_cobrado_cliente || 0,
      p.total_geral || 0,
      p.cupom_codigo || "",
      p.frete_motoboy || 0,
      p.garcom_nome || "",
      p.tempo_recebido || "",
      p.tempo_confirmado || "",
      p.tempo_preparo_iniciado || "",
      p.tempo_pronto || "",
      p.tempo_saiu_entrega || "",
      p.tempo_entregue || "",
      itensQtd,
      itensNomes,
      f.ruc || f.ci || "",
      f.razao || "",
    ]
      .map(escape)
      .join(",");
  });

  const csv = "\uFEFF" + cols.join(",") + "\n" + rows.join("\n"); // BOM para Excel/PBI
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const hoje = new Date().toISOString().split("T")[0];
  a.href = url;
  a.download = `relatorio_${hoje}_powerbi.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  alert(t("alert.csv_exportado") + ` (${pedidos.length} pedidos)`);
}

// ── PDF via janela de impressão ───────────────────────────
async function exportarPDF() {
  const pedidos = await _buscarDadosRelatorio();
  if (!pedidos.length) {
    alert("Nenhum pedido no período.");
    return;
  }

  const elI = document.getElementById("fin-inicio");
  const elF = document.getElementById("fin-fim");
  const hoje = new Date().toISOString().split("T")[0];
  const periodoLabel = `${elI?.value || hoje} a ${elF?.value || hoje}`;

  const fmt = (n) => "Gs " + (n || 0).toLocaleString("es-PY");
  const total = pedidos.reduce((a, p) => a + (p.total_geral || 0), 0);

  // Reutiliza a mesma lógica de classificação do calcularFinanceiro
  let totalPix = 0, totalEfet = 0, totalCard = 0, totalTransf = 0,
      totalQrPy = 0, totalCartaoBR = 0, totalMulti = 0;
  pedidos.forEach((p) => {
    const pag = (p.forma_pagamento || "").toLowerCase();
    const obsPag = p.obs_pagamento || "";
    const val = p.total_geral || 0;
    if (pag === "multipagamento" && obsPag) {
      try {
        const partes = JSON.parse(obsPag);
        if (Array.isArray(partes)) {
          partes.forEach((parte) => {
            const pf = (parte.metodo || parte.forma || "").toLowerCase();
            const pv = Number(parte.valor) || 0;
            if (pf.includes("pix"))                                   totalPix     += pv;
            else if (pf.includes("transfer"))                         totalTransf  += pv;
            else if (pf.includes("qrpy") || pf.includes("qr"))       totalQrPy    += pv;
            else if (pf.includes("cartaobr") || pf.includes("br"))   totalCartaoBR+= pv;
            else if (pf.includes("cartao") || pf.includes("cartão")) totalCard    += pv;
            else                                                       totalEfet   += pv;
          });
        } else { totalMulti += val; }
      } catch (_) { totalMulti += val; }
    } else if (pag.includes("pix"))                                   totalPix     += val;
    else if (pag.includes("transfer") || pag.includes("alias"))      totalTransf  += val;
    else if (pag === "qrpy")                                          totalQrPy    += val;
    else if (pag === "cartaobr")                                      totalCartaoBR+= val;
    else if (pag.includes("cart"))                                    totalCard    += val;
    else if (pag.includes("efetivo") || pag.includes("dinheiro"))    totalEfet    += val;
    else                                                              totalMulti   += val;
  });

  const rows = pedidos
    .map((p) => {
      const tz = { timeZone: "America/Asuncion" };
      const hora = new Date(p.created_at).toLocaleString("pt-BR", tz);
      const itens = (Array.isArray(p.itens) ? p.itens : [])
        .map((i) => `${i.qtd || i.q || 1}x ${i.nome || i.n}`)
        .join(", ");
      return `<tr>
      <td>${p.uid_temporal || "#" + p.id}</td>
      <td>${hora}</td>
      <td>${p.cliente_nome || "-"}</td>
      <td>${itens || "-"}</td>
      <td>${p.forma_pagamento || "-"}</td>
      <td style="text-align:right">${fmt(p.total_geral)}</td>
    </tr>`;
    })
    .join("");

  const nomeRestaurante = NOME_RESTAURANTE || "Relatório";

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>Relatório ${periodoLabel}</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:Arial,sans-serif;font-size:11px;color:#111;padding:20px}
    h1{font-size:16px;margin-bottom:2px}
    .sub{font-size:11px;color:#666;margin-bottom:16px}
    .resumo{display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap}
    .card{background:#f5f5f5;border-radius:6px;padding:10px 16px;min-width:130px}
    .card .lbl{font-size:10px;color:#888;margin-bottom:3px}
    .card .val{font-size:14px;font-weight:700}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#1a7a2e;color:#fff;padding:6px 8px;text-align:left}
    td{padding:5px 8px;border-bottom:1px solid #eee}
    tr:nth-child(even) td{background:#f9f9f9}
    td:last-child{text-align:right;font-weight:600}
    .footer{margin-top:16px;font-size:10px;color:#888;text-align:center}
    @media print{body{padding:6px}@page{margin:8mm}}
  </style>
  </head><body>
  <h1>${nomeRestaurante} — Relatório Financeiro</h1>
  <div class="sub">Período: ${periodoLabel} &nbsp;|&nbsp; Gerado em: ${new Date().toLocaleString("pt-BR")}</div>
  <div class="resumo">
    <div class="card"><div class="lbl">Total Faturado</div><div class="val">${fmt(total)}</div></div>
    <div class="card"><div class="lbl">Pedidos</div><div class="val">${pedidos.length}</div></div>
    <div class="card"><div class="lbl">Ticket Médio</div><div class="val">${fmt(pedidos.length ? Math.round(total / pedidos.length) : 0)}</div></div>
    <div class="card"><div class="lbl">Pix</div><div class="val">${fmt(totalPix)}</div></div>
    <div class="card"><div class="lbl">Dinheiro</div><div class="val">${fmt(totalEfet)}</div></div>
    <div class="card"><div class="lbl">Cartão PY</div><div class="val">${fmt(totalCard)}</div></div>
    <div class="card"><div class="lbl">Cartão BR</div><div class="val">${fmt(totalCartaoBR)}</div></div>
    <div class="card"><div class="lbl">Transferência</div><div class="val">${fmt(totalTransf)}</div></div>
    <div class="card"><div class="lbl">QR Paraguay</div><div class="val">${fmt(totalQrPy)}</div></div>
    ${totalMulti > 0 ? `<div class="card"><div class="lbl">Multi/Outros</div><div class="val">${fmt(totalMulti)}</div></div>` : ""}
  </div>
  <table>
    <thead><tr><th>#</th><th>Data/Hora</th><th>Cliente</th><th>Itens</th><th>Pagamento</th><th>Total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">${nomeRestaurante} &nbsp;·&nbsp; ${new Date().toLocaleDateString("pt-BR")} &nbsp;·&nbsp; ${pedidos.length} registros</div>
  <script>window.onload=()=>window.print();<\/script>
  </body></html>`;

  const w = window.open("", "PDF", "width=900,height=700");
  w.document.write(html);
  w.document.close();
}

// =========================================
// 7. ZAP & ROTA
// =========================================
function enviarRotaZap() {
  const checks = document.querySelectorAll(".check-pedido:checked");
  const selMoto = document.getElementById("sel-motoboy");

  if (checks.length === 0 || !selMoto.value)
    return alert(t("alert.sel_pedidos_moto"));

  // Pega dados do motoboy selecionado
  const opt = selMoto.options[selMoto.selectedIndex];
  // Fallback: se não tiver dataset, tenta pegar do texto
  const nomeMoto = opt.dataset.nome || opt.text;
  const telMoto = opt.dataset.tel || ""; // Importante ter o telefone no value ou dataset

  let msg = `🛵 *ROTA - ${nomeMoto.toUpperCase()}*\n\n`;
  let coords = [];
  let taxaTotal = 0;

  checks.forEach((chk) => {
    try {
      // Agora 'p' tem o objeto COMPLETO do banco
      const p = JSON.parse(decodeURIComponent(chk.value));

      // Atualiza status no banco para "saiu_entrega" ou "entregue"
      supa
        .from("pedidos")
        .update({ status: "saiu_entrega", motoboy_id: selMoto.value })
        .eq("id", p.id)
        .then();

      msg += `📦 *PEDIDO #${p.uid_temporal || p.id}*\n`;
      msg += `👤 ${p.cliente_nome || "Cliente"} | 📞 ${p.cliente_telefone || ""}\n`;

      if (p.itens && Array.isArray(p.itens)) {
        // Separa bebidas (para levar imediatamente) do restante
        const _esBebida = (i) => {
          if (i.es_bebida) return true;
          const cat = (i.categoria_slug || i.cat || "").toLowerCase();
          const _SLUGS_BEBIDA = [
            "bebida",
            "bebidas",
            "drink",
            "drinks",
            "refrigerante",
            "refrigerantes",
            "gaseosa",
            "gaseosas",
            "suco",
            "sucos",
            "jugo",
            "jugos",
            "cerveja",
            "cervejas",
            "cerveza",
            "cervezas",
            "trago",
            "tragos",
            "licor",
            "licores",
            "agua",
            "aguas",
            "água",
            "águas",
            "vino",
            "vinos",
            "vinho",
            "vinhos",
          ];
          return _SLUGS_BEBIDA.some((s) => cat === s || cat.includes(s));
        };
        const bebidas = p.itens.filter(_esBebida);
        const naoFoodKds = p.itens.filter((i) => !_esBebida(i));

        // Helper: formata um item com variação + montagem
        const _fmtItem = (b) => {
          let txt = `${b.qtd || b.q || 1}x ${b.nome || b.n}`;
          const v = b.variacao || b.t || "";
          if (v) txt += ` (${v})`;
          const mont = b.montagem || b.m || [];
          if (Array.isArray(mont) && mont.length) {
            const itensStr = mont
              .map((x) => (typeof x === "object" ? x.nome || "" : x))
              .filter(Boolean)
              .join(", ");
            if (itensStr) txt += ` [${itensStr}]`;
          }
          if (b.obs || b.o) txt += ` ⚠ ${b.obs || b.o}`;
          return txt;
        };

        if (bebidas.length > 0) {
          const lista = bebidas.map(_fmtItem).join(", ");
          msg += `🥤 *LEVAR:* ${lista}\n`;
        }
        // Nota sobre outros itens (já ficam na cozinha, info útil para motoboy saber o que pegar)
        if (naoFoodKds.length > 0) {
          msg += `📦 *Itens:* ` + naoFoodKds.map(_fmtItem).join(" | ") + `\n`;
        }
      }

      // LÓGICA DE MAPA
      if (p.geo_lat && p.geo_lng) {
        const link = `https://www.google.com/maps/search/?api=1&query=${p.geo_lat},${p.geo_lng}`;
        msg += `📍 ${link}\n`;
        coords.push(`${p.geo_lat},${p.geo_lng}`);
      } else {
        msg += `🏠 ${p.endereco_entrega || "Retirada"}\n`;
      }

      // LÓGICA DE PAGAMENTO
      const forma = (p.forma_pagamento || "").toLowerCase();
      const totalGeral = p.total_geral || 0;
      const totalFmt = totalGeral.toLocaleString("es-PY");

      if (
        forma.includes("pix") ||
        forma.includes("transfer") ||
        forma.includes("alias")
      ) {
        msg += `✅ *PAGO (Pix/Transf)*\n`;
      } else if (
        forma.includes("cartao") ||
        forma.includes("credito") ||
        forma.includes("debito")
      ) {
        msg += `💳 *Cobrar Cartão: Gs ${totalFmt}*\n`;
      } else {
        msg += `💰 *COBRAR: Gs ${totalFmt}*\n`;

        const obsPag = p.obs_pagamento || "";
        const nums = obsPag.match(/\d+/g);
        if (nums) {
          let valorTroco = parseInt(nums.join(""));
          if (valorTroco < 1000) valorTroco *= 1000;
          if (valorTroco > totalGeral) {
            const devolver = valorTroco - totalGeral;
            msg += `🔄 Troco p/ ${valorTroco.toLocaleString()} (Levar Gs ${devolver.toLocaleString()})\n`;
          }
        }
        if (obsPag && !nums) msg += `⚠️ Obs: ${obsPag}\n`;
      }

      msg += `-----------------\n`;
      const _freteM = parseFloat(p.frete_motoboy);
      taxaTotal += isNaN(_freteM) ? TAXA_MOTOBOY || 0 : _freteM;
    } catch (e) {
      console.error("Erro ao processar pedido na rota:", e);
    }
  });

  // MAPA GERAL DA ROTA
  if (coords.length > 0) {
    // Usa coordenadas da loja se existirem, senão usa padrão
    const latLoja = typeof COORD_LOJA !== "undefined" ? COORD_LOJA.lat : "";
    const lngLoja = typeof COORD_LOJA !== "undefined" ? COORD_LOJA.lng : "";
    const rota = `https://www.google.com/maps/dir/${latLoja},${lngLoja}/${coords.join("/")}`;
    msg += `\n🗺️ *ROTA NO MAPA:*\n${rota}\n`;
  }

  msg += `\n🏍️ *Taxa Total: Gs ${taxaTotal.toLocaleString("es-PY")}*`;

  // Abre WhatsApp
  const foneDestino = telMoto || ""; // Se tiver numero no cadastro do motoboy
  window.open(
    `https://wa.me/${foneDestino}?text=${encodeURIComponent(msg)}`,
    "_blank",
  );

  // Recarrega a tela depois de um tempo para atualizar os status
  setTimeout(() => {
    if (typeof carregarPedidos === "function") carregarPedidos();
    if (typeof calcularFinanceiro === "function") calcularFinanceiro();
  }, 2000);
}

// =========================================
// 8. PRODUTOS E CRUD COMPLETO (RESTAURADO)
// =========================================
// Cache dos produtos para filtro local
let _todosProdutos = [];
let _produtosMap = {}; // mapa id→produto para onclick seguro sem JSON inline

// ══════════════════════════════════════════════════════════════
//  CÓDIGO DE BARRAS — Scanner (câmera) + Busca PDV
// ══════════════════════════════════════════════════════════════

/**
 * Abre o scanner de código de barras via câmera do dispositivo.
 * Usa a Barcode Detection API (nativa em Android/Chrome) com fallback
 * para input manual.
 */
async function abrirScannerBarcode() {
  const campo = document.getElementById("prod-codigo-barras");
  if (!campo) return;

  // ── Barcode Detection API (Chrome Android / Edge) ──────────
  if ("BarcodeDetector" in window) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });

      // Cria overlay de câmera
      const overlay = document.createElement("div");
      overlay.id = "_barcode-overlay";
      overlay.style.cssText = `
        position:fixed; inset:0; z-index:99999; background:#000;
        display:flex; flex-direction:column; align-items:center; justify-content:center;
        font-family:'Rubik',sans-serif;
      `;
      overlay.innerHTML = `
        <p style="color:#fff; font-size:0.9rem; margin-bottom:12px; opacity:0.8">
          📷 Aponte para o código de barras
        </p>
        <video id="_barcode-video" autoplay playsinline
          style="width:100%; max-width:420px; border-radius:12px; border:2px solid #22c55e"></video>
        <div style="width:100%; max-width:420px; height:3px; background:transparent; position:relative; margin-top:-50%; pointer-events:none">
          <div style="position:absolute; left:0; right:0; height:2px; background:#22c55e; opacity:0.8; animation:_scanLine 1.5s ease-in-out infinite alternate; top:0"></div>
        </div>
        <style>@keyframes _scanLine { from { top:0 } to { top:100px } }</style>
        <button onclick="document.getElementById('_barcode-overlay').remove(); window._barcodeStream?.getTracks().forEach(t=>t.stop())"
          style="margin-top:20px; padding:12px 28px; background:#ef4444; color:#fff; border:none;
                 border-radius:8px; font-size:0.9rem; font-weight:700; cursor:pointer">
          ✕ Cancelar
        </button>
      `;
      document.body.appendChild(overlay);

      const video = document.getElementById("_barcode-video");
      video.srcObject = stream;
      window._barcodeStream = stream;

      const detector = new BarcodeDetector({
        formats: [
          "ean_13",
          "ean_8",
          "upc_a",
          "upc_e",
          "code_128",
          "code_39",
          "qr_code",
        ],
      });

      const tick = async () => {
        if (!document.getElementById("_barcode-overlay")) return; // foi fechado
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0) {
            const code = barcodes[0].rawValue;
            campo.value = code;
            stream.getTracks().forEach((t) => t.stop());
            overlay.remove();
            // Feedback visual
            campo.style.borderColor = "#22c55e";
            setTimeout(() => (campo.style.borderColor = ""), 2000);
            // Tenta buscar produto existente com esse barcode
            await _verificarBarcodeExistente(code);
            return;
          }
        } catch (_) {}
        requestAnimationFrame(tick);
      };
      video.addEventListener("play", () => requestAnimationFrame(tick));
      return;
    } catch (err) {
      console.warn("[Barcode] Câmera negada ou API falhou:", err.message);
    }
  }

  // ── Fallback: prompt manual ────────────────────────────────
  const manual = prompt(
    "📷 Scanner não disponível.\nDigite ou cole o código de barras:",
  );
  if (manual?.trim()) {
    campo.value = manual.trim();
    await _verificarBarcodeExistente(manual.trim());
  }
}

/**
 * Avisa se o código já está cadastrado em outro produto.
 */
async function _verificarBarcodeExistente(codigo) {
  if (!codigo) return;
  const idAtual = document.getElementById("prod-id")?.value;
  const { data } = await supa
    .from("produtos")
    .select("id, nome")
    .eq("codigo_barras", codigo)
    .maybeSingle();

  if (data && String(data.id) !== String(idAtual)) {
    alert(
      `⚠️ Este código já pertence ao produto:\n"${data.nome}" (ID ${data.id})\n\nVerifique antes de salvar.`,
    );
  }
}

/**
 * Busca um produto pelo código de barras.
 * Usada pelo PDV quando um leitor USB/BT envia o código.
 * @param {string} codigo
 * @returns {Promise<object|null>}
 */
async function buscarProdutoPorBarcode(codigo) {
  if (!codigo?.trim()) return null;
  const { data, error } = await supa
    .from("produtos")
    .select("*")
    .eq("codigo_barras", codigo.trim())
    .eq("ativo", true)
    .maybeSingle();
  if (error) {
    console.error("[Barcode PDV]", error.message);
    return null;
  }
  return data;
}

// ── Listener global para leitor USB/Bluetooth no PDV ────────
// Leitores HID digitam o código + Enter rapidamente.
// Detectamos pela velocidade de entrada (< 50ms entre chars).
(function _initBarcodeListener() {
  let _buf = "",
    _last = 0;
  const PDV_TABS = ["pdv"]; // abas onde o listener é ativo

  document.addEventListener("keydown", async (e) => {
    // Só na aba PDV
    const abaAtiva = localStorage.getItem("app_lastTab");
    if (!PDV_TABS.includes(abaAtiva)) return;

    // Bloqueia se o foco estiver em qualquer input EXCETO o campo de busca do PDV
    // (o leitor USB pode colocar o foco em #pdv-busca ao digitar)
    // Se o foco está em QUALQUER input (inclusive #pdv-busca), o próprio
    // input cuida do Enter via pdvBuscaKeydown. Só o listener global age
    // quando o foco NÃO está em um campo de texto.
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    const now = Date.now();
    if (now - _last > 80) _buf = ""; // reset se demorou muito
    _last = now;

    if (e.key === "Enter" && _buf.length >= 6) {
      e.preventDefault();
      const produto = await buscarProdutoPorBarcode(_buf);
      if (produto) {
        if (_pdvF2Mode) {
          // Modo F2: apenas exibe o preço, NÃO adiciona ao carrinho
          _pdvMostrarToast(
            `🔍 ${produto.nome} — Gs ${produto.preco.toLocaleString("es-PY")}`,
            "#1565c0",
            3000,
          );
        } else {
          // Modo normal: adiciona ao carrinho
          if (typeof adicionarItemPDV === "function") adicionarItemPDV(produto);
          _pdvMostrarToast(`✅ ${produto.nome} adicionado!`, "#16a34a", 2000);
        }
      } else {
        _pdvMostrarToast(`❌ Código ${_buf} não encontrado`, "#ef4444", 2500);
      }
      _buf = "";
    } else if (e.key.length === 1) {
      _buf += e.key;
    }
  });
})();

// Retorna true se algum filtro do painel de produtos está ativo
function _ptFiltrosAtivos() {
  const cat = document.getElementById("pt-filtro-cat")?.value || "";
  const status = document.getElementById("pt-filtro-status")?.value || "";
  const estoque = document.getElementById("pt-filtro-estoque")?.value || "";
  const validade = document.getElementById("pt-filtro-validade")?.value || "";
  const destaque = document.getElementById("pt-filtro-destaque")?.value || "";
  const ordem = document.getElementById("pt-filtro-ordem")?.value || "nome_az";
  const busca = (
    document.getElementById("pt-filtro-busca-rapida")?.value || ""
  ).trim();
  const apenasEstoque = document
    .getElementById("pt-toggle-estoque")
    ?.classList.contains("on");
  return (
    cat ||
    status ||
    estoque ||
    validade ||
    destaque ||
    busca ||
    apenasEstoque ||
    (ordem && ordem !== "nome_az")
  );
}

async function carregarProdutos() {
  const { data } = await supa.from("produtos").select("*").order("nome");
  _todosProdutos = data || [];
  _produtosMap = {};
  _todosProdutos.forEach((p) => {
    _produtosMap[p.id] = p;
  });

  // Reaaplica filtros ativos se houver algum selecionado, senão renderiza tudo
  if (_ptFiltrosAtivos()) {
    ptAplicarFiltros();
  } else {
    renderizarCardsProdutos(_todosProdutos);
  }
  atualizarStatsProdutos(_todosProdutos);
  // Só recarrega o select de categorias se o modal de produto estiver fechado
  const modalAberto =
    document.getElementById("modal-produto")?.style.display === "flex";
  if (!modalAberto) carregarSelectCategorias();

  // Popula filtro de categoria na tela de produtos
  await ptPopularFiltroCategoria();

  // ── Alerta de estoque baixo (varejo) ──────────────────────
  veVerificarEstoqueBaixo(5);
  // ── Alerta de validade próxima (produtos) ─────────────────
  ptVerificarValidadeProdutos(7);
  // ── Fim alertas ────────────────────────────────────────────
}

function atualizarStatsProdutos(lista) {
  const total = lista.length;
  const estoqueTotal = lista.reduce((s, p) => s + (p.estoque_qtd || 0), 0);
  const zerados = lista.filter(
    (p) =>
      p.estoque_qtd !== null &&
      p.estoque_qtd !== undefined &&
      p.estoque_qtd <= 0,
  ).length;
  const destaques = lista.filter((p) => p.destaque).length;
  const el = (id) => document.getElementById(id);
  if (el("pt-stat-total")) el("pt-stat-total").textContent = total;
  if (el("pt-stat-estoque"))
    el("pt-stat-estoque").textContent =
      estoqueTotal.toLocaleString("es-PY") + " un";
  if (el("pt-stat-zerado")) el("pt-stat-zerado").textContent = zerados;
  if (el("pt-stat-destaque")) el("pt-stat-destaque").textContent = destaques;
}

function ptAplicarFiltros() {
  let lista = [..._todosProdutos];
  const cat = document.getElementById("pt-filtro-cat")?.value || "";
  const status = document.getElementById("pt-filtro-status")?.value || "";
  const estoque = document.getElementById("pt-filtro-estoque")?.value || "";
  const validade = document.getElementById("pt-filtro-validade")?.value || "";
  const destaque = document.getElementById("pt-filtro-destaque")?.value || "";
  const ordem = document.getElementById("pt-filtro-ordem")?.value || "nome_az";
  const busca = (
    document.getElementById("pt-filtro-busca-rapida")?.value || ""
  ).toLowerCase();
  const apenasEstoque = document
    .getElementById("pt-toggle-estoque")
    ?.classList.contains("on");

  if (cat) lista = lista.filter((p) => p.categoria_slug === cat);

  // Status ativo/pausado
  if (status === "ativo") lista = lista.filter((p) => p.ativo === true);
  if (status === "pausado") lista = lista.filter((p) => p.ativo === false);

  if (estoque === "em_estoque") lista = lista.filter((p) => p.estoque_qtd > 0);
  if (estoque === "zerado")
    lista = lista.filter((p) => p.estoque_qtd !== null && p.estoque_qtd <= 0);
  if (estoque === "sem_controle")
    lista = lista.filter(
      (p) => p.estoque_qtd === null || p.estoque_qtd === undefined,
    );
  if (destaque === "sim") lista = lista.filter((p) => p.destaque);
  if (destaque === "nao") lista = lista.filter((p) => !p.destaque);
  if (validade) {
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    lista = lista.filter((p) => {
      if (!p.data_validade) return false;
      const d = new Date(p.data_validade + "T00:00:00");
      const diff = Math.round((d - hoje) / 86400000);
      if (validade === "vencido") return diff < 0;
      if (validade === "proximo") return diff >= 0 && diff <= 3;
      if (validade === "ok") return diff > 3;
      return true;
    });
  }
  if (busca) {
    lista = lista.filter(
      (p) =>
        p.nome.toLowerCase().includes(busca) ||
        (p.categoria_slug || "").toLowerCase().includes(busca) ||
        String(p.id).includes(busca) ||
        (p.codigo_barras || "").toLowerCase().includes(busca),
    );
  }
  if (apenasEstoque) lista = lista.filter((p) => p.estoque_qtd > 0);
  lista.sort((a, b) => {
    if (ordem === "nome_az") return a.nome.localeCompare(b.nome);
    if (ordem === "nome_za") return b.nome.localeCompare(a.nome);
    if (ordem === "preco_asc") return (a.preco || 0) - (b.preco || 0);
    if (ordem === "preco_desc") return (b.preco || 0) - (a.preco || 0);
    if (ordem === "estoque_asc")
      return (a.estoque_qtd || 0) - (b.estoque_qtd || 0);
    if (ordem === "estoque_desc")
      return (b.estoque_qtd || 0) - (a.estoque_qtd || 0);
    return 0;
  });
  renderizarCardsProdutos(lista);
}

async function ptPopularFiltroCategoria() {
  const sel = document.getElementById("pt-filtro-cat");
  if (!sel) return;
  const valorAtual = sel.value;
  // Busca todas as categorias com ativo=true OU ativa=true (tabela tem os dois campos)
  const { data: cats, error } = await supa
    .from("categorias")
    .select("slug, nome_exibicao, ativo, ativa")
    .or("ativo.eq.true,ativa.eq.true")
    .order("ordem");
  if (error) {
    console.warn("[ptPopularFiltroCategoria]", error.message);
    return;
  }
  if (!cats || cats.length === 0) {
    console.warn("[ptPopularFiltroCategoria] Nenhuma categoria retornada");
    return;
  }
  sel.innerHTML = '<option value="">Todas as categorias</option>';
  cats.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.slug;
    opt.textContent = c.nome_exibicao;
    if (c.slug === valorAtual) opt.selected = true;
    sel.appendChild(opt);
  });
  console.log("[ptPopularFiltroCategoria] Categorias carregadas:", cats.length);
}

function ptLimparFiltros() {
  [
    "pt-filtro-cat",
    "pt-filtro-status",
    "pt-filtro-estoque",
    "pt-filtro-validade",
    "pt-filtro-destaque",
    "pt-filtro-busca-rapida",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const ordem = document.getElementById("pt-filtro-ordem");
  if (ordem) ordem.value = "nome_az";
  const toggle = document.getElementById("pt-toggle-estoque");
  if (toggle) toggle.classList.remove("on");
  ptBulkDesmarcarTodos();
  renderizarCardsProdutos(_todosProdutos);
}

function ptToggleApenasEstoque(btn) {
  btn.classList.toggle("on");
  ptAplicarFiltros();
}

function filtrarProdutos(termo) {
  if (!termo.trim()) {
    renderizarCardsProdutos(_todosProdutos);
    return;
  }
  const t = termo.toLowerCase();
  const filtrados = _todosProdutos.filter(
    (p) =>
      p.nome.toLowerCase().includes(t) ||
      (p.categoria_slug || "").toLowerCase().includes(t),
  );
  renderizarCardsProdutos(filtrados);
}

function renderizarCardsProdutos(lista) {
  const grid = document.getElementById("lista-produtos-grid");
  if (!grid) return;

  // ── Manage table header visibility ─────────────────────────
  const header = document.getElementById("produtos-table-header");

  // ── Barra de ações em massa ─────────────────────────────────
  let barraAcoes = document.getElementById("pt-bulk-actions-bar");
  if (!barraAcoes) {
    barraAcoes = document.createElement("div");
    barraAcoes.id = "pt-bulk-actions-bar";
    barraAcoes.style.cssText = `
      display:none; align-items:center; gap:10px; flex-wrap:wrap;
      background:#fff; border:1px solid #e2e8f0; border-radius:10px;
      padding:8px 14px; margin-bottom:8px;
      box-shadow:0 1px 4px rgba(0,0,0,0.06);
    `;
            barraAcoes.innerHTML = `
      <span id="pt-bulk-count" style="font-size:0.82rem;font-weight:700;color:#334155"></span>
      <button onclick="ptBulkPausar()" style="
        padding:6px 14px;background:#f97316;color:#fff;border:none;border-radius:7px;
        font-size:0.8rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px">
        <i class="fas fa-pause"></i> Pausar
      </button>
      <button onclick="ptBulkDespausar()" style="
        padding:6px 14px;background:#22c55e;color:#fff;border:none;border-radius:7px;
        font-size:0.8rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px">
        <i class="fas fa-play"></i> Despausar
      </button>
      <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;color:#64748b;font-weight:600">
        <i class="fas fa-ruler-horizontal" style="color:#94a3b8"></i>
        <select id="pt-bulk-label-width"
          onchange="_setLabelSize(this.value)"
          style="padding:5px 8px;border:1px solid #e2e8f0;border-radius:7px;font-size:0.78rem;background:#fff;color:#334155;cursor:pointer;font-weight:600">
          <option value="48">48 mm</option>
          <option value="58">58 mm</option>
          <option value="72">72 mm</option>
          <option value="80">80 mm</option>
        </select>
      </label>
      <button onclick="imprimirEtiquetasEmMassa()" style="
        padding:6px 14px;background:#2563eb;color:#fff;border:none;border-radius:7px;
        font-size:0.8rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px">
        <i class="fas fa-print"></i> Imprimir Etiquetas
      </button>
      <button onclick="ptBulkExcluir()" style="
        padding:6px 14px;background:#ef4444;color:#fff;border:none;border-radius:7px;
        font-size:0.8rem;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:5px">
        <i class="fas fa-trash"></i> Excluir
      </button>
      <button onclick="ptBulkDesmarcarTodos()" style="
        padding:6px 10px;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;border-radius:7px;
        font-size:0.8rem;cursor:pointer">
        ✕ Desmarcar todos
      </button>
    `;

    // Restaura a última largura escolhida pelo usuário
    const _selWidth = document.getElementById("pt-bulk-label-width");
    if (_selWidth) {
      _selWidth.value = String(
        localStorage.getItem(_LABEL_SIZE_STORAGE_KEY) || _LABEL_SIZE_DEFAULT,
      );
    }
    grid.parentNode.insertBefore(barraAcoes, grid);
  }

  grid.innerHTML = "";

  if (!lista || lista.length === 0) {
    if (header) header.style.display = "none";
    if (barraAcoes) barraAcoes.style.display = "none";
    grid.innerHTML =
      '<p style="color:#bbb;font-size:0.9rem;padding:20px 0">Nenhum produto encontrado.</p>';
    return;
  }
  if (header) {
    header.style.display = "";
  }

  const _TIPO_ICONS = {
    padrao: "📦",
    bebida: "🥤",
    lanche: "🍔",
    pizza: "🍕",
    acai: "🍇",
    shake: "🥤",
    suco: "🍊",
    sorvete: "🍦",
    montavel: "🥗",
    almoco: "🍽️",
    combo: "⭐",
  };

  lista.forEach((p) => {
    const cfg = p.montagem_config;
    let tipoKey = "padrao";
    if (cfg && !Array.isArray(cfg) && cfg.__tipo) tipoKey = cfg.__tipo;
    else if (p.e_montavel || (cfg && Array.isArray(cfg) && cfg.length > 0))
      tipoKey = "montavel";

    const tipoIcon = _TIPO_ICONS[tipoKey] || "📦";

    // ── Image ────────────────────────────────────────────────
    const imgHtml = p.imagem_url
      ? `<img src="${p.imagem_url}" alt="${p.nome}" loading="lazy" style="width:100%;height:100%;object-fit:cover;display:block">`
      : `<div class="produto-card-img-placeholder">${tipoIcon}</div>`;

    // ── Estoque ──────────────────────────────────────────────
    const semCtrl = p.estoque_qtd === null || p.estoque_qtd === undefined;
    const qtd = semCtrl ? "—" : p.estoque_qtd;
    const estoqueStatusClass = semCtrl
      ? ""
      : p.estoque_qtd > 0
        ? "estoque-ok"
        : "estoque-zero";
    const estoqueStatusLabel = semCtrl
      ? ""
      : p.estoque_qtd > 0
        ? "Em estoque"
        : "Sem estoque";
    const estoqueBadge = semCtrl
      ? `<span class="produto-card-estoque-qty">—</span>`
      : `<span class="produto-card-estoque-qty">${qtd} un</span>
         <span class="produto-card-estoque-status ${estoqueStatusClass}">${estoqueStatusLabel}</span>`;

    // ── Validade ─────────────────────────────────────────────
    let validadeHtml = `<span style="color:#cbd5e1">—</span>`;
    if (p.data_validade) {
      const d = new Date(p.data_validade + "T00:00:00");
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const diff = Math.round((d - hoje) / 86400000);
      const fmt = d.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
      });
      const cor = diff < 0 ? "#dc2626" : diff <= 3 ? "#f59e0b" : "#94a3b8";
      validadeHtml = `<span style="color:${cor};font-size:0.75rem">${fmt}</span>`;
    }

    // ── Badge pausado ────────────────────────────────────────
    const badgePausado = !p.ativo
      ? `<span class="badge-pausado" style="font-size:0.6rem">⏸ Pausado</span>`
      : "";

    // ── Produto info (meta) ──────────────────────────────────
    const slugLabel = (p.categoria_slug || "").substring(0, 22);
    const eanHtml = p.codigo_barras
      ? `<span style="font-size:0.65rem;color:#94a3b8;font-family:monospace">${p.codigo_barras}</span>`
      : "";

    const card = document.createElement("div");
    card.className = `produto-card${!p.ativo ? " pausado" : ""}`;
    card.dataset.prodId = p.id;
    card.style.gridTemplateColumns = "32px 2.8fr 90px 130px 100px 70px 120px";
    card.innerHTML = `
      <!-- Col 0: Checkbox -->
      <div style="display:flex;align-items:center;justify-content:center">
        <input type="checkbox" class="pt-chk-produto"
          data-id="${p.id}"
          style="width:15px;height:15px;cursor:pointer;accent-color:#1a7a2e"
          onchange="ptAtualizarBarraBulk()">
      </div>
      <!-- Col 1: Produto -->
      <div class="produto-card-info">
        <div class="produto-card-img-wrap">${imgHtml}</div>
        <div class="produto-card-meta-wrap" style="min-width:0">
          <div class="produto-card-nome">${p.nome}</div>
          <div class="produto-card-meta" style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:2px">
            <span class="produto-card-cat" style="color:#94a3b8;font-size:0.7rem">${slugLabel}</span>
            <span class="produto-card-id" style="color:#cbd5e1;font-size:0.68rem">#${p.id}</span>
            ${eanHtml}
            ${badgePausado}
          </div>
        </div>
      </div>
      <!-- Col 2: Preço -->
      <div class="produto-card-preco">Gs ${(p.preco || 0).toLocaleString("es-PY")}</div>
      <!-- Col 3: Estoque -->
      <div class="produto-card-estoque">${estoqueBadge}</div>
      <!-- Col 4: Validade -->
      <div class="produto-card-validade">${validadeHtml}</div>
      <!-- Col 5: Destaque -->
      <div class="produto-card-destaque">
        <button class="btn-destaque${p.destaque ? " ativo" : ""}"
          onclick="toggleDestaqueProduto(${p.id}, ${!!p.destaque})"
          title="${p.destaque ? "Remover destaque" : "Marcar como destaque"}">
          ${p.destaque ? "★" : "☆"}
        </button>
      </div>
      <!-- Col 6: Ações -->
      <div class="produto-card-actions">
        <button class="btn-print-barcode" onclick="imprimirCodigoBarras('${p.codigo_barras || ''}', '${p.nome.replace(/'/g, "\\'")}', 'Gs ${(p.preco || 0).toLocaleString('es-PY')}', ${p.id})">
            <i class="fas fa-barcode"></i> Imprimir Etiqueta
        </button>
        <button class="btn btn-sm btn-primary" onclick="editarProdutoById(${p.id})" title="Editar">
          <i class="fas fa-edit"></i>
        </button>
        <button class="btn btn-sm btn-info" onclick="duplicarProduto(${p.id})" title="Duplicar">
          <i class="fas fa-copy"></i>
        </button>
        <button class="btn btn-sm ${p.ativo ? "btn-warning" : "btn-success"}"
          onclick="pausarProduto(${p.id}, ${p.ativo})"
          title="${p.ativo ? "Pausar" : "Reativar"}" style="background:${p.ativo ? "#f97316" : "#22c55e"}">
          <i class="fas fa-${p.ativo ? "pause" : "play"}"></i>
        </button>
        <button class="btn btn-sm btn-danger" onclick="deletarProduto(${p.id})" title="Excluir">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;
    grid.appendChild(card);
  });
}

// =========================================
// BULK ACTIONS — Seleção e ações em massa
// =========================================

function ptAtualizarBarraBulk() {
  const checkboxes = document.querySelectorAll(".pt-chk-produto");
  const selecionados = document.querySelectorAll(".pt-chk-produto:checked");
  const barra = document.getElementById("pt-bulk-actions-bar");
  const chkTodos = document.getElementById("pt-chk-todos");

  if (barra) {
    if (selecionados.length > 0) {
      barra.style.display = "flex";
      const countEl = document.getElementById("pt-bulk-count");
      if (countEl)
        countEl.textContent = `${selecionados.length} produto(s) selecionado(s)`;
    } else {
      barra.style.display = "none";
    }
  }

  // Atualiza estado do checkbox "selecionar todos"
  if (chkTodos) {
    chkTodos.indeterminate =
      selecionados.length > 0 && selecionados.length < checkboxes.length;
    chkTodos.checked =
      checkboxes.length > 0 && selecionados.length === checkboxes.length;
  }

  // Destaca visualmente os cards selecionados
  document.querySelectorAll(".pt-chk-produto").forEach((chk) => {
    const card = chk.closest(".produto-card");
    if (card) {
      card.style.outline = chk.checked ? "2px solid #1a7a2e" : "";
      card.style.background = chk.checked ? "#f0fdf4" : "";
    }
  });
}

function ptToggleSelecionarTodos(checked) {
  document.querySelectorAll(".pt-chk-produto").forEach((chk) => {
    chk.checked = checked;
  });
  ptAtualizarBarraBulk();
}

function ptBulkDesmarcarTodos() {
  document.querySelectorAll(".pt-chk-produto").forEach((chk) => {
    chk.checked = false;
  });
  const chkTodos = document.getElementById("pt-chk-todos");
  if (chkTodos) {
    chkTodos.checked = false;
    chkTodos.indeterminate = false;
  }
  ptAtualizarBarraBulk();
}

function _ptGetIdsSelecionados() {
  return Array.from(document.querySelectorAll(".pt-chk-produto:checked"))
    .map((chk) => parseInt(chk.dataset.id))
    .filter(Boolean);
}

async function ptBulkPausar() {
  const ids = _ptGetIdsSelecionados();
  if (!ids.length) return;

  if (!confirm(`Pausar ${ids.length} produto(s) selecionado(s)?`)) return;

  try {
    const { error } = await supa
      .from("produtos")
      .update({ ativo: false })
      .in("id", ids);

    if (error) {
      alert("❌ Erro: " + error.message);
    } else {
      const msg = `⏸️ ${ids.length} produto(s) pausado(s)!`;
      if (typeof mostrarToast === "function") mostrarToast(msg, "success", 3000);
      else alert(msg);
      ptBulkDesmarcarTodos();
      carregarProdutos();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}

async function ptBulkDespausar() {
  const ids = _ptGetIdsSelecionados();
  if (!ids.length) return;

  if (!confirm(`Despausar ${ids.length} produto(s) selecionado(s)?`)) return;

  try {
    const { error } = await supa
      .from("produtos")
      .update({ ativo: true })
      .in("id", ids);

    if (error) {
      alert("❌ Erro: " + error.message);
    } else {
      const msg = `▶️ ${ids.length} produto(s) despausado(s)!`;
      if (typeof mostrarToast === "function") mostrarToast(msg, "success", 3000);
      else alert(msg);
      ptBulkDesmarcarTodos();
      carregarProdutos();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}

async function ptBulkExcluir() {
  const ids = _ptGetIdsSelecionados();
  if (!ids.length) return;

  if (
    !confirm(
      `⚠️ ATENÇÃO: Excluir permanentemente ${ids.length} produto(s) selecionado(s)?\n\nEsta ação não pode ser desfeita.`,
    )
  )
    return;

  try {
    const { error } = await supa.from("produtos").delete().in("id", ids);

    if (error) {
      alert("❌ Erro ao excluir: " + error.message);
    } else {
      const msg = `🗑️ ${ids.length} produto(s) excluído(s) com sucesso!`;
      if (typeof mostrarToast === "function")
        mostrarToast(msg, "success", 3000);
      else alert(msg);
      ptBulkDesmarcarTodos();
      carregarProdutos();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}

// Toggle destaque inline without opening modal
async function toggleDestaqueProduto(id, atualDestaque) {
  try {
    await supa
      .from("produtos")
      .update({ destaque: !atualDestaque })
      .eq("id", id);
    const p = _produtosMap[id];
    if (p) {
      p.destaque = !atualDestaque;
      // Update button in place
      const btn = document.querySelector(
        `.btn-destaque[onclick*="toggleDestaqueProduto(${id},"]`,
      );
      if (btn) {
        btn.className = `btn-destaque${!atualDestaque ? " ativo" : ""}`;
        btn.innerHTML = !atualDestaque ? "★" : "☆";
        btn.setAttribute(
          "onclick",
          `toggleDestaqueProduto(${id}, ${!atualDestaque})`,
        );
        btn.title = !atualDestaque
          ? "Remover destaque"
          : "Marcar como destaque";
      }
      // Update stat counter
      const statDest = document.getElementById("pt-stat-destaque");
      if (statDest) {
        const cnt = _todosProdutos.filter((x) => x.destaque).length;
        statDest.textContent = cnt;
      }
    }
  } catch (e) {
    console.error("Erro ao alternar destaque:", e);
  }
}

function editarProdutoById(id) {
  const p = _produtosMap[id];
  if (p) editarProduto(p);
}

function editarProduto(p) {
  abrirModalProduto(p);
}

// (deletarProduto defined below alongside pausarProduto)

// Preview ao colar/digitar URL de imagem no campo de texto
function previewUrlImagem(url) {
  const box = document.getElementById("box-preview");
  const img = document.getElementById("img-preview");
  if (!box || !img) return;
  const trimmed = (url || "").trim();
  if (!trimmed) {
    box.style.display = "none";
    img.src = "";
    return;
  }
  img.src = trimmed;
  box.style.display = "block";
  img.onerror = () => {
    box.style.display = "none";
  };
  img.onload = () => {
    box.style.display = "block";
  };
}

function previewUpload(input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = function (e) {
      document.getElementById("img-preview").src = e.target.result;
      document.getElementById("box-preview").style.display = "block";
    };
    reader.readAsDataURL(input.files[0]);
  }
}

async function salvarProduto() {
  const btn = event.target;
  btn.disabled = true;
  try {
    const id = document.getElementById("prod-id").value;
    const fileInput = document.getElementById("prod-img-file");
    let urlFinal = document.getElementById("prod-img").value;

    // ── Upload para o Supabase Storage ────────────────────────
    console.log(
      "[salvarProduto] fileInput.files.length:",
      fileInput.files.length,
      "| urlFinal atual:",
      urlFinal,
    );
    if (fileInput.files.length > 0) {
      btn.innerText = "📤 Enviando imagem...";
      try {
        urlFinal = await uploadImageToSupabase(fileInput.files[0], "produtos");
        document.getElementById("prod-img").value = urlFinal;
        document.getElementById("img-preview").src = urlFinal;
        document.getElementById("box-preview").style.display = "block";
      } catch (uploadErr) {
        btn.disabled = false;
        btn.innerText = "Salvar Produto";
        alert(
          "❌ Falha no upload da imagem:\n\n" +
            uploadErr.message +
            "\n\nSe quiser, cole a URL da imagem diretamente no campo de URL e salve novamente.",
        );
        return;
      }
    } else if (urlFinal && urlFinal.trim()) {
      urlFinal = urlFinal.trim();
    }

    btn.innerText = "Salvando...";

    // ── Validações obrigatórias ───────────────────────────────
    const _nomeVal = document.getElementById("prod-nome").value.trim();
    if (!_nomeVal) {
      alert("⚠️ O nome do produto é obrigatório.");
      return;
    }
    const _catVal = document.getElementById("prod-cat").value;
    if (!_catVal) {
      alert("⚠️ Selecione uma categoria para o produto.");
      return;
    }

    // ── Preço base ────────────────────────────────────────────
    // Lê do campo principal. Se vazio e as faixas estão ativas com
    // unitário preenchido, usa a faixa unitária (evita gravar preco = 0).
    const _precoEl      = document.getElementById("prod-preco");
    const _faixaUniEl   = document.getElementById("prod-faixa-unitario");
    const _faixasAtivas = document.getElementById("prod-tem-faixas")?.checked === true;

    let precoBase =
      parseInt(
        _precoEl?.dataset?.valorNumerico ||
          (_precoEl?.value || "").replace(/\D/g, "") ||
          "0",
        10,
      ) || 0;

    if (precoBase <= 0 && _faixasAtivas && _faixaUniEl) {
      precoBase =
        parseInt(
          _faixaUniEl.dataset?.valorNumerico ||
            _faixaUniEl.value ||
            "0",
          10,
        ) || 0;
    }

    if (document.getElementById("prod-venda-kg")?.checked) {
      const pkgVal =
        parseFloat(document.getElementById("prod-preco-kg")?.value) || 0;
      if (pkgVal > 0) precoBase = pkgVal;
    }

    // ── Promoção ──────────────────────────────────────────────
    let precoOriginal = null;
    let emPromocao = false;

    if (document.getElementById("prod-promo-ativo")?.checked) {
      const tipoPromo = document.getElementById("prod-promo-tipo")?.value;
      const valor =
        parseFloat(document.getElementById("prod-promo-valor")?.value) || 0;

      if (valor > 0) {
        emPromocao = true;
        precoOriginal = precoBase;

        if (tipoPromo === "percent") {
          if (valor >= 100) {
            alert("⚠️ Desconto percentual inválido.");
            return;
          }
          precoBase = Math.round(precoBase * (1 - valor / 100));
        } else {
          precoBase = Math.max(0, precoBase - valor);
        }
      }
    }

    // ── Faixas de preço (varejo/atacado) ──────────────────────
    const _faixasPreco = _coletarFaixasPreco();

    // Preserva montagem_config existente quando não há faixas ativas.
    // Sem isso, editar uma pizza/montável/combo sem mexer em faixas
    // apaga a configuração original do produto.
    let _montagemConfig = null;
    if (_faixasPreco) {
      _montagemConfig = { __tipo: "varejo", faixas_preco: _faixasPreco };
    } else if (id && _produtosMap[id]?.montagem_config) {
      _montagemConfig = _produtosMap[id].montagem_config;
    }

    // ── Payload ───────────────────────────────────────────────
    const dados = {
      nome: document.getElementById("prod-nome").value,
      descricao: document.getElementById("prod-desc").value,
      preco: precoBase,
      promo_ativo:
        document.getElementById("prod-promo-ativo")?.checked || false,
      promo_tipo: document.getElementById("prod-promo-tipo")?.value || null,
      promo_valor:
        parseFloat(document.getElementById("prod-promo-valor")?.value) || null,
      em_promocao: emPromocao,
      preco_original: precoOriginal,
      categoria_slug: document.getElementById("prod-cat").value || null,
      subcategoria_slug: document.getElementById("prod-subcat")?.value || null,
      imagem_url: urlFinal,
      e_montavel: false,
      montagem_config: _montagemConfig,
      ativo: true,
      somente_balcao:
        document.getElementById("prod-somente-balcao")?.checked || false,
      codigo_barras:
        document.getElementById("prod-codigo-barras")?.value?.trim() || null,
      unidade_venda:
        document.getElementById("prod-unidade-venda")?.value || null,
      destaque: document.getElementById("prod-destaque")?.checked || false,
      estoque_qtd: document.getElementById("prod-tem-estoque")?.checked
        ? parseInt(document.getElementById("prod-estoque-qtd")?.value) || 0
        : null,
      estoque_minimo: document.getElementById("prod-tem-estoque")?.checked
        ? parseInt(document.getElementById("prod-estoque-minimo")?.value) || null
        : null,
      preco_compra: (() => {
        const el = document.getElementById("prod-preco-compra");
        if (!el) return null;
        const raw =
          el.dataset.valorNumerico ||
          (el.value || "").replace(/\D/g, "") ||
          "0";
        const v = parseInt(raw, 10);
        return v > 0 ? v : null;
      })(),
      perecivel: document.getElementById("prod-perecivel")?.checked || false,
      data_validade:
        document.getElementById("prod-perecivel")?.checked &&
        document.getElementById("prod-data-validade")?.value
          ? document.getElementById("prod-data-validade").value
          : null,
      dias_alerta_validade:
        parseInt(document.getElementById("prod-dias-alerta-validade")?.value) ||
        7,
    };

    let prodIdSalvo = id ? parseInt(id) : null;

    if (id) {
      const { error: errUpdate } = await supa
        .from("produtos")
        .update(dados)
        .eq("id", parseInt(id));
      if (errUpdate) throw new Error("Erro ao salvar: " + errUpdate.message);
      console.log(
        "[salvarProduto] Produto atualizado. imagem_url:",
        dados.imagem_url,
      );
    } else {
      const { data: novoProd, error: errInsert } = await supa
        .from("produtos")
        .insert([dados])
        .select("id")
        .single();
      if (errInsert) throw errInsert;
      prodIdSalvo = novoProd.id;
    }

    // ── Salva variações de estoque (varejo) ───────────────────
    if (prodIdSalvo && document.getElementById("secao-variacoes-estoque")) {
      await veSalvarVariacoes(prodIdSalvo);
    }

    fecharModal("modal-produto");
    carregarProdutos();
  } catch (e) {
    alert("Erro: " + e.message);
  } finally {
    btn.innerText = "Salvar";
    btn.disabled = false;
  }
}

// ── Máscara de preço em Guaranis (sem decimais) ───────────────
function _mascaraGsAdmin(input) {
  // Remove tudo que não for dígito
  let raw = input.value.replace(/\D/g, "");

  // Converte para número e formata com separador de milhar (ponto)
  if (raw === "") {
    input.value = "";
    delete input.dataset.valorNumerico;
    return;
  }

  const num = parseInt(raw, 10);
  // Formato paraguaio: 1.000.000
  input.value = num.toLocaleString("es-PY");

  // Guarda o valor numérico puro num atributo para o salvarProduto ler corretamente
  input.dataset.valorNumerico = String(num);
}

// ── Calcula e exibe o markup no modal de produto ──────────────
// (também definida inline no HTML para garantir disponibilidade imediata)
function _calcularMarkupModal() {
  const elVenda = document.getElementById("prod-preco");
  const elCompra = document.getElementById("prod-preco-compra");
  const elPreview = document.getElementById("prod-markup-preview");
  if (!elVenda || !elCompra || !elPreview) return;

  const venda = parseInt(
    elVenda.dataset.valorNumerico ||
      (elVenda.value || "").replace(/\D/g, "") ||
      "0",
    10,
  );
  const compra = parseInt(
    elCompra.dataset.valorNumerico ||
      (elCompra.value || "").replace(/\D/g, "") ||
      "0",
    10,
  );

  if (!compra || compra <= 0) {
    elPreview.textContent = "";
    return;
  }
  if (!venda || venda <= 0) {
    elPreview.style.color = "#e74c3c";
    elPreview.textContent = "⚠️ Informe o preço de venda";
    return;
  }

  const lucroGs = venda - compra;
  const markupPct = Math.round(((venda - compra) / compra) * 100);
  const margemPct = Math.round(((venda - compra) / venda) * 100);

  if (lucroGs < 0) {
    elPreview.style.color = "#e74c3c";
    elPreview.textContent = `❌ Prejuízo de Gs ${Math.abs(lucroGs).toLocaleString("es-PY")}`;
  } else {
    elPreview.style.color = markupPct >= 30 ? "#16a34a" : "#d97706";
    elPreview.textContent = `📈 Markup ${markupPct}% · Margem ${margemPct}% · +Gs ${lucroGs.toLocaleString("es-PY")}`;
  }
}

async function abrirModalProduto(produto = null, tipoInicial = null) {
  const modal = document.getElementById("modal-produto");

  // Reset completo
  const _bSteps = document.getElementById("builder-steps");
  if (_bSteps) _bSteps.innerHTML = "";
  document.getElementById("prod-id").value = "";
  document.getElementById("prod-nome").value = "";
  document.getElementById("prod-desc").value = "";
  document.getElementById("prod-preco").value = "";
  document.getElementById("prod-img").value = "";
  document.getElementById("box-preview").style.display = "none";
  document.getElementById("prod-somente-balcao").checked = false;
  // ── Preço de compra reset ─────────────────────────────────
  const _pcResetEl = document.getElementById("prod-preco-compra");
  if (_pcResetEl) {
    _pcResetEl.value = "";
    delete _pcResetEl.dataset.valorNumerico;
  }
  const _mkReset = document.getElementById("prod-markup-preview");
  if (_mkReset) _mkReset.textContent = "";
  // ── Código de barras reset ────────────────────────────────
  const _cbResetEl = document.getElementById("prod-codigo-barras");
  if (_cbResetEl) _cbResetEl.value = "";
  // ── Varejo reset ──────────────────────────────────────────
  const _unidEl = document.getElementById("prod-unidade-venda");
  if (_unidEl) _unidEl.value = "";
  const _destEl = document.getElementById("prod-destaque");
  if (_destEl) _destEl.checked = false;
  const _paEl = document.getElementById("prod-promo-ativo");
  if (_paEl) {
    _paEl.checked = false;
    togglePromoFields(false);
  }
  const _pvEl = document.getElementById("prod-promo-valor");
  if (_pvEl) _pvEl.value = "";
  const _ppEl = document.getElementById("prod-promo-preview");
  if (_ppEl) _ppEl.textContent = "";
  // Estoque direto
  const _teResetEl = document.getElementById("prod-tem-estoque");
  if (_teResetEl) {
    _teResetEl.checked = false;
    toggleEstoqueDireto(false);
  }
  const _eqResetEl = document.getElementById("prod-estoque-qtd");
  if (_eqResetEl) _eqResetEl.value = "";

  const _emResetEl = document.getElementById("prod-estoque-minimo");
  if (_emResetEl) _emResetEl.value = "";
  // Venda por kg
  const _vkResetEl = document.getElementById("prod-venda-kg");
  if (_vkResetEl) {
    _vkResetEl.checked = false;
    toggleVendaKg(false);
  }
  const _pkResetEl = document.getElementById("prod-preco-kg");
  if (_pkResetEl) _pkResetEl.value = "";
  // ── Perecível reset ───────────────────────────────────────
  const _perResetEl = document.getElementById("prod-perecivel");
  if (_perResetEl) {
    _perResetEl.checked = false;
    togglePerecivelFields(false);
  }
  const _dvResetEl = document.getElementById("prod-data-validade");
  if (_dvResetEl) _dvResetEl.value = "";
  // ── Fim Varejo reset ──────────────────────────────────────

  // Limpa file input para não reutilizar imagem anterior
  const fileInputReset = document.getElementById("prod-img-file");
  if (fileInputReset) fileInputReset.value = "";

  if (produto) {
    document.getElementById("prod-id").value = produto.id;
    document.getElementById("prod-nome").value = produto.nome;
    document.getElementById("prod-desc").value = produto.descricao || "";
    const _pvendaEl = document.getElementById("prod-preco");
    if (_pvendaEl) {
      const pv = produto.preco || 0;
      _pvendaEl.value = pv > 0 ? pv.toLocaleString("es-PY") : "";
      _pvendaEl.dataset.valorNumerico = String(pv);
    }
    document.getElementById("prod-img").value = produto.imagem_url || "";
    document.getElementById("prod-somente-balcao").checked =
      produto.somente_balcao || false;

    // ── Preço de compra ────────────────────────────────────
    const _pcEl = document.getElementById("prod-preco-compra");
    if (_pcEl) {
      const pc = produto.preco_compra || 0;
      if (pc > 0) {
        _pcEl.value = pc.toLocaleString("es-PY");
        _pcEl.dataset.valorNumerico = String(pc);
      } else {
        _pcEl.value = "";
        delete _pcEl.dataset.valorNumerico;
      }
    }
    _calcularMarkupModal();

    // ── Código de barras ───────────────────────────────────
    const _cbEl = document.getElementById("prod-codigo-barras");
    if (_cbEl) _cbEl.value = produto.codigo_barras || "";

    // ── Varejo: unidade, destaque, promoção, estoque direto ─
    const _unid = document.getElementById("prod-unidade-venda");
    if (_unid) _unid.value = produto.unidade_venda || "";

    const _dest = document.getElementById("prod-destaque");
    if (_dest) _dest.checked = produto.destaque || false;

    const _promoAtivo = document.getElementById("prod-promo-ativo");
    if (_promoAtivo) {
      _promoAtivo.checked = produto.promo_ativo || false;
      togglePromoFields(produto.promo_ativo || false);
    }
    const _promoTipo = document.getElementById("prod-promo-tipo");
    if (_promoTipo && produto.promo_tipo) _promoTipo.value = produto.promo_tipo;
    const _promoValor = document.getElementById("prod-promo-valor");
    if (_promoValor && produto.promo_valor)
      _promoValor.value = produto.promo_valor;
    promoAtualizarPreview();

    // Estoque direto
    const temEst = produto.estoque_qtd != null;
    const _teEl = document.getElementById("prod-tem-estoque");
    if (_teEl) {
      _teEl.checked = temEst;
      toggleEstoqueDireto(temEst);
    }
    const _eqEl = document.getElementById("prod-estoque-qtd");
    if (_eqEl && temEst) _eqEl.value = produto.estoque_qtd;
    const _emEl = document.getElementById("prod-estoque-minimo");
    if (_emEl && temEst && produto.estoque_minimo != null)
      _emEl.value = produto.estoque_minimo;

    // Venda por Kg
    const eKg = produto.unidade_venda === "kg" && produto.preco_kg > 0;
    const _vkEl = document.getElementById("prod-venda-kg");
    if (_vkEl) {
      _vkEl.checked = eKg;
      toggleVendaKg(eKg);
    }
    const _pkEl = document.getElementById("prod-preco-kg");
    if (_pkEl && produto.preco_kg) _pkEl.value = produto.preco_kg;
    // ── Perecível ──────────────────────────────────────────
    const _perEl = document.getElementById("prod-perecivel");
    if (_perEl) {
      const isPerecivel = produto.perecivel || false;
      _perEl.checked = isPerecivel;
      togglePerecivelFields(isPerecivel);
    }
    const _dvEl = document.getElementById("prod-data-validade");
    if (_dvEl && produto.data_validade)
      _dvEl.value = produto.data_validade.split("T")[0];
    // Antecedência do alerta de validade (7/15/30 dias) — default 7
    const _daEl = document.getElementById("prod-dias-alerta-validade");
    if (_daEl) _daEl.value = produto.dias_alerta_validade || 7;
    // ── Fim Varejo ──────────────────────────────────────────
    // Inventário vinculado removido — estoque agora é direto no produto
    if (produto.imagem_url) {
      document.getElementById("img-preview").src = produto.imagem_url;
      document.getElementById("box-preview").style.display = "block";
    }
  }

  // CORREÇÃO: Carrega categorias com a categoria atual do produto já selecionada
  const catAtual = produto ? produto.categoria_slug || "" : "";
  const subcatAtual = produto ? produto.subcategoria_slug || "" : "";
  await carregarSelectCategorias(catAtual);
  await carregarSelectSubcategorias(catAtual, subcatAtual);

  // ── Seção de variações de estoque (varejo) ────────────────
  veIniciarSecao(produto ? produto.id : null);
  // ── Fim variações ─────────────────────────────────────────

  // ── Faixas de preço (varejo/atacado) ─────────────────────
  _renderizarFaixasPreco(produto);

  modal.style.display = "flex";
}

// Mapa: tipo semântico → qual builder exibir
const BUILDER_MAP = {
  padrao: "",
  bebida: "",
  lanche: "",
  combo: "builder-combo",
  sorvete: "builder-sorvete",
  pizza: "builder-pizza",
  montavel: "builder-montavel",
  acai: "builder-acai",
  shake: "builder-shake",
  suco: "builder-suco",
  variacoes: "builder-variacoes",
  kg: "builder-kg",
  // ── Varejo ──────────────────────────────────────────────
  roupa: "", // usa seção de variações de estoque (veIniciarSecao)
  eletronico: "",
  suplemento: "",
  pod: "",
  mercado: "", // usa unidade_venda + destaque + promo
};
const BUILDER_HINTS = {
  shake: "🥤 Defina tamanhos (P/M/G) e sabores disponíveis.",
};

const _TIPO_BADGE_LABELS = {
  padrao: "📦 Simples",
  bebida: "🥤 Bebida",
  lanche: "🍔 Lanche",
  pizza: "🍕 Pizza",
  acai: "🍇 Açaí",
  shake: "🥤 Shake",
  suco: "🍊 Suco",
  sorvete: "🍦 Sorvete",
  montavel: "🥗 Montável",
  almoco: "🍽️ Prato",
  combo: "⭐ Combo",
  variacoes: "🎨 Multi-variação",
  kg: "⚖️ Venda por Kg",
  // ── Varejo ──────────────────────────────────────────────
  roupa: "👕 Roupa",
  eletronico: "🔌 Eletrônico",
  suplemento: "💪 Suplemento",
  pod: "☁️ Pod / Tabacaria",
  mercado: "🛒 Mercado",
};

function selecionarTipoBuilder(tipo) {
  document.getElementById("prod-tipo-builder").value = tipo;

  document.querySelectorAll(".builder-type-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tipo === tipo);
  });

  document
    .querySelectorAll(".builder-section")
    .forEach((s) => (s.style.display = "none"));

  const builderId = BUILDER_MAP[tipo];
  if (builderId) {
    const el = document.getElementById(builderId);
    if (el) el.style.display = "block";
  }

  // Para kg: o preço é definido no builder (prod-preco-kg), oculta o campo principal
  const precoBox = document.getElementById("box-prod-preco");
  if (precoBox) precoBox.style.display = tipo === "kg" ? "none" : "";

  // Atualiza badge de tipo no modal
  const badge = document.getElementById("modal-tipo-badge");
  if (badge) badge.textContent = _TIPO_BADGE_LABELS[tipo] || tipo;

  const hintEl = document.getElementById("builder-tipo-hint");
  if (hintEl) {
    const msg = BUILDER_HINTS[tipo] || "";
    hintEl.textContent = msg;
    hintEl.style.display = msg ? "block" : "none";
    if (msg) {
      hintEl.style.cssText =
        "background:#fff8e1;border-left:4px solid #f59e0b;border-radius:6px;padding:10px 14px;font-size:0.82rem;color:#78350f;margin-top:8px;";
    }
  }

  const lancheHint = document.getElementById("builder-lanche-hint");
  if (lancheHint) {
    lancheHint.style.display =
      tipo === "lanche" || tipo === "combo" ? "block" : "none";
  }

  // Para açaí/suco/sorvete: carrega lista de produtos no combo se necessário
  if (tipo === "combo") _carregarComboSelect();

  // ── Varejo: tipos que sempre usam seção de variações ────
  const tiposVarejo = ["roupa", "eletronico", "suplemento", "pod", "variacoes"];
  const secaoVe = document.getElementById("secao-variacoes-estoque");
  if (secaoVe && tiposVarejo.includes(tipo)) {
    // Garante que a seção esteja visível e com dica contextual
    secaoVe.style.display = "";
    const prodId = document.getElementById("prod-id")?.value || null;
    veIniciarSecao(prodId ? parseInt(prodId) : null);
    // Sugestão de variações padrão por tipo
    const sugestoes = {
      roupa: [
        "Branco - P",
        "Branco - M",
        "Branco - G",
        "Preto - P",
        "Preto - M",
        "Preto - G",
      ],
      eletronico: ["110v", "220v", "Bivolt"],
      suplemento: ["Baunilha - 900g", "Chocolate - 900g", "Morango - 900g"],
      pod: ["Melancia", "Menta", "Morango Gelado", "Uva", "Ice"],
    };
    if (sugestoes[tipo] && _ve_variacoes.length === 0) {
      _veMostrarSugestoes(sugestoes[tipo]);
    }
  }
}

// Abre modal com tipo pré-selecionado (vindo do seletor externo)
// Abre o modal de produto em branco (único formulário para todos os tipos)
function criarNovoProduto(tipo) {
  abrirModalProduto(null);
}

// Mantido por compatibilidade — abre o modal diretamente
function toggleNovosProdutosTipos() {
  abrirModalProduto(null);
}

// Removido: toggleAlterarTipo — sem seletor de tipo no modal

// Compatibilidade retroativa
function toggleBuilder() {}

function addBuilderStep(t = "", m = 1, i = []) {
  const div = document.createElement("div");
  div.className = "etapa-item";
  div.innerHTML = `<div class="etapa-header"><input type="text" class="form-control step-titulo" value="${t}" placeholder="Título da etapa (ex: Escolha a base)"><input type="number" class="form-control step-max" value="${m}" style="width:70px" title="Máx. seleções"><button class="btn btn-sm btn-danger" onclick="this.parentElement.parentElement.remove()">X</button></div><textarea class="etapa-ingredientes step-itens" placeholder="Itens separados por vírgula. Ex: Arroz, Atum, Salmão, Tofu">${Array.isArray(i) ? i.join(", ") : i}</textarea>`;
  document.getElementById("builder-steps").appendChild(div);
}

// ─── VARIAÇÕES DE SABOR BUILDER ───────────────────────────────────
function addVariacao(dados = {}) {
  const lista = document.getElementById("variacoes-lista");
  const row = document.createElement("div");
  row.className = "variacao-row";
  const pausado = dados.ativo === false;
  row.style.cssText = `background:${pausado ? "#fff5f5" : "#fff"};border:1px solid ${pausado ? "#fca5a5" : "#e9d5ff"};border-radius:10px;padding:12px;display:grid;grid-template-columns:1fr auto auto;gap:10px;align-items:center;opacity:${pausado ? "0.7" : "1"}`;
  row.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px">
      <input data-f="vnome" class="form-control" value="${dados.nome || ""}" placeholder="Nome da variação (ex: Ex: Variação Premium)" style="font-weight:600">
      <div style="display:flex;gap:8px;align-items:center">
        <span style="font-size:0.8rem;color:#777;white-space:nowrap">Gs</span>
        <input data-f="vpreco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="Preço" style="max-width:140px">
      </div>
      <input data-f="vimg" class="form-control" value="${dados.img || ""}" placeholder="URL da foto (opcional — usa foto do produto por padrão)" style="font-size:0.8rem;color:#888">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.82rem;color:${pausado ? "#c0392b" : "#16a34a"}">
        <input data-f="vativo" type="checkbox" ${!pausado ? "checked" : ""} onchange="this.closest('.variacao-row').style.background=this.checked?'#fff':'#fff5f5';this.closest('.variacao-row').style.opacity=this.checked?'1':'0.7';this.closest('.variacao-row').style.borderColor=this.checked?'#e9d5ff':'#fca5a5';this.parentElement.style.color=this.checked?'#16a34a':'#c0392b';this.parentElement.lastChild.textContent=this.checked?' Disponível':' Pausado'">
        <span>${pausado ? " Pausado" : " Disponível"}</span>
      </label>
    </div>
    <div style="width:60px;height:60px;border-radius:8px;overflow:hidden;background:#f3f4f6;flex-shrink:0">
      ${dados.img ? `<img src="${dados.img}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none'">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#ccc;font-size:1.5rem">🖼</div>'}
    </div>
    <button class="btn btn-sm btn-danger" onclick="this.closest('.variacao-row').remove()" title="Remover" style="align-self:start">✕</button>
  `;
  lista.appendChild(row);
}

// ─── PIZZA BUILDER (tipos dinâmicos) ───────────────────────────

function toggleBordaPreco() {
  const tem = document.getElementById("pizza-tem-borda").checked;
  document.getElementById("pizza-borda-preco-box").style.display = tem
    ? "block"
    : "none";
}

// Adiciona um tipo de pizza (ex: Tradicional, Especial, Vegana...)
function addPizzaTipo(nome = "") {
  const lista = document.getElementById("pizza-tipos-lista");
  if (!lista) return;
  const row = document.createElement("div");
  row.className = "pizza-tipo-row";
  row.style.cssText =
    "display:flex;gap:8px;align-items:center;margin-bottom:6px";
  row.innerHTML = `
    <input class="form-control pizza-tipo-nome" value="${nome}" placeholder="Ex: Tradicional, Especial, Vegana"
      oninput="_pizzaRefreshTamanhoPrecos()" style="flex:1">
    <button class="btn btn-sm btn-danger" onclick="this.closest('.pizza-tipo-row').remove();_pizzaRefreshTamanhoPrecos()">✕</button>
  `;
  lista.appendChild(row);
  _pizzaRefreshTamanhoPrecos();
}

// Lê os tipos atuais da lista
function _pizzaTiposAtuais() {
  return [...document.querySelectorAll(".pizza-tipo-nome")]
    .map((i) => i.value.trim())
    .filter(Boolean);
}

// Reconstrói as colunas de preço em todos os tamanhos quando tipos mudam
function _pizzaRefreshTamanhoPrecos() {
  const tipos = _pizzaTiposAtuais();
  document.querySelectorAll(".pizza-tamanho-row").forEach((row) => {
    const box = row.querySelector(".pizza-tamanho-precos-dinamico");
    if (!box) return;
    // Preserva valores existentes
    const valoresExistentes = {};
    box.querySelectorAll('[data-f="preco_tipo"]').forEach((inp) => {
      if (inp.dataset.tipo) valoresExistentes[inp.dataset.tipo] = inp.value;
    });
    box.innerHTML = tipos
      .map(
        (t) => `
      <div>
        <label style="font-size:0.72rem;color:#555">💰 ${t} (Gs)</label>
        <input data-f="preco_tipo" data-tipo="${t}" type="number" class="form-control"
          value="${valoresExistentes[t] || ""}" placeholder="0" min="0" step="500">
      </div>`,
      )
      .join("");
  });
  // Atualiza select de tipo nos sabores
  document.querySelectorAll(".pizza-sabor-tipo").forEach((sel) => {
    const val = sel.value;
    sel.innerHTML =
      tipos
        .map(
          (t) =>
            `<option value="${t}" ${t === val ? "selected" : ""}>${t}</option>`,
        )
        .join("") || '<option value="">— Tipo —</option>';
  });
}

function addPizzaBorda(dados = {}) {
  const lista = document.getElementById("pizza-bordas-lista");
  const row = document.createElement("div");
  row.className = "pizza-borda-row";
  row.style.cssText =
    "display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #eee;border-radius:8px;padding:8px 10px;margin-bottom:6px";
  row.innerHTML = `
    <div style="flex:3">
      <label style="font-size:0.72rem;color:#888">Nome da borda</label>
      <input data-f="bnome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Cheddar, Catupiry, Chocolate">
    </div>
    <div style="flex:2">
      <label style="font-size:0.72rem;color:#888">Preço (Gs)</label>
      <input data-f="bpreco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="0" min="0" step="500">
    </div>
    <button class="btn btn-sm btn-danger" onclick="this.closest('.pizza-borda-row').remove()" style="align-self:flex-end;margin-bottom:2px">✕</button>
  `;
  lista.appendChild(row);
}

function addPizzaTamanho(dados = {}) {
  const lista = document.getElementById("pizza-tamanhos-lista");
  const row = document.createElement("div");
  row.className = "pizza-tamanho-row";
  const tipos = _pizzaTiposAtuais();

  // Preços existentes: novo formato (precos obj) ou antigo (preco_tradicional etc.)
  const precosExist = dados.precos || {
    Tradicional: dados.preco_tradicional || dados.preco || "",
    Especial: dados.preco_especial || "",
    Doce: dados.preco_doce || "",
  };

  row.innerHTML = `
    <div class="pizza-tamanho-header" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:8px">
      <div style="flex:2;min-width:80px"><label style="font-size:0.72rem;color:#555">Nome</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: P, M, G, GG"></div>
      <div style="flex:1;min-width:60px"><label style="font-size:0.72rem;color:#555">Fatias</label><input data-f="fatias" type="number" class="form-control" value="${dados.fatias || ""}" placeholder="8"></div>
      <div style="flex:1;min-width:60px"><label style="font-size:0.72rem;color:#555">Cm</label><input data-f="cm" type="number" class="form-control" value="${dados.cm || ""}" placeholder="35"></div>
      <div style="flex:1;min-width:70px"><label style="font-size:0.72rem;color:#555">Máx. sabores</label><input data-f="max_sabores" type="number" min="1" max="8" class="form-control" value="${dados.max_sabores || 2}"></div>
      <button class="btn btn-sm btn-danger" onclick="this.closest('.pizza-tamanho-row').remove()" style="margin-bottom:2px">✕</button>
    </div>
    <div class="pizza-tamanho-precos-dinamico" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px">
      ${tipos
        .map(
          (t) => `
        <div>
          <label style="font-size:0.72rem;color:#555">💰 ${t} (Gs)</label>
          <input data-f="preco_tipo" data-tipo="${t}" type="number" class="form-control"
            value="${precosExist[t] || ""}" placeholder="0" min="0" step="500">
        </div>`,
        )
        .join("")}
    </div>
  `;
  lista.appendChild(row);
}

function addPizzaSabor(dados = {}) {
  const lista = document.getElementById("pizza-sabores-lista");
  const ph = lista.querySelector("p");
  if (ph) ph.remove();
  const tipos = _pizzaTiposAtuais();
  const row = document.createElement("div");
  row.className = "pizza-sabor-row";
  row.draggable = true;
  const imgSrc = dados.img || "";
  const isAtivo = dados.ativo !== false; // default true
  row.innerHTML = `
    <div class="pizza-sabor-main" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
      <span class="drag-handle" title="Arrastar para reordenar"
        style="cursor:grab;font-size:1.1rem;color:#aaa;padding:0 4px;user-select:none">⠿</span>
      <input data-f="snome" class="form-control" value="${dados.nome || ""}" placeholder="Nome do sabor" style="flex:2;min-width:120px">
      <select data-f="stipo" class="form-control pizza-sabor-tipo" style="flex:1;min-width:100px">
        ${
          tipos.length
            ? tipos
                .map(
                  (t) =>
                    `<option value="${t}" ${dados.tipo === t ? "selected" : ""}>${t}</option>`,
                )
                .join("")
            : `<option value="${dados.tipo || ""}">${dados.tipo || "—"}</option>`
        }
      </select>
      <button type="button" class="btn btn-sm pizza-sabor-toggle-ativo"
        data-ativo="${isAtivo}"
        style="background:${isAtivo ? "#27ae60" : "#e74c3c"};color:#fff;border:none;
               border-radius:6px;padding:4px 9px;cursor:pointer;font-size:0.78rem;white-space:nowrap"
        onclick="pizzaSaborToggleAtivo(this)">
        ${isAtivo ? "✅ Ativo" : "⏸ Pausado"}
      </button>
      <button type="button" class="btn btn-sm btn-danger" onclick="this.closest('.pizza-sabor-row').remove()">✕</button>
    </div>
    <textarea data-f="sdesc" class="form-control" rows="1" placeholder="Descrição (opcional)" style="margin-bottom:6px">${dados.desc || ""}</textarea>
    <div style="display:flex;gap:8px;align-items:center">
      ${imgSrc ? `<img src="${imgSrc}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0">` : ""}
      <input data-f="simg" type="text" class="form-control" value="${imgSrc}" placeholder="URL da imagem (opcional)" style="flex:1;font-size:0.8rem">
      <label style="cursor:pointer;background:#e8f4fd;border:1px solid #3498db;border-radius:6px;padding:5px 8px;font-size:0.75rem;white-space:nowrap">
        📷 <input type="file" accept="image/*" style="display:none" onchange="uploadSaborImagem(this, this.closest('.pizza-sabor-row'))">
      </label>
    </div>
  `;
  _pizzaSaborDragBind(row);
  lista.appendChild(row);
}

function pizzaSaborToggleAtivo(btn) {
  const atual = btn.dataset.ativo === "true";
  const novo = !atual;
  btn.dataset.ativo = String(novo);
  btn.style.background = novo ? "#27ae60" : "#e74c3c";
  btn.textContent = novo ? "✅ Ativo" : "⏸ Pausado";
}

// ── Drag & Drop nativo para reordenar sabores ──────────────────
let _dragSaborRow = null;

function _pizzaSaborDragBind(row) {
  row.addEventListener("dragstart", (e) => {
    _dragSaborRow = row;
    row.style.opacity = "0.4";
    e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    row.style.opacity = "";
    _dragSaborRow = null;
    // Remove indicadores visuais
    document
      .querySelectorAll(".pizza-sabor-row")
      .forEach((r) => r.classList.remove("drag-over"));
  });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (_dragSaborRow && _dragSaborRow !== row) {
      row.classList.add("drag-over");
    }
  });
  row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("drag-over");
    if (!_dragSaborRow || _dragSaborRow === row) return;
    const lista = document.getElementById("pizza-sabores-lista");
    const rows = [...lista.querySelectorAll(".pizza-sabor-row")];
    const fromIdx = rows.indexOf(_dragSaborRow);
    const toIdx = rows.indexOf(row);
    if (fromIdx < toIdx) {
      lista.insertBefore(_dragSaborRow, row.nextSibling);
    } else {
      lista.insertBefore(_dragSaborRow, row);
    }
  });
}

// Inicializa drag em sabores existentes (chamado ao abrir modal de edição)
function _pizzaSaboresDragInit() {
  document
    .querySelectorAll("#pizza-sabores-lista .pizza-sabor-row")
    .forEach(_pizzaSaborDragBind);
}

async function uploadSaborImagem(fileInput, row) {
  if (!fileInput.files.length) return;
  const file = fileInput.files[0];
  fileInput.disabled = true;

  // Feedback visual no botão/label pai
  const labelBtn = fileInput.closest("label");
  const originalLabel = labelBtn ? labelBtn.innerHTML : null;
  if (labelBtn) labelBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  try {
    // ── Upload para o Cloudinary (substitui Supabase Storage) ──
    const url = await uploadImageToSupabase(file, 'sabores');

    const inp =
      row.querySelector('[data-f="simg"]') ||
      row.querySelector('[data-f="img"]');
    if (inp) inp.value = url;
    const prev = row.querySelector("img.img-preview-mini");
    if (prev) {
      prev.src = url;
      prev.style.display = "block";
    }
  } catch (e) {
    alert("Erro ao enviar imagem: " + e.message);
  } finally {
    fileInput.disabled = false;
    if (labelBtn && originalLabel) labelBtn.innerHTML = originalLabel;
  }
}

// ─── AÇAÍ BUILDER ────────────────────────────────────────────────

function addAcaiTamanho(dados = {}) {
  const lista = document.getElementById("acai-tamanhos-lista");
  const row = document.createElement("div");
  row.className = "acai-tamanho-row builder-item-row";
  const img = dados.img || "";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Nome</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: 300ml, Médio, G"></div>
      <div><label class="bir-label">Preço (Gs)</label><input data-f="preco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="0" min="0" step="500"></div>
      <div style="position:relative">
        <label class="bir-label">Imagem</label>
        <div style="display:flex;gap:4px">
          <input data-f="img" type="text" class="form-control" value="${img}" placeholder="URL ou 📷">
          <label style="cursor:pointer;background:#e8f4fd;border:1px solid #3498db;border-radius:6px;padding:5px 8px;font-size:0.75rem;white-space:nowrap">
            📷<input type="file" accept="image/*" style="display:none" onchange="uploadSaborImagem(this,this.closest('.acai-tamanho-row'))">
          </label>
        </div>
        ${img ? `<img class="img-preview-mini" src="${img}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">` : '<img class="img-preview-mini" style="display:none;width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">'}
      </div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.acai-tamanho-row').remove()">✕</button>`;
  lista.appendChild(row);
}

function addAcaiAcompanhamento(dados = {}) {
  const lista = document.getElementById("acai-acomp-lista");
  const row = document.createElement("div");
  row.className = "acai-acomp-row builder-item-row";
  const img = dados.img || "";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Nome</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Granola, Leite Condensado"></div>
      <div><label class="bir-label">Preço extra (Gs)</label><input data-f="preco" type="number" class="form-control" value="${dados.preco || 0}" placeholder="0 = incluído" min="0" step="100"></div>
      <div>
        <label class="bir-label">Imagem</label>
        <div style="display:flex;gap:4px">
          <input data-f="img" type="text" class="form-control" value="${img}" placeholder="URL ou 📷">
          <label style="cursor:pointer;background:#e8f4fd;border:1px solid #3498db;border-radius:6px;padding:5px 8px;font-size:0.75rem;white-space:nowrap">
            📷<input type="file" accept="image/*" style="display:none" onchange="uploadSaborImagem(this,this.closest('.acai-acomp-row'))">
          </label>
        </div>
        ${img ? `<img class="img-preview-mini" src="${img}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">` : '<img class="img-preview-mini" style="display:none;width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">'}
      </div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.acai-acomp-row').remove()">✕</button>`;
  lista.appendChild(row);
}

function addAcaiEtapa(titulo = "", max = 1, itens = []) {
  const container = document.getElementById("acai-etapas-container");
  const div = document.createElement("div");
  div.className = "etapa-item";
  const itensStr = Array.isArray(itens) ? itens.join(", ") : itens;
  div.innerHTML = `
    <div class="etapa-header">
      <input type="text" class="form-control step-titulo" value="${titulo}" placeholder="Título da etapa (ex: Frutas)">
      <input type="number" class="form-control step-max" value="${max}" style="width:70px" title="Máx. seleções">
      <button class="btn btn-sm btn-danger" onclick="this.parentElement.parentElement.remove()">✕</button>
    </div>
    <textarea class="etapa-ingredientes step-itens" placeholder="Itens separados por vírgula. Ex: Morango, Banana, Uva">${itensStr}</textarea>`;
  container.appendChild(div);
}

// ─── SUCO BUILDER ────────────────────────────────────────────────

function addSucoTamanho(dados = {}) {
  const lista = document.getElementById("suco-tamanhos-lista");
  const row = document.createElement("div");
  row.className = "suco-tamanho-row builder-item-row";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Nome</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: 300ml, 500ml, Grande"></div>
      <div><label class="bir-label">Preço (Gs)</label><input data-f="preco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="0" min="0" step="500"></div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.suco-tamanho-row').remove()">✕</button>`;
  lista.appendChild(row);
}

function addSucoEtapa(titulo = "", max = 1, itens = []) {
  const container = document.getElementById("suco-etapas-container");
  const div = document.createElement("div");
  div.className = "etapa-item";
  const itensStr = Array.isArray(itens) ? itens.join(", ") : itens;
  div.innerHTML = `
    <div class="etapa-header">
      <input type="text" class="form-control step-titulo" value="${titulo}" placeholder="Título da etapa (ex: Fruta principal)">
      <input type="number" class="form-control step-max" value="${max}" style="width:70px" title="Máx. seleções">
      <button class="btn btn-sm btn-danger" onclick="this.parentElement.parentElement.remove()">✕</button>
    </div>
    <textarea class="etapa-ingredientes step-itens" placeholder="Ex: Laranja, Limão, Maracujá">${itensStr}</textarea>`;
  container.appendChild(div);
}

// ─── SORVETE BUILDER ─────────────────────────────────────────────

function addSorveteTamanho(dados = {}) {
  const lista = document.getElementById("sorvete-tamanhos-lista");
  const row = document.createElement("div");
  row.className = "sorvete-tamanho-row builder-item-row";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Nome</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: 1 Bola, Duplo, 3 Bolas"></div>
      <div><label class="bir-label">Qtd. Bolas</label><input data-f="qtd_bolas" type="number" class="form-control" value="${dados.qtd_bolas || ""}" placeholder="1" min="1"></div>
      <div><label class="bir-label">Preço (Gs)</label><input data-f="preco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="0" min="0" step="500"></div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.sorvete-tamanho-row').remove()">✕</button>`;
  lista.appendChild(row);
}

function addSorveteSabor(dados = {}) {
  const lista = document.getElementById("sorvete-sabores-lista");
  const row = document.createElement("div");
  row.className = "sorvete-sabor-row builder-item-row";
  const img = dados.img || "";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Sabor</label><input data-f="nome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Chocolate, Morango, Baunilha"></div>
      <div><label class="bir-label">Preço extra (Gs)</label><input data-f="preco" type="number" class="form-control" value="${dados.preco || 0}" placeholder="0 = incluído" min="0" step="100"></div>
      <div>
        <label class="bir-label">Imagem</label>
        <div style="display:flex;gap:4px">
          <input data-f="img" type="text" class="form-control" value="${img}" placeholder="URL ou 📷">
          <label style="cursor:pointer;background:#e8f4fd;border:1px solid #3498db;border-radius:6px;padding:5px 8px;font-size:0.75rem">
            📷<input type="file" accept="image/*" style="display:none" onchange="uploadSaborImagem(this,this.closest('.sorvete-sabor-row'))">
          </label>
        </div>
        ${img ? `<img class="img-preview-mini" src="${img}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">` : '<img class="img-preview-mini" style="display:none;width:36px;height:36px;border-radius:6px;object-fit:cover;margin-top:4px">'}
      </div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.sorvete-sabor-row').remove()">✕</button>`;
  lista.appendChild(row);
}

function addSorveteEtapa(titulo = "", max = 1, itens = []) {
  const container = document.getElementById("sorvete-etapas-container");
  const div = document.createElement("div");
  div.className = "etapa-item";
  const itensStr = Array.isArray(itens) ? itens.join(", ") : itens;
  div.innerHTML = `
    <div class="etapa-header">
      <input type="text" class="form-control step-titulo" value="${titulo}" placeholder="Título da etapa (ex: Cobertura)">
      <input type="number" class="form-control step-max" value="${max}" style="width:70px" title="Máx. seleções">
      <button class="btn btn-sm btn-danger" onclick="this.parentElement.parentElement.remove()">✕</button>
    </div>
    <textarea class="etapa-ingredientes step-itens" placeholder="Ex: Calda de Chocolate, Caramelo, Granulado">${itensStr}</textarea>`;
  container.appendChild(div);
}

// ─── VARIAÇÃO SIMPLES (para açaí / sorvete) ──────────────────────
// Igual a addVariacao mas sem foto, para listas secundárias
function addVariacaoSimples(dados = {}, listaId) {
  const lista = document.getElementById(listaId);
  if (!lista) return;
  const row = document.createElement("div");
  row.className = "variacao-acai-row builder-item-row";
  row.innerHTML = `
    <div class="bir-fields">
      <div><label class="bir-label">Nome</label><input data-f="vnome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Tradicional, Premium"></div>
      <div><label class="bir-label">Preço extra (Gs)</label><input data-f="vpreco" type="number" class="form-control" value="${dados.preco || 0}" placeholder="0" min="0" step="100"></div>
    </div>
    <button class="btn btn-sm btn-danger bir-remove" onclick="this.closest('.variacao-acai-row').remove()">✕</button>`;
  lista.appendChild(row);
}

// ─── COMBO BUILDER ───────────────────────────────────────────────

async function _carregarComboSelect() {
  const container = document.getElementById("combo-produtos-selecionados");
  if (!container) return;
  container.innerHTML =
    '<div style="text-align:center;padding:10px;color:#aaa;font-size:0.82rem">Carregando produtos...</div>';
  const { data } = await supa
    .from("produtos")
    .select("id, nome, preco, categoria_slug")
    .eq("ativo", true)
    .order("nome");
  if (!data || !data.length) {
    container.innerHTML =
      '<div style="color:#aaa;font-size:0.82rem">Nenhum produto cadastrado.</div>';
    return;
  }
  const presel = window._comboItensPresel || [];
  container.innerHTML = data
    .map(
      (p) => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;border:1px solid ${presel.includes(p.id) ? "#1a7a2e" : "#eee"};background:${presel.includes(p.id) ? "#f0fff4" : "#fff"};margin-bottom:4px;transition:all 0.15s"
      onmousedown="this.style.borderColor='#1a7a2e';this.style.background='#f0fff4'">
      <input type="checkbox" value="${p.id}" ${presel.includes(p.id) ? "checked" : ""} style="width:16px;height:16px"
        onchange="this.closest('label').style.borderColor=this.checked?'#1a7a2e':'#eee';this.closest('label').style.background=this.checked?'#f0fff4':'#fff'">
      <span style="flex:1;font-size:0.87rem;font-weight:600">${p.nome}</span>
      <span style="font-size:0.78rem;color:#888">${p.categoria_slug || ""}</span>
      <span style="font-size:0.8rem;color:#27ae60;font-weight:700;white-space:nowrap">Gs ${(p.preco || 0).toLocaleString("es-PY")}</span>
    </label>`,
    )
    .join("");
}

// ─── DUPLICAR PRODUTO ────────────────────────────────────────────

async function duplicarProduto(id) {
  if (
    !confirm(
      'Duplicar este produto? Uma cópia será criada com o nome "(Cópia) ..."',
    )
  )
    return;
  const { data: p, error } = await supa
    .from("produtos")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !p) {
    alert("Erro ao buscar produto.");
    return;
  }
  const copia = { ...p };
  delete copia.id;
  delete copia.created_at;
  delete copia.updated_at;
  copia.nome = `(Cópia) ${p.nome}`;
  copia.ativo = false; // entra como pausado para revisão
  const { error: errIns } = await supa.from("produtos").insert([copia]);
  if (errIns) {
    alert("Erro ao duplicar: " + errIns.message);
    return;
  }
  alert(t("alert.produto_duplicado"));
  carregarProdutos();
}

function toggleExtras() {
  const ativo = document.getElementById("prod-tem-extras").checked;
  document.getElementById("extras-area").style.display = ativo
    ? "block"
    : "none";
}

function addExtra(dados = {}) {
  const lista = document.getElementById("extras-lista");
  const row = document.createElement("div");
  row.className = "extra-row";
  row.innerHTML = `
    <input data-f="enome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Wasabi, Ovo Frito">
    <input data-f="epreco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="Preço (Gs)">
    <button class="btn btn-sm btn-danger" onclick="this.closest('.extra-row').remove()" title="Remover">✕</button>
  `;
  lista.appendChild(row);
}

// ── PREPARO ──────────────────────────────────
function togglePreparo() {
  const ativo = document.getElementById("prod-tem-preparo").checked;
  document.getElementById("preparo-area").style.display = ativo
    ? "block"
    : "none";
}

function addOpcaoPreparo(valor = "") {
  const lista = document.getElementById("preparo-lista");
  const row = document.createElement("div");
  row.className = "extra-row preparo-row-admin";
  row.innerHTML = `
    <input class="form-control preparo-opcao-input" value="${valor}" placeholder="Ex: Salmão Flambado, Batata Frita">
    <button class="btn btn-sm btn-danger" onclick="this.closest('.preparo-row-admin').remove()" title="Remover">✕</button>
  `;
  lista.appendChild(row);
}

// ── ADICIONAIS GLOBAIS ────────────────────────
function addExtraGlobal(dados = {}) {
  const lista = document.getElementById("extras-globais-lista");
  const row = document.createElement("div");
  row.className = "extra-row";
  row.style.marginBottom = "8px";
  row.innerHTML = `
    <input data-f="gnome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Ex: Adicional Extra">
    <input data-f="gpreco" type="number" class="form-control" value="${dados.preco || 0}" placeholder="Preço (0 = Grátis)">
    <button class="btn btn-sm btn-danger" onclick="this.closest('.extra-row').remove()" title="Remover">✕</button>
  `;
  lista.appendChild(row);
}

async function salvarExtrasGlobais() {
  const extras = [];
  document
    .querySelectorAll("#extras-globais-lista .extra-row")
    .forEach((row) => {
      const nome = row.querySelector('[data-f="gnome"]').value.trim();
      const preco =
        parseFloat(row.querySelector('[data-f="gpreco"]').value) || 0;
      if (nome) extras.push({ nome, preco });
    });

  // Categorias selecionadas (null = todas)
  const catChips = document.querySelectorAll(
    '#extras-globais-cats-lista input[type="checkbox"]:checked',
  );
  const catsArr = [...catChips].map((c) => c.value);
  const catsVal = catsArr.length === 0 ? null : catsArr;

  const { error } = await supa
    .from("configuracoes")
    .update({
      extras_globais: extras,
      extras_globais_categorias: catsVal,
    })
    .gt("id", 0);
  if (error) {
    alert("Erro ao salvar adicionais globais: " + error.message);
    return;
  }
  alert("✅ Adicionais globais salvos!");
}

async function carregarExtrasGlobaisAdmin() {
  const lista = document.getElementById("extras-globais-lista");
  if (!lista) return;
  lista.innerHTML = "";
  try {
    const { data, error } = await supa
      .from("configuracoes")
      .select("extras_globais, extras_globais_categorias")
      .single();
    if (error) {
      console.warn("Extras globais:", error.message);
      return;
    }
    if (data?.extras_globais && Array.isArray(data.extras_globais))
      data.extras_globais.forEach((ex) => addExtraGlobal(ex));

    // Carrega categorias para o seletor
    const { data: cats } = await supa
      .from("categorias")
      .select("slug, nome_exibicao")
      .eq("ativa", true)
      .order("ordem");
    const catsContainer = document.getElementById("extras-globais-cats-lista");
    if (catsContainer && cats) {
      const selCats = data?.extras_globais_categorias || null;
      catsContainer.innerHTML = cats
        .map(
          (c) => `
        <label style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:var(--color-background-secondary);border-radius:6px;cursor:pointer;font-size:0.82rem">
          <input type="checkbox" value="${c.slug}" ${!selCats || selCats.includes(c.slug) ? "checked" : ""} style="width:15px;height:15px">
          ${c.nome_exibicao || c.slug}
        </label>`,
        )
        .join("");
    }
  } catch (e) {
    console.log("Extras globais:", e.message);
  }
}

// =========================================
// AVISAR ENCERRAMENTO DO DELIVERY
// =========================================

/**
 * Grava na tabela `configuracoes` um timestamp de encerramento
 * e um aviso visível para todos os clientes.
 *
 * Na tabela configuracoes precisam existir os campos:
 *   aviso_delivery  TEXT  (mensagem exibida no banner do site)
 *   delivery_aberto BOOLEAN (controla se o delivery está habilitado)
 */
async function avisarEncerramentoDelivery() {
  const modal = document.getElementById("modal-encerramento-delivery");
  if (modal) {
    modal.style.display = "flex";
    return;
  }

  // Cria o modal dinamicamente se não estiver no HTML
  const overlay = document.createElement("div");
  overlay.id = "modal-encerramento-delivery";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:24px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
        <h3 style="margin:0;font-size:1.1rem;color:#c0392b">🚫 Encerrar Delivery</h3>
        <button onclick="this.closest('#modal-encerramento-delivery').remove()" 
                style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#999">✕</button>
      </div>

      <p style="color:#555;font-size:0.9rem;margin-bottom:16px">
        Isso vai <strong>fechar o delivery imediatamente</strong> e exibir um aviso para os clientes no site.
      </p>

      <label style="font-weight:600;font-size:0.85rem;color:#333;display:block;margin-bottom:6px">
        Mensagem para os clientes (opcional):
      </label>
      <textarea id="aviso-encerramento-texto" rows="3"
        style="width:100%;padding:10px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.9rem;resize:vertical;box-sizing:border-box;margin-bottom:16px"
        placeholder="Ex: Delivery encerrado por hoje. Voltamos amanhã às 18h! 🍣"></textarea>

      <div style="display:flex;gap:10px">
        <button onclick="this.closest('#modal-encerramento-delivery').remove()"
                style="flex:1;padding:12px;background:#f5f5f5;color:#555;border:none;border-radius:8px;font-weight:600;cursor:pointer">
          Cancelar
        </button>
        <button onclick="_confirmarEncerramentoDelivery()"
                style="flex:1;padding:12px;background:#e74c3c;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer">
          🚫 Fechar Agora
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
}

async function _confirmarEncerramentoDelivery() {
  const texto =
    document.getElementById("aviso-encerramento-texto")?.value?.trim() ||
    "Delivery encerrado por hoje. Obrigado! 🍣";

  const { error } = await supa
    .from("configuracoes")
    .update({
      delivery_aberto: false,
      aviso_delivery: texto,
    })
    .gt("id", 0);

  if (error) {
    // Tenta com upsert se update falhou (configuracoes pode não ter a linha)
    const { error: e2 } = await supa.from("configuracoes").upsert({
      id: 1,
      delivery_aberto: false,
      aviso_delivery: texto,
    });
    if (e2) {
      alert(
        "Erro ao encerrar delivery: " +
          e2.message +
          "\n\n💡 Execute no Supabase:\nALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS delivery_aberto BOOLEAN DEFAULT true;\nALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS aviso_delivery TEXT DEFAULT '';",
      );
      return;
    }
  }

  document.getElementById("modal-encerramento-delivery")?.remove();
  alert(t("alert.delivery_encerrado"));

  // Atualiza badge no painel se existir
  const badge = document.getElementById("badge-delivery-status");
  if (badge) {
    badge.style.background = "#e74c3c";
    badge.textContent = "🔴 Delivery Fechado";
  }
}

async function reabrirDelivery() {
  if (!confirm("Reabrir o delivery para novos pedidos?")) return;

  const { error } = await supa
    .from("configuracoes")
    .update({
      delivery_aberto: true,
      aviso_delivery: "",
    })
    .gt("id", 0);

  if (error) {
    alert("Erro: " + error.message);
    return;
  }

  alert(t("alert.delivery_reaberto"));

  const badge = document.getElementById("badge-delivery-status");
  if (badge) {
    badge.style.background = "#27ae60";
    badge.textContent = "🟢 Delivery Aberto";
  }
}

// =========================================
// ESTENDER HORÁRIO DE FUNCIONAMENTO
// =========================================

/**
 * Abre um modal para adicionar minutos extras ao horário de hoje.
 * Grava em configuracoes.horario_extra_hoje = { data: 'YYYY-MM-DD', minutos: N }
 * O app.js deve ler este campo para calcular o horário real de fechamento.
 *
 * Execute no Supabase:
 *   ALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS horario_extra_hoje JSONB DEFAULT NULL;
 */
function abrirModalEstenderHorario() {
  const existente = document.getElementById("modal-estender-horario");
  if (existente) {
    existente.style.display = "flex";
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "modal-estender-horario";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:24px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
        <h3 style="margin:0;font-size:1.1rem;color:#2980b9">⏰ Estender Horário Hoje</h3>
        <button onclick="this.closest('#modal-estender-horario').remove()"
                style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#999">✕</button>
      </div>

      <p style="color:#555;font-size:0.88rem;margin-bottom:18px">
        Adicione minutos extras ao horário de hoje. O site aceitará pedidos por mais tempo.
      </p>

      <label style="font-weight:600;font-size:0.85rem;color:#333;display:block;margin-bottom:10px">
        Quantos minutos a mais?
      </label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px">
        ${[15, 30, 45, 60, 90, 120]
          .map(
            (m) => `
          <button onclick="_selecionarMinutosExtra(${m}, this)"
                  data-min="${m}"
                  style="padding:10px 16px;border:2px solid #e0e0e0;border-radius:8px;background:#f8f9fa;font-weight:700;cursor:pointer;font-size:0.9rem;transition:all 0.15s">
            +${m}min
          </button>`,
          )
          .join("")}
      </div>

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
        <label style="font-size:0.85rem;color:#666;white-space:nowrap">Ou digite:</label>
        <input type="number" id="input-minutos-extra" min="1" max="480" placeholder="ex: 45"
               oninput="document.querySelectorAll('[data-min]').forEach(b => b.style.background='#f8f9fa')"
               style="flex:1;padding:10px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.95rem;font-weight:700">
        <span style="color:#666;font-size:0.85rem">min</span>
      </div>

      <div style="display:flex;gap:10px">
        <button onclick="this.closest('#modal-estender-horario').remove()"
                style="flex:1;padding:12px;background:#f5f5f5;color:#555;border:none;border-radius:8px;font-weight:600;cursor:pointer">
          Cancelar
        </button>
        <button onclick="_confirmarEstenderHorario()"
                style="flex:1;padding:12px;background:#2980b9;color:white;border:none;border-radius:8px;font-weight:700;cursor:pointer">
          ⏰ Confirmar
        </button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
}

function _selecionarMinutosExtra(min, btn) {
  // Destaca o botão selecionado e limpa o input
  document.querySelectorAll("[data-min]").forEach((b) => {
    b.style.background = "#f8f9fa";
    b.style.borderColor = "#e0e0e0";
    b.style.color = "#333";
  });
  btn.style.background = "#2980b9";
  btn.style.borderColor = "#2980b9";
  btn.style.color = "#fff";
  const inp = document.getElementById("input-minutos-extra");
  if (inp) inp.value = min;
}

async function _confirmarEstenderHorario() {
  const inp = document.getElementById("input-minutos-extra");
  const minutos = parseInt(inp?.value || "0");
  if (!minutos || minutos < 1) {
    alert("Escolha quantos minutos deseja adicionar.");
    return;
  }

  const hoje = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const { error } = await supa
    .from("configuracoes")
    .update({
      horario_extra_hoje: { data: hoje, minutos },
    })
    .gt("id", 0);

  if (error) {
    const { error: e2 } = await supa.from("configuracoes").upsert({
      id: 1,
      horario_extra_hoje: { data: hoje, minutos },
    });
    if (e2) {
      alert(
        "Erro ao salvar: " +
          e2.message +
          "\n\n💡 Execute no Supabase:\nALTER TABLE configuracoes ADD COLUMN IF NOT EXISTS horario_extra_hoje JSONB DEFAULT NULL;",
      );
      return;
    }
  }

  document.getElementById("modal-estender-horario")?.remove();
  alert(`✅ Horário estendido em +${minutos} minutos hoje!`);
}

async function removerExtensaoHorario() {
  if (!confirm("Remover a extensão de horário de hoje?")) return;
  await supa
    .from("configuracoes")
    .update({ horario_extra_hoje: null })
    .gt("id", 0);
  alert("✅ Extensão removida.");
}

// Carrega status do delivery no painel (chamado no DOMContentLoaded / showTab)
async function carregarStatusDelivery() {
  const badge = document.getElementById("badge-delivery-status");
  if (!badge) return;
  try {
    const { data } = await supa
      .from("configuracoes")
      .select("delivery_aberto, aviso_delivery, horario_extra_hoje")
      .gt("id", 0)
      .single();

    if (!data) return;

    if (data.delivery_aberto === false) {
      badge.style.background = "#e74c3c";
      badge.textContent = "🔴 Delivery Fechado";
    } else {
      badge.style.background = "#27ae60";
      badge.textContent = "🟢 Delivery Aberto";
    }

    // Mostra extensão de horário se ativa hoje
    const hoje = new Date().toISOString().split("T")[0];
    const ext = data.horario_extra_hoje;
    const badgeExt = document.getElementById("badge-horario-extra");
    if (badgeExt) {
      if (ext && ext.data === hoje && ext.minutos > 0) {
        badgeExt.style.display = "inline-block";
        badgeExt.textContent = `⏰ +${ext.minutos}min hoje`;
      } else {
        badgeExt.style.display = "none";
      }
    }
  } catch (e) {
    // Colunas ainda não existem — ignora silenciosamente
  }
}

// --- CATEGORIAS ---
async function carregarCategorias() {
  const { data, error } = await supa
    .from("categorias")
    .select("*")
    .order("ordem");

  const grid = document.getElementById("lista-categorias");
  if (!grid) return;

  if (error) {
    grid.innerHTML = `<p style="color:red;padding:20px">Erro ao carregar categorias: ${error.message}</p>`;
    return;
  }

  if (!data || data.length === 0) {
    grid.innerHTML = `
      <div class="cat-empty">
        <i class="fas fa-tags" style="font-size:3rem;color:#ddd;margin-bottom:12px;display:block"></i>
        <p>Nenhuma categoria criada ainda.</p>
        <button class="btn btn-primary" onclick="abrirModalCategoria()"><i class="fas fa-plus"></i> Criar primeira categoria</button>
      </div>`;
    carregarSelectCategorias();
    return;
  }

  const paleta = [
    "#FF441F",
    "#3498db",
    "#2ecc71",
    "#9b59b6",
    "#e67e22",
    "#1abc9c",
    "#e74c3c",
    "#f39c12",
    "#34495e",
    "#00b894",
  ];

  grid.innerHTML = "";
  data.forEach((c, idx) => {
    const cor = paleta[idx % paleta.length];
    const cJson = JSON.stringify(c)
      .replace(/'/g, "&apos;")
      .replace(/"/g, "&quot;");
    const horarioBadge =
      c.hora_inicio && c.hora_fim
        ? `<span class="cat-badge cat-badge-horario">🕐 ${c.hora_inicio}–${c.hora_fim}${Array.isArray(c.dias_semana) && c.dias_semana.length ? " (" + c.dias_semana.join(",") + ")" : ""}</span>`
        : `<span class="cat-badge cat-badge-sempre">✅ Sempre visível</span>`;

    const card = document.createElement("div");
    card.className = "cat-card";
    card.style.borderTopColor = cor;
    card.setAttribute("draggable", "true");
    card.setAttribute("data-cat-slug", c.slug);
    card.setAttribute("data-cat-ordem", c.ordem);
    card.innerHTML = `
      <div class="cat-card-top">
        <div class="cat-drag-handle" title="Arraste para reordenar" style="cursor:grab; padding:0 8px 0 2px; color:#bbb; font-size:1.2rem; display:flex; align-items:center; user-select:none;">
          ⠿
        </div>
        <div class="cat-card-icon" style="background:${cor}20;color:${cor}">
          <i class="fas fa-tag"></i>
        </div>
        <div class="cat-card-info">
          <div class="cat-card-nome">${c.nome_exibicao}</div>
          <code class="cat-card-slug">${c.slug}</code>
        </div>
        <div class="cat-card-ordem" style="background:${cor}15;color:${cor}">#${c.ordem}</div>
      </div>
      <div class="cat-card-mid">${horarioBadge}</div>
      <div class="cat-card-actions">
        <button class="cat-btn cat-btn-sub" onclick="abrirPainelSubcategorias('${c.slug}')" title="Gerenciar Subcategorias">
          <i class="fas fa-layer-group"></i><span>Sub</span>
        </button>
        <button class="cat-btn cat-btn-edit" onclick='editarCategoria(${cJson})' title="Editar Categoria">
          <i class="fas fa-pen"></i><span>Editar</span>
        </button>
        <button class="cat-btn cat-btn-del" onclick="deletarCat('${c.slug}')" title="Excluir Categoria">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `;
    grid.appendChild(card);
  });

  // Inicializa drag & drop após renderizar
  iniciarDragDropCategorias(grid);

  carregarSelectCategorias();
}

// =========================================
// DRAG & DROP — REORDENAR CATEGORIAS
// =========================================
function iniciarDragDropCategorias(grid) {
  let draggingEl = null;
  let placeholder = null;

  // Cria o placeholder visual
  function criarPlaceholder() {
    const ph = document.createElement("div");
    ph.id = "cat-drag-placeholder";
    ph.style.cssText = `
      border: 2px dashed #FF441F;
      border-radius: 12px;
      background: rgba(255,68,31,0.05);
      min-height: 80px;
      transition: all 0.15s ease;
      opacity: 0.7;
    `;
    return ph;
  }

  grid.querySelectorAll(".cat-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      draggingEl = card;
      placeholder = criarPlaceholder();
      // Visual do card sendo arrastado
      setTimeout(() => {
        card.style.opacity = "0.4";
        card.style.transform = "scale(0.97)";
      }, 0);
      e.dataTransfer.effectAllowed = "move";
    });

    card.addEventListener("dragend", async () => {
      if (draggingEl) {
        draggingEl.style.opacity = "1";
        draggingEl.style.transform = "";
      }
      if (placeholder && placeholder.parentNode) placeholder.remove();
      draggingEl = null;
      placeholder = null;

      // Salva nova ordem no banco
      await salvarOrdemCategorias(grid);
    });

    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!draggingEl || draggingEl === card) return;

      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;

      if (placeholder.parentNode) placeholder.remove();

      if (e.clientY < midY) {
        grid.insertBefore(placeholder, card);
      } else {
        grid.insertBefore(placeholder, card.nextSibling);
      }
    });

    card.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!draggingEl || draggingEl === card) return;
      if (placeholder && placeholder.parentNode) {
        grid.insertBefore(draggingEl, placeholder);
        placeholder.remove();
      }
    });
  });

  // Permite soltar no próprio grid (área vazia)
  grid.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  grid.addEventListener("drop", (e) => {
    e.preventDefault();
    if (draggingEl && placeholder?.parentNode) {
      grid.insertBefore(draggingEl, placeholder);
      placeholder.remove();
    }
  });
}

async function salvarOrdemCategorias(grid) {
  const cards = grid.querySelectorAll(".cat-card[data-cat-slug]");
  const updates = [];
  cards.forEach((card, idx) => {
    const slug = card.getAttribute("data-cat-slug");
    if (slug) updates.push({ slug, ordem: idx + 1 });
    // Atualiza badge visual imediatamente
    const badge = card.querySelector(".cat-card-ordem");
    if (badge) badge.textContent = `#${idx + 1}`;
  });

  if (updates.length === 0) return;

  try {
    // Atualiza todos em paralelo
    await Promise.all(
      updates.map(({ slug, ordem }) =>
        supa.from("categorias").update({ ordem }).eq("slug", slug),
      ),
    );
    console.log(
      "✅ Ordem das categorias salva:",
      updates.map((u) => `${u.slug}=${u.ordem}`).join(", "),
    );

    // Feedback visual sutil
    const toastId = "toast-ordem";
    let toast = document.getElementById(toastId);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = toastId;
      toast.style.cssText = `
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
        background:#27ae60; color:white; padding:10px 22px; border-radius:24px;
        font-size:0.9rem; font-weight:600; z-index:9999;
        box-shadow:0 4px 16px rgba(0,0,0,0.2);
        animation: fadeInUp 0.3s ease;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = "✅ Ordem salva com sucesso!";
    toast.style.display = "block";
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.display = "none";
    }, 2500);
  } catch (err) {
    console.error("Erro ao salvar ordem:", err);
    alert("Erro ao salvar nova ordem. Tente novamente.");
  }
}

// Carrega o Select no Modal de Produto
async function carregarSelectCategorias(valorAtual = null) {
  const { data } = await supa.from("categorias").select("*").order("ordem");
  const sel = document.getElementById("prod-cat");
  if (!sel) return;

  // Preserva seleção atual se não foi passado valorAtual
  const valorPreservar = valorAtual || sel.value;

  sel.innerHTML = '<option value="">— Sem categoria —</option>';
  if (data) {
    data.forEach(
      (c) =>
        (sel.innerHTML += `<option value="${c.slug}">${c.nome_exibicao}</option>`),
    );
  }

  // Restaura seleção
  if (valorPreservar) sel.value = valorPreservar;
}

// =========================================
// SISTEMA DE SUBCATEGORIAS
// =========================================

// Carrega subcategorias no select do modal de produto
async function carregarSelectSubcategorias(
  categoriaSlag = "",
  valorAtual = "",
) {
  const sel = document.getElementById("prod-subcat");
  const box = document.getElementById("box-subcategoria");
  if (!sel) return;

  sel.innerHTML = '<option value="">— Sem subcategoria —</option>';

  if (!categoriaSlag) {
    if (box) box.style.display = "none";
    return;
  }

  try {
    const { data, error } = await supa
      .from("subcategorias")
      .select("*")
      .eq("categoria_slug", categoriaSlag)
      .order("ordem");

    if (error) {
      console.warn("Subcategorias indisponíveis:", error.message);
      // Mostra o box mesmo assim (com só a opção "sem subcategoria")
      if (box) box.style.display = "block";
      return;
    }

    // Sempre mostra o campo quando uma categoria está selecionada
    if (box) box.style.display = "block";

    if (data && data.length > 0) {
      data.forEach(
        (s) =>
          (sel.innerHTML += `<option value="${s.slug}">${s.nome_exibicao}</option>`),
      );
      if (valorAtual) sel.value = valorAtual;
    }
  } catch (e) {
    console.warn("Erro ao buscar subcategorias:", e);
    // Mostra mesmo assim — melhor mostrar vazio do que esconder sem avisar
    if (box) box.style.display = "block";
  }
}

// Chamado quando o usuário muda a categoria no modal de produto
async function onCatChange() {
  const catSlug = document.getElementById("prod-cat").value;
  await carregarSelectSubcategorias(catSlug, "");
}

// --- CRUD DE SUBCATEGORIAS ---
let _catSlugAtualSubcat = "";

async function carregarSubcategorias(categoriaSlag) {
  _catSlugAtualSubcat = categoriaSlag;
  const wrapper = document.getElementById("lista-subcategorias-wrapper");
  if (!wrapper) return;

  let html = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <h4 style="margin:0">Subcategorias de: <strong>${categoriaSlag}</strong></h4>
      <button class="btn btn-primary btn-sm" onclick="abrirModalSubcat()">+ Nova Subcategoria</button>
    </div>`;

  try {
    const { data, error } = await supa
      .from("subcategorias")
      .select("*")
      .eq("categoria_slug", categoriaSlag)
      .order("ordem");

    if (error) throw error;

    if (!data || data.length === 0) {
      html +=
        '<p style="color:#aaa;padding:10px 0">Nenhuma subcategoria criada ainda.</p>';
    } else {
      html +=
        '<table class="table"><thead><tr><th>Slug</th><th>Nome</th><th>Ordem</th><th></th></tr></thead><tbody>';
      data.forEach((s) => {
        const sJson = JSON.stringify(s)
          .replace(/'/g, "&apos;")
          .replace(/"/g, "&quot;");
        html += `<tr>
          <td>${s.slug}</td>
          <td>${s.nome_exibicao}</td>
          <td>${s.ordem}</td>
          <td class="actions-cell">
            <button class="btn btn-sm btn-info" onclick='editarSubcat(${sJson})'><i class="fas fa-edit"></i></button>
            <button class="btn btn-sm btn-danger" onclick="deletarSubcat('${s.slug}')"><i class="fas fa-trash"></i></button>
          </td>
        </tr>`;
      });
      html += "</tbody></table>";
    }
  } catch (e) {
    html += `<div style="background:#fff3cd;padding:12px;border-radius:8px;color:#856404;font-size:0.85rem">
      ⚠️ A tabela <strong>subcategorias</strong> ainda não existe no banco.<br>
      Execute o SQL abaixo no Supabase para ativá-la:<br><br>
      <code style="background:#f8f9fa;padding:4px 8px;border-radius:4px;font-size:0.8rem;display:block;white-space:pre-wrap">
CREATE TABLE subcategorias (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  nome_exibicao TEXT NOT NULL,
  categoria_slug TEXT REFERENCES categorias(slug) ON DELETE CASCADE,
  ordem INT DEFAULT 0
);
ALTER TABLE produtos ADD COLUMN IF NOT EXISTS subcategoria_slug TEXT REFERENCES subcategorias(slug) ON DELETE SET NULL;
      </code>
    </div>`;
  }

  wrapper.innerHTML = html;
}

function abrirModalSubcat(subcat = null) {
  const isEdit = !!subcat;
  const slugVal = subcat ? subcat.slug : "";
  const nomeVal = subcat ? subcat.nome_exibicao : "";
  const ordemVal = subcat ? subcat.ordem : "";

  const modalHtml = `
    <div id="modal-subcat" class="modal-overlay" style="display:flex">
      <div class="modal-content" style="max-width:400px">
        <h3>${isEdit ? "Editar Subcategoria" : "Nova Subcategoria"}</h3>
        <input type="hidden" id="subcat-modo" value="${isEdit ? "sim" : "nao"}">
        <input type="hidden" id="subcat-slug-original" value="${slugVal}">
        <div class="form-group">
          <label>Nome Exibição</label>
          <input type="text" id="subcat-nome" class="form-control" value="${nomeVal}" oninput="autoSlugFromSubcatNome()">
        </div>
        <div class="form-group">
          <label>Slug (ID único)</label>
          <input type="text" id="subcat-slug" class="form-control" value="${slugVal}">
          <small style="color:#888">Gerado automaticamente ou edite manualmente</small>
        </div>
        <div class="form-group">
          <label>Ordem</label>
          <input type="number" id="subcat-ordem" class="form-control" value="${ordemVal}">
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary" onclick="salvarSubcat()">Salvar</button>
          <button class="btn btn-secondary" onclick="document.getElementById('modal-subcat').remove()">Cancelar</button>
        </div>
      </div>
    </div>`;

  // Remove modal anterior se existir
  document.getElementById("modal-subcat")?.remove();
  document.body.insertAdjacentHTML("beforeend", modalHtml);
}

function editarSubcat(s) {
  abrirModalSubcat(s);
}

function autoSlugFromSubcatNome() {
  const nome = document.getElementById("subcat-nome").value;
  const slug = gerarSlug(nome);
  document.getElementById("subcat-slug").value = slug;
}

async function salvarSubcat() {
  const modo = document.getElementById("subcat-modo").value;
  const slugOriginal = document.getElementById("subcat-slug-original").value;
  const nome = document.getElementById("subcat-nome").value.trim();
  const slug = document.getElementById("subcat-slug").value.trim();
  const ordem = parseInt(document.getElementById("subcat-ordem").value) || 0;

  if (!slug || !nome) return alert("Preencha o slug e o nome!");

  const dados = {
    slug,
    nome_exibicao: nome,
    categoria_slug: _catSlugAtualSubcat,
    ordem,
  };

  let erro = null;
  if (modo === "sim") {
    const { error } = await supa
      .from("subcategorias")
      .update(dados)
      .eq("slug", slugOriginal);
    erro = error;
  } else {
    const { error } = await supa.from("subcategorias").insert([dados]);
    erro = error;
  }

  if (erro) {
    alert("Erro ao salvar: " + erro.message);
  } else {
    document.getElementById("modal-subcat")?.remove();
    carregarSubcategorias(_catSlugAtualSubcat);
  }
}

async function deletarSubcat(slug) {
  if (
    !confirm(
      `Deletar a subcategoria "${slug}"?\n\nOs produtos vinculados ficarão sem subcategoria.`,
    )
  )
    return;

  // Desvincula produtos
  await supa
    .from("produtos")
    .update({ subcategoria_slug: null })
    .eq("subcategoria_slug", slug);

  const { error } = await supa.from("subcategorias").delete().eq("slug", slug);
  if (error) alert("Erro: " + error.message);
  else carregarSubcategorias(_catSlugAtualSubcat);
}

// Utilitário: gera slug a partir de um texto
function gerarSlug(texto) {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^a-z0-9\s_]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

// Abre Modal de Edição (Recebe o objeto c inteiro)
function editarCategoria(c) {
  document.getElementById("titulo-modal-cat").innerText = "Editar Categoria";
  document.getElementById("cat-modo-edicao").value = "sim";

  const slugInput = document.getElementById("cat-slug");
  slugInput.value = c.slug;
  slugInput.readOnly = false; // Permite editar o slug
  slugInput.dataset.slugOriginal = c.slug; // Guarda o original para comparar

  document.getElementById("cat-nome").value = c.nome_exibicao;
  document.getElementById("cat-ordem").value = c.ordem;
  document.getElementById("cat-hora-inicio").value = c.hora_inicio || "";
  document.getElementById("cat-hora-fim").value = c.hora_fim || "";
  const diasSalvos = Array.isArray(c.dias_semana) ? c.dias_semana : [];
  document.querySelectorAll(".cat-dia-check").forEach((cb) => {
    cb.checked = diasSalvos.includes(cb.value);
  });

  document.getElementById("modal-cat").style.display = "flex";
}

async function salvarCategoria() {
  const slugInput = document.getElementById("cat-slug");
  const slug = slugInput.value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^a-z0-9\s_]/g, "")
    .replace(/\s+/g, "_");
  const nome = document.getElementById("cat-nome").value.trim();
  let ordemVal = parseInt(document.getElementById("cat-ordem").value);
  const modo = document.getElementById("cat-modo-edicao").value;
  const slugOriginal = slugInput.dataset.slugOriginal || slug;

  if (!slug || !nome) return alert("Preencha o slug e o nome!");

  // Se ordem não foi preenchida ou ficou 0 em modo inserção, busca a próxima automaticamente
  if ((!ordemVal || ordemVal === 0) && modo !== "sim") {
    const { data: ult } = await supa
      .from("categorias")
      .select("ordem")
      .order("ordem", { ascending: false })
      .limit(1);
    ordemVal =
      ult && ult.length > 0 && ult[0].ordem != null ? ult[0].ordem + 1 : 1;
  }

  let erro = null;

  if (modo === "sim") {
    const slugMudou = slug !== slugOriginal;

    if (slugMudou) {
      // 1. Insere novo registro com o novo slug
      const horaIni = document.getElementById("cat-hora-inicio").value || null;
      const horaFim = document.getElementById("cat-hora-fim").value || null;
      const dias = Array.from(
        document.querySelectorAll(".cat-dia-check:checked"),
      ).map((cb) => cb.value);
      const { error: insErr } = await supa.from("categorias").insert([
        {
          slug,
          nome: nome,
          nome_exibicao: nome,
          ordem: ordemVal,
          hora_inicio: horaIni,
          hora_fim: horaFim,
          dias_semana: dias.length > 0 ? dias : null,
        },
      ]);
      if (insErr) {
        alert("Erro ao salvar: " + insErr.message);
        return;
      }

      // 2. Migra todos os produtos do slug antigo para o novo
      await supa
        .from("produtos")
        .update({ categoria_slug: slug })
        .eq("categoria_slug", slugOriginal);

      // 3. Migra subcategorias (se existirem)
      try {
        await supa
          .from("subcategorias")
          .update({ categoria_slug: slug })
          .eq("categoria_slug", slugOriginal);
      } catch (_) {}

      // 4. Deleta o registro antigo
      const { error: delErr } = await supa
        .from("categorias")
        .delete()
        .eq("slug", slugOriginal);
      erro = delErr;
    } else {
      const { error } = await supa
        .from("categorias")
        .update({
          nome: nome,
          nome_exibicao: nome,
          ordem: ordemVal,
          hora_inicio: document.getElementById("cat-hora-inicio").value || null,
          hora_fim: document.getElementById("cat-hora-fim").value || null,
          dias_semana: (() => {
            const d = Array.from(
              document.querySelectorAll(".cat-dia-check:checked"),
            ).map((cb) => cb.value);
            return d.length > 0 ? d : null;
          })(),
        })
        .eq("slug", slugOriginal);
      erro = error;
    }
  } else {
    const { error } = await supa.from("categorias").insert([
      {
        slug,
        nome: nome,
        nome_exibicao: nome,
        ordem: ordemVal,
        hora_inicio: document.getElementById("cat-hora-inicio").value || null,
        hora_fim: document.getElementById("cat-hora-fim").value || null,
        dias_semana: (() => {
          const d = Array.from(
            document.querySelectorAll(".cat-dia-check:checked"),
          ).map((cb) => cb.value);
          return d.length > 0 ? d : null;
        })(),
      },
    ]);
    erro = error;
  }

  if (erro) alert("Erro ao salvar: " + erro.message);
  else {
    fecharModal("modal-cat");
    carregarCategorias();
  }
}

async function abrirModalCategoria() {
  document.getElementById("titulo-modal-cat").innerText = "Nova Categoria";
  document.getElementById("cat-modo-edicao").value = "nao";
  const slugInput = document.getElementById("cat-slug");
  slugInput.value = "";
  slugInput.readOnly = false;
  slugInput.dataset.slugOriginal = "";
  document.getElementById("cat-nome").value = "";
  document.getElementById("cat-hora-inicio").value = "";
  document.getElementById("cat-hora-fim").value = "";
  document
    .querySelectorAll(".cat-dia-check")
    .forEach((cb) => (cb.checked = false));

  // Auto-preenche a ordem com o próximo número
  try {
    const { data } = await supa
      .from("categorias")
      .select("ordem")
      .order("ordem", { ascending: false })
      .limit(1);
    const proximaOrdem =
      data && data.length > 0 && data[0].ordem != null ? data[0].ordem + 1 : 1;
    document.getElementById("cat-ordem").value = proximaOrdem;
  } catch (e) {
    document.getElementById("cat-ordem").value = "";
  }

  document.getElementById("modal-cat").style.display = "flex";
}

async function deletarProduto(id) {
  const confirmar = confirm(
    "⚠️ ATENÇÃO: Deletar este produto?\n\nEsta ação não pode ser desfeita. O produto será removido permanentemente do sistema.",
  );
  if (!confirmar) return;

  try {
    const { error } = await supa.from("produtos").delete().eq("id", id);
    if (error) {
      alert("❌ Erro ao deletar: " + error.message);
    } else {
      alert(t("alert.produto_excluido"));
      carregarProdutos();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}

async function pausarProduto(id, ativoAtual) {
  const novoStatus = !ativoAtual;
  const acao = novoStatus ? "reativar" : "pausar";
  if (!confirm(`Deseja ${acao} este produto?`)) return;

  const { error } = await supa
    .from("produtos")
    .update({ ativo: novoStatus })
    .eq("id", id);
  if (error) {
    alert("❌ Erro: " + error.message);
  } else {
    alert(novoStatus ? "✅ Produto reativado!" : "⏸️ Produto pausado!");
    carregarProdutos();
  }
}

async function deletarCat(slug) {
  // Verifica quantos produtos usam esta categoria
  const { count } = await supa
    .from("produtos")
    .select("*", { count: "exact", head: true })
    .eq("categoria_slug", slug);

  let msg = `⚠️ ATENÇÃO: Deletar a categoria "${slug}"?\n\nEsta ação não pode ser desfeita.`;
  if (count > 0) {
    msg += `\n\n⚠️ ${count} produto(s) usam esta categoria e ficarão sem categoria após a exclusão.`;
  }

  const confirmar = confirm(msg);
  if (!confirmar) return;

  try {
    // Primeiro: desvincula todos os produtos desta categoria
    if (count > 0) {
      await supa
        .from("produtos")
        .update({ categoria_slug: null, subcategoria_slug: null })
        .eq("categoria_slug", slug);
    }

    // Segundo: remove subcategorias vinculadas (se a tabela existir)
    try {
      await supa.from("subcategorias").delete().eq("categoria_slug", slug);
    } catch (_) {
      /* tabela pode não existir ainda */
    }

    // Terceiro: deleta a categoria
    const { error } = await supa.from("categorias").delete().eq("slug", slug);
    if (error) {
      alert("❌ Erro ao deletar: " + error.message);
    } else {
      alert("✅ Categoria deletada com sucesso!");
      carregarCategorias();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}

// Abre o painel de subcategorias abaixo da tabela de categorias
function abrirPainelSubcategorias(categoriaSlug) {
  const painel = document.getElementById("lista-subcategorias-wrapper");
  if (!painel) return;
  painel.style.display = "block";
  painel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  carregarSubcategorias(categoriaSlug);
}

// Auto-gera o slug a partir do nome da categoria (modal de categoria)
function autoSlugFromNome() {
  const modo = document.getElementById("cat-modo-edicao")?.value;
  // Só auto-gera o slug se for criação (não edição)
  if (modo === "sim") return;
  const nome = document.getElementById("cat-nome").value;
  document.getElementById("cat-slug").value = gerarSlug(nome);
}

async function deletarMotoboy(id) {
  const confirmar = confirm(
    "⚠️ ATENÇÃO: Deletar este motoboy?\n\nEsta ação não pode ser desfeita.",
  );
  if (!confirmar) return;

  try {
    const { error } = await supa.from("motoboys").delete().eq("id", id);
    if (error) {
      if (
        error.code === "23503" ||
        (error.message && error.message.includes("foreign key"))
      ) {
        alert(
          "❌ Não é possível excluir este motoboy pois ele possui pedidos vinculados.\n\nDica: Você pode desativar o motoboy em vez de excluir.",
        );
      } else {
        alert("❌ Erro ao deletar: " + error.message);
      }
    } else {
      alert("✅ Motoboy deletado com sucesso!");
      carregarMotoboys();
      carregarMotoboysSelect();
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  }
}
async function carregarMotoboys() {
  const { data, error } = await supa.from("motoboys").select("*").order("nome");

  // Log limpo: só mostra se houver erro real
  if (error) console.error("❌ carregarMotoboys error:", error);

  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    const wrapper = document.getElementById("lista-motos-wrapper");
    let container = document.getElementById("mobile-motos");

    if (!container) {
      container = document.createElement("div");
      container.className = "mobile-cards-container";
      container.id = "mobile-motos";
      const tableContainer = wrapper.querySelector(".table-container");
      if (tableContainer) {
        wrapper.insertBefore(container, tableContainer);
      }
    }

    container.innerHTML = "";

    if (!error && data && data.length > 0) {
      data.forEach((m) => {
        const card = document.createElement("div");
        card.className = "mobile-card";
        card.innerHTML = `
                    <div class="mobile-card-header">
                        <div class="mobile-card-title">
                            <i class="fas fa-motorcycle" style="color:var(--primary);margin-right:8px;"></i>
                            ${m.nome}
                        </div>
                    </div>
                    <div class="mobile-card-body">
                        <div class="mobile-card-row">
                            <span class="mobile-card-label">Telefone:</span>
                            <span class="mobile-card-value">${m.telefone || "-"}</span>
                        </div>
                    </div>
                    <div class="mobile-card-actions">
                        <button class="btn btn-info" onclick='editarMoto(${JSON.stringify(m).replace(/'/g, "&apos;").replace(/"/g, "&quot;")})'>
                            <i class="fas fa-edit"></i> Editar
                        </button>
                        <button class="btn btn-danger" onclick="deletarMotoboy(${m.id})">
                            <i class="fas fa-trash"></i> Excluir
                        </button>
                    </div>
                `;
        container.appendChild(card);
      });
    } else {
      container.innerHTML =
        '<p style="text-align:center;padding:20px;color:#999">Nenhum motoboy cadastrado.</p>';
    }

    // Esconde tabela desktop no mobile
    const tableContainer = wrapper.querySelector(".table-container");
    if (tableContainer) tableContainer.style.display = "none";

    return;
  }

  // CÓDIGO DESKTOP
  const wrapper = document.getElementById("lista-motos-wrapper");
  const tableContainer = wrapper
    ? wrapper.querySelector(".table-container")
    : null;
  if (tableContainer) tableContainer.style.display = "block"; // Mostra tabela no desktop

  const tbody = document.getElementById("lista-motos");
  if (!tbody) {
    console.error("❌ Elemento lista-motos não encontrado!");
    return;
  }

  tbody.innerHTML = "";

  if (error) {
    console.error("❌ Erro ao carregar motoboys:", error);
    tbody.innerHTML =
      '<tr><td colspan="3" style="text-align:center;color:red">Erro ao carregar motoboys</td></tr>';
    return;
  }

  if (data && data.length > 0) {
    data.forEach((m) => {
      const mJson = JSON.stringify(m)
        .replace(/'/g, "'")
        .replace(/"/g, "&quot;");
      tbody.innerHTML += `
                <tr>
                    <td data-label="Nome">${m.nome}</td>
                    <td data-label="Telefone">${m.telefone || "-"}</td>
                    <td class="actions-cell">
                        <button class="btn btn-sm btn-info" onclick='editarMoto(${mJson})'>
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-sm btn-danger" onclick="deletarMotoboy(${m.id})">
                            <i class="fas fa-trash"></i>
                        </button>
                    </td>
                </tr>
            `;
    });
  } else {
    tbody.innerHTML =
      '<tr><td colspan="3" style="text-align:center">Nenhum motoboy cadastrado.</td></tr>';
  }
}

// Função chamada pelo botão editar
function editarMoto(m) {
  document.getElementById("moto-id").value = m.id;
  document.getElementById("moto-nome").value = m.nome;
  document.getElementById("moto-tel").value = m.telefone || "";
  document.getElementById("modal-moto").style.display = "flex";
}

function abrirModalMoto() {
  document.getElementById("moto-id").value = "";
  document.getElementById("moto-nome").value = "";
  document.getElementById("moto-tel").value = "";
  document.getElementById("modal-moto").style.display = "flex";
}

async function salvarMotoboy() {
  const dados = {
    nome: document.getElementById("moto-nome").value,
    telefone: document.getElementById("moto-tel").value,
  };
  const id = document.getElementById("moto-id").value;

  if (!dados.nome || !dados.nome.trim()) {
    alert("❌ Nome do motoboy é obrigatório!");
    return;
  }

  try {
    if (id) {
      const { error } = await supa.from("motoboys").update(dados).eq("id", id);
      if (error) throw error;
    } else {
      const { error } = await supa.from("motoboys").insert([dados]);
      if (error) throw error;
    }

    alert(t("alert.moto_salvo"));
    fecharModal("modal-moto");
    carregarMotoboys();
    carregarMotoboysSelect(); // Atualiza o select da Rota
  } catch (e) {
    alert("❌ Erro ao salvar: " + e.message);
  }
}

async function carregarMotoboysSelect() {
  const { data } = await supa.from("motoboys").select("*");
  const sel = document.getElementById("sel-motoboy");
  if (!sel) return;
  sel.innerHTML = '<option value="">Selecione...</option>';
  if (data) {
    data.forEach((m) => {
      sel.innerHTML += `<option value="${m.id}" data-tel="${m.telefone}" data-nome="${m.nome}">${m.nome}</option>`;
    });
  }
}

// =========================================
// MOTOBOYS (CORRIGIDO)
// =========================================

// === CONFIGURAÇÕES (COMPLETO) ===

function _getDiasSemana() {
  return [
    { key: "seg", label: t("dia.seg") },
    { key: "ter", label: t("dia.ter") },
    { key: "qua", label: t("dia.qua") },
    { key: "qui", label: t("dia.qui") },
    { key: "sex", label: t("dia.sex") },
    { key: "sab", label: t("dia.sab") },
    { key: "dom", label: t("dia.dom") },
  ];
}
// Mantém compatibilidade com referências diretas a DIAS_SEMANA
const DIAS_SEMANA = _getDiasSemana();

function _renderGradeSemanal(horariosSalvos = {}) {
  const container = document.getElementById("grade-semanal");
  if (!container) return;
  container.innerHTML = "";

  // Botão "Aplicar a todos"
  const applyBar = document.createElement("div");
  applyBar.style.cssText =
    "display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:10px 12px;background:var(--color-background-secondary);border-radius:10px;flex-wrap:wrap";
  applyBar.innerHTML = `
    <span style="font-size:0.82rem;font-weight:600;color:var(--color-text-secondary)">${t("grade.aplicar_titulo")}</span>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input type="time" id="apply-all-abre" style="padding:5px 8px;border:1.5px solid var(--color-border-secondary);border-radius:6px;font-size:0.85rem">
      <span style="font-size:0.8rem;color:var(--color-text-secondary)">→</span>
      <input type="time" id="apply-all-fecha" style="padding:5px 8px;border:1.5px solid var(--color-border-secondary);border-radius:6px;font-size:0.85rem">
      <button onclick="_aplicarHorarioTodos()" class="btn btn-sm btn-primary">${t("grade.aplicar_btn")}</button>
    </div>`;
  container.appendChild(applyBar);

  const ICONES_DIA = {
    seg: "☀️",
    ter: "☀️",
    qua: "☀️",
    qui: "☀️",
    sex: "🌟",
    sab: "🎉",
    dom: "🌙",
  };

  _getDiasSemana().forEach(({ key, label }) => {
    const dia = horariosSalvos[key] || {
      fechado: false,
      turnos: [{ abre: "", fecha: "" }],
    };
    const fechado = dia.fechado === true;
    const turnos =
      dia.turnos && dia.turnos.length > 0
        ? dia.turnos
        : [{ abre: "", fecha: "" }];

    const row = document.createElement("div");
    row.className = `gs-dia-card ${fechado ? "gs-fechado" : "gs-aberto"}`;
    row.dataset.dia = key;

    let turnosHtml = turnos
      .map(
        (turno, i) => `
      <div class="gs-turno-row" data-idx="${i}">
        <span class="gs-turno-label">${i === 0 ? t("grade.turno_1") : t("grade.turno_2")}</span>
        <div class="gs-turno-inputs">
          <div class="gs-time-group">
            <span class="gs-time-label">${t("grade.das")}</span>
            <input type="time" class="gs-time-input turno-abre" value="${turno.abre || ""}">
          </div>
          <span class="gs-time-sep">→</span>
          <div class="gs-time-group">
            <span class="gs-time-label">${t("grade.ate")}</span>
            <input type="time" class="gs-time-input turno-fecha" value="${turno.fecha || ""}">
          </div>
          ${i > 0 ? `<button class="gs-btn-rm" onclick="removerTurno(this)" title="Remover turno">✕</button>` : '<div style="width:28px"></div>'}
        </div>
      </div>`,
      )
      .join("");

    row.innerHTML = `
      <div class="gs-dia-header">
        <div class="gs-dia-info">
          <span class="gs-dia-icone">${ICONES_DIA[key] || "📅"}</span>
          <span class="gs-dia-nome">${label}</span>
        </div>
        <div class="gs-dia-controls">
          <span class="gs-status-badge ${fechado ? "gs-badge-fechado" : "gs-badge-aberto"}">
            ${fechado ? t("grade.fechado") : t("grade.aberto")}
          </span>
          <label class="gs-toggle-wrap">
            <input type="checkbox" class="dia-fechado-check" ${fechado ? "checked" : ""} onchange="toggleDiaFechado(this)">
            <span class="gs-toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="gs-dia-turnos" style="${fechado ? "display:none" : ""}">
        <div class="gs-turnos-lista">${turnosHtml}</div>
        <button class="gs-btn-add-turno btn-add-turno" onclick="adicionarTurno(this)">
          <i class="fas fa-plus"></i> ${t("grade.add_turno")}
        </button>
      </div>
    `;
    container.appendChild(row);
  });
}

function toggleDiaFechado(checkbox) {
  const row = checkbox.closest(".gs-dia-card");
  const turnos = row.querySelector(".gs-dia-turnos");
  const badge = row.querySelector(".gs-status-badge");
  if (checkbox.checked) {
    if (turnos) turnos.style.display = "none";
    row.classList.add("gs-fechado");
    row.classList.remove("gs-aberto");
    if (badge) {
      badge.textContent = t("grade.fechado");
      badge.className = "gs-status-badge gs-badge-fechado";
    }
  } else {
    if (turnos) turnos.style.display = "";
    row.classList.add("gs-aberto");
    row.classList.remove("gs-fechado");
    if (badge) {
      badge.textContent = t("grade.aberto");
      badge.className = "gs-status-badge gs-badge-aberto";
    }
  }
}

function adicionarTurno(btn) {
  const lista = btn.previousElementSibling;
  const idx = lista.querySelectorAll(".gs-turno-row").length;
  if (idx >= 2) {
    alert(t("grade.max_turnos"));
    return;
  }
  const div = document.createElement("div");
  div.className = "gs-turno-row";
  div.dataset.idx = idx;
  div.innerHTML = `
    <span class="gs-turno-label">${t("grade.turno_2")}</span>
    <div class="gs-turno-inputs">
      <div class="gs-time-group">
        <span class="gs-time-label">${t("grade.das")}</span>
        <input type="time" class="gs-time-input turno-abre">
      </div>
      <span class="gs-time-sep">→</span>
      <div class="gs-time-group">
        <span class="gs-time-label">${t("grade.ate")}</span>
        <input type="time" class="gs-time-input turno-fecha">
      </div>
      <button class="gs-btn-rm btn-rm-turno" onclick="removerTurno(this)" title="Remover turno">✕</button>
    </div>
  `;
  lista.appendChild(div);
}

function removerTurno(btn) {
  btn.closest(".gs-turno-row").remove();
}

function _aplicarHorarioTodos() {
  const abre = document.getElementById("apply-all-abre")?.value;
  const fecha = document.getElementById("apply-all-fecha")?.value;
  if (!abre || !fecha) {
    alert(t("grade.preencha_horario"));
    return;
  }
  document.querySelectorAll(".gs-dia-card").forEach((row) => {
    // Desmarca "fechado"
    const check = row.querySelector(".dia-fechado-check");
    if (check && check.checked) {
      check.checked = false;
      toggleDiaFechado(check);
    }
    // Remove turnos extras
    row.querySelectorAll(".gs-turno-row").forEach((t, i) => {
      if (i > 0) t.remove();
    });
    // Define horário do 1º turno
    const turnoAbre = row.querySelector(".turno-abre");
    const turnoFecha = row.querySelector(".turno-fecha");
    if (turnoAbre) turnoAbre.value = abre;
    if (turnoFecha) turnoFecha.value = fecha;
  });
  alert(t("grade.aplicado_ok"));
}

/* ══════════════════════════════════════════════
   SHAKE BUILDER — Tamanhos + Sabores
   ══════════════════════════════════════════════ */
function addShakeTamanho(dados = {}) {
  const lista = document.getElementById("shake-tamanhos-lista");
  if (!lista) return;
  const row = document.createElement("div");
  row.className = "shake-tamanho-row";
  row.style.cssText =
    "display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #dde;border-radius:8px;padding:8px 10px;";
  row.innerHTML = `
    <div style="flex:2">
      <label style="font-size:0.72rem;color:#888">Nome</label>
      <input data-f="snome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: P, M, G, 500ml">
    </div>
    <div style="flex:1">
      <label style="font-size:0.72rem;color:#888">Volume (ml)</label>
      <input data-f="sml" type="number" class="form-control" value="${dados.ml || ""}" placeholder="400">
    </div>
    <div style="flex:2">
      <label style="font-size:0.72rem;color:#888">Preço (Gs)</label>
      <input data-f="spreco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="15000">
    </div>
    <button onclick="this.closest('.shake-tamanho-row').remove()" style="background:none;border:none;color:#e74c3c;font-size:1.2rem;cursor:pointer;padding:0 4px;flex-shrink:0">✕</button>
  `;
  lista.appendChild(row);
}

function addShakeSabor(dados = {}) {
  const lista = document.getElementById("shake-sabores-lista");
  if (!lista) return;
  const row = document.createElement("div");
  row.className = "shake-sabor-row";
  row.style.cssText =
    "display:flex;gap:8px;align-items:center;background:#fff;border:1px solid #dde;border-radius:8px;padding:8px 10px;";
  row.innerHTML = `
    <div style="flex:3">
      <label style="font-size:0.72rem;color:#888">Sabor</label>
      <input data-f="snome" class="form-control" value="${dados.nome || ""}" placeholder="Ex: Morango, Chocolate">
    </div>
    <div style="flex:2">
      <label style="font-size:0.72rem;color:#888">Preço extra (Gs)</label>
      <input data-f="spreco" type="number" class="form-control" value="${dados.preco || ""}" placeholder="0">
    </div>
    <div style="flex:2">
      <label style="font-size:0.72rem;color:#888">URL Foto (opcional)</label>
      <input data-f="simg" class="form-control" value="${dados.img || ""}" placeholder="https://...">
    </div>
    <button onclick="this.closest('.shake-sabor-row').remove()" style="background:none;border:none;color:#e74c3c;font-size:1.2rem;cursor:pointer;padding:0 4px;flex-shrink:0">✕</button>
  `;
  lista.appendChild(row);
}

function _popularShakeBuilder(shakeConfig) {
  document.getElementById("shake-tamanhos-lista").innerHTML = "";
  document.getElementById("shake-sabores-lista").innerHTML = "";
  if (!shakeConfig) return;
  (shakeConfig.tamanhos || []).forEach((t) => addShakeTamanho(t));
  (shakeConfig.sabores || []).forEach((s) => addShakeSabor(s));
}

function _lerGradeSemanal() {
  const horarios = {};
  document.querySelectorAll(".gs-dia-card").forEach((row) => {
    const key = row.dataset.dia;
    const fechado = row.querySelector(".dia-fechado-check").checked;
    const turnos = [];
    row.querySelectorAll(".gs-turno-row").forEach((t) => {
      const abre = t.querySelector(".turno-abre").value;
      const fecha = t.querySelector(".turno-fecha").value;
      if (abre || fecha) turnos.push({ abre, fecha });
    });
    horarios[key] = {
      fechado,
      turnos: fechado ? [] : turnos.length ? turnos : [{ abre: "", fecha: "" }],
    };
  });
  return horarios;
}

async function carregarConfiguracoes() {
  // Gestão de cupons: apenas dono, gerente e adminMaster
  const _cardCupons = document.getElementById("card-cupons-cfg");
  if (_cardCupons)
    _cardCupons.style.display = ["dono", "gerente", "adminMaster"].includes(
      perfilUsuario,
    )
      ? ""
      : "none";

  // Painel adminMaster
  const _cardAM = document.getElementById("card-adminmaster-cfg");
  if (_cardAM) {
    _cardAM.style.display = perfilUsuario === "adminMaster" ? "" : "none";
    if (perfilUsuario === "adminMaster") renderPainelFeatures();
  }

  const { data } = await supa.from("configuracoes").select("*").maybeSingle();
  _renderGradeSemanal((data && data.horarios_semanais) || {});
  _renderTabelaFrete((data && data.tabela_frete) || null);
  if (!data) return;

  const s = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val ?? "";
  };
  // Operação
  s("cfg-aberta", data.loja_aberta ? "true" : "false");
  s("cfg-cotacao", data.cotacao_real);

  // Identidade da loja
  s("cfg-nome-restaurante", data.nome_restaurante);
  s("cfg-descricao-loja", data.descricao_loja);
  s("cfg-url-loja", data.url_loja);
  s("cfg-telefone-loja", data.telefone_loja);
  s("cfg-whatsapp-loja", data.whatsapp_loja);
  s("cfg-logo-url", data.logo_url || data.icone_url);

  // Pagamento
  s("cfg-chave-pix", data.chave_pix);
  s("cfg-nome-pix", data.nome_pix);
  s("cfg-dados-alias", data.dados_alias);
  s("cfg-nome-alias", data.nome_alias);

  // Localização
  s("cfg-coord-lat", data.coord_lat);
  s("cfg-coord-lng", data.coord_lng);

  // Banner 1
  s("cfg-banner-id", data.banner_produto_id || "");
  s("cfg-banner-img", data.banner_imagem || "");
  s("cfg-banner-desc-tipo", data.banner_desconto_tipo || "percentual");
  s("cfg-banner-desc-valor", data.banner_desconto_valor ?? "");
  if (data.banner_imagem) {
    const prev = document.getElementById("cfg-banner-preview");
    const box = document.getElementById("cfg-banner-preview-box");
    if (prev) prev.src = data.banner_imagem;
    if (box) box.style.display = "block";
  }
  // Banner 2
  s("cfg-banner2-id", data.banner2_produto_id || "");
  s("cfg-banner2-img", data.banner2_imagem || "");
  s("cfg-banner2-desc-tipo", data.banner2_desconto_tipo || "percentual");
  s("cfg-banner2-desc-valor", data.banner2_desconto_valor ?? "");
  if (data.banner2_imagem) {
    const prev2 = document.getElementById("cfg-banner2-preview");
    const box2 = document.getElementById("cfg-banner2-preview-box");
    if (prev2) prev2.src = data.banner2_imagem;
    if (box2) box2.style.display = "block";
  }

  // Visual
  const sc = (id, val) => {
    const el = document.getElementById(id);
    if (el && val) el.value = val;
  };
  sc("cfg-nome-loja", data.nome_restaurante || data.nome_loja);
  sc("cfg-cor-primaria", data.cor_primaria);
  sc("cfg-cor-primaria-hex", data.cor_primaria);

  const corPicker = document.getElementById("cfg-cor-primaria");
  const corHex = document.getElementById("cfg-cor-primaria-hex");
  if (corPicker && corHex) {
    corPicker.addEventListener("input", (e) => {
      corHex.value = e.target.value;
    });
    corHex.addEventListener("input", (e) => {
      if (e.target.value.startsWith("#") && e.target.value.length === 7)
        corPicker.value = e.target.value;
    });
  }

  const iconeUrlInput = document.getElementById("cfg-icone-url");
  const iconePreview = document.getElementById("cfg-icone-preview");
  const logoVal = data.logo_url || data.icone_url || "";
  if (iconeUrlInput) iconeUrlInput.value = logoVal;
  if (iconePreview && logoVal) {
    iconePreview.src = logoVal;
    iconePreview.style.display = "block";
  }

  // Globals
  if (data.nome_restaurante) NOME_RESTAURANTE = data.nome_restaurante;
  if (data.whatsapp_loja) WHATSAPP_LOJA_CFG = data.whatsapp_loja;
  if (data.coord_lat) COORD_LOJA.lat = parseFloat(data.coord_lat);
  if (data.coord_lng) COORD_LOJA.lng = parseFloat(data.coord_lng);
  if (data.chave_pix) CHAVE_PIX_CFG = data.chave_pix;
  if (data.nome_pix) NOME_PIX_CFG = data.nome_pix;
  if (data.dados_alias) DADOS_ALIAS_CFG = data.dados_alias;
  if (data.nome_alias) NOME_ALIAS_CFG = data.nome_alias;

  await carregarExtrasGlobaisAdmin();
  await _carregarMaquininhas();

  // Limite de distância e maquininhas
  s("cfg-limite-distancia", data.limite_distancia_km ?? "");
  s("cfg-taxa-motoboy-base", data.taxa_motoboy_base ?? 0);
  TAXA_MOTOBOY = data.taxa_motoboy_base ?? 0;
  const combEl = document.getElementById("cfg-combustivel");
  if (combEl) {
    const saved = data.ajuda_combustivel ?? 0;
    combEl.value = saved;
    AJUDA_COMBUSTIVEL = saved;
  }
}

async function salvarConfiguracoes() {
  const g = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : null;
  };
  const dados = {
    loja_aberta: g("cfg-aberta") === "true",
    cotacao_real: parseFloat(g("cfg-cotacao")) || 1100,
    banner_produto_id: parseInt(g("cfg-banner-id")) || null,
    banner_imagem: g("cfg-banner-img") || "",
    banner_desconto_tipo: g("cfg-banner-desc-tipo") || null,
    banner_desconto_valor: parseFloat(g("cfg-banner-desc-valor")) || null,
    banner2_produto_id: parseInt(g("cfg-banner2-id")) || null,
    banner2_imagem: g("cfg-banner2-img") || "",
    banner2_desconto_tipo: g("cfg-banner2-desc-tipo") || null,
    banner2_desconto_valor: parseFloat(g("cfg-banner2-desc-valor")) || null,
    horarios_semanais: _lerGradeSemanal(),
    // Identidade
    nome_restaurante: g("cfg-nome-restaurante") || "",
    descricao_loja: g("cfg-descricao-loja") || "",
    url_loja: g("cfg-url-loja") || "",
    telefone_loja: g("cfg-telefone-loja") || "",
    whatsapp_loja: (g("cfg-whatsapp-loja") || "").replace(/\D/g, ""),
    logo_url: g("cfg-logo-url") || "",
    icone_url: g("cfg-logo-url") || "",
    // Pagamento
    chave_pix: g("cfg-chave-pix") || "",
    nome_pix: g("cfg-nome-pix") || "",
    dados_alias: g("cfg-dados-alias") || "",
    nome_alias: g("cfg-nome-alias") || "",
    // Localização
    coord_lat: parseFloat(g("cfg-coord-lat")) || 0,
    coord_lng: parseFloat(g("cfg-coord-lng")) || 0,
    // Motoboy
    taxa_motoboy_base: parseInt(g("cfg-taxa-motoboy-base")) || 0,
    // Visual
    cor_primaria: g("cfg-cor-primaria") || "#1a7a2e",
  };

  // Aplica globals imediatamente
  NOME_RESTAURANTE = dados.nome_restaurante;
  WHATSAPP_LOJA_CFG = dados.whatsapp_loja;
  COORD_LOJA.lat = dados.coord_lat;
  COORD_LOJA.lng = dados.coord_lng;
  TAXA_MOTOBOY = dados.taxa_motoboy_base;
  CHAVE_PIX_CFG = dados.chave_pix;
  NOME_PIX_CFG = dados.nome_pix;
  DADOS_ALIAS_CFG = dados.dados_alias;
  NOME_ALIAS_CFG = dados.nome_alias;

  const { error } = await supa.from("configuracoes").update(dados).gt("id", 0);
  if (error) alert("Erro: " + error.message);
  else alert(t("alert.cfg_salvas"));
}

function previewBanner(input, num = 1) {
  if (!input.files || !input.files[0]) return;
  const suf = num === 2 ? "2" : "";
  const reader = new FileReader();
  reader.onload = (e) => {
    const prev = document.getElementById(`cfg-banner${suf}-preview`);
    const box = document.getElementById(`cfg-banner${suf}-preview-box`);
    if (prev) prev.src = e.target.result;
    if (box) box.style.display = "block";
  };
  reader.readAsDataURL(input.files[0]);
}

async function salvarBanner(num = 1) {
  const suf = num === 2 ? "2" : "";
  const fileInput = document.getElementById(`cfg-banner${suf}-file`);
  const prodId = document.getElementById(`cfg-banner${suf}-id`)?.value?.trim();
  const descTipo =
    document.getElementById(`cfg-banner${suf}-desc-tipo`)?.value || null;
  const descValor =
    parseFloat(document.getElementById(`cfg-banner${suf}-desc-valor`)?.value) ||
    null;

  if (!prodId) {
    alert("Informe o ID do produto para o banner.");
    return;
  }

  const btn = event.target;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';
  btn.disabled = true;

  try {
    let urlFinal = document.getElementById(`cfg-banner${suf}-img`)?.value || "";

    if (fileInput?.files?.length) {
      const file = fileInput.files[0];
      btn.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Enviando imagem...';
      // ── Upload para o Cloudinary (substitui Supabase Storage) ──
      try {
        urlFinal = await uploadImageToImgbb(file);
      } catch (uploadErr) {
        alert(
          "❌ Falha no upload do banner: " +
            uploadErr.message +
            "\nO banner não foi salvo.",
        );
        return;
      }
    }

    if (!urlFinal) {
      alert("Selecione uma foto ou informe a URL do banner.");
      return;
    }

    const updateData = {};
    updateData[`banner${suf}_imagem`] = urlFinal;
    updateData[`banner${suf}_produto_id`] = parseInt(prodId) || null;
    updateData[`banner${suf}_desconto_tipo`] = descValor ? descTipo : null;
    updateData[`banner${suf}_desconto_valor`] = descValor || null;

    await supa.from("configuracoes").update(updateData).gt("id", 0);

    const imgEl = document.getElementById(`cfg-banner${suf}-img`);
    const prevEl = document.getElementById(`cfg-banner${suf}-preview`);
    const boxEl = document.getElementById(`cfg-banner${suf}-preview-box`);
    if (imgEl) imgEl.value = urlFinal;
    if (prevEl) prevEl.src = urlFinal;
    if (boxEl) boxEl.style.display = "block";

    alert(`✅ Banner ${num} ativado!`);
  } catch (e) {
    alert("Erro: " + e.message);
  } finally {
    btn.innerHTML = '<i class="fas fa-upload"></i> Salvar Banner';
    btn.disabled = false;
  }
}
function previewIcone(input) {
  const file = input.files?.[0];
  const prev = document.getElementById("cfg-icone-preview");
  const box = document.getElementById("cfg-icone-preview-box");
  if (!prev) return;
  if (file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      prev.src = e.target.result;
      if (box) box.style.display = "block";
    };
    reader.readAsDataURL(file);
  } else {
    if (box) box.style.display = "none";
  }
}

// =========================================================
// TABELA DE FRETE
// =========================================================
const FRETE_FAIXAS = [
  { label: "0 – 1 km", max: 1.0 },
  { label: "1,1 – 2 km", max: 2.0 },
  { label: "2,1 – 3 km", max: 3.0 },
  { label: "3,1 – 4 km", max: 4.0 },
  { label: "4,1 – 5 km", max: 5.0 },
  { label: "5,1 – 6 km", max: 6.0 },
  { label: "6,1 – 7 km", max: 7.0 },
  { label: "7,1 – 8 km", max: 8.0 },
  { label: "8,1 – 9 km", max: 9.0 },
  { label: "9,1 – 10 km", max: 10.0 },
  { label: "10,1 – 11 km", max: 11.0 },
  { label: "11,1 – 12 km", max: 12.0 },
  { label: "12,1 – 13 km", max: 13.0 },
  { label: "13,1 – 14 km", max: 14.0 },
  { label: "14,1 – 15 km", max: 15.0 },
  { label: "15,1 – 16 km", max: 16.0 },
  { label: "16,1 – 17 km", max: 17.0 },
  { label: "17,1 – 18 km", max: 18.0 },
  { label: "18,1 – 19 km", max: 19.0 },
  { label: "19,1 – 20 km", max: 20.0 },
];

function _renderTabelaFrete(savedData) {
  const tbody = document.getElementById("tabela-frete-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  FRETE_FAIXAS.forEach((faixa, idx) => {
    const saved = (savedData && savedData[idx]) || {};
    const valLoja   = saved.loja ?? "";
    const valMoto   = saved.motoboy ?? "";
    const aCombinar = saved.acombinar === true;

    const bg = idx % 2 === 0
      ? "var(--color-background-primary)"
      : "var(--color-background-secondary)";
    const rowStyle = aCombinar ? "opacity:0.55" : "";

    tbody.innerHTML += `
      <tr style="background:${bg};${rowStyle}" id="frete-row-${idx}">
        <td style="padding:8px;font-weight:600;white-space:nowrap;font-size:0.85rem">${faixa.label}</td>
        <td style="padding:6px;text-align:center">
          <input type="number" class="form-control frete-loja" data-idx="${idx}"
                 value="${aCombinar ? "" : valLoja}" placeholder="0" min="0" step="1000"
                 ${aCombinar ? "disabled" : ""}
                 style="text-align:center;max-width:120px;margin:0 auto;border:1.5px solid #2980b9;${aCombinar ? "opacity:0.4" : ""}">
        </td>
        <td style="padding:6px;text-align:center">
          <input type="number" class="form-control frete-motoboy" data-idx="${idx}"
                 value="${aCombinar ? "" : valMoto}" placeholder="0" min="0" step="1000"
                 ${aCombinar ? "disabled" : ""}
                 style="text-align:center;max-width:120px;margin:0 auto;border:1.5px solid #27ae60;${aCombinar ? "opacity:0.4" : ""}">
        </td>
        <td style="padding:6px;text-align:center">
          <label style="display:flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;font-size:0.78rem;color:${aCombinar ? "#e67e22" : "#aaa"};white-space:nowrap">
            <input type="checkbox" class="frete-acombinar" data-idx="${idx}" ${aCombinar ? "checked" : ""}
              onchange="_toggleFreteRow(${idx}, this.checked)"
              style="width:15px;height:15px">
            🤝 Combinar
          </label>
        </td>
      </tr>`;
  });
}

function _toggleFreteRow(idx, acombinar) {
  const row = document.getElementById(`frete-row-${idx}`);
  if (!row) return;
  const lojaInp = row.querySelector(".frete-loja");
  const motoInp = row.querySelector(".frete-motoboy");
  const lbl     = row.querySelector("label");

  row.style.opacity = acombinar ? "0.55" : "1";

  if (lojaInp) {
    lojaInp.disabled     = acombinar;
    lojaInp.style.opacity = acombinar ? "0.4" : "1";
    if (acombinar) lojaInp.value = "";
  }
  if (motoInp) {
    motoInp.disabled     = acombinar;
    motoInp.style.opacity = acombinar ? "0.4" : "1";
    if (acombinar) motoInp.value = "";
  }
  if (lbl) lbl.style.color = acombinar ? "#e67e22" : "#aaa";
}

async function salvarTabelaFrete() {
  const tabela = [];
  FRETE_FAIXAS.forEach((_, idx) => {
    const aCombinar =
      document.querySelector(`.frete-acombinar[data-idx="${idx}"]`)?.checked ||
      false;

    const loja = aCombinar
      ? 0
      : parseInt(document.querySelector(`.frete-loja[data-idx="${idx}"]`)?.value) || 0;

    const motoboy = aCombinar
      ? 0
      : parseInt(document.querySelector(`.frete-motoboy[data-idx="${idx}"]`)?.value) || 0;

    tabela.push({ loja, motoboy, acombinar: aCombinar });
  });

  const novoCombus =
    parseInt(document.getElementById("cfg-combustivel")?.value) || 0;
  const novoMotoBase =
    parseInt(document.getElementById("cfg-taxa-motoboy-base")?.value) || 0;
  const limiteKm =
    parseFloat(document.getElementById("cfg-limite-distancia")?.value) || null;

  AJUDA_COMBUSTIVEL = novoCombus;
  TAXA_MOTOBOY = novoMotoBase;

  const updateData = {
    tabela_frete: tabela,
    ajuda_combustivel: novoCombus,
    taxa_motoboy_base: novoMotoBase,
    limite_distancia_km: limiteKm || null,
  };

  const { error } = await supa
    .from("configuracoes")
    .update(updateData)
    .gt("id", 0);
  if (error) {
    alert("Erro ao salvar: " + error.message);
    return;
  }
  TABELA_FRETE_ADMIN = tabela;
  alert(t("alert.frete_salvo"));
}

// ── MAQUININHAS DE CARTÃO ─────────────────────────────────────────
async function _carregarMaquininhas() {
  const container = document.getElementById("maquininhas-lista");
  if (!container) return;
  const { data } = await supa
    .from("configuracoes")
    .select("maquininhas_cartao")
    .maybeSingle();
  const lista = data?.maquininhas_cartao || [];
  container.innerHTML = "";
  if (!lista.length) {
    container.innerHTML =
      '<p style="color:var(--color-text-secondary);font-size:0.82rem;padding:8px 0">Nenhuma maquininha cadastrada.</p>';
    return;
  }
  lista.forEach((m, idx) => _renderMaquininha(m, idx, container));
}

function _renderMaquininha(m, idx, container) {
  const row = document.createElement("div");
  row.className = "maquininha-row";
  row.style.cssText =
    "background:var(--color-background-secondary);border:1px solid var(--color-border-tertiary);border-radius:10px;padding:12px;margin-bottom:8px";
  row.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-weight:700;font-size:0.9rem">${m.nome || "Maquininha " + (idx + 1)}</span>
      <button onclick="this.closest('.maquininha-row').remove()" style="background:none;border:none;color:#e74c3c;font-size:1rem;cursor:pointer">✕</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;font-size:0.82rem">
      <div><label style="font-size:0.72rem;color:var(--color-text-secondary)">Nome/Operadora</label>
        <input class="form-control maq-nome" value="${m.nome || ""}" placeholder="Ex: Cielo, Rede, Sicredi"></div>
      <div><label style="font-size:0.72rem;color:var(--color-text-secondary)">Débito (%)</label>
        <input type="number" class="form-control maq-debito" value="${m.taxas?.debito ?? ""}" placeholder="1.5" min="0" step="0.01"></div>
      <div><label style="font-size:0.72rem;color:var(--color-text-secondary)">Crédito (%)</label>
        <input type="number" class="form-control maq-credito" value="${m.taxas?.credito ?? ""}" placeholder="2.5" min="0" step="0.01"></div>
      <div><label style="font-size:0.72rem;color:var(--color-text-secondary)">Parcelado (%)</label>
        <input type="number" class="form-control maq-parcelado" value="${m.taxas?.parcelado ?? ""}" placeholder="3.0" min="0" step="0.01"></div>
      <div><label style="font-size:0.72rem;color:var(--color-text-secondary)">PIX (%)</label>
        <input type="number" class="form-control maq-pix" value="${m.taxas?.pix ?? ""}" placeholder="0.99" min="0" step="0.01"></div>
    </div>`;
  container.appendChild(row);
}

function adicionarMaquininha() {
  const container = document.getElementById("maquininhas-lista");
  if (!container) return;
  const p = container.querySelector("p");
  if (p) p.remove();
  _renderMaquininha(
    {},
    container.querySelectorAll(".maquininha-row").length,
    container,
  );
}

async function salvarMaquininhas() {
  const maquininhas = [];
  document
    .querySelectorAll("#maquininhas-lista .maquininha-row")
    .forEach((row) => {
      const nome = row.querySelector(".maq-nome")?.value.trim() || "";
      if (!nome) return;
      maquininhas.push({
        nome,
        taxas: {
          debito: parseFloat(row.querySelector(".maq-debito")?.value) || 0,
          credito: parseFloat(row.querySelector(".maq-credito")?.value) || 0,
          parcelado:
            parseFloat(row.querySelector(".maq-parcelado")?.value) || 0,
          pix: parseFloat(row.querySelector(".maq-pix")?.value) || 0,
        },
      });
    });
  const { error } = await supa
    .from("configuracoes")
    .update({ maquininhas_cartao: maquininhas })
    .gt("id", 0);
  if (error) {
    alert("Erro: " + error.message);
    return;
  }
  alert("✅ Maquininhas salvas!");
}

async function salvarPersonalizacao() {
  const btn = event.target;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Salvando...';
  btn.disabled = true;

  try {
    const dados = {};
    const nomeLoja =
      document.getElementById("cfg-nome-restaurante")?.value?.trim() ||
      document.getElementById("cfg-nome-loja")?.value?.trim();
    const corHex =
      document.getElementById("cfg-cor-primaria-hex")?.value ||
      document.getElementById("cfg-cor-primaria")?.value;
    const logoUrl = document.getElementById("cfg-logo-url")?.value?.trim();

    if (nomeLoja) {
      dados.nome_restaurante = nomeLoja;
    }
    if (corHex && corHex.startsWith("#")) dados.cor_primaria = corHex;
    if (logoUrl) {
      dados.logo_url = logoUrl;
      dados.icone_url = logoUrl;
    }

    // Upload do ícone se houver arquivo selecionado
    const iconeFile = document.getElementById("cfg-icone-file")?.files?.[0];
    if (iconeFile) {
      btn.innerHTML =
        '<i class="fas fa-spinner fa-spin"></i> Enviando ícone...';
      // ── Upload para o Cloudinary (substitui Supabase Storage) ──
      let iconeUrl;
      try {
        iconeUrl = await uploadImageToSupabase(iconeFile, 'icones');
      } catch (uploadErr) {
        alert(
          "❌ Falha no upload do ícone: " +
            uploadErr.message +
            "\nA personalização não foi salva.",
        );
        return;
      }
      dados.icone_url = iconeUrl;
      dados.logo_url = iconeUrl;
      // Atualiza preview
      const prev = document.getElementById("cfg-icone-preview");
      const box = document.getElementById("cfg-icone-preview-box");
      if (prev) {
        prev.src = iconeUrl;
      }
      if (box) {
        box.style.display = "block";
      }
      // Preenche campo URL
      const urlInp = document.getElementById("cfg-logo-url");
      if (urlInp) urlInp.value = iconeUrl;
    }

    if (Object.keys(dados).length > 0) {
      const { error } = await supa
        .from("configuracoes")
        .update(dados)
        .gt("id", 0);
      if (error) throw error;
    }
    if (dados.nome_restaurante) NOME_RESTAURANTE = dados.nome_restaurante;
    alert(
      "✅ Personalização salva! Recarregue o cardápio para ver as mudanças.",
    );
  } catch (e) {
    alert("Erro: " + e.message);
  } finally {
    btn.innerHTML = '<i class="fas fa-paint-brush"></i> Salvar Personalização';
    btn.disabled = false;
  }
}

// ── Upload de logo direto da seção Identidade ────────────────────
async function _uploadLogoIdentidade(input) {
  if (!input.files || !input.files[0]) return;
  const file = input.files[0];
  const btn = input.closest("label");
  const originalHtml = btn ? btn.innerHTML : "";
  if (btn) btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enviando...';

  try {
    const url = await uploadImageToSupabase(file, 'sabores');

    // Preenche o campo de URL de texto
    const urlInput = document.getElementById("cfg-logo-url");
    if (urlInput) urlInput.value = url;

    // Mostra preview
    const preview = document.getElementById("cfg-logo-preview-identidade");
    const img = document.getElementById("cfg-logo-img-identidade");
    if (img) img.src = url;
    if (preview) preview.style.display = "block";
  } catch (e) {
    alert("Erro ao enviar imagem: " + e.message);
  } finally {
    if (btn) btn.innerHTML = originalHtml;
  }
}

async function _dashVerificarAlertas() {
  const wrap = document.getElementById("dash-alertas-wrap");
  if (!wrap) return;

  const LIMITE_PADRAO = 5;
  const DIAS_ALERTA_PADRAO = 7;

  try {
    // ── 1. Produtos com estoque controlado ──
    const { data: prodsEstoque } = await supa
      .from("produtos")
      .select("id, nome, estoque_qtd, estoque_minimo")
      .eq("ativo", true)
      .not("estoque_qtd", "is", null);

    // ── 2. Variações de produto (varejo) ──
    const { data: varsEstoque } = await supa
      .from("produto_variacoes")
      .select("id, produto_id, nome, estoque_qtd, produtos(nome)")
      .eq("ativo", true)
      .eq("controlar_estoque", true)
      .lte("estoque_qtd", LIMITE_PADRAO);

    // ── 3. Produtos perecíveis ──
    const { data: prodsValidade } = await supa
      .from("produtos")
      .select("id, nome, data_validade, dias_alerta_validade, estoque_qtd")
      .eq("ativo", true)
      .eq("perecivel", true)
      .not("data_validade", "is", null)
      .order("data_validade", { ascending: true });

    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);

    // ── Processa estoque ─────────────────────────────────────
    const estoqueZerado = [];
    const estoqueBaixo = [];

    (prodsEstoque || []).forEach((p) => {
      const minimo = p.estoque_minimo ?? LIMITE_PADRAO;
      const base = { id: p.id, tipo: "produto", nome: p.nome, qtd: p.estoque_qtd, minimo };

      if (p.estoque_qtd <= 0) {
        estoqueZerado.push(base);
      } else if (p.estoque_qtd <= minimo) {
        estoqueBaixo.push(base);
      }
    });

    (varsEstoque || []).forEach((v) => {
      const base = {
        id: v.produto_id, // abre o produto-pai no modal
        tipo: "variacao",
        nome: `${v.produtos?.nome || "?"} — ${v.nome}`,
        qtd: v.estoque_qtd,
        minimo: LIMITE_PADRAO,
      };
      if (v.estoque_qtd <= 0) estoqueZerado.push(base);
      else estoqueBaixo.push(base);
    });

    // ── Processa validade ────────────────────────────────────
    const vencidos = [];
    const proximos = [];

    (prodsValidade || []).forEach((p) => {
      if (
        p.estoque_qtd !== null &&
        p.estoque_qtd !== undefined &&
        p.estoque_qtd <= 0
      )
        return;

      const val = new Date(p.data_validade + "T00:00:00");
      const dias = Math.ceil((val - hoje) / 86400000);
      const diasAlerta = p.dias_alerta_validade || DIAS_ALERTA_PADRAO;
      const base = { id: p.id, tipo: "produto", nome: p.nome, dias };

      if (dias < 0) vencidos.push(base);
      else if (dias <= diasAlerta) proximos.push(base);
    });

    // ── Card ESTOQUE ─────────────────────────────────────────
    const cardEst = document.getElementById("dash-alerta-estoque");
    const listaEst = document.getElementById("dash-estoque-lista");
    const tituloEst = document.getElementById("dash-estoque-titulo");
    const totalEstoque = estoqueZerado.length + estoqueBaixo.length;

    if (totalEstoque > 0 && cardEst && listaEst) {
      cardEst.style.display = "flex";
      cardEst.classList.add("dash-alerta--com-chips");

      if (tituloEst) {
        tituloEst.textContent = estoqueZerado.length
          ? `⚠️ ${estoqueZerado.length} produto(s) sem estoque` +
            (estoqueBaixo.length ? ` · ${estoqueBaixo.length} em nível crítico` : "")
          : `⚠️ Estoque baixo (${estoqueBaixo.length})`;
      }

      const chips = [];
      estoqueZerado.forEach((e) => chips.push(_chipEstoque(e, "zero")));
      estoqueBaixo.forEach((e) => {
        // Ainda mais crítico se está muito próximo de 0 (<= 50% do mínimo)
        const severidade = e.qtd <= e.minimo * 0.5 ? "critico" : "baixo";
        chips.push(_chipEstoque(e, severidade));
      });

      listaEst.innerHTML = `<div class="dash-alerta-chips">${chips.join("")}</div>`;
    } else if (cardEst) {
      cardEst.style.display = "none";
    }

    // ── Card VALIDADE ────────────────────────────────────────
    const cardVal = document.getElementById("dash-alerta-validade");
    const listaVal = document.getElementById("dash-validade-lista");
    const tituloVal = document.getElementById("dash-validade-titulo");
    const totalVal = vencidos.length + proximos.length;

    if (totalVal > 0 && cardVal && listaVal) {
      cardVal.style.display = "flex";
      cardVal.classList.add("dash-alerta--com-chips");

      if (tituloVal) {
        tituloVal.textContent = vencidos.length
          ? `⚠️ ${vencidos.length} produto(s) vencido(s)` +
            (proximos.length ? ` · ${proximos.length} vencendo em breve` : "")
          : `Validade próxima (${proximos.length})`;
      }

      const chips = [];
      vencidos.forEach((e) => chips.push(_chipValidade(e, "vencido")));
      proximos.forEach((e) => chips.push(_chipValidade(e, "avencer")));

      listaVal.innerHTML = `<div class="dash-alerta-chips">${chips.join("")}</div>`;
    } else if (cardVal) {
      cardVal.style.display = "none";
    }

    // ── Wrapper ─────────────────────────────────────────────
    wrap.style.display = totalEstoque > 0 || totalVal > 0 ? "flex" : "none";
  } catch (e) {
    console.warn("[dash-alertas]", e.message);
  }
}

/* ── Helpers de chip ──────────────────────────────────────── */
function _chipEstoque(item, severidade) {
  // severidade: "zero" | "critico" | "baixo"
  const icon = severidade === "zero" ? "🔴" : "⚠️";
  const label =
    severidade === "zero" ? "0" : `${item.qtd}/${item.minimo}`;
  const tipoTag = item.tipo === "variacao" ? " ·var" : "";
  return `<button class="dash-alerta-chip dash-alerta-chip--${severidade}"
    onclick="_dashAbrirProduto(${item.id})"
    title="${item.nome}${tipoTag} — clique para editar">
    <span>${icon}</span>
    <span class="chip-nome">${item.nome}</span>
    <span class="chip-qtd">${label}</span>
  </button>`;
}

function _chipValidade(item, severidade) {
  // severidade: "vencido" | "avencer"
  const icon = severidade === "vencido" ? "🚫" : "⏰";
  const label =
    severidade === "vencido" ? `${item.dias}d atrás` : `${item.dias}d`;
  return `<button class="dash-alerta-chip dash-alerta-chip--${severidade}"
    onclick="_dashAbrirProduto(${item.id})"
    title="${item.nome} — clique para editar">
    <span>${icon}</span>
    <span class="chip-nome">${item.nome}</span>
    <span class="chip-qtd">${label}</span>
  </button>`;
}

/* ── Abre o produto direto no modal de edição ─────────────── */
async function _dashAbrirProduto(id) {
  if (!id) return;

  // Tenta reusar o cache local (mais rápido)
  let prod = typeof _produtosMap !== "undefined" ? _produtosMap[id] : null;

  // Se não tiver em cache (user nunca abriu a aba Produtos), busca no banco
  if (!prod) {
    try {
      const { data } = await supa
        .from("produtos")
        .select("*")
        .eq("id", id)
        .single();
      prod = data;
    } catch (e) {
      alert("Erro ao carregar produto: " + e.message);
      return;
    }
  }

  if (!prod) {
    alert("Produto não encontrado.");
    return;
  }

  // Garante que o cache esteja populado para o modal
  if (typeof _produtosMap !== "undefined") _produtosMap[id] = prod;

  // Abre o modal
  if (typeof abrirModalProduto === "function") abrirModalProduto(prod);
}

async function carregarDashboard() {
  // Saudação dinâmica
  const hora = new Date().getHours();
  const saudacao =
    hora < 12
      ? t("saudacao.manha")
      : hora < 18
        ? t("saudacao.tarde")
        : t("saudacao.noite");
  const elGreet = document.getElementById("dash-greeting");
  if (elGreet) elGreet.textContent = saudacao + " 👋";

  const elDate = document.getElementById("dash-date");
  if (elDate)
    elDate.textContent = new Date().toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });

  // Data de hoje em Assunção (UTC-3) → converte para UTC para query correta
  const _agoraAsuncion = new Date();
  const _offMs = _getAsuncionOffsetMs(_agoraAsuncion);
  const _inicioHojeLocal = new Date(_agoraAsuncion.toISOString().split("T")[0] + "T00:00:00");
  const hojeUTCInicio = new Date(_inicioHojeLocal.getTime() + _offMs).toISOString();
  const hojeUTCFim    = new Date(_inicioHojeLocal.getTime() + _offMs + 86399999).toISOString();

  // Pedidos de hoje (todos exceto cancelado — igual ao Financeiro)
  const { data: pedidos } = await supa
    .from("pedidos")
    .select("*")
    .neq("status", "cancelado")
    .gte("created_at", hojeUTCInicio)
    .lte("created_at", hojeUTCFim);
  const total = pedidos
    ? pedidos.reduce((a, b) => a + (b.total_geral || 0), 0)
    : 0;

  // Pedidos em preparo
  const { count: emPreparo } = await supa
    .from("pedidos")
    .select("*", { count: "exact", head: true })
    .eq("status", "em_preparo");

  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.innerText = v;
  };
  setVal("kpi-vendas", `Gs ${total.toLocaleString("es-PY")}`);
  setVal("kpi-pedidos", pedidos ? pedidos.length : 0);

  // Bug #8 corrigido: soma frete_motoboy real de cada delivery.
  // A versão anterior multiplicava TAXA_MOTOBOY × total de pedidos,
  // incluindo balcão/retirada/local que não têm motoboy.
  const custoMotoReal = (pedidos || [])
    .filter((p) => p.tipo_entrega === "delivery")
    .reduce((acc, p) => acc + (Number(p.frete_motoboy) || TAXA_MOTOBOY || 0), 0);
  const qtdMotoboyUnicos = new Set(
    (pedidos || [])
      .filter((p) => p.tipo_entrega === "delivery" && p.motoboy_id)
      .map((p) => p.motoboy_id),
  ).size;
  const custoMotoTotal = custoMotoReal + (AJUDA_COMBUSTIVEL || 0) * (qtdMotoboyUnicos || 0);
  setVal("kpi-moto", `Gs ${custoMotoTotal.toLocaleString("es-PY")}`);
  setVal("kpi-em-preparo", emPreparo || 0);

  // === RANKING PRODUTOS ===
  await carregarRankingProdutos();

  // === RANKING CLIENTES ===
  await carregarRankingClientes();

  // === ALERTAS DE ESTOQUE E VALIDADE ===   ← ADICIONE ESTA LINHA
  await _dashVerificarAlertas();
}

// ══════════════════════════════════════════════════════════
// RANKING PRODUTOS com filtro de período
// ══════════════════════════════════════════════════════════
async function carregarRankingProdutos() {
  const sel = document.getElementById("rank-prod-periodo");
  const periodo = sel ? sel.value : "hoje";
  const customBox = document.getElementById("rank-prod-custom");
  if (customBox)
    customBox.style.display = periodo === "custom" ? "flex" : "none";
  const { inicio, fim } = _calcularIntervalo(
    periodo,
    "rank-prod-inicio",
    "rank-prod-fim",
  );

  // Conta vendas de todos os pedidos finalizados (exceto cancelado).
  // Usar só "entregue" excluía todas as vendas de balcão/PDV. (bug #3 corrigido)
  let query = supa
    .from("pedidos")
    .select("itens")
    .not("status", "eq", "cancelado");
  if (inicio) query = query.gte("created_at", inicio);
  if (fim) query = query.lte("created_at", fim);
  const { data } = await query;

  const cnt = {};
  (data || []).forEach((ped) => {
    (Array.isArray(ped.itens) ? ped.itens : []).forEach((item) => {
      const n = item.nome || item.n || "Produto";
      const q = parseInt(item.qtd || item.q || 1);
      cnt[n] = (cnt[n] || 0) + q;
    });
  });
  const ranking = Object.entries(cnt)
    .map(([nome, v]) => ({ nome, v }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 8);

  const el = document.getElementById("ranking-produtos-list");
  if (!el) return;
  if (!ranking.length) {
    el.innerHTML = '<div class="rank-vazio">Nenhuma venda no período</div>';
    return;
  }
  el.innerHTML = "";
  const max = ranking[0].v;
  ranking.forEach((p, i) => {
    const pct = Math.round((p.v / max) * 100);
    el.innerHTML += `<div class="rank-item">
      <div class="rank-pos rank-pos-${i + 1}">${i + 1}</div>
      <div class="rank-info">
        <div class="rank-name">${p.nome}</div>
        <div class="rank-bar-wrap"><div class="rank-bar" style="width:${pct}%"></div></div>
      </div>
      <div class="rank-val">${p.v}</div>
    </div>`;
  });
}

// ══════════════════════════════════════════════════════════
// RANKING CLIENTES com filtro de período + limpeza de "MESA X -"
// ══════════════════════════════════════════════════════════
async function carregarRankingClientes() {
  const sel = document.getElementById("rank-cli-periodo");
  const periodo = sel ? sel.value : "tudo";
  const customBox = document.getElementById("rank-cli-custom");
  if (customBox)
    customBox.style.display = periodo === "custom" ? "flex" : "none";
  const { inicio, fim } = _calcularIntervalo(
    periodo,
    "rank-cli-inicio",
    "rank-cli-fim",
  );

  // Conta clientes de todos os pedidos não cancelados. (bug #4 corrigido)
  let query = supa
    .from("pedidos")
    .select("cliente_nome, cliente_telefone, total_geral")
    .not("status", "eq", "cancelado")
    .order("created_at", { ascending: false })
    .limit(1000);
  if (inicio) query = query.gte("created_at", inicio);
  if (fim) query = query.lte("created_at", fim);
  const { data } = await query;

  const map = {};
  (data || []).forEach((p) => {
    const nomeLimpo =
      (p.cliente_nome || "").replace(/^MESA\s+\d+\s*-\s*/i, "").trim() ||
      "Cliente";
    const tel = (p.cliente_telefone || "").trim();
    if (nomeLimpo === "Cliente" && tel.length < 5) return;
    const key = tel.length > 5 ? tel : "nome:" + nomeLimpo;
    if (!map[key]) map[key] = { nome: nomeLimpo, tel, qtd: 0, total: 0 };
    else if (nomeLimpo !== "Cliente" && map[key].nome === "Cliente")
      map[key].nome = nomeLimpo;
    map[key].qtd++;
    map[key].total += p.total_geral || 0;
  });

  const top = Object.values(map)
    .sort((a, b) => b.qtd - a.qtd)
    .slice(0, 8);
  const el = document.getElementById("ranking-clientes-list");
  if (!el) return;
  if (!top.length) {
    el.innerHTML = '<div class="rank-vazio">Nenhum cliente no período</div>';
    return;
  }
  el.innerHTML = "";
  const max = top[0].qtd;
  top.forEach((c, i) => {
    const pct = Math.round((c.qtd / max) * 100);
    el.innerHTML += `<div class="rank-item">
      <div class="rank-pos rank-pos-${i + 1}">${i + 1}</div>
      <div class="rank-info">
        <div class="rank-name">${c.nome}</div>
        ${c.tel ? `<div class="rank-sub"><i class="fas fa-phone"></i> ${c.tel}</div>` : ""}
        <div class="rank-bar-wrap"><div class="rank-bar rank-bar-purple" style="width:${pct}%"></div></div>
      </div>
      <div class="rank-val">${c.qtd}x</div>
    </div>`;
  });
}

// Utilitário: datas para os rankings
function _calcularIntervalo(periodo, idI, idF) {
  const now = new Date();
  let inicio = null,
    fim = null;
  if (periodo === "hoje") {
    inicio = now.toISOString().split("T")[0] + "T00:00:00";
  } else if (periodo === "7") {
    const d = new Date(now);
    d.setDate(d.getDate() - 7);
    inicio = d.toISOString().split("T")[0] + "T00:00:00";
  } else if (periodo === "30") {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    inicio = d.toISOString().split("T")[0] + "T00:00:00";
  } else if (periodo === "mes") {
    inicio = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01T00:00:00`;
  } else if (periodo === "custom") {
    const elI = document.getElementById(idI);
    const elF = document.getElementById(idF);
    if (elI?.value) inicio = elI.value + "T00:00:00";
    if (elF?.value) fim = elF.value + "T23:59:59";
  }
  return { inicio, fim };
}

// ══════════════════════════════════════════════════════════
// PDV MOBILE — Tabs de navegação
// ══════════════════════════════════════════════════════════
function pdvMudarAba(aba, btn) {
  localStorage.setItem("app_pdv_aba", aba);
  document
    .querySelectorAll(".pdv-tab-btn")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");

  // Hide all panels, show the selected one
  document
    .querySelectorAll(".pdv-tab-panel")
    .forEach((el) => el.classList.remove("pdv-tab-active"));

  if (aba === "produtos") {
    document
      .getElementById("pdv-panel-produtos")
      ?.classList.add("pdv-tab-active");
  } else if (aba === "carrinho") {
    document
      .getElementById("pdv-panel-carrinho")
      ?.classList.add("pdv-tab-active");
  } else if (aba === "monitor") {
    // On mobile: show the mesas panel instead
    const panelMesas = document.getElementById("pdv-panel-mesas");
    const panelVenda = document.getElementById("pdv-panel-venda");
    if (panelMesas && window.innerWidth <= 768) {
      panelVenda.style.display = "none";
      panelMesas.style.display = "";
    } else {
      document
        .getElementById("pdv-panel-monitor")
        ?.classList.add("pdv-tab-active");
    }
  }
}

function pdvMudarView(view) {
  const panelVenda = document.getElementById("pdv-panel-venda");
  const panelMesas = document.getElementById("pdv-panel-mesas");
  const btnVenda = document.getElementById("pdv-view-btn-venda");
  const btnMesas = document.getElementById("pdv-view-btn-mesas");
  if (view === "venda") {
    if (panelVenda) panelVenda.style.display = "block";
    if (panelMesas) panelMesas.style.display = "none";
    if (btnVenda) btnVenda.classList.add("active");
    if (btnMesas) btnMesas.classList.remove("active");
  } else {
    if (panelVenda) panelVenda.style.display = "none";
    if (panelMesas) panelMesas.style.display = "block";
    if (btnVenda) btnVenda.classList.remove("active");
    if (btnMesas) btnMesas.classList.add("active");
    carregarMonitorMesas();
  }
}

function pdvIniciarTabs() {
  const isMobile = window.innerWidth <= 768;
  const tabsEl = document.getElementById("pdv-tabs");
  const footer = document.getElementById("pdv-mobile-footer");
  const headerBar = document.querySelector(".pdv-header-bar .pdv-view-btns");

  if (isMobile) {
    if (tabsEl) tabsEl.style.display = "flex";
    if (footer) footer.style.display = "flex";
    if (headerBar) headerBar.style.display = "none";
    // Mobile começa mostrando o cardápio
    document
      .querySelectorAll(".pdv-tab-btn")
      .forEach((b) => b.classList.remove("active"));

    const savedPdvAba = localStorage.getItem("app_pdv_aba") || "produtos";
    let activeBtn = null;
    if (tabsEl) {
      if (savedPdvAba === "produtos")
        activeBtn = tabsEl.querySelector(".pdv-tab-btn:nth-child(1)");
      else if (savedPdvAba === "carrinho")
        activeBtn = tabsEl.querySelector(".pdv-tab-btn:nth-child(2)");
      else if (savedPdvAba === "mesas")
        activeBtn = tabsEl.querySelector(".pdv-tab-btn:nth-child(3)");
    }
    pdvMudarAba(savedPdvAba, activeBtn);
  } else {
    if (tabsEl) tabsEl.style.display = "none";
    if (footer) footer.style.display = "none";
    if (headerBar) headerBar.style.display = "flex";
    // Desktop: mostra produtos e carrinho sempre
    [".pdv-carrinho", ".pdv-produtos"].forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) el.classList.add("pdv-tab-active");
    });
    const panelVenda = document.getElementById("pdv-panel-venda");
    if (panelVenda) panelVenda.style.display = "block";
  }
}

async function logout() {
  const { error } = await supa.auth.signOut();
  if (error) alert("Erro ao sair: " + error.message);
  else window.location.href = "login.html";
}

// ─────────────────────────────────────────────────────────────
// ALTERAR SENHA
// ─────────────────────────────────────────────────────────────
function abrirModalAlterarSenha() {
  const html = `
    <div id="modal-alterar-senha" class="modal-overlay" style="display:flex;z-index:9999;backdrop-filter:blur(4px)">
      <div style="background:#fff;border-radius:20px;width:100%;max-width:420px;
        box-shadow:0 24px 60px rgba(0,0,0,0.18);overflow:hidden;font-family:inherit">
        <!-- Header -->
        <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#1a7a2e 100%);
          padding:24px 24px 20px;position:relative">
          <button onclick="document.getElementById('modal-alterar-senha').remove()"
            style="position:absolute;top:14px;right:16px;background:rgba(255,255,255,0.12);
            border:none;color:#fff;width:30px;height:30px;border-radius:50%;font-size:14px;
            cursor:pointer">✕</button>
          <div style="display:flex;align-items:center;gap:12px">
            <div style="background:rgba(255,255,255,0.12);border-radius:12px;padding:10px;font-size:22px">🔐</div>
            <div>
              <div style="color:#fff;font-size:1.1rem;font-weight:700">Alterar Senha</div>
              <div style="color:rgba(255,255,255,0.55);font-size:0.78rem;margin-top:2px">Escolha uma senha forte</div>
            </div>
          </div>
        </div>
        <!-- Body -->
        <div style="padding:22px 24px 18px">
          <div style="margin-bottom:16px">
            <label style="font-size:0.75rem;font-weight:600;color:#64748b;text-transform:uppercase;
              letter-spacing:.4px;display:block;margin-bottom:6px">Nova senha</label>
            <div style="position:relative">
              <input type="password" id="wl-nova-senha" placeholder="Digite a nova senha"
                autocomplete="new-password" oninput="_wlAvaliarSenha(this.value)"
                style="width:100%;padding:10px 42px 10px 13px;border:2px solid #e2e8f0;
                border-radius:10px;font-size:0.9rem;outline:none;box-sizing:border-box"
                onfocus="this.style.borderColor='#1a7a2e'" onblur="this.style.borderColor='#e2e8f0'"/>
              <span onclick="_wlToggleSenha('wl-nova-senha','wl-eye1')" id="wl-eye1"
                style="position:absolute;right:11px;top:50%;transform:translateY(-50%);
                cursor:pointer;font-size:17px;user-select:none">👁</span>
            </div>
            <!-- Barra de força -->
            <div style="margin-top:7px">
              <div style="display:flex;gap:4px;height:5px;border-radius:4px;overflow:hidden">
                <div id="wl-b1" style="flex:1;background:#e2e8f0;border-radius:4px;transition:background .3s"></div>
                <div id="wl-b2" style="flex:1;background:#e2e8f0;border-radius:4px;transition:background .3s"></div>
                <div id="wl-b3" style="flex:1;background:#e2e8f0;border-radius:4px;transition:background .3s"></div>
                <div id="wl-b4" style="flex:1;background:#e2e8f0;border-radius:4px;transition:background .3s"></div>
              </div>
              <div id="wl-forca-lbl" style="font-size:0.72rem;color:#aaa;margin-top:4px;min-height:14px"></div>
            </div>
            <!-- Critérios -->
            <div style="margin-top:9px;display:grid;grid-template-columns:1fr 1fr;gap:3px 10px">
              <div id="wl-c1" style="font-size:.72rem;color:#bbb;transition:color .25s">✗ Mín. 8 caracteres</div>
              <div id="wl-c2" style="font-size:.72rem;color:#bbb;transition:color .25s">✗ Número</div>
              <div id="wl-c3" style="font-size:.72rem;color:#bbb;transition:color .25s">✗ Maiúscula</div>
              <div id="wl-c4" style="font-size:.72rem;color:#bbb;transition:color .25s">✗ Caractere especial</div>
            </div>
          </div>
          <div style="margin-bottom:6px">
            <label style="font-size:0.75rem;font-weight:600;color:#64748b;text-transform:uppercase;
              letter-spacing:.4px;display:block;margin-bottom:6px">Confirmar senha</label>
            <div style="position:relative">
              <input type="password" id="wl-conf-senha" placeholder="Repita a nova senha"
                autocomplete="new-password" oninput="_wlVerificarMatch()"
                style="width:100%;padding:10px 42px 10px 13px;border:2px solid #e2e8f0;
                border-radius:10px;font-size:0.9rem;outline:none;box-sizing:border-box"
                onfocus="this.style.borderColor='#1a7a2e'" onblur="this.style.borderColor='#e2e8f0'"/>
              <span onclick="_wlToggleSenha('wl-conf-senha','wl-eye2')" id="wl-eye2"
                style="position:absolute;right:11px;top:50%;transform:translateY(-50%);
                cursor:pointer;font-size:17px;user-select:none">👁</span>
            </div>
            <div id="wl-match-lbl" style="font-size:0.78rem;margin-top:5px;min-height:16px"></div>
          </div>
          <div id="wl-msg-senha" style="display:none;color:#e74c3c;font-size:0.82rem;
            background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;margin-top:10px"></div>
        </div>
        <!-- Footer -->
        <div style="padding:0 24px 22px;display:flex;gap:10px">
          <button onclick="document.getElementById('modal-alterar-senha').remove()"
            style="flex:1;padding:11px;background:#f5f5f5;color:#666;border:none;border-radius:10px;
            font-size:0.88rem;font-weight:600;cursor:pointer">Cancelar</button>
          <button id="wl-btn-salvar-senha" onclick="wlSalvarNovaSenha()"
            style="flex:2;padding:11px;background:linear-gradient(135deg,#1a7a2e,#145a22);
            color:#fff;border:none;border-radius:10px;font-size:0.88rem;font-weight:700;cursor:pointer">
            🔒 Salvar Nova Senha
          </button>
        </div>
      </div>
    </div>`;
  const old = document.getElementById("modal-alterar-senha");
  if (old) old.remove();
  document.body.insertAdjacentHTML("beforeend", html);
  setTimeout(() => document.getElementById("wl-nova-senha")?.focus(), 120);
}

function _wlToggleSenha(inputId, spanId) {
  const inp = document.getElementById(inputId);
  const sp  = document.getElementById(spanId);
  if (!inp) return;
  inp.type = inp.type === "password" ? "text" : "password";
  if (sp) sp.textContent = inp.type === "password" ? "👁" : "🙈";
}

/**
 * Avalia a força da senha segundo a política do sistema:
 *   - Mínimo 8 caracteres
 *   - Pelo menos 1 letra minúscula
 *   - Pelo menos 1 letra maiúscula
 *   - Pelo menos 1 número
 *   - Pelo menos 1 caractere especial
 * Retorna `true` somente se TODOS os critérios forem atendidos.
 */
function _wlAvaliarSenha(v) {
  v = v || '';
  const checks = [
    v.length >= 8,          // c1 — mínimo
    /[a-z]/.test(v),        // c2 — minúscula
    /[A-Z]/.test(v),        // c3 — maiúscula
    /\d/.test(v),           // c4 — número
    /[^A-Za-z0-9]/.test(v), // c5 — especial
  ];
  const txts   = ['Mín. 8 caracteres','Minúscula','Maiúscula','Número','Caractere especial'];
  const cores  = ['#e2e8f0','#ef4444','#f97316','#eab308','#22c55e'];
  const labels = ['','Fraca 😬','Razoável 😐','Boa 👍','Forte 💪','Excelente 🔒'];
  const score  = checks.filter(Boolean).length;

  // Atualiza critérios individuais — admin tem 5 itens
  checks.forEach((ok, i) => {
    const el = document.getElementById('wl-c' + (i + 1));
    if (!el) return;
    el.textContent = (ok ? '✓ ' : '✗ ') + txts[i];
    el.style.color = ok ? '#22c55e' : '#bbb';
  });

  // Barra de força — admin tem 4 segmentos (vou manter 4, mapeando 5 critérios)
  // score 0-1 → 0 barras | 2 → 1 | 3 → 2 | 4 → 3 | 5 → 4 (cheio)
  const barras = score <= 1 ? 0 : score - 1;
  for (let i = 1; i <= 4; i++) {
    const b = document.getElementById('wl-b' + i);
    if (b) b.style.background = i <= barras ? cores[score] : '#e2e8f0';
  }

  const fl = document.getElementById('wl-forca-lbl');
  if (fl) {
    fl.textContent = labels[score];
    fl.style.color = cores[score];
  }
  _wlVerificarMatch();
  return score === 5;
}

function _wlAvaliarSenha(v) {
  const checks = [
    v.length >= 8,
    /\d/.test(v),
    /[A-Z]/.test(v),
    /[^A-Za-z0-9]/.test(v),
  ];
  const txts = [
    "Mín. 8 caracteres",
    "Número",
    "Maiúscula",
    "Caractere especial",
  ];
  const cores = ["#e2e8f0", "#ef4444", "#f97316", "#eab308", "#22c55e"];
  const labels = ["", "Fraca 😬", "Razoável 😐", "Boa 👍", "Forte 💪"];
  const score = checks.filter(Boolean).length;

  checks.forEach((ok, i) => {
    const el = document.getElementById("wl-c" + (i + 1));
    if (!el) return;
    el.textContent = (ok ? "✓ " : "✗ ") + txts[i];
    el.style.color = ok ? "#22c55e" : "#bbb";
  });
  for (let i = 1; i <= 4; i++) {
    const b = document.getElementById("wl-b" + i);
    if (b) b.style.background = i <= score ? cores[score] : "#e2e8f0";
  }
  const fl = document.getElementById("wl-forca-lbl");
  if (fl) {
    fl.textContent = labels[score];
    fl.style.color = cores[score];
  }
  _wlVerificarMatch();
}

function _wlVerificarMatch() {
  const a = document.getElementById("wl-nova-senha")?.value || "";
  const b = document.getElementById("wl-conf-senha")?.value || "";
  const lbl = document.getElementById("wl-match-lbl");
  const inp = document.getElementById("wl-conf-senha");
  if (!lbl || !b) return;
  const ok = a === b && b.length > 0;
  lbl.textContent = ok ? "✓ Senhas coincidem" : "✗ Senhas não coincidem";
  lbl.style.color = ok ? "#22c55e" : "#ef4444";
  if (inp)
    inp.style.borderColor =
      b.length > 0 ? (ok ? "#22c55e" : "#ef4444") : "#e2e8f0";
}

async function wlSalvarNovaSenha() {
  const nova   = document.getElementById("wl-nova-senha")?.value || "";
  const conf   = document.getElementById("wl-conf-senha")?.value || "";
  const msgEl  = document.getElementById("wl-msg-senha");
  const showErr = (t) => { msgEl.textContent = t; msgEl.style.display = "block"; };
  msgEl.style.display = "none";

  // ── Política de senha forte ─────────────────────────────────────
  if (nova.length < 8)             return showErr("A senha deve ter pelo menos 8 caracteres.");
  if (!/[a-z]/.test(nova))         return showErr("Falta ao menos uma letra minúscula.");
  if (!/[A-Z]/.test(nova))         return showErr("Falta ao menos uma letra maiúscula.");
  if (!/\d/.test(nova))            return showErr("Falta ao menos um número.");
  if (!/[^A-Za-z0-9]/.test(nova))  return showErr("Falta ao menos um caractere especial (ex: !@#$%).");
  if (nova !== conf)               return showErr("As senhas não coincidem.");

  const btn = document.getElementById("wl-btn-salvar-senha");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Salvando...";
    btn.style.opacity = ".7";
  }

  const { error } = await supa.auth.updateUser({ password: nova });

  if (btn) {
    btn.disabled = false;
    btn.textContent = "🔒 Salvar Nova Senha";
    btn.style.opacity = "1";
  }

  if (error) {
    showErr("Erro: " + error.message);
  } else {
    document.getElementById("modal-alterar-senha").remove();
    const toast = document.createElement("div");
    toast.textContent = "✅ Senha alterada com sucesso!";
    toast.style.cssText =
      "position:fixed;bottom:28px;left:50%;transform:translateX(-50%);" +
      "background:#1a7a2e;color:#fff;padding:12px 24px;border-radius:12px;font-weight:600;" +
      "font-size:0.9rem;z-index:99999;box-shadow:0 8px 24px rgba(0,0,0,0.2)";
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }
}

// =========================================
// 9. VENDA BALCÃO (NOVA VERSÃO VISUAL)
// =========================================

// =========================================
// 9. VENDA BALCÃO (VISUAL / NOVO)
// =========================================
let carrinhoPDV = [];
let produtosCachePDV = [];
// Cotação carregada das configurações (fallback 1100)
let _cotacaoPDV = 1100;
let _taxaDebitoPDV = 1.99;
let _taxaCreditoPDV = 4.98;
let _cartaoBRTipoPDV = "debito";

async function carregarPDV() {
  // 🔧 Limpa IDs duplicados ANTES de qualquer getElementById
  _pdvLimparElementosDuplicados();

  // PDV carrega TODOS os produtos ativos (inclui pausado=null e pausado=false)
  // .neq("pausado", true) exclui NULLs no PostgREST — usar .or() para incluir
  const { data } = await supa
    .from("produtos")
    .select("*")
    .eq("ativo", true)
    .or("pausado.is.null,pausado.eq.false")
    .order("categoria_slug")
    .order("nome");
  produtosCachePDV = data || [];

  // Carrega categorias para exibir no PDV
  const { data: cats } = await supa
    .from("categorias")
    .select("*")
    .order("ordem");
  produtosCatsPDV = cats || [];

  // Carrega cotação atual das configurações
  const { data: cfg } = await supa
    .from("configuracoes")
    .select("cotacao_real, taxa_debito, taxa_credito")
    .maybeSingle();
  if (cfg?.cotacao_real) _cotacaoPDV = Number(cfg.cotacao_real);
  if (cfg?.taxa_debito != null) _taxaDebitoPDV = Number(cfg.taxa_debito);
  if (cfg?.taxa_credito != null) _taxaCreditoPDV = Number(cfg.taxa_credito);

  // Aplica visibilidade das formas de pagamento no PDV
  const { data: featCfg } = await supa
    .from("configuracoes")
    .select("features_ativas")
    .maybeSingle();
  _aplicarFormasPagamentoPDV(featCfg?.features_ativas);

  // ── Sincroniza painel de abertura de caixa no PDV ────────────────
  await _carregarSessaoCaixa();
  _pdvAtualizarPainelCaixa();

  renderizarGridPDV();
  atualizarBarraMesasAtivas();
  pdvIniciarTabs();

  // ── Alerta de pedidos pendentes + badge no menu ────────────────
  _injetarBadgeNoMenuPDV();
  await _atualizarBadgePedidosPendentes();

    _pdvRealocarBuscaParaTopo();

  // ⚠️ Revalida cache quando o operador volta o foco ao PDV.
  // Evita vender produto que esgotou enquanto a aba estava em background
  // (ex: operador trocou pra aba Pedidos e outro vendeu a última unidade).
  if (!window._pdvFocusListenerBound) {
    window._pdvFocusListenerBound = true;
    window.addEventListener("focus", async () => {
      if (localStorage.getItem("app_lastTab") !== "pdv") return;
      try {
        const { data: prodsFresh } = await supa
          .from("produtos")
          .select("id, nome, estoque_qtd, ativo")
          .eq("ativo", true);
        if (!prodsFresh?.length) return;
        let atualizados = 0;
        prodsFresh.forEach((fp) => {
          const cached = produtosCachePDV.find((p) => p.id === fp.id);
          if (
            cached &&
            cached.estoque_qtd !== fp.estoque_qtd &&
            (cached.estoque_qtd !== null || fp.estoque_qtd !== null)
          ) {
            cached.estoque_qtd = fp.estoque_qtd;
            atualizados++;
          }
        });
        if (atualizados > 0) {
          console.log(
            `[PDV] 🔄 Cache revalidado: ${atualizados} produto(s) atualizado(s)`,
          );
          renderizarGridPDV(document.getElementById("pdv-busca")?.value || "");
        }
      } catch (_) {
        /* silencioso */
      }
    });
  }
}

/**
 * Atualiza o mini-painel de status/abertura de caixa dentro do PDV.
 * Chamado após _carregarSessaoCaixa() para refletir o estado atual.
 *
 * 🔧 Os botões Sangria / Suprimento / Despesa só aparecem quando há
 *    sessão de caixa ABERTA — porque salvarMovimentacaoCaixa() exige
 *    _sessaoCaixaAtiva para registrar a movimentação.
 */
function _pdvAtualizarPainelCaixa() {
  const elStatus       = document.getElementById("pdv-status-caixa");
  const btnAbrir       = document.getElementById("pdv-btn-abrir-caixa");
  const btnFechar      = document.getElementById("pdv-btn-fechar-caixa");
  const btnSuprimento  = document.getElementById("pdv-btn-suprimento");
  const btnSangria     = document.getElementById("pdv-btn-sangria");
  const btnDespesa     = document.getElementById("pdv-btn-despesa");
  if (!elStatus) return;

  const botoesMov = [btnSuprimento, btnSangria, btnDespesa];

  if (_sessaoCaixaAtiva) {
    const dAbr = new Date(_sessaoCaixaAtiva.aberto_em).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Asuncion",
    });
    elStatus.innerHTML = `<span style="color:#27ae60">🟢 Aberto desde ${dAbr}</span>`;

    // Caixa aberto → esconde "Abrir", mostra movimentações + "Fechar"
    if (btnAbrir) btnAbrir.style.display = "none";
    botoesMov.forEach((b) => { if (b) b.style.display = "inline-flex"; });
    if (btnFechar) btnFechar.style.display = "inline-flex";
  } else {
    elStatus.innerHTML = `<span style="color:#e74c3c">🔴 Caixa fechado — abra para registrar vendas</span>`;

    // Caixa fechado → mostra "Abrir", esconde movimentações + "Fechar"
    if (btnAbrir) btnAbrir.style.display = "inline-flex";
    botoesMov.forEach((b) => { if (b) b.style.display = "none"; });
    if (btnFechar) btnFechar.style.display = "none";
  }
}

let produtosCatsPDV = [];

let _pdvCatFiltro = "todos";

function pdvSelecionarTipo(tipo, btn) {
  const inp = document.getElementById("balcao-tipo-entrega");
  if (inp) inp.value = tipo;
  document
    .querySelectorAll(".pdv-tipo-tab")
    .forEach((b) => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  const delivRow = document.getElementById("pdv-delivery-row");
  if (delivRow) delivRow.style.display = tipo === "delivery" ? "" : "none";
  atualizarCarrinhoPDV();
}

function renderizarGridPDV(filtroNome = "") {
  const grid = document.getElementById("pdv-grid");
  if (!grid) return;
  grid.innerHTML = "";

  // Gera chips de categoria
  const filterBar = document.getElementById("pdv-cat-filter");
  if (filterBar) {
    filterBar.innerHTML = "";
    const allChip = document.createElement("button");
    allChip.className = `pdv-cat-chip${_pdvCatFiltro === "todos" ? " active" : ""}`;
    allChip.textContent = "TODOS";
    allChip.onclick = () => {
      _pdvCatFiltro = "todos";
      renderizarGridPDV(document.getElementById("pdv-busca")?.value || "");
    };
    filterBar.appendChild(allChip);

    const slugsUsados = [
      ...new Set(produtosCachePDV.map((p) => p.categoria_slug).filter(Boolean)),
    ];
    const ordemCats = produtosCatsPDV.map((c) => c.slug);
    slugsUsados.sort((a, b) => {
      const ia = ordemCats.indexOf(a),
        ib = ordemCats.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });
    slugsUsados.forEach((slug) => {
      const catInfo = produtosCatsPDV.find((c) => c.slug === slug);
      const chip = document.createElement("button");
      chip.className = `pdv-cat-chip${_pdvCatFiltro === slug ? " active" : ""}`;
      chip.textContent = (catInfo?.nome_exibicao || slug).toUpperCase();
      chip.onclick = () => {
        _pdvCatFiltro = slug;
        renderizarGridPDV(document.getElementById("pdv-busca")?.value || "");
      };
      filterBar.appendChild(chip);
    });
  }

  // Filtra produtos
  const query = filtroNome.toLowerCase().trim();
  let produtos = produtosCachePDV.filter((p) => {
    if (_pdvCatFiltro !== "todos" && p.categoria_slug !== _pdvCatFiltro)
      return false;
    if (query && !p.nome.toLowerCase().includes(query)) return false;
    return true;
  });

  if (_pdvCatFiltro !== "todos" || query) {
    // Flat grid sem cabeçalhos de categoria
    const row = document.createElement("div");
    row.className = "pdv-cat-row";
    produtos.forEach((p) => {
      row.appendChild(_criarCardPDV(p));
    });
    if (produtos.length === 0) {
      row.innerHTML = `<p style="color:#aaa;grid-column:1/-1;text-align:center;padding:20px">Nenhum produto encontrado</p>`;
    }
    grid.appendChild(row);
    return;
  }

  // Agrupa por categoria
  const porCategoria = {};
  produtosCachePDV.forEach((p) => {
    const cat = p.categoria_slug || "outros";
    if (!porCategoria[cat]) porCategoria[cat] = [];
    porCategoria[cat].push(p);
  });

  const ordemCats = produtosCatsPDV.map((c) => c.slug);
  const slugsOrdenados = Object.keys(porCategoria).sort((a, b) => {
    const ia = ordemCats.indexOf(a),
      ib = ordemCats.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  slugsOrdenados.forEach((slug) => {
    const catInfo = produtosCatsPDV.find((c) => c.slug === slug);
    const catNome = catInfo ? catInfo.nome_exibicao : slug;

    const h = document.createElement("div");
    h.className = "pdv-cat-header";
    h.textContent = catNome;
    grid.appendChild(h);

    const row = document.createElement("div");
    row.className = "pdv-cat-row";
    porCategoria[slug].forEach((p) => row.appendChild(_criarCardPDV(p)));
    grid.appendChild(row);
  });
}

function _criarCardPDV(p) {
  const img = p.imagem_url || "";
  let cfg = p.montagem_config;
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch (_) {
      cfg = null;
    }
  }
  const isKg = cfg && !Array.isArray(cfg) && cfg.__tipo === "kg";
  const precoKg = isKg ? cfg.preco_kg || p.preco || 0 : 0;

  const card = document.createElement("div");
  card.className = "pdv-card" + (isKg ? " pdv-card-kg" : "");
  card.title = p.nome;
  card.onclick = () => adicionarItemPDV(p);

  const imgHtml = img
    ? `<div class="pdv-card-img" style="background-image:url('${img}')"></div>`
    : `<div class="pdv-card-img pdv-card-img-none"><i class="fas fa-utensils"></i></div>`;

  const priceStr = isKg
    ? `Gs ${precoKg.toLocaleString("es-PY")}<span class="pdv-card-unit">/kg</span>`
    : `Gs ${p.preco.toLocaleString("es-PY")}`;

  const badge = isKg ? `<span class="pdv-card-kg-badge">⚖️ Kg</span>` : "";

  card.innerHTML = `
    ${imgHtml}
    <div class="pdv-card-body">
      <div class="pdv-card-name">${p.nome} ${badge}</div>
      <div class="pdv-card-price">${priceStr}</div>
    </div>`;
  return card;
}

/**
 * Remove elementos duplicados no PDV.
 * O HTML tem IDs repetidos (pdv-f2-badge, pdv-f2-btn, pdv-busca-resultados),
 * o que faz getElementById pegar o PRIMEIRO — que está solto na coluna,
 * sem o position:absolute correto. Mantém apenas o ÚLTIMO (o que está
 * dentro de .pdv-busca-wrap).
 */
function _pdvLimparElementosDuplicados() {
  ["pdv-f2-badge", "pdv-f2-btn", "pdv-busca-resultados"].forEach((id) => {
    const els = document.querySelectorAll(`[id="${id}"]`);
    if (els.length > 1) {
      for (let i = 0; i < els.length - 1; i++) els[i].remove();
    }
  });
}

// ── PDV — FUNÇÕES AUXILIARES ───────────────────────────────────────

// Estado F2 (consultar preço sem adicionar ao carrinho)
let _pdvF2Mode = false;

function togglePdvF2Mode() {
  _pdvF2Mode = !_pdvF2Mode;

  const btn    = document.getElementById("pdv-f2-btn");
  const badge  = document.getElementById("pdv-f2-badge");
  const input  = document.getElementById("pdv-busca");

  if (btn)   btn.classList.toggle("active", _pdvF2Mode);
  if (badge) badge.style.display = _pdvF2Mode ? "inline-flex" : "none";

  // ── Feedback visual no campo de busca ──
  // Borda azul + placeholder diferente deixam ÓBVIO que o modo está ativo
  if (input) {
    if (_pdvF2Mode) {
      input.style.borderColor = "#1565c0";
      input.style.boxShadow   = "0 0 0 3px rgba(21,101,192,0.15)";
      input.placeholder       = "🔍 MODO PREÇO (F2) — consultar sem adicionar";
    } else {
      input.style.borderColor = "";
      input.style.boxShadow   = "";
      input.placeholder       = "🔍 Buscar produto, código ou escanear...";
    }
    input.focus();
    input.select();
  }

  // ── Toast informativo na ativação/desativação ──
  _pdvMostrarToast(
    _pdvF2Mode
      ? "🔍 Modo F2 ativo — apenas consulta, não adiciona ao carrinho"
      : "✅ Modo F2 desativado — voltou ao normal",
    _pdvF2Mode ? "#1565c0" : "#16a34a",
    2500,
  );
}

async function pdvBuscaKeydown(e) {
  const dropdown = document.getElementById("pdv-busca-resultados");
  const itens = dropdown ? [...dropdown.querySelectorAll(".pdv-resultado-item")] : [];

  // ── Navegação ↓↑ no dropdown ────────────────────────────
  if (e.key === "ArrowDown" && itens.length) {
    e.preventDefault();
    _pdvDropdownIdx = Math.min(_pdvDropdownIdx + 1, itens.length - 1);
    itens.forEach((el, i) => el.classList.toggle("pdv-resultado-ativo", i === _pdvDropdownIdx));
    itens[_pdvDropdownIdx]?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (e.key === "ArrowUp" && itens.length) {
    e.preventDefault();
    _pdvDropdownIdx = Math.max(_pdvDropdownIdx - 1, 0);
    itens.forEach((el, i) => el.classList.toggle("pdv-resultado-ativo", i === _pdvDropdownIdx));
    itens[_pdvDropdownIdx]?.scrollIntoView({ block: "nearest" });
    return;
  }

  // ── Escape: fecha dropdown, ou sai do F2 ─────────────────
  if (e.key === "Escape") {
    e.preventDefault();
    if (dropdown && dropdown.style.display !== "none") {
      _pdvFecharDropdown();
      return;
    }
    if (_pdvF2Mode) togglePdvF2Mode();
    return;
  }

  // ── F2 ───────────────────────────────────────────────────
  if (e.key === "F2") {
    e.preventDefault();
    togglePdvF2Mode();
    return;
  }

  // ── Enter ────────────────────────────────────────────────
    if (e.key === "Enter") {
    e.preventDefault();
    const rawBusca = (e.target.value || "").trim();
    if (!rawBusca) return;

    // Detecta prefixo "10+codigo" ou "10xcodigo"
    const { qty: qtdPrefixo, code: busca } = _pdvParseQtyPrefix(rawBusca);
    if (qtdPrefixo > 1) {
      pdvSetQtyMultiplier(qtdPrefixo);
      e.target.value = busca;
    }

    // Item ativo no dropdown → selecionar
    if (_pdvDropdownIdx >= 0 && itens[_pdvDropdownIdx]) {
      itens[_pdvDropdownIdx].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return;
    }

    // Exatamente 1 resultado no dropdown → selecionar direto
    if (itens.length === 1) {
      itens[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      return;
    }

    // Parece código de barras → buscar no banco
    const pareceBarcode =
      busca.length >= 6 && !busca.includes(" ") && /^[\d\w\-]+$/.test(busca);
    if (pareceBarcode) {
      const produto = await buscarProdutoPorBarcode(busca);
      if (produto) {
        if (_pdvF2Mode) {
          _pdvMostrarToast(
            `🔍 ${produto.nome} — Gs ${produto.preco.toLocaleString("es-PY")}`,
            "#1565c0",
            3000,
          );
        } else {
          if (typeof adicionarItemPDV === "function") adicionarItemPDV(produto);
          _pdvMostrarToast(`✅ ${produto.nome} adicionado!`, "#16a34a", 2000);
        }
        e.target.value = "";
        filtrarPDV("");
        return;
      }
    }

    // Fallback: clica no primeiro card visível que bate com a busca
    const buscaLow = busca.toLowerCase();
    const cards = document.querySelectorAll(".pdv-card");
    if (!cards.length) return;
    const primeiro =
      Array.from(cards).find((c) =>
        c.title?.toLowerCase().includes(buscaLow),
      ) || cards[0];
    primeiro?.click();
  }
}

// Estado cashback
let _pdvCashbackDisponivel = 0;
let _pdvCashbackUsando = false;

function pdvGetCashbackDesconto(total) {
  if (!_pdvCashbackUsando || _pdvCashbackDisponivel <= 0) return 0;
  return Math.min(_pdvCashbackDisponivel, total);
}

function pdvToggleCashback() {
  _pdvCashbackUsando = !_pdvCashbackUsando;
  const btn = document.getElementById("pdv-btn-usar-cash");
  if (btn) {
    btn.textContent = _pdvCashbackUsando
      ? "❌ Remover Cashback"
      : "💰 Usar Cashback";
    btn.style.background = _pdvCashbackUsando ? "#e74c3c" : "#ff9800";
  }
  atualizarCarrinhoPDV();
}

async function pdvTelefoneInput(tel) {
  tel = (tel || "").trim();
  const box = document.getElementById("pdv-cashback-box");
  if (!box) return;
  // Reseta estado ao mudar telefone
  _pdvCashbackDisponivel = 0;
  _pdvCashbackUsando = false;
  box.style.display = "none";
  if (tel.length < 7) return;
  try {
    const { data } = await supa
      .from("clientes")
      .select("nome, cashback_saldo")
      .eq("telefone", tel)
      .maybeSingle();
    if (data && data.cashback_saldo > 0) {
      _pdvCashbackDisponivel = data.cashback_saldo;
      const nomeEl = document.getElementById("pdv-cash-nome");
      const saldoEl = document.getElementById("pdv-cash-saldo");
      if (nomeEl) nomeEl.textContent = data.nome || "Cliente";
      if (saldoEl)
        saldoEl.textContent =
          "Gs " + data.cashback_saldo.toLocaleString("es-PY");
      box.style.display = "block";
    }
  } catch (_) {
    /* silencioso */
  }
}

// ── Fim funções auxiliares PDV ─────────────────────────────────────

// ── Dropdown de busca PDV ───────────────────────────────────────────
let _pdvDropdownIdx = -1; // índice do item ativo para navegação por teclado

function filtrarPDV(valor) {
  // Mantém o grid oculto sincronizado (compatibilidade com resto do código)
  renderizarGridPDV(valor);

  const dropdown = document.getElementById("pdv-busca-resultados");
  if (!dropdown) return;

  const colEsq = document.querySelector(".pdv-col-esq");
  const query  = (valor || "").trim();

  // Sem texto → fecha dropdown e sai do modo busca
  if (!query) {
    dropdown.style.display = "none";
    dropdown.innerHTML = "";
    colEsq?.classList.remove("pdv-buscando");
    _pdvDropdownIdx = -1;
    return;
  }

  // ── Busca ativa → ativa o modo "pdv-buscando" UMA vez ──
  // (Antes essa função adicionava e removia a classe na mesma chamada,
  //  o que a deixava sempre DESATIVADA. Agora só adiciona.)
  colEsq?.classList.add("pdv-buscando");

  const ql = query.toLowerCase();
  const resultados = (produtosCachePDV || [])
    .filter((p) => p.ativo !== false &&
      (p.nome.toLowerCase().includes(ql) ||
       (p.codigo_barras && String(p.codigo_barras).includes(ql))))
    .slice(0, 30);

  dropdown.innerHTML = "";
  _pdvDropdownIdx = -1;

  if (!resultados.length) {
    dropdown.innerHTML = `<div class="pdv-resultado-vazio">Nenhum produto encontrado para "<b>${query}</b>"</div>`;
    dropdown.style.display = "block";
    return;
  }

  resultados.forEach((p, i) => {
    const item = document.createElement("div");
    item.className = "pdv-resultado-item";
    item.dataset.idx = i;

    let cfg = p.montagem_config;
    if (typeof cfg === "string") { try { cfg = JSON.parse(cfg); } catch(_) { cfg = null; } }
    const isKg = cfg && !Array.isArray(cfg) && cfg.__tipo === "kg";
    const preco = isKg ? (cfg.preco_kg || p.preco || 0) : (p.preco || 0);
    const precoStr = `Gs ${preco.toLocaleString("es-PY")}${isKg ? "/kg" : ""}`;
    const catNome = (produtosCatsPDV || []).find(c => c.slug === p.categoria_slug)?.nome_exibicao || "";

    const fotoHtml = p.imagem_url
      ? `<img class="pdv-resultado-foto" src="${p.imagem_url}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : ``;
    const fotoNone = `<div class="pdv-resultado-foto-none" ${p.imagem_url ? 'style="display:none"' : ''}><i class="fas fa-box"></i></div>`;

    item.innerHTML = `
      ${fotoHtml}${fotoNone}
      <div class="pdv-resultado-info">
        <div class="pdv-resultado-nome">${p.nome}${isKg ? ' <span style="font-size:0.72rem;color:#888">⚖️ kg</span>' : ''}</div>
        <div class="pdv-resultado-preco">${precoStr}</div>
        ${catNome ? `<div class="pdv-resultado-cat">${catNome}</div>` : ""}
      </div>`;

    item.addEventListener("mousedown", (e) => {
      e.preventDefault(); // evita blur antes do click
      _pdvSelecionarResultado(p);
    });

    dropdown.appendChild(item);
  });

  dropdown.style.display = "block";
}

function _pdvSelecionarResultado(p) {
  // ── Modo F2 (consulta de preço): apenas exibe, NÃO adiciona ao carrinho ──
  if (_pdvF2Mode) {
    // Extrai o preço — considera venda por kg
    let cfg = p.montagem_config;
    if (typeof cfg === "string") {
      try { cfg = JSON.parse(cfg); } catch (_) { cfg = null; }
    }
    const isKg = cfg && !Array.isArray(cfg) && cfg.__tipo === "kg";
    const preco = isKg ? (cfg.preco_kg || p.preco || 0) : (p.preco || 0);
    const precoFmt = `Gs ${preco.toLocaleString("es-PY")}${isKg ? "/kg" : ""}`;

    // Toast grande com o preço (fica visível por 3.5s)
    _pdvMostrarToast(
      `🔍 ${p.nome} — ${precoFmt}`,
      "#1565c0",
      3500,
    );

    // Limpa input, fecha dropdown, mas MANTÉM o modo F2 ativo para a próxima consulta
    const input = document.getElementById("pdv-busca");
    if (input) { input.value = ""; input.focus(); }
    const dropdown = document.getElementById("pdv-busca-resultados");
    if (dropdown) { dropdown.style.display = "none"; dropdown.innerHTML = ""; }
    document.querySelector(".pdv-col-esq")?.classList.remove("pdv-buscando");
    _pdvDropdownIdx = -1;
    return; // ← sai sem adicionar
  }

  // ── Modo normal: adiciona ao carrinho ─────────────────────────────────
  adicionarItemPDV(p);
  const input = document.getElementById("pdv-busca");
  if (input) { input.value = ""; input.focus(); }
  const dropdown = document.getElementById("pdv-busca-resultados");
  if (dropdown) { dropdown.style.display = "none"; dropdown.innerHTML = ""; }
  document.querySelector(".pdv-col-esq")?.classList.remove("pdv-buscando");
  _pdvDropdownIdx = -1;
}

function _pdvFecharDropdown() {
  const dropdown = document.getElementById("pdv-busca-resultados");
  if (dropdown) dropdown.style.display = "none";
  _pdvDropdownIdx = -1;
}

// Fechar dropdown ao clicar fora
document.addEventListener("click", (e) => {
  if (!e.target.closest("#pdv-busca-resultados") && e.target.id !== "pdv-busca") {
    _pdvFecharDropdown();
  }
});

// Categorias que NÃO recebem o upsell de extras globais
const _CATS_SEM_EXTRAS_GLOBAIS = [
  "bebidas",
  "bebida",
  "extras",
  "extra",
  "molhos",
  "adicionais",
];

// Extras globais configurados pelo admin
let _extrasGlobaisCache = null;
async function _getExtrasGlobais() {
  if (_extrasGlobaisCache !== null) return _extrasGlobaisCache;
  try {
    const { data } = await supa
      .from("configuracoes")
      .select("extras_globais")
      .maybeSingle();
    _extrasGlobaisCache =
      data &&
      Array.isArray(data.extras_globais) &&
      data.extras_globais.length > 0
        ? data.extras_globais
        : []; // sem fallback hardcoded — se não configurado, não mostra upsell
  } catch (_e) {
    _extrasGlobaisCache = [];
  }
  return _extrasGlobaisCache;
}

function _deveMostrarExtrasGlobais(produto) {
  const cat = (produto.categoria_slug || "").toLowerCase();
  return !_CATS_SEM_EXTRAS_GLOBAIS.some((c) => cat.includes(c));
}

// ── Toast helper do PDV ───────────────────────────────────────────
function _pdvMostrarToast(msg, cor, duracao) {
  // Remove toast anterior se ainda visível
  document.getElementById("_pdv-toast")?.remove();
  const el = document.createElement("div");
  el.id = "_pdv-toast";
  el.style.cssText = `
    position:fixed;bottom:88px;left:50%;transform:translateX(-50%) translateY(8px);
    background:${cor || "#16a34a"};color:#fff;padding:11px 22px;border-radius:10px;
    font-weight:700;z-index:9999;font-size:0.92rem;box-shadow:0 4px 16px rgba(0,0,0,.22);
    opacity:0;transition:opacity .18s,transform .18s;pointer-events:none;white-space:nowrap`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.opacity = "1";
    el.style.transform = "translateX(-50%) translateY(0)";
  });
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateX(-50%) translateY(8px)";
    setTimeout(() => el.remove(), 200);
  }, duracao || 2000);
}

function adicionarItemPDV(p) {
  // montagem_config pode chegar como string JSON de bancos antigos
  let cfg = p.montagem_config;
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch (_) {
      cfg = null;
    }
  }
  const tipo = cfg && !Array.isArray(cfg) && cfg.__tipo ? cfg.__tipo : null;

  // Kg → modal de peso/balança
  if (tipo === "kg") {
    _mostrarModalPesoPDV(p, cfg.preco_kg || p.preco || 0);
    return;
  }

  // Tipos com seleção obrigatória → abre modal de opções
  if (tipo === "variacoes" && cfg.variacoes?.length > 0) {
    const ativas = cfg.variacoes.filter((v) => v.ativo !== false);
    if (!ativas.length) {
      alert("⏸️ Todas as variações estão pausadas.");
      return;
    }
    _mostrarModalOpcoesPDV(p, "variacoes");
    return;
  }
  if (tipo === "pizza") {
    _mostrarModalOpcoesPDV(p, "pizza");
    return;
  }
  if (tipo === "acai") {
    _mostrarModalOpcoesPDV(p, "acai");
    return;
  }
  if (tipo === "shake") {
    _mostrarModalOpcoesPDV(p, "shake");
    return;
  }
  if (tipo === "suco") {
    _mostrarModalOpcoesPDV(p, "suco");
    return;
  }
  if (tipo === "sorvete") {
    _mostrarModalOpcoesPDV(p, "sorvete");
    return;
  }
  if (tipo === "montavel" && cfg.etapas?.length > 0) {
    _mostrarModalOpcoesPDV(p, "montavel");
    return;
  }

    // Simples / Lanche / Bebida / Combo — adiciona direto
    // Aplica o multiplicador atual (botões +5/+10 ou prefixo "10+")
    const mult = Math.max(1, parseInt(window._pdvQtyMultiplier || 1, 10));
    const existe = carrinhoPDV.find((i) => i.id === p.id && !i.variacao);
    if (existe) existe.qtd += mult;
    else carrinhoPDV.push({
      ...p,
      qtd: mult,
      montagem: [],
      obs: "",
      _extrasSoma: 0,
    });
    // Reseta multiplicador após adicionar
    pdvSetQtyMultiplier(1);
    atualizarCarrinhoPDV();

  if (_deveMostrarExtrasGlobais(p)) {
    _getExtrasGlobais().then((extras) => {
      if (extras?.length > 0) _mostrarUpsellExtrasPDV(p, extras);
    });
  }
}

// ── Modal unificado de opções para PDV ────────────────────────────
// Cobre: variacoes, pizza, acai, shake, suco, sorvete, montavel
function _mostrarModalOpcoesPDV(produto, tipo) {
  document.getElementById("pdv-opcoes-modal")?.remove();

  let cfg = produto.montagem_config || {};
  if (typeof cfg === "string") {
    try {
      cfg = JSON.parse(cfg);
    } catch (_) {
      cfg = {};
    }
  }
  const cacheKey = "pdv_" + (produto.id || Date.now());
  window._pdvProdCache[cacheKey] = produto;

  const overlay = document.createElement("div");
  overlay.id = "pdv-opcoes-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:flex-end;justify-content:center;padding:0";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff;border-radius:20px 20px 0 0;width:100%;max-width:520px;max-height:88vh;overflow-y:auto;padding:20px 16px 32px;box-shadow:0 -8px 40px rgba(0,0,0,0.2)";

  // Header
  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <div>
        <div style="font-weight:800;font-size:1rem;color:#1a1a1a">${produto.nome}</div>
        <div style="font-size:0.8rem;color:#888">Gs ${(produto.preco || 0).toLocaleString("es-PY")}</div>
      </div>
      <button onclick="document.getElementById('pdv-opcoes-modal').remove()"
        style="background:#f3f4f6;border:none;border-radius:50%;width:32px;height:32px;font-size:1.1rem;cursor:pointer;color:#666">✕</button>
    </div>
    <div id="_pdv-modal-corpo"></div>
    <div id="_pdv-obs-row" style="margin-top:12px">
      <label style="font-size:0.8rem;font-weight:600;color:#555">Observações</label>
      <input type="text" id="_pdv-obs-input" class="form-control" placeholder="Ex: sem cebola, bem passado..." style="margin-top:4px">
    </div>
    <button id="_pdv-modal-add" onclick="_pdvModalConfirmar('${cacheKey}')"
      style="width:100%;padding:14px;background:var(--primary,#1a7a2e);color:#fff;border:none;border-radius:12px;font-size:1rem;font-weight:800;cursor:pointer;margin-top:16px">
      ✅ Adicionar ao Pedido
    </button>`;

  const corpo = () => modal.querySelector("#_pdv-modal-corpo");

  // ── VARIAÇÕES ────────────────────────────────────────────────
  if (tipo === "variacoes") {
    const ativas = (cfg.variacoes || []).filter((v) => v.ativo !== false);
    corpo().innerHTML = `<p style="font-size:0.82rem;color:#555;margin-bottom:10px;font-weight:600">Escolha a variação:</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${ativas
          .map(
            (v, i) => `
          <label style="display:flex;align-items:center;gap:12px;border:2px solid #e5e7eb;border-radius:10px;padding:10px 12px;cursor:pointer;transition:all .15s"
            onclick="this.closest('div').querySelectorAll('label').forEach(l=>l.style.borderColor='#e5e7eb');this.style.borderColor='var(--primary)';this.style.background='#f0fff4'">
            <input type="radio" name="_pdv_var" value="${i}" style="width:18px;height:18px" ${i === 0 ? "checked" : ""}>
            ${v.img || produto.imagem_url ? `<img src="${v.img || produto.imagem_url}" style="width:44px;height:44px;border-radius:8px;object-fit:cover" onerror="this.style.display='none'">` : ""}
            <div style="flex:1"><div style="font-weight:700;font-size:0.9rem">${v.nome}</div></div>
            <div style="font-weight:700;color:var(--primary)">Gs ${(v.preco || produto.preco || 0).toLocaleString("es-PY")}</div>
          </label>`,
          )
          .join("")}
      </div>`;
  }

  // ── PIZZA ────────────────────────────────────────────────────
  else if (tipo === "pizza") {
    const tamanhos = cfg.tamanhos || [];
    const sabores = cfg.sabores || [];
    const bordas = cfg.bordas || [];

    // ── Helpers de preço (igual ao app.js) ──────────────────────
    // Retorna o preço do tamanho para um determinado tipo de sabor
    const _pdvPrecoTipo = (tam, tipo) => {
      if (!tam) return 0;
      const precos = tam.precos || {};
      if (tipo && precos[tipo] > 0) return precos[tipo];
      if (tipo) {
        const k = Object.keys(precos).find(
          (k2) => k2.toLowerCase() === (tipo || "").toLowerCase(),
        );
        if (k && precos[k] > 0) return precos[k];
      }
      return tam.preco || 0;
    };
    // Retorna o menor preço disponível no tamanho (preço base)
    const _pdvPrecoMin = (tam) => {
      if (!tam) return 0;
      const vals = Object.values(tam.precos || {}).filter((v) => v > 0);
      return vals.length ? Math.min(...vals) : tam.preco || 0;
    };

    let html = "";

    // ── Passo 1: Tamanho (cards com fatias, cm e preço — igual ao app.js) ──
    if (tamanhos.length) {
      html += `<div style="margin-bottom:14px">
        <p style="font-size:0.82rem;font-weight:700;color:#e74c3c;margin-bottom:8px">📐 Tamanho:</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px" id="_pdv_pizza_tam_grid">
          ${tamanhos
            .map(
              (t, i) => `
            <label style="border:2px solid ${i === 0 ? "#e74c3c" : "#e5e7eb"};background:${i === 0 ? "#fff5f5" : ""};border-radius:10px;padding:10px 12px;cursor:pointer;text-align:center;min-width:80px;transition:all .15s"
              onclick="this.closest('#_pdv_pizza_tam_grid').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#e74c3c';this.style.background='#fff5f5';_pdvPizzaAtualizarPreco()">
              <input type="radio" name="_pdv_pizza_tam" value="${i}" style="display:none" ${i === 0 ? "checked" : ""}>
              <div style="font-weight:700;font-size:0.9rem">${t.nome}</div>
              ${t.fatias ? `<div style="font-size:0.7rem;color:#888">${t.fatias} fatias</div>` : ""}
              ${t.cm ? `<div style="font-size:0.7rem;color:#888">⌀${t.cm}cm</div>` : ""}
              <div style="font-size:0.82rem;font-weight:800;color:#e74c3c;margin-top:3px">Gs ${(t.preco || 0).toLocaleString("es-PY")}</div>
            </label>`,
            )
            .join("")}
        </div>
      </div>`;
    }

    // ── Passo 2: Sabores — cada card mostra o preço do seu tipo (igual ao app.js) ──
    const maxSabDefault = tamanhos[0]?.max_sabores || 2;
    const tam0 = tamanhos[0];
    const precoMin0 = _pdvPrecoMin(tam0);
    html += `<div style="margin-bottom:14px">
      <p style="font-size:0.82rem;font-weight:700;color:#e74c3c;margin-bottom:8px">🍽️ Sabores <span id="_pdv_pizza_maxlabel" style="font-weight:400;color:#888">(até ${maxSabDefault})</span>:</p>
      <div id="_pdv_sabores_lista" style="display:flex;flex-direction:column;gap:6px">
        ${sabores
          .map((s) => {
            const precoEste0 = _pdvPrecoTipo(tam0, s.tipo);
            const diff0 = precoEste0 - precoMin0;
            const precoLbl =
              diff0 > 0
                ? `<span id="_pdv_sp_${s.nome.replace(/[^a-zA-Z0-9]/g, "_")}" style="font-size:0.78rem;font-weight:700;color:#e74c3c;white-space:nowrap">+Gs ${diff0.toLocaleString("es-PY")}</span>`
                : `<span id="_pdv_sp_${s.nome.replace(/[^a-zA-Z0-9]/g, "_")}" style="font-size:0.78rem;font-weight:700;color:#e74c3c;white-space:nowrap"></span>`;
            const tipoBadge = s.tipo
              ? `<span style="font-size:0.68rem;background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 6px;margin-left:4px;font-weight:600">${s.tipo}</span>`
              : "";
            return `
            <label style="display:flex;align-items:center;gap:10px;border:1.5px solid #e5e7eb;border-radius:8px;padding:8px 10px;cursor:pointer;transition:all .15s"
              data-tipo-sabor="${s.tipo || ""}"
              onclick="(function(el){var cb=el.querySelector('input[type=checkbox]');if(!cb.checked){var t=parseInt(document.getElementById('_pdv_pizza_maxlabel').textContent.match(/\\d+/)?.[0]||2);var chk=document.querySelectorAll('#_pdv_sabores_lista input[type=checkbox]:checked').length;if(chk>=t){alert('Máx. '+t+' sabores');return;}cb.checked=true;el.style.borderColor='#e74c3c';el.style.background='#fff5f5';}else{cb.checked=false;el.style.borderColor='#e5e7eb';el.style.background='';}if(typeof _pdvPizzaAtualizarPreco==='function')_pdvPizzaAtualizarPreco();})(this)">
              <input type="checkbox" value="${s.nome}" style="display:none">
              ${s.img ? `<img src="${s.img}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">` : `<span style="font-size:1.4rem;flex-shrink:0">🍕</span>`}
              <div style="flex:1;min-width:0">
                <div style="font-size:0.88rem;font-weight:600">${s.nome}${tipoBadge}</div>
                ${s.desc ? `<div style="font-size:0.73rem;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.desc}</div>` : ""}
              </div>
              ${precoLbl}
            </label>`;
          })
          .join("")}
      </div>
    </div>`;

    // ── Passo 3: Borda (opcional) — com update de preço ──────────
    if (bordas.length) {
      html += `<div style="margin-bottom:14px">
        <p style="font-size:0.82rem;font-weight:700;color:#e74c3c;margin-bottom:8px">🧀 Borda (opcional):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px" id="_pdv_pizza_borda_grid">
          <label style="border:2px solid #27ae60;background:#f0fff4;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:all .15s"
            onclick="this.closest('#_pdv_pizza_borda_grid').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#27ae60';this.style.background='#f0fff4';if(typeof _pdvPizzaAtualizarPreco==='function')_pdvPizzaAtualizarPreco()">
            <input type="radio" name="_pdv_pizza_borda" value="" style="display:none" checked> Sem borda
          </label>
          ${bordas
            .map(
              (b) => `
            <label style="border:2px solid #e5e7eb;border-radius:8px;padding:8px 12px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:all .15s"
              onclick="this.closest('#_pdv_pizza_borda_grid').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#27ae60';this.style.background='#f0fff4';if(typeof _pdvPizzaAtualizarPreco==='function')_pdvPizzaAtualizarPreco()">
              <input type="radio" name="_pdv_pizza_borda" value="${b.nome}" style="display:none">
              ${b.nome}${b.preco ? ` <span style="color:#e74c3c">+Gs ${b.preco.toLocaleString("es-PY")}</span>` : ""}
            </label>`,
            )
            .join("")}
        </div>
      </div>`;
    }

    html += `<div id="_pdv_pizza_preco_box" style="background:#fff5f5;border:1.5px solid #fca5a5;border-radius:10px;padding:10px 14px;text-align:center;margin-bottom:8px">
      <div style="font-size:0.78rem;color:#888;margin-bottom:2px">★ Prevalece o preço do tipo mais caro entre os sabores</div>
      <div style="font-size:0.8rem;color:#888">Total estimado:</div>
      <div id="_pdv_pizza_preco_val" style="font-size:1.4rem;font-weight:800;color:#e74c3c">Gs —</div>
    </div>`;

    corpo().innerHTML = html;

    // Expõe cfg para uso externo
    window._pdvPizzaCfg = cfg;

    // ── _pdvPizzaAtualizarPreco: igual ao app.js ─────────────────
    // Preço = max(tam.precos[tipo] para cada sabor selecionado) + borda
    window._pdvPizzaAtualizarPreco = function () {
      const tamIdx = parseInt(
        modal.querySelector('input[name="_pdv_pizza_tam"]:checked')?.value ?? 0,
      );
      const tam = cfg.tamanhos?.[tamIdx];
      if (!tam) return;

      // Atualiza label de max sabores
      const maxLbl = modal.querySelector("#_pdv_pizza_maxlabel");
      if (maxLbl) maxLbl.textContent = `(até ${tam.max_sabores || 2})`;

      // Atualiza preço diferencial em cada card de sabor
      const precoMin = _pdvPrecoMin(tam);
      modal.querySelectorAll("#_pdv_sabores_lista label").forEach((lbl) => {
        const tipo = lbl.dataset.tipoSabor || "";
        const precoEste = _pdvPrecoTipo(tam, tipo);
        const diff = precoEste - precoMin;
        const nomeSabor = (
          lbl.querySelector("input[type=checkbox]")?.value || ""
        ).replace(/[^a-zA-Z0-9]/g, "_");
        const el = modal.querySelector(`#_pdv_sp_${nomeSabor}`);
        if (el)
          el.textContent =
            diff > 0 ? `+Gs ${diff.toLocaleString("es-PY")}` : "";
      });

      // Calcula preço: max dos tipos dos sabores selecionados (REGRA DE OURO — igual app.js)
      const saboresSel = [
        ...modal.querySelectorAll(
          "#_pdv_sabores_lista input[type=checkbox]:checked",
        ),
      ].map((c) => c.closest("label")?.dataset.tipoSabor || "");

      let precoBase;
      if (saboresSel.length > 0) {
        precoBase = Math.max(
          ...saboresSel.map((tipo) => _pdvPrecoTipo(tam, tipo)),
        );
      } else {
        precoBase = tam.preco || 0;
      }

      const bordaVal =
        modal.querySelector('input[name="_pdv_pizza_borda"]:checked')?.value ||
        "";
      const bordaPreco = bordaVal
        ? cfg.bordas?.find((b) => b.nome === bordaVal)?.preco || 0
        : 0;

      const el = modal.querySelector("#_pdv_pizza_preco_val");
      if (el)
        el.textContent =
          "Gs " + (precoBase + bordaPreco).toLocaleString("es-PY");
    };

    // Compatibilidade — mantém função de filtro mas delegando para update de preço
    window._pdvPizzaFiltrarSabores = function () {
      _pdvPizzaAtualizarPreco();
    };

    _pdvPizzaAtualizarPreco();
  }

  // ── AÇAÍ ────────────────────────────────────────────────────
  else if (tipo === "acai") {
    let html = "";
    if (cfg.tamanhos?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#7c3aed;margin-bottom:6px">🍇 Tamanho:</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
          ${cfg.tamanhos
            .map(
              (t, i) => `
            <label style="border:2px solid ${i === 0 ? "#7c3aed" : "#e5e7eb"};border-radius:10px;padding:8px 10px;cursor:pointer;text-align:center;min-width:70px;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#7c3aed';this.style.background='#f5f3ff'">
              <input type="radio" name="_pdv_acai_tam" value="${i}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${t.img ? `<img src="${t.img}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;display:block;margin:0 auto 4px" onerror="this.style.display='none'">` : ""}
              <div style="font-weight:700;font-size:0.85rem">${t.nome}</div>
              <div style="font-size:0.75rem;color:#7c3aed;font-weight:600">Gs ${(t.preco || 0).toLocaleString("es-PY")}</div>
            </label>`,
            )
            .join("")}
        </div>`;
    }
    if (cfg.acompanhamentos?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#7c3aed;margin-bottom:6px">🥄 Acompanhamentos:</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">
          ${cfg.acompanhamentos
            .map(
              (a) => `
            <label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:7px 10px;cursor:pointer;font-size:0.83rem;font-weight:600;display:flex;align-items:center;gap:6px;transition:all .15s"
              onclick="var cb=this.querySelector('input');cb.checked=!cb.checked;this.style.borderColor=cb.checked?'#7c3aed':'#e5e7eb';this.style.background=cb.checked?'#f5f3ff':''">
              <input type="checkbox" value="${a.nome}" style="display:none">
              ${a.img ? `<img src="${a.img}" style="width:28px;height:28px;border-radius:4px;object-fit:cover" onerror="this.style.display='none'">` : ""}
              ${a.nome} ${a.preco ? `(+Gs ${a.preco.toLocaleString("es-PY")})` : ""}
            </label>`,
            )
            .join("")}
        </div>`;
    }
    (cfg.etapas || []).forEach((et) => {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#7c3aed;margin-bottom:6px">${et.titulo} (até ${et.max}):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${(et.itens || [])
            .map((it) => {
              const nome = it.nome || it;
              return `<label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:0.83rem;font-weight:600;transition:all .15s"
              onclick="var cb=this.querySelector('input');if(!cb.checked){var m=${et.max};var ch=this.closest('div').querySelectorAll('input:checked').length;if(ch>=m){alert('Máx. '+m+' itens');return;}cb.checked=true;this.style.borderColor='#7c3aed';this.style.background='#f5f3ff';}else{cb.checked=false;this.style.borderColor='#e5e7eb';this.style.background='';}">
              <input type="checkbox" value="${nome}" style="display:none">${nome}
            </label>`;
            })
            .join("")}
        </div>`;
    });
    corpo().innerHTML = html;
  }

  // ── SHAKE ────────────────────────────────────────────────────
  else if (tipo === "shake") {
    const sk = cfg.shake || {};
    let html = "";
    if (sk.tamanhos?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#2980b9;margin-bottom:6px">📐 Tamanho:</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
          ${sk.tamanhos
            .map(
              (t, i) => `
            <label style="border:2px solid ${i === 0 ? "#2980b9" : "#e5e7eb"};border-radius:10px;padding:8px 12px;cursor:pointer;font-size:0.88rem;font-weight:600;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#2980b9';this.style.background='#e8f4fd'">
              <input type="radio" name="_pdv_shake_tam" value="${i}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${t.nome}${t.ml ? ` (${t.ml}ml)` : ""}<br><span style="font-size:0.75rem;color:#2980b9">Gs ${(t.preco || 0).toLocaleString("es-PY")}</span>
            </label>`,
            )
            .join("")}
        </div>`;
    }
    if (sk.sabores?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#2980b9;margin-bottom:6px">🍓 Sabor:</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:14px">
          ${sk.sabores
            .map(
              (s, i) => `
            <label style="border:2px solid ${i === 0 ? "#2980b9" : "#e5e7eb"};border-radius:10px;padding:8px;cursor:pointer;text-align:center;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#2980b9';this.style.background='#e8f4fd'">
              <input type="radio" name="_pdv_shake_sabor" value="${s.nome}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${s.img ? `<img src="${s.img}" style="width:44px;height:44px;border-radius:8px;object-fit:cover;display:block;margin:0 auto 4px" onerror="this.style.display='none'">` : ""}
              <div style="font-size:0.83rem;font-weight:600">${s.nome}</div>
              ${s.preco ? `<div style="font-size:0.72rem;color:#2980b9">+Gs ${s.preco.toLocaleString("es-PY")}</div>` : ""}
            </label>`,
            )
            .join("")}
        </div>`;
    }
    corpo().innerHTML = html;
  }

  // ── SUCO ────────────────────────────────────────────────────
  else if (tipo === "suco") {
    let html = "";
    if (cfg.tamanhos?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#f59e0b;margin-bottom:6px">📐 Tamanho:</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
          ${cfg.tamanhos
            .map(
              (t, i) => `
            <label style="border:2px solid ${i === 0 ? "#f59e0b" : "#e5e7eb"};border-radius:10px;padding:8px 12px;cursor:pointer;font-size:0.88rem;font-weight:600;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#f59e0b';this.style.background='#fffbeb'">
              <input type="radio" name="_pdv_suco_tam" value="${i}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${t.nome}<br><span style="font-size:0.75rem;color:#f59e0b">Gs ${(t.preco || 0).toLocaleString("es-PY")}</span>
            </label>`,
            )
            .join("")}
        </div>`;
    }
    (cfg.etapas || []).forEach((et) => {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#f59e0b;margin-bottom:6px">${et.titulo} (até ${et.max}):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${(et.itens || [])
            .map((it) => {
              const nome = it.nome || it;
              return `<label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:0.83rem;font-weight:600;transition:all .15s"
              onclick="var cb=this.querySelector('input');if(!cb.checked){var m=${et.max};var ch=this.closest('div').querySelectorAll('input:checked').length;if(ch>=m){alert('Máx. '+m+' itens');return;}cb.checked=true;this.style.borderColor='#f59e0b';this.style.background='#fffbeb';}else{cb.checked=false;this.style.borderColor='#e5e7eb';this.style.background='';}">
              <input type="checkbox" value="${nome}" style="display:none">${nome}
            </label>`;
            })
            .join("")}
        </div>`;
    });
    corpo().innerHTML = html;
  }

  // ── SORVETE ─────────────────────────────────────────────────
  else if (tipo === "sorvete") {
    let html = "";
    if (cfg.tamanhos?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#0ea5e9;margin-bottom:6px">🍦 Quantidade de Bolas:</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
          ${cfg.tamanhos
            .map(
              (t, i) => `
            <label style="border:2px solid ${i === 0 ? "#0ea5e9" : "#e5e7eb"};border-radius:10px;padding:8px 12px;cursor:pointer;font-size:0.88rem;font-weight:600;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#0ea5e9';this.style.background='#f0f9ff'">
              <input type="radio" name="_pdv_sorv_tam" value="${i}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${t.nome}<br><span style="font-size:0.75rem;color:#0ea5e9">Gs ${(t.preco || 0).toLocaleString("es-PY")}</span>
            </label>`,
            )
            .join("")}
        </div>`;
    }
    if (cfg.sabores?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#0ea5e9;margin-bottom:6px">🎨 Sabores:</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(100px,1fr));gap:6px;margin-bottom:14px">
          ${cfg.sabores
            .map(
              (s) => `
            <label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:7px;cursor:pointer;text-align:center;transition:all .15s"
              onclick="var cb=this.querySelector('input');cb.checked=!cb.checked;this.style.borderColor=cb.checked?'#0ea5e9':'#e5e7eb';this.style.background=cb.checked?'#f0f9ff':''">
              <input type="checkbox" value="${s.nome}" style="display:none">
              ${s.img ? `<img src="${s.img}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;display:block;margin:0 auto 4px" onerror="this.style.display='none'">` : ""}
              <div style="font-size:0.8rem;font-weight:600">${s.nome}</div>
              ${s.preco ? `<div style="font-size:0.7rem;color:#0ea5e9">+Gs ${s.preco.toLocaleString("es-PY")}</div>` : ""}
            </label>`,
            )
            .join("")}
        </div>`;
    }
    if (cfg.variacoes?.length) {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#0ea5e9;margin-bottom:6px">🍦 Servir em:</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${cfg.variacoes
            .map(
              (v, i) => `
            <label style="border:2px solid ${i === 0 ? "#0ea5e9" : "#e5e7eb"};border-radius:8px;padding:7px 12px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:all .15s"
              onclick="this.closest('div').querySelectorAll('label').forEach(l=>{l.style.borderColor='#e5e7eb';l.style.background=''});this.style.borderColor='#0ea5e9';this.style.background='#f0f9ff'">
              <input type="radio" name="_pdv_sorv_var" value="${v.nome}" style="display:none" ${i === 0 ? "checked" : ""}>
              ${v.nome} ${v.preco ? `(+Gs ${v.preco.toLocaleString("es-PY")})` : ""}
            </label>`,
            )
            .join("")}
        </div>`;
    }
    (cfg.etapas || []).forEach((et) => {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#0ea5e9;margin-bottom:6px">${et.titulo} (até ${et.max}):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${(et.itens || [])
            .map((it) => {
              const nome = it.nome || it;
              return `<label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:0.83rem;font-weight:600;transition:all .15s"
              onclick="var cb=this.querySelector('input');if(!cb.checked){var m=${et.max};var ch=this.closest('div').querySelectorAll('input:checked').length;if(ch>=m){alert('Máx. '+m+' itens');return;}cb.checked=true;this.style.borderColor='#0ea5e9';this.style.background='#f0f9ff';}else{cb.checked=false;this.style.borderColor='#e5e7eb';this.style.background='';}">
              <input type="checkbox" value="${nome}" style="display:none">${nome}
            </label>`;
            })
            .join("")}
        </div>`;
    });
    corpo().innerHTML = html;
  }

  // ── MONTÁVEL GENÉRICO ────────────────────────────────────────
  else if (tipo === "montavel") {
    let html = "";
    (cfg.etapas || []).forEach((et) => {
      html += `<p style="font-size:0.82rem;font-weight:700;color:#e67e22;margin-bottom:6px">${et.titulo} (até ${et.max}):</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">
          ${(et.itens || [])
            .map((it) => {
              const nome = it.nome || it;
              const preco = it.preco || 0;
              return `<label style="border:1.5px solid #e5e7eb;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:0.83rem;font-weight:600;transition:all .15s"
              onclick="var cb=this.querySelector('input');if(!cb.checked){var m=${et.max};var ch=this.closest('div').querySelectorAll('input:checked').length;if(ch>=m){alert('Máx. '+m+' itens');return;}cb.checked=true;this.style.borderColor='#e67e22';this.style.background='#fff8f0';}else{cb.checked=false;this.style.borderColor='#e5e7eb';this.style.background='';}">
              <input type="checkbox" value="${nome}" style="display:none">${nome}${preco ? ` (+Gs ${preco.toLocaleString("es-PY")})` : ""}
            </label>`;
            })
            .join("")}
        </div>`;
    });
    corpo().innerHTML =
      html ||
      '<p style="color:#aaa;font-size:0.85rem">Nenhuma etapa configurada.</p>';
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── Confirmar seleção do modal de opções PDV ─────────────────────
function _pdvModalConfirmar(cacheKey) {
  const modal = document.getElementById("pdv-opcoes-modal");
  if (!modal) return;
  const produto = window._pdvProdCache[cacheKey];
  if (!produto) return;
  const cfg = produto.montagem_config || {};
  const tipo = cfg.__tipo || "";
  const obs = modal.querySelector("#_pdv-obs-input")?.value?.trim() || "";

  let preco = produto.preco || 0;
  const montagem = [];
  let variacaoLabel = "";

  if (tipo === "variacoes") {
    const idx = parseInt(
      modal.querySelector('input[name="_pdv_var"]:checked')?.value ?? 0,
    );
    const v = (cfg.variacoes || [])[idx];
    if (v) {
      preco = v.preco || preco;
      variacaoLabel = v.nome;
    }
  } else if (tipo === "pizza") {
    const tamIdx = parseInt(
      modal.querySelector('input[name="_pdv_pizza_tam"]:checked')?.value ?? 0,
    );
    const tam = (cfg.tamanhos || [])[tamIdx];
    const borda =
      modal.querySelector('input[name="_pdv_pizza_borda"]:checked')?.value ||
      "";
    // Coleta sabores com seus tipos (igual ao app.js)
    const saboresSel = [
      ...modal.querySelectorAll(
        "#_pdv_sabores_lista input[type=checkbox]:checked",
      ),
    ].map((c) => ({
      nome: c.value,
      tipo: c.closest("label")?.dataset.tipoSabor || "",
    }));

    if (!saboresSel.length) {
      alert("Escolha pelo menos 1 sabor.");
      return;
    }

    // Preço = max entre os tipos dos sabores selecionados — REGRA DE OURO (igual app.js)
    const _pdvPrecoPorTipo = (tamObj, tipo) => {
      if (!tamObj) return 0;
      const precos = tamObj.precos || {};
      if (tipo && precos[tipo] > 0) return precos[tipo];
      if (tipo) {
        const k = Object.keys(precos).find(
          (k2) => k2.toLowerCase() === (tipo || "").toLowerCase(),
        );
        if (k && precos[k] > 0) return precos[k];
      }
      return tamObj.preco || 0;
    };
    const precostipos = saboresSel.map((s) => _pdvPrecoPorTipo(tam, s.tipo));
    preco =
      precostipos.length > 0 ? Math.max(...precostipos) : tam?.preco || preco;

    const bordaPreco = borda
      ? cfg.bordas?.find((b) => b.nome === borda)?.preco || 0
      : 0;
    preco += bordaPreco;

    variacaoLabel = tam?.nome || "";
    montagem.push("Sabores: " + saboresSel.map((s) => s.nome).join(" / "));
    if (borda) montagem.push("Borda: " + borda);
  } else if (tipo === "shake") {
    const sk = cfg.shake || {};
    const tamIdx = parseInt(
      modal.querySelector('input[name="_pdv_shake_tam"]:checked')?.value ?? 0,
    );
    const tam = (sk.tamanhos || [])[tamIdx];
    const saborSel =
      modal.querySelector('input[name="_pdv_shake_sabor"]:checked')?.value ||
      "";
    const saborObj = sk.sabores?.find((s) => s.nome === saborSel);
    preco = (tam?.preco || preco) + (saborObj?.preco || 0);
    variacaoLabel = tam?.nome || "";
    if (saborSel) montagem.push(saborSel);
  } else if (tipo === "acai") {
    const tamIdx = parseInt(
      modal.querySelector('input[name="_pdv_acai_tam"]:checked')?.value ?? 0,
    );
    const tam = (cfg.tamanhos || [])[tamIdx];
    preco = tam?.preco || preco;
    variacaoLabel = tam?.nome || "";
    modal.querySelectorAll('input[type="checkbox"]:checked').forEach((c) => {
      const nome = c.value;
      const acomp = cfg.acompanhamentos?.find((a) => a.nome === nome);
      if (acomp?.preco) preco += acomp.preco;
      montagem.push(nome);
    });
  } else if (tipo === "suco") {
    const tamIdx = parseInt(
      modal.querySelector('input[name="_pdv_suco_tam"]:checked')?.value ?? 0,
    );
    const tam = (cfg.tamanhos || [])[tamIdx];
    preco = tam?.preco || preco;
    variacaoLabel = tam?.nome || "";
    modal
      .querySelectorAll('input[type="checkbox"]:checked')
      .forEach((c) => montagem.push(c.value));
  } else if (tipo === "sorvete") {
    const tamIdx = parseInt(
      modal.querySelector('input[name="_pdv_sorv_tam"]:checked')?.value ?? 0,
    );
    const tam = (cfg.tamanhos || [])[tamIdx];
    const varSel =
      modal.querySelector('input[name="_pdv_sorv_var"]:checked')?.value || "";
    const varObj = cfg.variacoes?.find((v) => v.nome === varSel);
    preco = (tam?.preco || preco) + (varObj?.preco || 0);
    variacaoLabel = tam?.nome
      ? `${tam.nome}${varSel ? " — " + varSel : ""}`
      : varSel;
    modal.querySelectorAll('input[type="checkbox"]:checked').forEach((c) => {
      const nome = c.value;
      const sabor = cfg.sabores?.find((s) => s.nome === nome);
      if (sabor?.preco) preco += sabor.preco;
      montagem.push(nome);
    });
  } else if (tipo === "montavel") {
    modal.querySelectorAll('input[type="checkbox"]:checked').forEach((c) => {
      const nome = c.value;
      const item = cfg.etapas
        ?.flatMap((e) => e.itens || [])
        .find((it) => (it.nome || it) === nome);
      if (item?.preco) preco += item.preco;
      montagem.push(nome);
    });
  }

  carrinhoPDV.push({
    id: produto.id,
    nome: produto.nome,
    img: produto.imagem_url,
    categoria_slug: produto.categoria_slug || "",
    es_bebida: produto.es_bebida || false,
    preco,
    qtd: 1,
    variacao: variacaoLabel,
    montagem,
    obs,
  });
  atualizarCarrinhoPDV();
  modal.remove();

  if (_deveMostrarExtrasGlobais(produto)) {
    _getExtrasGlobais().then((extras) => {
      if (extras?.length > 0) _mostrarUpsellExtrasPDV(produto, extras);
    });
  }
}
let _toledoPort = null; // Web Serial: porta da balança Toledo

function _mostrarModalPesoPDV(produto, precoKg) {
  document.getElementById("pdv-kg-modal")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "pdv-kg-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff;border-radius:20px;padding:24px 20px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.35)";

  // Formata peso digitado: trata como gramas, exibe "300g" ou "1,230 kg"
  function formatarPeso(gramas) {
    if (!gramas || gramas <= 0) return "";
    if (gramas < 1000) return gramas + "g";
    const kg = (gramas / 1000).toFixed(3).replace(/\.?0+$/, "");
    return kg.replace(".", ",") + " kg";
  }

  function calcularPreco(gramas) {
    return Math.round((precoKg * gramas) / 1000);
  }

  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px">
      <div>
        <div style="font-size:1rem;font-weight:800;color:#0891b2">⚖️ ${produto.nome}</div>
        <div style="font-size:0.8rem;color:#888;margin-top:2px">Gs ${precoKg.toLocaleString("es-PY")} / kg</div>
      </div>
      <button id="_kg-close" style="background:none;border:none;font-size:1.4rem;cursor:pointer;color:#999;line-height:1">✕</button>
    </div>

    <!-- Display de peso -->
    <div style="background:#f0fdfe;border:2px solid #a5f3fc;border-radius:14px;padding:16px;text-align:center;margin-bottom:14px">
      <div style="font-size:2.6rem;font-weight:800;color:#0891b2;letter-spacing:-1px;line-height:1" id="_kg-display-peso">—</div>
      <div style="font-size:0.78rem;color:#0e7490;margin-top:4px">Peso</div>
    </div>

    <!-- Input gramas -->
    <div style="margin-bottom:12px">
      <label style="font-size:0.8rem;font-weight:700;color:#555;display:block;margin-bottom:6px">
        Digite o peso em gramas:
      </label>
      <div style="display:flex;align-items:center;gap:8px;width:100%">
        <input type="number" id="_kg-input-g" min="1" step="1" placeholder="Ex: 300"
          style="flex:1 1 auto;min-width:0;box-sizing:border-box;width:100%;font-size:1.5rem;font-weight:700;padding:10px 14px;border:2px solid #0891b2;border-radius:10px;text-align:center;color:#0891b2;outline:none;-moz-appearance:textfield"
          oninput="_kgAtualizarPreview()" onkeydown="if(event.key==='Enter')_kgConfirmar()">
        <span style="font-size:1rem;font-weight:700;color:#888;white-space:nowrap;flex-shrink:0">g</span>
      </div>
      <div style="font-size:0.73rem;color:#888;margin-top:4px;text-align:center">
        Acima de 1000g é convertido automaticamente para kg
      </div>
    </div>

    <!-- Preview preço -->
    <div id="_kg-preview-preco" style="background:#f0fdf4;border:2px solid #bbf7d0;border-radius:12px;padding:12px 16px;margin-bottom:16px;display:none">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:0.85rem;color:#166534">Total a cobrar:</span>
        <span id="_kg-preco-val" style="font-size:1.5rem;font-weight:800;color:#16a34a">Gs 0</span>
      </div>
      <div id="_kg-peso-formatado" style="font-size:0.75rem;color:#4ade80;text-align:right;margin-top:2px"></div>
    </div>

    <!-- Botão balança Toledo -->
    <button id="_kg-btn-balanca" onclick="_kgConectarBalanca()"
      style="width:100%;padding:10px;background:#fff;border:2px dashed #0891b2;border-radius:10px;color:#0891b2;font-weight:700;font-size:0.85rem;cursor:pointer;margin-bottom:10px;display:flex;align-items:center;justify-content:center;gap:8px">
      🔌 <span id="_kg-balanca-txt">Conectar Balança (Toledo Prix 3)</span>
    </button>

    <!-- Confirmar -->
    <button id="_kg-btn-ok" onclick="_kgConfirmar()"
      disabled
      style="width:100%;padding:14px;background:#0891b2;color:#fff;border:none;border-radius:12px;font-size:1rem;font-weight:800;cursor:pointer;opacity:0.5;transition:all 0.2s">
      ✅ Adicionar ao Pedido
    </button>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  modal.querySelector("#_kg-close").onclick = () => overlay.remove();

  // Se balança já conectada → inicia leitura automática
  if (_toledoPort) {
    const btnBal = document.getElementById("_kg-btn-balanca");
    const txtBal = document.getElementById("_kg-balanca-txt");
    if (btnBal) {
      btnBal.style.borderStyle = "solid";
      btnBal.style.background = "#e0f7fa";
    }
    if (txtBal)
      txtBal.textContent = "🟢 Balança conectada — aguardando peso...";
    setTimeout(() => _kgIniciarLeituraBalanca(), 100);
  }

  // Funções locais expostas globalmente (escopo do modal)
  window._kgAtualizarPreview = function () {
    const g = parseInt(document.getElementById("_kg-input-g")?.value) || 0;
    const displayPeso = document.getElementById("_kg-display-peso");
    const previewBox = document.getElementById("_kg-preview-preco");
    const precoVal = document.getElementById("_kg-preco-val");
    const pesoFmt = document.getElementById("_kg-peso-formatado");
    const btnOk = document.getElementById("_kg-btn-ok");

    if (g > 0) {
      const fmt = formatarPeso(g);
      const preco = calcularPreco(g);
      if (displayPeso) displayPeso.textContent = fmt;
      if (precoVal)
        precoVal.textContent = `Gs ${preco.toLocaleString("es-PY")}`;
      if (pesoFmt)
        pesoFmt.textContent = `${g}g = ${fmt} × Gs ${precoKg.toLocaleString("es-PY")}/kg`;
      if (previewBox) previewBox.style.display = "block";
      if (btnOk) {
        btnOk.disabled = false;
        btnOk.style.opacity = "1";
      }
    } else {
      if (displayPeso) displayPeso.textContent = "—";
      if (previewBox) previewBox.style.display = "none";
      if (btnOk) {
        btnOk.disabled = true;
        btnOk.style.opacity = "0.5";
      }
    }
  };

  window._kgConfirmar = function () {
    const g = parseInt(document.getElementById("_kg-input-g")?.value) || 0;
    if (!g || g <= 0) {
      document.getElementById("_kg-input-g")?.focus();
      return;
    }
    const preco = calcularPreco(g);
    carrinhoPDV.push({
      id: produto.id + "_kg_" + Date.now(),
      produto_id: produto.id,
      nome: produto.nome,
      preco: preco,
      preco_kg: precoKg,
      peso_gramas: g,
      qtd: 1,
      _isKg: true,
      img: produto.imagem_url || "",
      categoria_slug: produto.categoria_slug || "",
      es_bebida: produto.es_bebida || false,
      montagem: [],
      obs: "",
    });
    atualizarCarrinhoPDV();
    overlay.remove();
  };

  window._kgConectarBalanca = async function () {
    const btn = document.getElementById("_kg-btn-balanca");
    const txt = document.getElementById("_kg-balanca-txt");

    // Web Serial API check
    if (!navigator.serial) {
      alert(
        "⚠️ Web Serial API não suportada neste navegador.\nUse Google Chrome ou Edge para conectar a balança.",
      );
      return;
    }

    // Se porta já conectada, desconectar
    if (_toledoPort) {
      try {
        await _toledoPort.close();
      } catch (_) {}
      _toledoPort = null;
      if (txt) txt.textContent = "Conectar Balança (Toledo Prix 3)";
      if (btn) btn.style.background = "#fff";
      return;
    }

    try {
      if (txt) txt.textContent = "⏳ Aguardando seleção da porta...";
      const port = await navigator.serial.requestPort();
      await port.open({
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
      });
      _toledoPort = port;
      if (txt)
        txt.textContent = "🟢 Balança conectada — Pressione PRINT na balança";
      if (btn) {
        btn.style.background = "#ecfdf5";
        btn.style.borderColor = "#16a34a";
        btn.style.color = "#16a34a";
      }

      // Leitura contínua
      const reader = port.readable.getReader();
      let buffer = "";

      const lerDados = async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += new TextDecoder().decode(value);

            // Protocolo Toledo Prix 3 Fit: envia linha ao pressionar PRINT
            // Formatos possíveis:
            //   "  0.300 kg\r\n"  →  300g
            //   " 1.230 kg\r\n"   →  1230g
            //   "P  0.300\r\n"    →  variação com prefixo P
            //   "ST,GS,+  0.300kg\r\n"  → formato contínuo
            if (buffer.includes("\n") || buffer.includes("\r")) {
              const linhas = buffer.split(/[\r\n]+/);
              buffer = linhas.pop() || ""; // mantém fragmento incompleto

              for (const linha of linhas) {
                const limpa = linha.trim();
                if (!limpa) continue;

                // Extrai número de kg: procura padrão X.XXX ou X,XXX seguido de "kg" (opcional)
                const match =
                  limpa.match(/([\d]+[.,][\d]{1,3})\s*kg?/i) ||
                  limpa.match(/[STPG,\s]*([\d]+[.,][\d]{1,3})/);

                if (match) {
                  const kgStr = match[1].replace(",", ".");
                  const kgVal = parseFloat(kgStr);
                  if (!isNaN(kgVal) && kgVal > 0) {
                    const gramas = Math.round(kgVal * 1000);
                    // Preenche input e atualiza preview
                    const inp = document.getElementById("_kg-input-g");
                    if (inp) {
                      inp.value = gramas;
                      window._kgAtualizarPreview();
                      // Flash visual de confirmação
                      inp.style.borderColor = "#16a34a";
                      inp.style.background = "#f0fdf4";
                      setTimeout(() => {
                        if (inp) {
                          inp.style.borderColor = "#0891b2";
                          inp.style.background = "";
                        }
                      }, 1200);
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          if (_toledoPort) {
            if (txt) txt.textContent = "🔴 Balança desconectada";
            if (btn) {
              btn.style.background = "#fff";
              btn.style.borderColor = "#0891b2";
              btn.style.color = "#0891b2";
            }
            _toledoPort = null;
          }
        } finally {
          try {
            reader.releaseLock();
          } catch (_) {}
        }
      };

      lerDados();
    } catch (e) {
      if (txt) txt.textContent = "Conectar Balança (Toledo Prix 3)";
      if (e.name !== "NotFoundError") {
        console.error("Erro balança:", e);
      }
    }
  };

  // Foca no input após render
  setTimeout(() => document.getElementById("_kg-input-g")?.focus(), 100);
}

window._pdvProdCache = {};

function _mostrarModalVariacaoPDV(produto, variacoes) {
  document.getElementById("pdv-var-modal")?.remove();

  // Guarda produto no cache por ID
  const cacheKey = "pdv_" + (produto.id || Date.now());
  window._pdvProdCache[cacheKey] = produto;

  const overlay = document.createElement("div");
  overlay.id = "pdv-var-modal";
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  const modal = document.createElement("div");
  modal.style.cssText =
    "background:#fff;border-radius:16px;padding:20px;max-width:420px;width:100%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.3)";

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;margin-bottom:16px";
  header.innerHTML = `
    <h4 style="margin:0;font-size:1rem;color:#333">🎨 Escolha a variação</h4>
    <button id="_pdv-var-close" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:#999">✕</button>`;
  modal.appendChild(header);
  modal.querySelector("#_pdv-var-close").onclick = () => overlay.remove();

  const nomeProd = document.createElement("p");
  nomeProd.style.cssText = "font-size:0.88rem;color:#666;margin-bottom:14px";
  nomeProd.textContent = produto.nome;
  modal.appendChild(nomeProd);

  const lista = document.createElement("div");
  lista.style.cssText = "display:flex;flex-direction:column;gap:10px";

  variacoes.forEach((v) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.style.cssText =
      "display:flex;align-items:center;gap:12px;background:#f9f9f9;border:2px solid #e5e7eb;border-radius:10px;padding:10px 14px;cursor:pointer;text-align:left;transition:border-color 0.15s;width:100%";
    btn.onmouseover = () => {
      btn.style.borderColor = "var(--primary)";
    };
    btn.onmouseout = () => {
      btn.style.borderColor = "#e5e7eb";
    };

    const imgSrc = v.img || produto.imagem_url;
    btn.innerHTML = `
      ${imgSrc ? `<img src="${imgSrc}" style="width:48px;height:48px;border-radius:8px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">` : ""}
      <div style="flex:1">
        <div style="font-weight:700;font-size:0.9rem;color:#333">${v.nome}</div>
        <div style="font-size:0.82rem;color:var(--primary);font-weight:600">Gs ${(v.preco || produto.preco || 0).toLocaleString("es-PY")}</div>
      </div>`;

    btn.onclick = () => {
      const p = window._pdvProdCache[cacheKey];
      if (!p) return;
      const existe = carrinhoPDV.find(
        (i) => i.id === p.id && i.variacao === v.nome,
      );
      if (existe) {
        existe.qtd++;
      } else {
        carrinhoPDV.push({
          id: p.id,
          nome: p.nome,
          img: p.imagem_url,
          categoria_slug: p.categoria_slug || "",
          es_bebida: p.es_bebida || false,
          preco: v.preco || p.preco || 0,
          qtd: 1,
          variacao: v.nome,
          montagem: [],
          obs: "",
        });
      }
      atualizarCarrinhoPDV();
      overlay.remove();
    };
    lista.appendChild(btn);
  });

  modal.appendChild(lista);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── Toast de upsell de extras globais ─────────────────────────────
function _mostrarUpsellExtrasPDV(produto, extras) {
  // Remove toast anterior se ainda estiver aberto
  document.getElementById("pdv-upsell-toast")?.remove();

  const toast = document.createElement("div");
  toast.id = "pdv-upsell-toast";
  toast.style.cssText = [
    "position:fixed;bottom:20px;right:16px;z-index:99998",
    "background:#fff;border-radius:14px",
    "box-shadow:0 8px 32px rgba(0,0,0,0.18)",
    "padding:0;max-width:300px;width:calc(100vw - 32px)",
    "border:1px solid #f0f0f0",
    "animation:_upsellIn 0.25s cubic-bezier(.4,0,.2,1)",
    "overflow:hidden",
  ].join(";");

  if (!document.getElementById("_upsell-style")) {
    const s = document.createElement("style");
    s.id = "_upsell-style";
    s.textContent = `
      @keyframes _upsellIn{from{transform:translateY(20px) scale(.96);opacity:0}to{transform:none;opacity:1}}
      #pdv-upsell-toast .ue-btn:hover{filter:brightness(0.92)}
    `;
    document.head.appendChild(s);
  }

  // Header
  const hdr = document.createElement("div");
  hdr.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;padding:12px 14px 10px;border-bottom:1px solid #f5f5f5;background:var(--color-background-secondary)";

  // Pega o último item do carrinho que corresponde a este produto (para mostrar a variação)
  const ultimoItem = [...carrinhoPDV]
    .reverse()
    .find((i) => i.id === produto.id);
  const subtitleTxt = ultimoItem?.variacao
    ? `${produto.nome} — ${ultimoItem.variacao}`
    : produto.nome;

  hdr.innerHTML = `
    <div>
      <div style="font-weight:700;font-size:0.85rem;color:var(--color-text-primary)">➕ Adicionar ao pedido?</div>
      <div style="font-size:0.73rem;color:var(--color-text-secondary);margin-top:1px">${subtitleTxt}</div>
    </div>`;
  const btnX = document.createElement("button");
  btnX.textContent = "✕";
  btnX.style.cssText =
    "background:none;border:none;font-size:1rem;cursor:pointer;color:#bbb;padding:4px 6px;border-radius:6px;flex-shrink:0";
  btnX.addEventListener("click", () => toast.remove());
  hdr.appendChild(btnX);
  toast.appendChild(hdr);

  // Lista de extras
  const lista = document.createElement("div");
  lista.style.cssText = "padding:6px 0";
  extras.forEach((extra) => {
    if (!extra.nome) return;
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;justify-content:space-between;align-items:center;padding:7px 14px;transition:background .1s";
    row.onmouseenter = () => (row.style.background = "#fafafa");
    row.onmouseleave = () => (row.style.background = "");

    const info = document.createElement("div");
    info.innerHTML = `
      <div style="font-size:0.83rem;font-weight:600;color:#333">${extra.nome}</div>
      <div style="font-size:0.73rem;color:var(--primary,#FF441F);font-weight:700">+ Gs ${(extra.preco || 0).toLocaleString("es-PY")}</div>`;

    const btn = document.createElement("button");
    btn.className = "ue-btn";
    btn.style.cssText =
      "background:var(--primary,#FF441F);color:#fff;border:none;border-radius:8px;padding:5px 13px;font-size:0.78rem;cursor:pointer;font-weight:700;transition:all .15s;white-space:nowrap;flex-shrink:0";
    btn.textContent = "+ Add";
    btn.addEventListener("click", () => {
      const nomeExtra = extra.nome;
      const existe = carrinhoPDV.find(
        (i) => i._isExtra && i.nome === nomeExtra,
      );
      if (existe) {
        existe.qtd++;
      } else {
        carrinhoPDV.push({
          id: "ext_" + Date.now(),
          produto_id: null,
          nome: nomeExtra,
          preco: extra.preco || 0,
          qtd: 1,
          _isExtra: true,
        });
      }
      atualizarCarrinhoPDV();
      btn.textContent = "✓";
      btn.style.background = "#27ae60";
      btn.disabled = true;
      row.style.opacity = "0.6";
    });

    row.appendChild(info);
    row.appendChild(btn);
    lista.appendChild(row);
  });
  toast.appendChild(lista);

  document.body.appendChild(toast);
  // Auto-fecha em 10 s
  setTimeout(() => {
    if (document.getElementById("pdv-upsell-toast") === toast) toast.remove();
  }, 10000);
}

function removerItemPDV(idx) {
  carrinhoPDV.splice(idx, 1);
  atualizarCarrinhoPDV();
}

function limparCarrinhoPDV() {
  if (carrinhoPDV.length === 0 && !window._mesaAbertaId) return;
  if (!confirm("Cancelar a venda e limpar o carrinho?")) return;

  carrinhoPDV = [];
  window._mesaAbertaId = null;
  window._mesaAbertaPedido = null;

  const ids = {
    "balcao-cliente": "",
    "balcao-mesa": "",
    "balcao-telefone": "",
    "balcao-endereco": "",
    "balcao-geo-lat": "",
    "balcao-geo-lng": "",
    "balcao-frete": "",
    "pdv-desconto-val": "",
    "pdv-recebido": "",
  };
  Object.entries(ids).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });

  const selPag = document.getElementById("balcao-pag");
  if (selPag) {
    selPag.value = "Efetivo";
    selPag.style.display = "";
  }
  const selTipo = document.getElementById("balcao-tipo-entrega");
  if (selTipo) selTipo.value = "balcao";
  const descTipo = document.getElementById("pdv-desconto-tipo");
  if (descTipo) descTipo.value = "fixo";

  const trocoEl = document.getElementById("pdv-troco-val");
  if (trocoEl) trocoEl.textContent = "0";
  const freteMsgEl = document.getElementById("frete-msg-pdv");
  if (freteMsgEl) freteMsgEl.innerHTML = "";

  [
    "pdv-delivery-row",
    "box-multi-pdv",
    "pdv-cashback-box",
    "pdv-row-troco",
    "pdv-row-recebido",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });

  const toggleEl = document.getElementById("pdv-toggle-delivery");
  if (toggleEl) toggleEl.classList.remove("active");
  const chipEl = document.getElementById("pdv-tipo-chip");
  if (chipEl) chipEl.textContent = "🏪 Balcão";

  const multiPartes = document.getElementById("multi-partes-pdv");
  if (multiPartes) multiPartes.innerHTML = "";
  if (typeof _multiContadorPDV !== "undefined") _multiContadorPDV = 0;

  _pdvCashbackDisponivel = 0;
  _pdvCashbackUsando = false;

  atualizarCarrinhoPDV();
  _pdvToast("🗑️ Carrinho limpo.");
}

/**
 * Verifica se há uma sessão de caixa aberta no momento.
 * Faz consulta ao banco (não confia apenas no cache em memória)
 * para evitar vendas com caixa fechado em outra aba/dispositivo.
 *
 * @returns {Promise<{ aberto: boolean, sessao?: object }>}
 */
async function _pdvCaixaEstaAberto() {
  try {
    const { data } = await supa
      .from("sessoes_caixa")
      .select("id, usuario_email, aberto_em, valor_abertura")
      .is("fechado_em", null)
      .order("aberto_em", { ascending: false })
      .limit(1);

    if (data && data.length > 0) {
      // Sincroniza o cache em memória com o banco
      _sessaoCaixaAtiva = data[0];
      return { aberto: true, sessao: data[0] };
    }
    _sessaoCaixaAtiva = null;
    return { aberto: false };
  } catch (e) {
    console.warn("[_pdvCaixaEstaAberto] Falha ao consultar sessão:", e.message);
    // Em caso de erro de rede, confia no cache (evita bloquear venda legítima)
    return { aberto: !!_sessaoCaixaAtiva, sessao: _sessaoCaixaAtiva };
  }
}

/**
 * Exibe modal de aviso quando o caixa está fechado.
 * Reutiliza o padrão visual dos modais existentes.
 */
function _pdvMostrarBloqueioCaixaFechado() {
  // Se já existe modal aberto, não duplica
  if (document.getElementById("_modal-caixa-fechado")) return;

  const overlay = document.createElement("div");
  overlay.id = "_modal-caixa-fechado";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "background:rgba(0,0,0,0.6)",
    "z-index:99999",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:16px",
  ].join(";");

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:18px;padding:28px 24px;max-width:400px;width:100%;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,0.3)">
      <div style="font-size:3rem;margin-bottom:12px">🔒</div>
      <h3 style="margin:0 0 8px;font-size:1.15rem;color:#1a1a1a">Caixa fechado</h3>
      <p style="margin:0 0 20px;font-size:0.92rem;color:#555;line-height:1.55">
        É necessário <strong>abrir o caixa</strong> antes de registrar vendas no PDV.
        Isso garante que as movimentações sejam contabilizadas corretamente na sessão.
      </p>
      <div style="display:flex;gap:10px;flex-direction:column">
        <button id="_btn-abrir-caixa-modal"
          style="padding:14px;background:linear-gradient(135deg,#1a7a2e,#145a22);color:#fff;border:none;border-radius:10px;font-size:0.95rem;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">
          <i class="fas fa-door-open"></i> Abrir Caixa Agora
        </button>
        <button id="_btn-fechar-modal-caixa"
          style="padding:11px;background:transparent;color:#888;border:none;font-size:0.85rem;cursor:pointer">
          Continuar sem vender
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay
    .querySelector("#_btn-abrir-caixa-modal")
    .addEventListener("click", () => {
      overlay.remove();
      abrirModalCaixa("abertura");
    });
  overlay
    .querySelector("#_btn-fechar-modal-caixa")
    .addEventListener("click", () => {
      overlay.remove();
    });
}

function pdvAlterarQtd(idx, delta) {
  const item = carrinhoPDV[idx];
  if (!item) return;
  item.qtd = Math.max(1, (item.qtd || 1) + delta);
  atualizarCarrinhoPDV();
}

function pdvEditarItem(idx) {
  const item = carrinhoPDV[idx];
  if (!item) return;
  // Reabre o modal de opções para o produto, preservando o índice para substituição
  window._pdvEditandoIdx = idx;
  adicionarItemPDV({ ...item, _editando: true });
}

function atualizarCarrinhoPDV() {
  const lista = document.getElementById("pdv-lista");
  const totalEl = document.getElementById("balcao-total");
  if (!lista) return;

  // ── Aplica faixas de preço ANTES de renderizar ──
  vfRecalcularCarrinho(carrinhoPDV, (pid) =>
    produtosCachePDV.find((p) => p.id == pid)
  );

  lista.innerHTML = "";
  let total = 0;

  // ── Itens existentes da mesa (snapshot do DB) ──────────────────
  const itensExistentes = window._mesaAbertaPedido
    ? Array.isArray(window._mesaAbertaPedido.itens)
      ? window._mesaAbertaPedido.itens
      : []
    : [];

  if (itensExistentes.length > 0) {
    const secTitle = document.createElement("tr");
    secTitle.innerHTML =
      '<td colspan="4" class="pdv-sec-title">Itens já lançados</td>';
    lista.appendChild(secTitle);

    itensExistentes.forEach((item, idx) => {
      const entregue = item.status_item === "entregue";
      const qtd = item.qtd || item.q || 1;
      const nome = item.nome || item.n || "Item";
      const preco = item.preco || item.p || 0;
      total += preco * qtd;

      const row = document.createElement("tr");
      row.className = "pdv-item-existente" + (entregue ? " pdv-item-entregue" : "");
      row.innerHTML = `
        <td colspan="4" class="pdv-item-card">
          <div class="pdv-item-card-header">
            <span class="pdv-item-card-nome">${nome}${entregue ? ' <span class="badge-entregue">✓</span>' : ""}</span>
            <span class="pdv-item-card-total" style="${entregue ? "color:#888" : ""}">Gs ${(preco * qtd).toLocaleString("es-PY")}</span>
          </div>
          <div class="pdv-item-card-sub">Gs ${preco.toLocaleString("es-PY")} / un. · ${qtd}x${entregue ? " · <em style='color:#27ae60;font-weight:700'>✓ Entregue</em>" : ""}</div>
          ${!entregue ? `
          <div class="pdv-item-card-acoes">
            <button class="pdv-item-card-excluir" style="background:#e8f5e9;color:#27ae60;border-color:#86efac" title="Baixar item" onclick="baixarItemMesa(${window._mesaAbertaId},${idx})">
              <i class="fas fa-check"></i> Baixar
            </button>
          </div>` : ""}
        </td>`;
      lista.appendChild(row);
    });
  }

  // ── Novos itens sendo adicionados (carrinhoPDV) ────────────────
  if (carrinhoPDV.length > 0) {
    const secTitle2 = document.createElement("tr");
    secTitle2.innerHTML = `<td colspan="4" class="pdv-sec-title pdv-sec-novo">${itensExistentes.length > 0 ? "+ Novos itens" : "Itens do pedido"}</td>`;
    lista.appendChild(secTitle2);

    carrinhoPDV.forEach((item, idx) => {
      total += item.preco * item.qtd;
      const row = document.createElement("tr");

      if (item._isKg) {
        // Item por peso: layout compacto com remove
        const g = item.peso_gramas || 0;
        const pesofmt =
          g >= 1000
            ? (g / 1000)
                .toFixed(3)
                .replace(/\.?0+$/, "")
                .replace(".", ",") + "kg"
            : g + "g";
        row.innerHTML = `
          <td colspan="4" class="pdv-item-card">
            <div class="pdv-item-card-header">
              <span class="pdv-item-card-nome">⚖️ ${pesofmt} — ${item.nome}</span>
              <span class="pdv-item-card-total">Gs ${item.preco.toLocaleString("es-PY")}</span>
            </div>
            <div class="pdv-item-card-acoes">
              <button class="pdv-item-card-excluir" onclick="removerItemPDV(${idx})">
                <i class="fas fa-trash"></i> Excluir
              </button>
            </div>
          </td>`;
      } else {
        // Item normal: card com preço unitário, controles de qtd, Editar e Excluir
        const temMontagem = item.montagem?.length > 0 || item.obs;
        row.innerHTML = `
          <td colspan="4" class="pdv-item-card">
            <div class="pdv-item-card-header">
              <span class="pdv-item-card-nome">${item.nome}</span>
              <span class="pdv-item-card-total">Gs ${(item.preco * item.qtd).toLocaleString("es-PY")}</span>
            </div>
            <div class="pdv-item-card-sub">Gs ${item.preco.toLocaleString("es-PY")} / un.</div>
            ${item.obs ? `<div class="pdv-item-card-obs">📝 ${item.obs}</div>` : ""}
            <div class="pdv-item-card-acoes">
              <div class="pdv-item-card-qtd">
                <button class="pdv-qtd-btn" onclick="pdvAlterarQtd(${idx}, -1)">−</button>
                <span class="pdv-qtd-val">${item.qtd}</span>
                <button class="pdv-qtd-btn" onclick="pdvAlterarQtd(${idx}, +1)">+</button>
              </div>
              ${temMontagem ? `<button class="pdv-item-card-editar" onclick="pdvEditarItem(${idx})"><i class="fas fa-pencil-alt"></i> Editar</button>` : ""}
              <button class="pdv-item-card-excluir" onclick="removerItemPDV(${idx})">
                <i class="fas fa-trash"></i> Excluir
              </button>
            </div>
          </td>`;
      }
      lista.appendChild(row);
    });
  }

  if (itensExistentes.length === 0 && carrinhoPDV.length === 0) {
    lista.innerHTML =
      '<tr><td colspan="4" class="pdv-lista-vazio">Nenhum item adicionado.</td></tr>';
  }

  if (totalEl) totalEl.innerText = total.toLocaleString("es-PY");

  // ── Desconto ──────────────────────────────────────────────────
  const descTipo =
    document.getElementById("pdv-desconto-tipo")?.value || "fixo";
  const descValRaw =
    parseFloat(document.getElementById("pdv-desconto-val")?.value || "0") || 0;
  let desconto = 0;
  if (descValRaw > 0) {
    desconto =
      descTipo === "percentual"
        ? Math.round((total * descValRaw) / 100)
        : Math.round(descValRaw);
    desconto = Math.min(desconto, total);
  }
  const totalComDesc = total - desconto;

  // Atualiza subtotal
  const subEl = document.getElementById("balcao-subtotal");
  if (subEl) subEl.innerText = total.toLocaleString("es-PY");

  // Linha de desconto
  const rowDesc = document.getElementById("pdv-row-desconto");
  const descEl = document.getElementById("balcao-desconto");
  if (rowDesc) rowDesc.style.display = desconto > 0 ? "flex" : "none";
  if (descEl) descEl.innerText = desconto.toLocaleString("es-PY");

  // Total final
  if (totalEl) totalEl.innerText = totalComDesc.toLocaleString("es-PY");

  // Frete (delivery)
  const frete =
    parseInt(document.getElementById("balcao-frete")?.value || "0") || 0;
  const tipoEntrega =
    document.getElementById("balcao-tipo-entrega")?.value || "balcao";
  let totalFinal = totalComDesc + (tipoEntrega === "delivery" ? frete : 0);

  // Cashback (calculado APÓS soma total dos itens)
  const cashDesc = pdvGetCashbackDesconto(totalFinal);
  if (cashDesc > 0) totalFinal = Math.max(0, totalFinal - cashDesc);
  const elCash = document.getElementById("pdv-row-cashback");
  if (elCash) {
    elCash.style.display = cashDesc > 0 ? "flex" : "none";
    const elCashVal = document.getElementById("balcao-cashback");
    if (elCashVal) elCashVal.textContent = cashDesc.toLocaleString("es-PY");
  }

  if (totalEl) totalEl.innerText = totalFinal.toLocaleString("es-PY");

  // Atualiza barra inferior mobile
  const mobileQtd = document.getElementById("pdv-mobile-qtd");
  const mobileTot = document.getElementById("pdv-mobile-total-val");
  const qtdTotal = carrinhoPDV.reduce((a, i) => a + i.qtd, 0);
  if (mobileQtd)
    mobileQtd.textContent = qtdTotal + (qtdTotal === 1 ? " item" : " itens");
  if (mobileTot) mobileTot.textContent = totalFinal.toLocaleString("es-PY");

  // Troco / Vuelta — recalcula ao mudar carrinho
  _pdvAtualizarTroco(totalFinal);

  atualizarInfoPagPDV(totalFinal);
}

function _pdvAtualizarTroco(totalFinal) {
  const pag = document.getElementById("balcao-pag")?.value;
  const recebidoEl = document.getElementById("pdv-recebido");
  const trocoEl = document.getElementById("pdv-troco-val");
  const trocoRow = document.getElementById("pdv-row-troco");
  const recebRow = document.getElementById("pdv-row-recebido");
  if (!recebidoEl || !trocoEl) return;

  const isEfetivo = pag === "Efetivo";
  if (recebRow) recebRow.style.display = isEfetivo ? "flex" : "none";
  if (trocoRow) trocoRow.style.display = isEfetivo ? "flex" : "none";

  if (!isEfetivo) return;
  const recebido = parseInt((recebidoEl.value || "0").replace(/\D/g, "")) || 0;
  const troco = recebido > totalFinal ? recebido - totalFinal : 0;
  trocoEl.textContent = troco.toLocaleString("es-PY");
  trocoEl.style.color = troco > 0 ? "#16a34a" : "#888";
}

function atualizarInfoPagPDV(total) {
  const pag = document.getElementById("balcao-pag")?.value;
  const infoBox = document.getElementById("balcao-pag-info");
  const boxMultiPDV = document.getElementById("box-multi-pdv");
  const selectPag = document.getElementById("balcao-pag");
  if (!infoBox) return;

  // Mostra/oculta campo Recebido + Troco conforme forma de pagamento
  _pdvAtualizarTroco(total);

  infoBox.style.display = "none";
  if (boxMultiPDV) boxMultiPDV.style.display = "none";
  if (selectPag) selectPag.style.display = "";

  if (pag === "CartaoBR" && total > 0) {
    infoBox.style.display = "block";
    const _renderCarBR = () => {
      const taxa =
        _cartaoBRTipoPDV === "debito" ? _taxaDebitoPDV : _taxaCreditoPDV;
      const brl =
        _cotacaoPDV > 0
          ? ((total / _cotacaoPDV) * (1 + taxa / 100)).toFixed(2)
          : "---";
      infoBox.innerHTML = `
        <div style="font-size:0.78rem;font-weight:700;margin-bottom:6px">💳🇧🇷 Cartão Brasileiro</div>
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <button type="button" onclick="_setPDVBRTipo('debito')"
            style="flex:1;padding:6px 4px;border-radius:6px;font-weight:700;cursor:pointer;font-size:0.75rem;
                   border:2px solid ${_cartaoBRTipoPDV === "debito" ? "#1a7a2e" : "#ccc"};
                   background:${_cartaoBRTipoPDV === "debito" ? "#eafaf1" : "#f8f9fa"};
                   color:${_cartaoBRTipoPDV === "debito" ? "#1a7a2e" : "#555"}">
            Débito<br><small>${_taxaDebitoPDV.toFixed(2)}%</small></button>
          <button type="button" onclick="_setPDVBRTipo('credito')"
            style="flex:1;padding:6px 4px;border-radius:6px;font-weight:700;cursor:pointer;font-size:0.75rem;
                   border:2px solid ${_cartaoBRTipoPDV === "credito" ? "#1a7a2e" : "#ccc"};
                   background:${_cartaoBRTipoPDV === "credito" ? "#eafaf1" : "#f8f9fa"};
                   color:${_cartaoBRTipoPDV === "credito" ? "#1a7a2e" : "#555"}">
            Crédito<br><small>${_taxaCreditoPDV.toFixed(2)}%</small></button>
        </div>
        <div style="text-align:center;font-size:1rem;font-weight:900;color:#1a7a2e">R$ ${brl}</div>`;
    };
    window._setPDVBRTipo = (tipo) => {
      _cartaoBRTipoPDV = tipo;
      _renderCarBR();
    };
    window._renderCarBRPDV = _renderCarBR;
    _renderCarBR();
  } else if (pag === "Pix" && total > 0) {
    const valorReais = (total / _cotacaoPDV).toFixed(2);
    infoBox.style.display = "block";
    infoBox.innerHTML = `<i class="fas fa-qrcode"></i> <strong>Cobrar em Pix: R$ ${valorReais}</strong>`;
  } else if (pag === "Multipagamento") {
    if (selectPag) selectPag.style.display = "none";
    if (boxMultiPDV) {
      boxMultiPDV.style.display = "block";
      const partesEl = document.getElementById("multi-partes-pdv");
      if (partesEl && partesEl.children.length === 0) {
        adicionarPartePagamentoPDV();
        adicionarPartePagamentoPDV();
      }
      atualizarRestanteMultiPDV();
    }
  }
}

// ── MULTIPAGAMENTO PDV ─────────────────────────────────────────────
let _multiContadorPDV = 0;

function voltarPagamentoPDVUnico() {
  document.getElementById("balcao-pag").value = "Efetivo";
  document.getElementById("box-multi-pdv").style.display = "none";
  document.getElementById("multi-partes-pdv").innerHTML = "";
  document.getElementById("balcao-pag").style.display = "";
  _multiContadorPDV = 0;
  atualizarInfoPagPDV(
    parseInt(
      document.getElementById("balcao-total").innerText.replace(/\D/g, ""),
    ) || 0,
  );
}

function adicionarPartePagamentoPDV() {
  const container = document.getElementById("multi-partes-pdv");
  if (!container) return;
  _multiContadorPDV++;
  const id = _multiContadorPDV;
  const ordinal = ["1ª", "2ª", "3ª", "4ª", "5ª"][id - 1] || `${id}ª`;
  const opts = [
    { v: "Efetivo", l: "💵 Efectivo" },
    { v: "Cartao", l: "💳 Tarjeta" },
    { v: "CartaoBR", l: "💳🇧🇷 Cartão BR" },
    { v: "Pix", l: "🟢 Pix" },
    { v: "Transferencia", l: "🏦 Alias" },
    { v: "QrPy", l: "📱 QR Paraguay" },
  ]
    .map((m) => `<option value="${m.v}">${m.l}</option>`)
    .join("");

  const card = document.createElement("div");
  card.id = `multi-parte-pdv-${id}`;
  card.style.cssText =
    "background:white;border:1.5px solid #e0e0e0;border-radius:10px;padding:12px;margin-bottom:8px";
  card.innerHTML = `
    <div style="font-size:0.72rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px">${ordinal} FORMA</div>
    <div style="display:flex;gap:8px;align-items:center">
      <select id="multi-metodo-pdv-${id}" onchange="atualizarRestanteMultiPDV()"
          style="flex:1.5;padding:8px;border:1.5px solid #e0e0e0;border-radius:7px;font-size:0.85rem;background:white;font-weight:600">
        <option value="">Selecionar...</option>${opts}
      </select>
      <div style="flex:1;position:relative">
        <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);color:#888;font-size:0.8rem;pointer-events:none">Gs</span>
        <input type="number" id="multi-valor-pdv-${id}" placeholder="0" min="0" step="1000"
            data-touched="0"
            oninput="this.dataset.touched='1'; atualizarRestanteMultiPDV()"
            style="width:100%;padding:8px 8px 8px 28px;border:1.5px solid #e0e0e0;border-radius:7px;font-size:0.9rem;font-weight:700;box-sizing:border-box">
      </div>
      ${
        id > 2
          ? `<button type="button" onclick="removerPartePDV(${id})"
          style="background:#ffeaea;color:#e74c3c;border:none;padding:8px 10px;border-radius:7px;cursor:pointer;flex-shrink:0">✕</button>`
          : ""
      }
    </div>`;
  container.appendChild(card);
  atualizarRestanteMultiPDV();
}

function removerPartePDV(id) {
  document.getElementById(`multi-parte-pdv-${id}`)?.remove();
  atualizarRestanteMultiPDV();
}

function atualizarRestanteMultiPDV() {
  const total = parseInt(
    document.getElementById("balcao-total")?.innerText.replace(/\D/g, "") ||
      "0",
  );
  const inputs = [...document.querySelectorAll('[id^="multi-valor-pdv-"]')];
  let soma = 0;
  inputs.forEach((inp) => {
    soma += parseFloat(inp.value) || 0;
  });

  // Auto-fill: se exatamente 1 input vazio e sobra valor
  const vazios = inputs.filter(
    (inp) => !inp.value || parseFloat(inp.value) === 0,
  );
  if (vazios.length === 1 && total - soma > 0) {
    vazios[0].value = total - soma;
    soma = total;
  }

  const bar = document.getElementById("multi-status-pdv");
  const el = document.getElementById("multi-restante-pdv");
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
}

function _coletarMultiPagamentoPDV() {
  const partes = [];
  document.querySelectorAll('[id^="multi-parte-pdv-"]').forEach((div) => {
    const idStr = div.id.replace("multi-parte-pdv-", "");
    const metodo =
      document.getElementById(`multi-metodo-pdv-${idStr}`)?.value || "";
    const valor =
      parseFloat(document.getElementById(`multi-valor-pdv-${idStr}`)?.value) ||
      0;
    if (metodo && valor > 0) partes.push({ metodo, valor });
  });
  return partes;
}

// ═══════════════════════════════════════════════════════════════
//  SISTEMA DE IMPRESSÃO DO PDV
//  Modos persistidos em localStorage:
//    "ask"    → pergunta sempre (padrão)
//    "always" → imprime automaticamente sem perguntar
//    "never"  → nunca imprime automaticamente
// ═══════════════════════════════════════════════════════════════

const _PDV_PRINT_MODE_KEY = "pdv_print_mode";
const _PDV_PRINT_MODE_DEFAULT = "ask";

/**
 * Retorna o modo de impressão configurado.
 * @returns {"ask"|"always"|"never"}
 */
function _pdvGetPrintMode() {
  const m = localStorage.getItem(_PDV_PRINT_MODE_KEY);
  if (m === "always" || m === "never" || m === "ask") return m;
  return _PDV_PRINT_MODE_DEFAULT;
}

/**
 * Salva o modo de impressão e atualiza o chip visual no header.
 */
function _pdvSetPrintMode(mode) {
  if (mode !== "always" && mode !== "never" && mode !== "ask") return;
  localStorage.setItem(_PDV_PRINT_MODE_KEY, mode);
  _pdvRenderPrintModeChip();
}

/**
 * Reseta para o modo "pergunta sempre".
 */
function _pdvResetPrintMode() {
  localStorage.removeItem(_PDV_PRINT_MODE_KEY);
  _pdvRenderPrintModeChip();
}

/**
 * Monta o objeto de dados que o imprimir.html espera.
 * Recebe um contexto com os dados da venda do PDV.
 */
function _pdvGerarDadosImpressao(ctx) {
  return {
    id: ctx.pedidoId,
    cliente: { nome: ctx.clienteNome, tel: ctx.clienteTel },
    entrega: { tipo: "balcao", ref: ctx.entregaRef },
    itens: (ctx.itens || []).map((i) => ({
      q: i.qtd || 1,
      n: i.nome,
      p: i.preco,
      t: i.variacao || "",
      pr: i.preparo || "",
      m: i.montagem || [],
      o: i.obs || "",
      peso_gramas: i.peso_gramas,
      _isKg: i._isKg,
    })),
    valores: {
      sub: ctx.subtotalBruto,
      desconto: ctx.descontoAplicado,
      frete: ctx.fretePDV,
      total: ctx.totalNovo,
    },
    pagamento: { metodo: ctx.formaPagamento, obs: ctx.obsPagamento },
    data: new Date().toLocaleString("pt-BR"),
  };
}

/**
 * Abre a janela de impressão do comprovante.
 * Isolado numa função para poder ser chamado tanto pelo modal
 * quanto pelo modo "automático" (sempre imprime).
 */
function _pdvImprimirComprovante(dadosImpressao) {
  try {
    const base64 = btoa(
      unescape(encodeURIComponent(JSON.stringify(dadosImpressao))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    window.open(
      `imprimir.html?d=${base64}`,
      "PrintPDV",
      "width=400,height=600",
    );
  } catch (e) {
    console.error("[_pdvImprimirComprovante] Erro:", e);
    alert("Erro ao abrir a janela de impressão: " + e.message);
  }
}

/**
 * Ponto de entrada após cada venda no PDV.
 * Respeita o modo configurado (ask / always / never).
 */
function _pdvPerguntarImpressao(dadosImpressao) {
  const mode = _pdvGetPrintMode();
  if (mode === "always") {
    _pdvImprimirComprovante(dadosImpressao);
    return;
  }
  if (mode === "never") {
    return;
  }
  _pdvMostrarModalImpressao(dadosImpressao);
}

/**
 * Mostra o modal "Imprimir comprovante?".
 * Reutiliza o mesmo overlay — não duplica se já estiver aberto.
 */
function _pdvMostrarModalImpressao(dadosImpressao) {
  document.getElementById("_pdv-modal-print")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "_pdv-modal-print";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "background:rgba(0,0,0,0.6)",
    "z-index:99999",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:16px",
  ].join(";");

  const totalFmt = (dadosImpressao.valores?.total || 0).toLocaleString("es-PY");
  const clienteNome = dadosImpressao.cliente?.nome || "Cliente";
  const qtdItens = (dadosImpressao.itens || []).length;

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:18px;padding:26px 24px;max-width:400px;width:100%;box-shadow:0 24px 60px rgba(0,0,0,0.35);text-align:center">
      <div style="font-size:2.5rem;margin-bottom:8px">🖨️</div>
      <h3 style="margin:0 0 4px;font-size:1.15rem;color:#1a1a1a">Imprimir comprovante?</h3>
      <div style="font-size:0.82rem;color:#888;margin-bottom:16px">
        Pedido <strong>#${dadosImpressao.id}</strong> — ${clienteNome}
      </div>

      <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin-bottom:18px;text-align:left">
        <div style="display:flex;justify-content:space-between;font-size:0.85rem;color:#555;margin-bottom:4px">
          <span>Itens:</span>
          <strong>${qtdItens}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:1.05rem;color:#1a1a1a;font-weight:800;border-top:1px dashed #cbd5e1;padding-top:6px;margin-top:6px">
          <span>Total:</span>
          <span>Gs ${totalFmt}</span>
        </div>
      </div>

      <label style="display:flex;align-items:center;gap:8px;margin-bottom:16px;cursor:pointer;justify-content:center;font-size:0.82rem;color:#64748b">
        <input type="checkbox" id="_pdv-print-lembrar" style="width:16px;height:16px;accent-color:#1a7a2e">
        Lembrar minha escolha
      </label>

      <div style="display:flex;gap:10px;flex-direction:column">
        <button id="_pdv-print-sim"
          style="padding:14px;background:linear-gradient(135deg,#1a7a2e,#145a22);color:#fff;border:none;border-radius:10px;font-size:0.95rem;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">
          <i class="fas fa-print"></i> Imprimir comprovante
        </button>
        <button id="_pdv-print-nao"
          style="padding:12px;background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:10px;font-size:0.9rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">
          <i class="fas fa-times"></i> Não imprimir
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const fechar = () => overlay.remove();

  overlay.querySelector("#_pdv-print-sim").addEventListener("click", () => {
    const lembrar = overlay.querySelector("#_pdv-print-lembrar").checked;
    if (lembrar) _pdvSetPrintMode("always");
    fechar();
    _pdvImprimirComprovante(dadosImpressao);
  });

  overlay.querySelector("#_pdv-print-nao").addEventListener("click", () => {
    const lembrar = overlay.querySelector("#_pdv-print-lembrar").checked;
    if (lembrar) _pdvSetPrintMode("never");
    fechar();
  });

  const _keyHandler = (e) => {
    if (e.key === "Escape") {
      document.removeEventListener("keydown", _keyHandler);
      fechar();
    }
  };
  document.addEventListener("keydown", _keyHandler);
}

/**
 * Chip de status no header do PDV.
 * Só aparece quando o modo NÃO é "ask" (ou seja, quando o
 * operador já escolheu lembrar). Clicar reseta para perguntar.
 */
function _pdvRenderPrintModeChip() {
  const headerBar = document.querySelector(".pdv-header-bar");
  if (!headerBar) return;

  let chip = document.getElementById("_pdv-print-mode-chip");
  const mode = _pdvGetPrintMode();

  if (mode === "ask") {
    if (chip) chip.remove();
    return;
  }

  if (!chip) {
    chip = document.createElement("button");
    chip.id = "_pdv-print-mode-chip";
    chip.type = "button";
    chip.style.cssText = [
      "background:#f1f5f9",
      "border:1px solid #cbd5e1",
      "color:#475569",
      "padding:6px 12px",
      "border-radius:8px",
      "font-size:0.78rem",
      "font-weight:700",
      "cursor:pointer",
      "display:flex",
      "align-items:center",
      "gap:6px",
      "transition:background 0.15s",
    ].join(";");
    chip.title = "Clique para voltar a perguntar sempre";
    chip.addEventListener("mouseenter", () => {
      chip.style.background = "#e2e8f0";
    });
    chip.addEventListener("mouseleave", () => {
      chip.style.background = "#f1f5f9";
    });
    chip.addEventListener("click", () => {
      if (
        confirm(
          "Voltar a perguntar sempre?\n\nO PDV vai mostrar o modal de impressão a cada venda.",
        )
      ) {
        _pdvResetPrintMode();
      }
    });
    headerBar.appendChild(chip);
  }

  if (mode === "always") {
    chip.innerHTML = `<i class="fas fa-print"></i> Impressão: automática`;
  } else {
    chip.innerHTML = `<i class="fas fa-eye-slash"></i> Impressão: desligada`;
  }
}

// Auto-init do chip ao carregar
document.addEventListener("DOMContentLoaded", () => {
  _pdvRenderPrintModeChip();
});

// ── trava anti-duplo-clique do PDV ─────────────────────────────────────
let _pdvEnviando = false;

async function salvarPedidoBalcao() {
  if (_pdvEnviando) return; // bloqueia duplo-clique
  _pdvEnviando = true;

  // Feedback visual imediato no botão
  const _btnLancar = document.querySelector(".pdv-btn-lancar");
  const _txtOrigBtn = _btnLancar ? _btnLancar.innerHTML : "";
  if (_btnLancar) {
    _btnLancar.disabled = true;
    _btnLancar.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processando...';
    _btnLancar.style.opacity = "0.65";
  }
  const _liberarPDV = () => {
    _pdvEnviando = false;
    if (_btnLancar) {
      _btnLancar.disabled = false;
      _btnLancar.innerHTML = _txtOrigBtn;
      _btnLancar.style.opacity = "1";
    }
  };
  // Segurança: libera em 30s mesmo se algo travar
  const _timerPDV = setTimeout(_liberarPDV, 30000);

  // Envolve o corpo da função em try/finally para garantir liberação
  try {

    if (carrinhoPDV.length === 0 && !window._mesaAbertaId) {
    alert(t("alert.carrinho_vazio"));
    return;
  }
  if (carrinhoPDV.length === 0 && window._mesaAbertaId) {
    alert("Adicione ao menos 1 novo item antes de lançar.");
    return;
  }

  // ── TRAVA: verifica caixa aberto no banco antes de vender ──────
  const _caixaStatus = await _pdvCaixaEstaAberto();
  if (!_caixaStatus.aberto) {
    _pdvMostrarBloqueioCaixaFechado();
    return; // não libera o envio
  }

  const _soKg = carrinhoPDV.length > 0 && carrinhoPDV.every((i) => i._isKg);

  // const mesaInput = document.getElementById("balcao-mesa");
  //   if (mesaInput) mesaInput.value = "";

  const mesaEl = document.getElementById("balcao-mesa");
  const clienteEl = document.getElementById("balcao-cliente");
  const telefoneEl = document.getElementById("balcao-telefone");
  const pagEl = document.getElementById("balcao-pag");

  const cli = clienteEl?.value?.trim() || "Cliente";
  const tel = telefoneEl?.value?.trim() || "";
  const pag = pagEl?.value || "Efetivo";
  const mesa = "";
  const pagFinalPDV =
    pag === "CartaoBR"
      ? _cartaoBRTipoPDV === "debito"
        ? "Cartão BR - Débito"
        : "Cartão BR - Crédito"
      : pag;

  const nomeFinal = mesa
    ? `MESA ${mesa} - ${cliente}`
    : _soKg
      ? `BALCÃO KG - ${cli}`
      : `BALCÃO - ${cli}`;

  // ── Desconto manual ──────────────────────────────────────────
  const descTipo =
    document.getElementById("pdv-desconto-tipo")?.value || "fixo";
  const descValRaw =
    parseFloat(document.getElementById("pdv-desconto-val")?.value || "0") || 0;
  const subtotalBruto = carrinhoPDV.reduce(
    (a, i) => a + (i.preco || 0) * (i.qtd || 1),
    0,
  );
  let descontoAplicado = 0;
  if (descValRaw > 0) {
    descontoAplicado =
      descTipo === "percentual"
        ? Math.round((subtotalBruto * descValRaw) / 100)
        : Math.round(descValRaw);
    descontoAplicado = Math.min(descontoAplicado, subtotalBruto); // não pode ser maior que o total
  }

  // ── Tratamento Multipagamento ────────────────────────────────
  let obsPagPDV = "Pagamento no Balcão";
  if (pag === "Multipagamento") {
    const partesPDV = _coletarMultiPagamentoPDV();
    if (partesPDV.length === 0) {
      alert("Adicione ao menos 1 forma de pagamento!");
      return;
    }
    const totalPedido = parseInt(
      document.getElementById("balcao-total")?.innerText.replace(/\D/g, "") ||
        "0",
    );
    const somaPartes = partesPDV.reduce((a, p) => a + p.valor, 0);
    if (Math.abs(somaPartes - totalPedido) > 1) {
      alert(
        `⚠️ Total das formas (Gs ${somaPartes.toLocaleString("es-PY")}) não bate com o total do pedido (Gs ${totalPedido.toLocaleString("es-PY")}).`,
      );
      return;
    }
    obsPagPDV = JSON.stringify(partesPDV);
  }

  // ── Novos itens ganham status_item: 'pendente' ─────────────────
  const novosItens = carrinhoPDV.map((i) => ({
    produto_id: i._isExtra ? null : (i.produto_id ?? i.id ?? null),
    id: i.id || Date.now() + Math.random(),
    nome: i.nome,
    preco: i.preco,
    qtd: i.qtd,
    montagem: i.montagem || [],
    obs: i.obs || "",
    categoria_slug: i.categoria_slug || "",
    es_bebida: i.es_bebida || false,
    ...(i._isKg
      ? { peso_gramas: i.peso_gramas, preco_kg: i.preco_kg, _isKg: true }
      : {}),
    _tier: i._faixaTier ?? null,
    _faixaAplicada: i._faixaAplicada ?? null,
    _extrasSoma: i._extrasSoma ?? 0,
    status_item: "pendente", // ← campo de status por item
    lancado_em: new Date().toISOString(),
  }));

  if (window._mesaAbertaId) {
    // ── UPDATE: mantém itens existentes (com seus status_item atuais)
    //           e acrescenta apenas os novos itens pendentes ──────────
    const itensExistentes = Array.isArray(window._mesaAbertaPedido?.itens)
      ? window._mesaAbertaPedido.itens
      : [];

    const itensMerged = [...itensExistentes, ...novosItens];
    // Itens kg: preco já é o total pesado (preco_kg × peso), não multiplicar por qtd
    const novoTotal = itensMerged.reduce(
      (acc, i) =>
        acc + (i._isKg ? i.preco || 0 : (i.preco || 0) * (i.qtd || 1)),
      0,
    );

    const { error } = await supa
      .from("pedidos")
      .update({
        itens: itensMerged,
        total_geral: novoTotal,
        subtotal: novoTotal,
        forma_pagamento: pagFinalPDV,
        obs_pagamento: obsPagPDV,
        cliente_nome: nomeFinal,
        cliente_telefone: tel,
        status: "em_preparo",
      })
      .eq("id", window._mesaAbertaId);

    if (error) {
      alert("Erro ao atualizar mesa: " + error.message);
      return;
    }
    // Descontar estoque dos novos itens adicionados
    const _resDescMesa = await _descontarEstoqueVendaItens(novosItens);
    // 🔧 Marca a flag com o resultado REAL — evita mascarar falha silenciosa
    // (mantém rastreabilidade e evita duplo desconto em mudarStatus('em_preparo'))
    await supa
      .from("pedidos")
      .update({ estoque_descontado: _resDescMesa.ok })
      .eq("id", window._mesaAbertaId);
    await _alertarFalhaEstoque(_resDescMesa, `Mesa — Pedido #${window._mesaAbertaId}`);

    // Reset
    window._mesaAbertaId = null;
    window._mesaAbertaTotal = 0;
    window._mesaAbertaPedido = null;
    carrinhoPDV = [];
    document.getElementById("balcao-cliente").value = "";
    document.getElementById("balcao-mesa").value = "";
    document.getElementById("balcao-telefone").value = "";
    document.querySelector(".pdv-mesa-aviso")?.remove();
    atualizarCarrinhoPDV();
    atualizarBarraMesasAtivas();
    carregarMonitorMesas();
    alert(`✅ ${novosItens.length} item(s) enviado(s) para separação!`);
    return;
  }

  // ── INSERT: novo pedido de balcão ─────────────────────────────
  const tipoEntregaPDV =
    document.getElementById("balcao-tipo-entrega")?.value || "balcao";
  const fretePDV =
    tipoEntregaPDV === "delivery"
      ? parseInt(document.getElementById("balcao-frete")?.value || "0") || 0
      : 0;
  const enderecoPDV =
    tipoEntregaPDV === "delivery"
      ? document.getElementById("balcao-endereco")?.value.trim() || "Delivery"
      : mesa
        ? `Mesa ${mesa}`
        : _soKg
          ? "Balcão - Venda Kg"
          : "Balcão";

  const _geoLat = document.getElementById("balcao-geo-lat")?.value || null;
  const _geoLng = document.getElementById("balcao-geo-lng")?.value || null;

  const subtotalLiquido = subtotalBruto - descontoAplicado;
  const totalNovo = subtotalLiquido + fretePDV;
  const _agora = new Date().toISOString();
  // ── Lógica de status inicial ───────────────────────────────────
  // PDV delivery: precisa passar por preparo → em_preparo (ou pronto se todos sem cozinha)
  // PDV balcão / mesa / retirada: cliente já comprou e saiu → entregue direto
  const _isPdvDelivery = tipoEntregaPDV === "delivery";
  const _statusInicial = _isPdvDelivery
    ? (_todosSemCozinha(carrinhoPDV) ? "pronto_entrega" : "em_preparo")
    : "entregue"; // balcão/mesa/retirada: venda concluída na hora

  // Timestamps: delivery recebe só os tempos iniciais; balcão fecha todos de uma vez
  const _tsDelivery = _isPdvDelivery ? {} : {
    tempo_pronto:    _agora,
    tempo_entregue:  _agora,
  };

  // ── Chave de idempotência do PDV ────────────────────────────────────
  // Protege contra inserts duplicados quando o operador clica várias vezes
  // (rede lenta, F5 no meio do envio, etc). Hash determinístico do carrinho
  // + cliente + minuto atual: se o MESMO carrinho for enviado de novo dentro
  // da mesma janela de 1 minuto, o backend recusa o segundo insert.
  const _hashCarrinhoPDV = novosItens
    .map((i) => `${i.id}-${i.qtd}-${i.preco}`)
    .sort()
    .join("|");
  const _pdvIdempKey = `pdv-${_hashCarrinhoPDV}-${tel || cli}-${Math.floor(Date.now() / 60000)}`;

  // Verifica no banco se já existe um pedido idêntico nos últimos 60s
  const { data: _pedidoExistente } = await supa
    .from("pedidos")
    .select("id")
    .eq("idempotency_key", _pdvIdempKey)
    .maybeSingle();

  if (_pedidoExistente) {
    console.warn(`[PDV] Envio duplicado bloqueado — pedido já existe: #${_pedidoExistente.id}`);
    alert(`⚠️ Esta venda já foi registrada (Pedido #${_pedidoExistente.id}). Evite clicar várias vezes.`);
    carrinhoPDV = [];
    atualizarCarrinhoPDV();
    return;
  }

  const pedido = {
    uid_temporal: `BALC-${Math.floor(Math.random() * 1000)}`,
    idempotency_key: _pdvIdempKey,
    status: _soKg ? "entregue" : _statusInicial,
    tipo_entrega: tipoEntregaPDV,
    subtotal: subtotalBruto,
    desconto_pdv_valor: descontoAplicado,
    desconto_pdv_tipo: descontoAplicado > 0 ? descTipo : null,
    frete_cobrado_cliente: fretePDV,
    total_geral: totalNovo,
    forma_pagamento: pag,
    itens: novosItens,
    endereco_entrega: enderecoPDV,
    cliente_nome: nomeFinal,
    cliente_telefone: tel,
    obs_pagamento: obsPagPDV,
    garcom_id: _perfilId || null,
    garcom_nome: _perfilNome || null,
    ...(tipoEntregaPDV === "delivery" && _geoLat && _geoLng
      ? { geo_lat: _geoLat, geo_lng: _geoLng }
      : {}),
    tempo_recebido:          _agora,
    tempo_confirmado:        _agora,
    tempo_preparo_iniciado:  _isPdvDelivery ? _agora : null,
    ..._tsDelivery,
    ...(_soKg ? { tempo_pronto: _agora, tempo_entregue: _agora } : {}),
    // 🔧 CORREÇÃO: NÃO marcar como descontado aqui. O valor real só é
    // conhecido depois que _descontarEstoqueVenda() roda e confirma (ou não)
    // cada UPDATE. Gravar `true` antes de tentar mascarava falhas silenciosas
    // pra sempre — o pedido "mentia" ter descontado mesmo quando não tinha.
    estoque_descontado: false,
  };

  const { data: novoPedido, error } = await supa
    .from("pedidos")
    .insert([pedido])
    .select("id")
    .single();
  if (error) {
    // Se o erro for de chave duplicada (unique constraint), é uma tentativa
    // de duplo-envio que passou pela checagem acima por race condition —
    // trata como sucesso silencioso em vez de erro confuso pro operador.
    if (error.code === "23505" || /duplicate key/i.test(error.message || "")) {
      alert("⚠️ Esta venda já estava sendo processada. Verifique a lista de pedidos antes de tentar novamente.");
      carrinhoPDV = [];
      atualizarCarrinhoPDV();
      return;
    }
    alert("Erro: " + error.message);
    return;
  }
  // Descontar estoque imediatamente (PDV não passa por mudarStatus)
  if (novoPedido?.id) {
    const _resDescPdv = await _descontarEstoqueVenda(novoPedido.id, novosItens);
    // 🔧 Só grava `estoque_descontado: true` se realmente confirmou sucesso
    // em TODOS os itens. Se falhou parcialmente, mantém false — assim um
    // cancelamento futuro sabe que precisa repor (ou não), sem mentira gravada.
    await supa
      .from("pedidos")
      .update({ estoque_descontado: _resDescPdv.ok })
      .eq("id", novoPedido.id);
    await _alertarFalhaEstoque(_resDescPdv, `Balcão — Pedido #${novoPedido.id}`);
  }

  if (_pdvCashbackUsando && tel) {
    const descCash = pdvGetCashbackDesconto(totalNovo);
    if (descCash > 0 && typeof crmUsarCashback === "function") {
      await crmUsarCashback(tel, descCash);
    }
    _pdvCashbackUsando = false;
    _pdvCashbackDisponivel = 0;
    const _cbBox = document.getElementById("pdv-cashback-box");
    if (_cbBox) _cbBox.style.display = "none";
  }

  if (tel && typeof crmGerarCashback === "function") {
    await crmGerarCashback(tel, totalNovo, novoPedido?.id || null);
  }

    // ── Impressão do comprovante (pergunta, automático ou silencioso) ──
  if (novoPedido?.id) {
    const dadosImpressao = _pdvGerarDadosImpressao({
      pedidoId: novoPedido.id,
      clienteNome: nomeFinal,
      clienteTel: tel,
      entregaRef: pedido.endereco_entrega,
      itens: novosItens,
      subtotalBruto,
      descontoAplicado,
      fretePDV,
      totalNovo,
      formaPagamento: pag,
      obsPagamento: obsPagPDV,
    });
    _pdvPerguntarImpressao(dadosImpressao);
  }

  carrinhoPDV = [];
  document.getElementById("balcao-cliente").value = "";
  const mesaInput = document.getElementById("balcao-mesa");
  if (mesaInput) mesaInput.value = "";
  document.getElementById("balcao-telefone").value = "";
  // Reset tipo entrega e campos de delivery
  const tipoSelPDV = document.getElementById("balcao-tipo-entrega");
  if (tipoSelPDV) tipoSelPDV.value = "balcao";
  const endPDV = document.getElementById("balcao-endereco");
  if (endPDV) endPDV.value = "";
  const geoPDVLat = document.getElementById("balcao-geo-lat");
  if (geoPDVLat) geoPDVLat.value = "";
  const geoPDVLng = document.getElementById("balcao-geo-lng");
  if (geoPDVLng) geoPDVLng.value = "";
  const fretePDVInput = document.getElementById("balcao-frete");
  if (fretePDVInput) fretePDVInput.value = "";
  const freteMsgPDV = document.getElementById("frete-msg-pdv");
  if (freteMsgPDV) freteMsgPDV.innerHTML = "";
  const deliveryRowPDV = document.getElementById("pdv-delivery-row");
  if (deliveryRowPDV) deliveryRowPDV.style.display = "none";
  // Reset visual do toggle delivery
  const toggleDelivEl = document.getElementById("pdv-toggle-delivery");
  if (toggleDelivEl) toggleDelivEl.classList.remove("active");
  const chipEl = document.getElementById("pdv-tipo-chip");
  if (chipEl) chipEl.textContent = "🏪 Balcão";
  const descValEl = document.getElementById("pdv-desconto-val");
  if (descValEl) descValEl.value = "";
  const descTipoEl = document.getElementById("pdv-desconto-tipo");
  if (descTipoEl) descTipoEl.value = "fixo";
  // Reset recebido / troco
  const recebidoEl = document.getElementById("pdv-recebido");
  if (recebidoEl) recebidoEl.value = "";
  const trocoEl = document.getElementById("pdv-troco-val");
  if (trocoEl) trocoEl.textContent = "0";
  // Reset cashback
  _pdvCashbackDisponivel = 0;
  _pdvCashbackUsando = false;
  const cashBox = document.getElementById("pdv-cashback-box");
  if (cashBox) cashBox.style.display = "none";
  // Reset multipagamento PDV
  const multiPartesPDV = document.getElementById("multi-partes-pdv");
  if (multiPartesPDV) multiPartesPDV.innerHTML = "";
  _multiContadorPDV = 0;
  document.getElementById("balcao-pag").value = "Efetivo";
  document.getElementById("balcao-pag").style.display = "";
  const boxMultiPDV = document.getElementById("box-multi-pdv");
  if (boxMultiPDV) boxMultiPDV.style.display = "none";
  atualizarCarrinhoPDV();
  atualizarBarraMesasAtivas();
  carregarMonitorMesas();
  // Toast não-bloqueante (alert segurava o popup de impressão)
  const _msgFinal = _soKg
    ? "✅ Venda registrada!"
    : _todosBebidas(novosItens)
      ? "✅ Só bebidas — direto ao balcão."
      : "✅ Enviado para separação!";
  _pdvToast(_msgFinal);

  } finally {
    clearTimeout(_timerPDV);
    _liberarPDV();
  }
}

// ── Toast não-bloqueante do PDV ───────────────────────────────
function _pdvToast(msg, duracao = 3000) {
  document.getElementById("_pdv-toast")?.remove();
  const t = document.createElement("div");
  t.id = "_pdv-toast";
  t.style.cssText =
    "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a7a2e;color:#fff;padding:12px 28px;border-radius:30px;font-size:1rem;font-weight:700;z-index:999999;box-shadow:0 4px 20px rgba(0,0,0,0.25);pointer-events:none;animation:_toastIn 0.2s ease";
  t.textContent = msg;
  if (!document.getElementById("_pdv-toast-style")) {
    const s = document.createElement("style");
    s.id = "_pdv-toast-style";
    s.textContent =
      "@keyframes _toastIn{from{opacity:0;transform:translateX(-50%) translateY(10px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}";
    document.head.appendChild(s);
  }
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duracao);
}

// ── Barra de Mesas Ativas no PDV ─────────────────────────────
async function atualizarBarraMesasAtivas() {
  const bar = document.getElementById("pdv-mesas-bar");
  const vazio = document.getElementById("pdv-mesas-vazio");
  if (!bar) return;

  const { data } = await supa
    .from("pedidos")
    .select("id, endereco_entrega, cliente_nome, total_geral, status, itens")
    .eq("tipo_entrega", "balcao")
    .neq("status", "entregue")
    .neq("status", "cancelado")
    .order("id", { ascending: true });

  // Limpar chips anteriores (manter apenas label e span vazio)
  bar.querySelectorAll(".mesa-chip").forEach((c) => c.remove());
  if (vazio) vazio.style.display = data && data.length > 0 ? "none" : "inline";

  if (!data || data.length === 0) return;

  data.forEach((p) => {
    const nrMesa = (p.endereco_entrega || "").replace("Mesa ", "") || p.id;
    const chip = document.createElement("button");
    chip.className =
      "mesa-chip" +
      (p.status === "pronto_entrega"
        ? " mesa-pronto"
        : p.status === "em_preparo"
          ? " mesa-em-preparo"
          : "");
    chip.title = `${p.cliente_nome || "Mesa " + nrMesa} — Gs ${(p.total_geral || 0).toLocaleString("es-PY")} — Clique para adicionar itens`;
    chip.innerHTML = `<span class="mesa-chip-num">${nrMesa}</span><span class="mesa-chip-status">${
      p.status === "pronto_entrega"
        ? "✓ Pronto"
        : p.status === "em_preparo"
          ? "🔥"
          : "●"
    }</span>`;
    chip.onclick = () => abrirMesaExistente(p);
    bar.appendChild(chip);
  });
}

// Abre uma mesa existente no carrinho PDV para adicionar mais itens
function abrirMesaExistente(pedido) {
  const nrMesa = (pedido.endereco_entrega || "").replace("Mesa ", "") || "";
  const nomeCli = (pedido.cliente_nome || "").replace(/^MESA \d+ - /i, "");

  // Preenche os campos
  const elMesa = document.getElementById("balcao-mesa");
  const elCli = document.getElementById("balcao-cliente");
  if (elMesa) elMesa.value = nrMesa;
  if (elCli) elCli.value = nomeCli === "Cliente" ? "" : nomeCli;

  // ──────────────────────────────────────────────────────────────────
  // MUDANÇA: carrinhoPDV fica VAZIO — só recebe os NOVOS itens.
  // Os itens existentes ficam em window._mesaAbertaPedido (snapshot do DB).
  // Na hora do save, fazemos merge: existentes (intactos) + novos (pendente).
  // ──────────────────────────────────────────────────────────────────
  carrinhoPDV = [];
  window._mesaAbertaId = pedido.id;
  window._mesaAbertaTotal = pedido.total_geral || 0;
  window._mesaAbertaPedido = pedido; // guarda snapshot completo

  atualizarCarrinhoPDV();

  // Scroll para o topo do PDV
  const pdv = document.getElementById("pdv");
  if (pdv) pdv.scrollIntoView({ behavior: "smooth", block: "start" });

  // Aviso visual
  const aviso = document.createElement("div");
  aviso.className = "pdv-mesa-aviso";
  aviso.innerHTML = `<i class="fas fa-edit"></i> Editando Mesa ${nrMesa} — adicione os NOVOS itens e clique em Lançar`;
  const existing = pdv?.querySelector(".pdv-mesa-aviso");
  if (existing) existing.remove();
  const h4 = pdv?.querySelector(".pdv-carrinho-titulo");
  if (h4) h4.after(aviso);
  setTimeout(() => aviso?.remove(), 8000);
}

async function carregarMonitorMesas() {
  // Atualiza barra de chips de mesas no PDV junto com o monitor
  atualizarBarraMesasAtivas();
  // Busca pedidos de Balcão que NÃO foram finalizados (entregues)
  const { data } = await supa
    .from("pedidos")
    .select("*")
    .eq("tipo_entrega", "balcao")
    .neq("status", "entregue") // Traz 'pendente', 'em_preparo' e 'pronto_entrega'
    .order("id", { ascending: false });

  const div = document.getElementById("lista-mesas-andamento");
  if (!div) return;

  div.innerHTML = "";

  if (!data || data.length === 0) {
    div.innerHTML = '<p class="mesa-monitor-vazio">Nenhum pedido ativo.</p>';
    return;
  }

  data.forEach((p) => {
    let statusHtml = "";
    let acaoHtml = "";
    let cardClass = "mesa-monitor-card";

    // Lógica Visual do Status — usa classes CSS
    if (p.status === "em_preparo") {
      cardClass += " mesa-preparo";
      statusHtml =
        '<span class="mesa-monitor-status-cozinha"><i class="fas fa-fire"></i> Em Separação</span>';
      acaoHtml =
        '<small class="mesa-monitor-status-cozinha">Aguardando Separação...</small>';
    } else if (p.status === "pronto_entrega") {
      cardClass += " mesa-pronta";
      statusHtml =
        '<span class="mesa-monitor-status-pronto"><i class="fas fa-check-circle"></i> PRONTO!</span>';
      acaoHtml = `<button class="btn btn-sm btn-success btn-block-pdv" onclick="finalizarMesa(${p.id})">Entregar / Baixar</button>`;
    } else {
      statusHtml = `<span class="mesa-monitor-valor">${p.status}</span>`;
    }

    const nrMesa =
      (p.endereco_entrega || "").replace("Mesa ", "") || p.uid_temporal || p.id;

    // Lista de itens com status visual por item
    const itens = Array.isArray(p.itens) ? p.itens : [];
    const pendentes = itens.filter(
      (i) => !i.status_item || i.status_item === "pendente",
    );
    const entregues = itens.filter((i) => i.status_item === "entregue");

    let itensListHtml = itens
      .map((item, idx) => {
        const isEntregue = item.status_item === "entregue";
        const nome = item.nome || item.n || "Item";
        const qtd = item.qtd || item.q || 1;
        return `
        <div class="monitor-item-row ${isEntregue ? "monitor-item-entregue" : ""}">
          <span class="monitor-item-nome">${qtd}x ${nome}</span>
          ${
            isEntregue
              ? '<span class="monitor-item-badge-entregue">✓ Entregue</span>'
              : `<button class="btn btn-xs btn-outline-success monitor-btn-baixar"
                title="Marcar como entregue"
                onclick="baixarItemMesa(${p.id}, ${idx})">
                <i class="fas fa-check"></i>
               </button>`
          }
        </div>`;
      })
      .join("");

    // Contador de pendentes no cabeçalho
    const cntPendente =
      pendentes.length > 0
        ? `<span class="mesa-monitor-cnt-pendente">${pendentes.length} pendente${pendentes.length > 1 ? "s" : ""}</span>`
        : "";

    const card = document.createElement("div");
    card.className = cardClass;
    card.innerHTML = `
      <div class="mesa-monitor-titulo">Mesa ${nrMesa} ${cntPendente}</div>
      <div class="mesa-monitor-cliente">${p.cliente_nome || "-"}</div>
      <div class="mesa-monitor-itens-lista">${itensListHtml}</div>
      <div class="mesa-monitor-rodape">
        ${statusHtml}
        <span class="mesa-monitor-valor">Gs ${(p.total_geral || 0).toLocaleString("es-PY")}</span>
      </div>
      ${acaoHtml}
    `;
    div.appendChild(card);
  });
}

// ── Baixa parcial: marca 1 item como 'entregue' no banco ──────────
// idx = índice do item dentro do array p.itens no banco
async function baixarItemMesa(pedidoId, itemIdx) {
  // Busca snapshot mais recente do banco (evita conflito de estado stale)
  const { data: p, error: errFetch } = await supa
    .from("pedidos")
    .select("itens, total_geral")
    .eq("id", pedidoId)
    .single();
  if (errFetch || !p) {
    alert("Erro ao buscar comanda.");
    return;
  }

  const itens = Array.isArray(p.itens) ? [...p.itens] : [];
  if (!itens[itemIdx]) return;

  // Muda status do item específico
  itens[itemIdx] = { ...itens[itemIdx], status_item: "entregue" };

  const { error } = await supa
    .from("pedidos")
    .update({ itens })
    .eq("id", pedidoId);

  if (error) {
    alert("Erro ao baixar item: " + error.message);
    return;
  }

  // Atualiza o snapshot local e re-renderiza o carrinho PDV
  if (window._mesaAbertaPedido && window._mesaAbertaId === pedidoId) {
    window._mesaAbertaPedido = { ...window._mesaAbertaPedido, itens };
    atualizarCarrinhoPDV();
  }
  // Atualiza o monitor de mesas sem precisar recarregar tudo
  atualizarBarraMesasAtivas();
}

// Função para dar baixa na mesa (Muda status para 'entregue' e sai da lista)
async function finalizarMesa(id) {
  if (confirm("Confirmar entrega e pagamento desta mesa?")) {
    // Busca pedido para checar se estoque já foi descontado (PDV balcao desconta na criação)
    const { data: pedAtual } = await supa
      .from("pedidos")
      .select("estoque_descontado")
      .eq("id", id)
      .single();

    // 🔧 CORREÇÃO: NÃO grava `estoque_descontado: true` aqui — isso mascarava
    // qualquer falha do desconto abaixo, gravando "sucesso" antes de saber
    // se o desconto realmente aconteceu. Só mexe em status/tempo_entregue.
    await supa
      .from("pedidos")
      .update({
        status: "entregue",
        tempo_entregue: new Date().toISOString(),
      })
      .eq("id", id);

    // Desconta estoque apenas se ainda não foi descontado
    // PDV balcão desconta em salvarPedidoBalcao(); demais pedidos balcão descontam aqui
    if (!pedAtual?.estoque_descontado) {
      const _resDescFinal = await _descontarEstoqueVenda(id, null);
      // Grava o resultado REAL da tentativa, não um "true" otimista
      await supa
        .from("pedidos")
        .update({ estoque_descontado: _resDescFinal.ok })
        .eq("id", id);
      await _alertarFalhaEstoque(_resDescFinal, `Mesa finalizada — Pedido #${id}`);
    }

    carregarMonitorMesas();
    if (typeof calcularFinanceiro === "function") calcularFinanceiro();
    const abaAtual = localStorage.getItem("app_lastTab");
    if (abaAtual === "pedidos") carregarPedidos();
  }
}

// Utilitários de Modal e Checkbox
function fecharModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove("active");
    modal.style.display = "none";
  }
}

function toggleTodos(s) {
  document
    .querySelectorAll(".check-pedido")
    .forEach((c) => (c.checked = s.checked));
}

// Clique fora do modal fecha
window.onclick = function (event) {
  if (event.target.classList.contains("modal-overlay")) {
    event.target.classList.remove("active");
    event.target.style.display = "none";
  }
};

// ESC fecha modal
document.addEventListener("keydown", function (event) {
  if (event.key === "Escape") {
    document
      .querySelectorAll('.modal-overlay.active, .modal-overlay[style*="flex"]')
      .forEach((modal) => {
        modal.classList.remove("active");
        modal.style.display = "none";
      });
  }
});

// =========================================
// 10. GESTÃO DE EQUIPE
// =========================================
async function carregarEquipe() {
  const { data } = await supa.from("perfis_acesso").select("*").order("cargo");

  const tbody = document.getElementById("lista-equipe");
  if (!tbody) return;

  tbody.innerHTML = "";
  if (data) {
    data.forEach((u) => {
      const dataCriacao = u.created_at
        ? new Date(u.created_at).toLocaleDateString("pt-BR")
        : "-";
      const ehDono = u.cargo === "dono";
      const ehGerente = u.cargo === "gerente";
      const ehFuncionario = u.cargo === "funcionario";
      const ehGarcom = u.cargo === "garcom";
      const ehAM = u.cargo === "adminMaster";

      // Botão de promoção/rebaixamento
      let acaoCargo = "";
      if (
        !ehAM &&
        (perfilUsuario === "dono" || perfilUsuario === "adminMaster")
      ) {
        if (ehFuncionario || ehGarcom) {
          acaoCargo = `<button class="btn btn-sm btn-success" onclick="promoverUsuario('${u.id}', 'gerente')" title="Promover a Gerente"><i class="fas fa-arrow-up"></i> Gerente</button>`;
        } else if (ehGerente) {
          acaoCargo = `<button class="btn btn-sm btn-warning" onclick="promoverUsuario('${u.id}', 'funcionario')" title="Rebaixar a Funcionário"><i class="fas fa-arrow-down"></i> Funcionário</button>`;
        }
        if (perfilUsuario === "adminMaster" && !ehDono) {
          acaoCargo += ` <button class="btn btn-sm btn-primary" onclick="promoverUsuario('${u.id}', 'dono')" title="Tornar Dono"><i class="fas fa-crown"></i> Dono</button>`;
        }
        if (!ehDono) {
          acaoCargo += ` <button class="btn btn-sm btn-danger" onclick="excluirUsuario('${u.id}', '${u.email}')" title="Excluir"><i class="fas fa-trash"></i></button>`;
        }
      }

      const cargoBadge = ehAM
        ? "🎮 Admin Master"
        : ehDono
          ? "🔑 Dono"
          : ehGerente
            ? "👔 Gerente"
            : ehGarcom
              ? "🍽️ Garçom"
              : "👷 Funcionário";
      tbody.innerHTML += `<tr>
                <td><strong>${u.nome_display || "—"}</strong></td>
                <td>${u.email}</td>
                <td>${cargoBadge}</td>
                <td>${dataCriacao}</td>
                <td>${acaoCargo}</td>
            </tr>`;
    });
  }
}

async function promoverUsuario(id, novoCargo) {
  const msg =
    novoCargo === "gerente"
      ? "Promover este usuário a Gerente?"
      : "Rebaixar este usuário a Funcionário?";
  if (!confirm(msg)) return;

  const { error } = await supa
    .from("perfis_acesso")
    .update({ cargo: novoCargo })
    .eq("id", id);
  if (error) {
    alert("❌ Erro: " + error.message);
  } else {
    alert(`✅ Cargo alterado para ${novoCargo}!`);
    carregarEquipe();
  }
}

async function excluirUsuario(id, email) {
  if (
    !confirm(
      `⚠️ Excluir o usuário "${email}"?\n\nEsta ação remove apenas o perfil. O acesso de autenticação pode precisar ser revogado no Supabase Dashboard.`,
    )
  )
    return;

  const { error } = await supa.from("perfis_acesso").delete().eq("id", id);
  if (error) {
    alert("❌ Erro ao excluir: " + error.message);
  } else {
    alert("✅ Usuário excluído com sucesso!");
    carregarEquipe();
  }
}

// ═══════════════════════════════════════════════════════════════
// ADMIN MASTER — CRUD completo de usuários
// ═══════════════════════════════════════════════════════════════

async function amCriarUsuario() {
  if (perfilUsuario !== "adminMaster") return alert(t("alert.acesso_negado"));
  const email = document.getElementById("am-email")?.value?.trim();
  const nome = document.getElementById("am-nome")?.value?.trim();
  const senha = document.getElementById("am-senha")?.value;
  const cargo = document.getElementById("am-cargo")?.value || "dono";
  if (!email || !nome || !senha || senha.length < 6)
    return alert("Preencha email, nome e senha (mín. 6 caracteres).");
  const btn = event?.target;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Criando...";
  }
  try {
    const { data, error } = await supa.auth.signUp({ email, password: senha });
    if (error) {
      alert("❌ Erro: " + error.message);
      return;
    }
    if (data.user) {
      const { error: ep } = await supa
        .from("perfis_acesso")
        .upsert([{ id: data.user.id, email, cargo, nome_display: nome }], {
          onConflict: "id",
        });
      if (ep) {
        alert("⚠️ Auth criado mas erro no perfil: " + ep.message);
        return;
      }
      const cargoBadge = {
        dono: "Dono",
        gerente: "Gerente",
        funcionario: "Funcionário",
        garcom: "Garçom",
      };
      alert(
        `✅ Usuário "${nome}" criado como ${cargoBadge[cargo] || cargo}!\nSolicite que confirme o email antes de fazer login.`,
      );
      document.getElementById("am-email").value = "";
      document.getElementById("am-nome").value = "";
      document.getElementById("am-senha").value = "";
      amCarregarUsuarios();
    }
  } catch (e) {
    alert("❌ Erro: " + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-user-plus"></i> Criar Usuário';
    }
  }
}

// Compatibilidade com cadastrarDono (aba Configurações)
async function cadastrarDono() {
  const emailEl = document.getElementById("am-email");
  const cargoEl = document.getElementById("am-cargo");
  if (cargoEl) cargoEl.value = "dono";
  return amCriarUsuario();
}

async function amCarregarUsuarios() {
  if (perfilUsuario !== "adminMaster") return;
  const tbody = document.getElementById("am-lista-usuarios");
  if (!tbody) return;
  tbody.innerHTML =
    '<tr><td colspan="4" style="text-align:center;padding:16px"><i class="fas fa-spinner fa-spin"></i> Carregando...</td></tr>';

  const { data, error } = await supa
    .from("perfis_acesso")
    .select("*")
    .order("cargo");
  if (error) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:red;text-align:center">${error.message}</td></tr>`;
    return;
  }

  if (!data || !data.length) {
    tbody.innerHTML =
      '<tr><td colspan="4" style="text-align:center;color:#aaa">Nenhum usuário cadastrado</td></tr>';
    return;
  }

  const cargoBadges = {
    adminMaster:
      '<span style="background:#e74c3c;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.75rem">🎮 Admin Master</span>',
    dono: '<span style="background:#f39c12;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.75rem">🔑 Dono</span>',
    gerente:
      '<span style="background:#2980b9;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.75rem">👔 Gerente</span>',
    funcionario:
      '<span style="background:#7f8c8d;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.75rem">👷 Funcionário</span>',
    garcom:
      '<span style="background:#27ae60;color:#fff;padding:2px 8px;border-radius:10px;font-size:0.75rem">🍽️ Garçom</span>',
  };

  tbody.innerHTML = data
    .map((u) => {
      const isMe = u.id === _perfilId;
      const isAM = u.cargo === "adminMaster";
      const opcoesCargo = ["dono", "gerente", "funcionario", "garcom"]
        .map(
          (c) =>
            `<option value="${c}" ${u.cargo === c ? "selected" : ""}>${c}</option>`,
        )
        .join("");
            const btnPermissoes = u.cargo === "socio"
        ? `<button onclick="amAbrirModalPermissoes('${u.id}','${u.email.replace(/'/g, "\\'")}')"
            style="background:#8e44ad;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.8rem;margin-right:6px"
            title="Editar abas visíveis">
            🔐 Permissões
          </button>`
        : "";

      const acoes =
        isMe || isAM
          ? '<span style="color:#aaa;font-size:0.78rem">—</span>'
          : `
      ${btnPermissoes}
      <select onchange="amAlterarCargo('${u.id}', this.value)" style="padding:4px 8px;border-radius:6px;border:1px solid #ddd;font-size:0.8rem;margin-right:6px">
        ${opcoesCargo}
      </select>
      <button onclick="amExcluirUsuario('${u.id}','${u.email}')"
        style="background:#e74c3c;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.8rem">
        <i class="fas fa-trash"></i>
      </button>`;
      return `<tr>
      <td><strong>${u.nome_display || "—"}</strong>${isMe ? ' <span style="font-size:0.7rem;color:#27ae60">(você)</span>' : ""}</td>
      <td style="font-size:0.85rem">${u.email}</td>
      <td>${cargoBadges[u.cargo] || u.cargo}</td>
      <td>${acoes}</td>
    </tr>`;
    })
    .join("");
}

async function amAlterarCargo(id, novoCargo) {
  if (perfilUsuario !== "adminMaster") return;
  if (!confirm(`Alterar cargo para "${novoCargo}"?`)) {
    amCarregarUsuarios();
    return;
  }
  const { error } = await supa
    .from("perfis_acesso")
    .update({ cargo: novoCargo })
    .eq("id", id);
  if (error) alert("❌ Erro: " + error.message);
  else {
    amCarregarUsuarios();
    carregarEquipe();
  }
}

// ─────────────────────────────────────────────────────────────
//  Admin Master — Editor de permissões do Sócio
//  Modal dinâmico: 1 checkbox por aba. Salva em
//  perfis_acesso.permissoes_customizadas = { abas: [...] }
// ─────────────────────────────────────────────────────────────
const _ABAS_DISPONIVEIS = [
  { key: "dashboard",     label: "📊 Visão Geral" },
  { key: "pdv",           label: "🏪 PDV Mostrador" },
  { key: "pedidos",       label: "📋 Pedidos" },
  { key: "cozinha",       label: "🍳 Separação" },
  { key: "equipe",        label: "👥 Equipe" },
  { key: "produtos",      label: "🍽️ Produtos" },
  { key: "categorias",    label: "🏷️ Categorias" },
  { key: "motoboys",      label: "🏍️ Motoboys" },
  { key: "financeiro",    label: "💰 Financeiro" },
  { key: "inventario",    label: "📦 Inventário" },
  { key: "configuracoes", label: "⚙️ Configurações" },
  { key: "estatisticas",  label: "📈 Estatísticas" },
  { key: "ficha-tecnica", label: "🧮 Ficha Técnica" },
  { key: "crm",           label: "👥 CRM Clientes" },
  { key: "mensalistas",   label: "📆 Mensalistas" },
  { key: "filiais",       label: "🏬 Filiais" },
];

async function amAbrirModalPermissoes(userId, userEmail) {
  if (perfilUsuario !== "adminMaster") return;

  // Busca permissões atuais
  const { data, error } = await supa
    .from("perfis_acesso")
    .select("permissoes_customizadas, nome_display")
    .eq("id", userId)
    .single();

  if (error || !data) {
    alert("Erro ao carregar permissões: " + (error?.message || "usuário não encontrado"));
    return;
  }

  const atuais = data.permissoes_customizadas?.abas || [];
  const nomeExibir = data.nome_display || userEmail;

  document.getElementById("_modal-perm-socio")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "_modal-perm-socio";
  overlay.style.cssText = [
    "position:fixed","inset:0","background:rgba(0,0,0,0.6)",
    "z-index:99999","display:flex","align-items:center",
    "justify-content:center","padding:16px","overflow-y:auto",
  ].join(";");
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:18px;max-width:560px;width:100%;
                max-height:92vh;overflow:hidden;display:flex;flex-direction:column;
                box-shadow:0 24px 80px rgba(0,0,0,0.4)">
      <div style="background:linear-gradient(135deg,#1e40af,#1e3a8a);color:#fff;
                  padding:20px 24px;flex-shrink:0">
        <div style="font-size:1.15rem;font-weight:800">🔐 Permissões do Sócio</div>
        <div style="font-size:0.82rem;opacity:0.9;margin-top:4px">
          <b>${nomeExibir}</b> — marque as abas que ele pode ver
        </div>
      </div>

      <div style="padding:20px 24px;overflow-y:auto;flex:1">
        <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
          <button type="button" onclick="_permMarcarTodas(true)"
            style="padding:6px 14px;background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;
                   border-radius:8px;font-weight:700;font-size:0.78rem;cursor:pointer">
            ✓ Marcar todas
          </button>
          <button type="button" onclick="_permMarcarTodas(false)"
            style="padding:6px 14px;background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;
                   border-radius:8px;font-weight:700;font-size:0.78rem;cursor:pointer">
            ✗ Limpar todas
          </button>
        </div>

        <div id="_perm-checkboxes" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          ${_ABAS_DISPONIVEIS.map((a) => `
            <label style="display:flex;align-items:center;gap:8px;padding:8px 12px;
                          background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:10px;
                          cursor:pointer;font-size:0.85rem;font-weight:600;color:#334155;
                          transition:all .15s"
              onmouseover="this.style.borderColor='#8e44ad'"
              onmouseout="this.style.borderColor='#e2e8f0'">
              <input type="checkbox" class="_perm-chk" value="${a.key}"
                ${atuais.includes(a.key) ? "checked" : ""}
                style="width:17px;height:17px;accent-color:#8e44ad;flex-shrink:0">
              ${a.label}
            </label>
          `).join("")}
        </div>

        <div style="margin-top:18px;padding:12px 14px;background:#fffbeb;
                    border:1px solid #fcd34d;border-radius:10px;font-size:0.78rem;color:#92400e">
          ⚠️ <b>Admin Master</b> e <b>Assinatura</b> são sempre exclusivos do adminMaster —
          mesmo que você marque, o Sócio não verá essas abas.
        </div>
      </div>

      <div style="padding:16px 24px;border-top:1px solid #f0f0f0;background:#fafafa;
                  display:flex;gap:10px;flex-shrink:0">
        <button type="button" onclick="document.getElementById('_modal-perm-socio').remove()"
          style="flex:1;padding:12px;background:#fff;color:#64748b;border:1.5px solid #e2e8f0;
                 border-radius:10px;font-weight:700;font-size:0.88rem;cursor:pointer">
          Cancelar
        </button>
        <button type="button" id="_perm-btn-salvar"
          onclick="amSalvarPermissoes('${userId}')"
          style="flex:2;padding:12px;background:linear-gradient(135deg,#8e44ad,#6b21a8);
                 color:#fff;border:none;border-radius:10px;font-weight:800;font-size:0.9rem;
                 cursor:pointer;box-shadow:0 4px 14px rgba(142,68,173,0.35)">
          ✅ Salvar Permissões
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Helper para "marcar/desmarcar todas"
  window._permMarcarTodas = (valor) => {
    document.querySelectorAll("._perm-chk").forEach((c) => (c.checked = valor));
  };
}

async function amSalvarPermissoes(userId) {
  if (perfilUsuario !== "adminMaster") return;

  const marcados = Array.from(document.querySelectorAll("._perm-chk:checked"))
    .map((c) => c.value);

  const btn = document.getElementById("_perm-btn-salvar");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Salvando..."; }

  const { error } = await supa
    .from("perfis_acesso")
    .update({ permissoes_customizadas: { abas: marcados } })
    .eq("id", userId);

  if (error) {
    alert("❌ Erro ao salvar: " + error.message);
    if (btn) { btn.disabled = false; btn.textContent = "✅ Salvar Permissões"; }
    return;
  }

  document.getElementById("_modal-perm-socio")?.remove();

  // Toast
  const toast = document.createElement("div");
  toast.textContent = `✅ ${marcados.length} aba(s) liberada(s)`;
  toast.style.cssText = [
    "position:fixed","bottom:28px","left:50%","transform:translateX(-50%)",
    "background:#16a34a","color:#fff","padding:12px 24px","border-radius:12px",
    "font-weight:700","font-size:0.9rem","z-index:99999",
    "box-shadow:0 8px 24px rgba(0,0,0,0.2)",
  ].join(";");
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}


async function amExcluirUsuario(id, email) {
  if (perfilUsuario !== "adminMaster") return;
  if (
    !confirm(
      `⚠️ Excluir o usuário "${email}"?\n\nIsso remove o perfil do banco. O acesso de autenticação pode precisar ser revogado no Supabase Dashboard.`,
    )
  )
    return;
  const { error } = await supa.from("perfis_acesso").delete().eq("id", id);
  if (error) alert("❌ Erro: " + error.message);
  else {
    alert("✅ Usuário excluído.");
    amCarregarUsuarios();
    carregarEquipe();
  }
}

async function cadastrarUsuario() {
  const email = document.getElementById("novo-user-email")?.value?.trim();
  const nomeDisplay =
    document.getElementById("novo-user-nome")?.value?.trim() || "";
  const senha = document.getElementById("novo-user-senha")?.value;
  const cargo = document.getElementById("novo-user-cargo")?.value;

  if (!email || !senha || senha.length < 6)
    return alert("Email e senha (mín. 6 caracteres) são obrigatórios");
  if (!nomeDisplay) return alert("O nome de exibição é obrigatório");

  // Apenas adminMaster pode criar dono
  if (cargo === "dono" && perfilUsuario !== "adminMaster")
    return alert("Apenas o Admin Master pode criar usuários com cargo Dono.");

  const btn = event?.target;
  if (btn) {
    btn.disabled = true;
    btn.innerText = "Criando...";
  }

  try {
    // 1. Cria usuário na Autenticação do Supabase
    const { data, error } = await supa.auth.signUp({ email, password: senha });

    if (error) {
      alert("❌ Erro ao criar usuário: " + error.message);
      return;
    }

    if (data.user) {
      // 2. Salva perfil no banco usando upsert para evitar duplicata de chave
      const { error: errPerfil } = await supa
        .from("perfis_acesso")
        .upsert(
          [{ id: data.user.id, email, cargo, nome_display: nomeDisplay }],
          { onConflict: "id" },
        );

      if (errPerfil) {
        alert(
          "⚠️ Usuário de autenticação criado, mas erro ao salvar perfil: " +
            errPerfil.message,
        );
      } else {
        alert(
          "✅ Usuário cadastrado com sucesso!\n\nO usuário receberá um email de confirmação.",
        );
        document.getElementById("novo-user-email").value = "";
        document.getElementById("novo-user-nome").value = "";
        document.getElementById("novo-user-senha").value = "";
        carregarEquipe();
      }
    } else {
      alert("⚠️ Usuário criado. Aguardando confirmação de email para ativar.");
    }
  } catch (e) {
    alert("❌ Erro inesperado: " + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-user-plus"></i> Criar';
    }
  }
}

function adicionarItem(etapaIndex) {
  const lista = document.getElementById(`itens-list-${etapaIndex}`);
  const itemDiv = document.createElement("div");
  itemDiv.className = "item-row";
  itemDiv.innerHTML = `
        <input type="text" class="input-modern" placeholder="Nome do item">
        <button type="button" class="btn-remove-item" 
                onclick="this.parentElement.remove()">
            <i class="fas fa-times"></i>
        </button>
    `;
  lista.appendChild(itemDiv);
}

function removerEtapa(index) {
  if (confirm("Remover esta etapa?")) {
    const container = document.getElementById("builder-steps");
    container.children[index].remove();
  }
}

// CARREGAR CUPONS
async function carregarCupons() {
  const { data } = await supa
    .from("cupons")
    .select("*")
    .order("created_at", { ascending: false });
  const tbody = document.getElementById("lista-cupons");

  if (!tbody) return;
  tbody.innerHTML = "";

  (data || []).forEach((c) => {
    const tipoLabel = c.tipo === "percentual" ? `${c.valor}%` : "Frete Grátis";
    const statusBadge = c.ativo
      ? '<span class="badge badge-success">Ativo</span>'
      : '<span class="badge badge-danger">Inativo</span>';

    // Uso / limite
    const usosRealizados = c.usos_realizados || c.usos_atual || 0;
    let usoHtml;
    if (c.limite_uso && c.limite_uso > 0) {
      const restante = c.limite_uso - usosRealizados;
      const esgotado = restante <= 0;
      usoHtml = `
        <div style="font-size:0.82rem">
          <span style="font-weight:700;color:${esgotado ? "#e74c3c" : "#27ae60"}">${usosRealizados}/${c.limite_uso}</span>
          ${esgotado ? '<span class="badge badge-danger" style="font-size:0.65rem">Esgotado</span>' : `<span style="color:#888;font-size:0.72rem">(${restante} restantes)</span>`}
        </div>`;
    } else {
      usoHtml = `<span style="color:#aaa;font-size:0.82rem">${usosRealizados} usos / ∞</span>`;
    }

    // Validade
    let validadeHtml = '<span style="color:#ccc;font-size:0.8rem">—</span>';
    if (c.validade) {
      const vDate = new Date(c.validade + "T00:00:00");
      const hoje = new Date();
      hoje.setHours(0, 0, 0, 0);
      const expirado = vDate < hoje;
      validadeHtml = `<span style="font-size:0.8rem;color:${expirado ? "#e74c3c" : "#555"}">${vDate.toLocaleDateString("pt-BR")}${expirado ? " <em style='font-size:0.7rem'>(Expirado)</em>" : ""}</span>`;
    }

    tbody.innerHTML += `
            <tr>
                <td><strong>${c.codigo}</strong></td>
                <td>${c.tipo === "percentual" ? "Percentual" : "Frete Grátis"}</td>
                <td>${tipoLabel}</td>
                <td>Gs ${c.minimo.toLocaleString("es-PY")}</td>
                <td>${usoHtml}</td>
                <td>${validadeHtml}</td>
                <td>${statusBadge}</td>
                <td class="actions-cell">
                    <button class="btn btn-sm btn-primary" onclick='editarCupom(${JSON.stringify(c)})'>
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="deletarCupom(${c.id})">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `;
  });
}

// ABRIR MODAL CUPOM
function abrirModalCupom(cupom = null) {
  document.getElementById("cupom-id").value = cupom ? cupom.id : "";
  document.getElementById("cupom-codigo").value = cupom ? cupom.codigo : "";
  document.getElementById("cupom-tipo").value = cupom
    ? cupom.tipo
    : "percentual";
  document.getElementById("cupom-valor").value = cupom ? cupom.valor : "";
  document.getElementById("cupom-minimo").value = cupom ? cupom.minimo : "";
  document.getElementById("cupom-ativo").checked = cupom ? cupom.ativo : true;
  // Limite de usos e validade
  document.getElementById("cupom-limite").value = cupom?.limite_uso ?? "";
  document.getElementById("cupom-validade").value = cupom?.validade
    ? cupom.validade.split("T")[0]
    : "";

  alterarTipoCupom();

  const modal = document.getElementById("modal-cupom");
  modal.style.display = "flex";
  modal.classList.add("active");
}

function editarCupom(cupom) {
  abrirModalCupom(cupom);
}

function alterarTipoCupom() {
  const tipo = document.getElementById("cupom-tipo").value;
  const boxValor = document.getElementById("box-valor-cupom");
  boxValor.style.display = tipo === "percentual" ? "block" : "none";
}

// SALVAR CUPOM
async function salvarCupom() {
  const id = document.getElementById("cupom-id").value;
  const limiteRaw = parseInt(document.getElementById("cupom-limite").value);
  const validadeRaw = document.getElementById("cupom-validade").value;

  const dados = {
    codigo: document.getElementById("cupom-codigo").value.toUpperCase(),
    tipo: document.getElementById("cupom-tipo").value,
    valor: parseFloat(document.getElementById("cupom-valor").value) || 0,
    minimo: parseFloat(document.getElementById("cupom-minimo").value) || 0,
    ativo: document.getElementById("cupom-ativo").checked,
    limite_uso: !isNaN(limiteRaw) && limiteRaw > 0 ? limiteRaw : null,
    validade: validadeRaw || null,
  };

  if (!dados.codigo) {
    alert("Digite um código para o cupom");
    return;
  }

  let error;
  if (id) {
    ({ error } = await supa.from("cupons").update(dados).eq("id", id));
  } else {
    ({ error } = await supa.from("cupons").insert([dados]));
  }

  if (error) {
    alert("Erro: " + error.message);
  } else {
    alert("✅ Cupom salvo com sucesso!");
    document.getElementById("modal-cupom").classList.remove("active"); // Fecha o modal
    document.getElementById("modal-cupom").style.display = "none";
    carregarCupons();
  }
}

// DELETAR CUPOM
async function deletarCupom(id) {
  if (confirm("Deletar este cupom?")) {
    const { error } = await supa.from("cupons").delete().eq("id", id);
    if (error) alert("Erro: " + error.message);
    else carregarCupons();
  }
}

// ── Avisar cliente via WhatsApp que o pedido está pronto ──────────
async function avisarClientePronto(pedidoId) {
  const { data: p } = await supa
    .from("pedidos")
    .select("cliente_nome, cliente_telefone, uid_temporal")
    .eq("id", pedidoId)
    .single();
  if (!p) {
    alert("Pedido não encontrado.");
    return;
  }

  const tel = (p.cliente_telefone || "").replace(/\D/g, "");
  if (!tel) {
    alert("Este pedido não tem número de telefone registrado.");
    return;
  }

  // Carrega nome da loja
  const nomeRestaurante = NOME_RESTAURANTE || "Restaurante";
  const nomeCliente = p.cliente_nome || "Cliente";
  const numPedido = p.uid_temporal || pedidoId;

  // Mensagem em 3 idiomas
  const msgs = {
    pt: `Olá, ${nomeCliente}! 🎉\nSeu pedido #${numPedido} está pronto! 🍽️\n\nObrigado por escolher ${nomeRestaurante}!`,
    es: `¡Hola, ${nomeCliente}! 🎉\n¡Tu pedido #${numPedido} está listo! 🍽️\n\n¡Gracias por elegir ${nomeRestaurante}!`,
    gn: `Mba'éichapa, ${nomeCliente}! 🎉\nNde pedido #${numPedido} oĩma! 🍽️\n\nAguyje ${nomeRestaurante}-pe remomba'apo haguépe!`,
  };

  // Modal de seleção de idioma
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };

  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:20px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.3)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h4 style="margin:0;color:#25D366"><i class="fab fa-whatsapp"></i> Avisar Cliente</h4>
        <button onclick="this.closest('[style]').remove()" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:#999">✕</button>
      </div>
      <p style="font-size:0.85rem;color:#555;margin-bottom:14px">Pedido <strong>#${numPedido}</strong> — <strong>${nomeCliente}</strong></p>
      <p style="font-size:0.8rem;font-weight:600;color:#333;margin-bottom:10px">Escolha o idioma da mensagem:</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${Object.entries({
          pt: "🇧🇷 Português",
          es: "🇵🇾 Español",
          gn: "🌿 Guarani",
        })
          .map(
            ([k, lbl]) => `
          <button onclick="window.open('https://wa.me/595${tel.replace(/^0/, "")}?text='+encodeURIComponent('${msgs[k].replace(/'/g, "\\'").replace(/\n/g, "%0A")}'),'_blank');this.closest('[style]').remove()"
            style="background:#f0fff4;border:2px solid #25D366;border-radius:10px;padding:11px 14px;cursor:pointer;text-align:left;font-size:0.88rem;font-weight:600;color:#155c24;transition:all .15s"
            onmouseover="this.style.background='#25D366';this.style.color='#fff'"
            onmouseout="this.style.background='#f0fff4';this.style.color='#155c24'">
            ${lbl}
          </button>`,
          )
          .join("")}
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function confirmarEntregaFuncionario(pedidoId) {
  if (!confirm("Confirmar que este pedido foi entregue ao cliente?")) {
    return;
  }

  try {
    const { error } = await supa
      .from("pedidos")
      .update({
        status: "entregue",
        entrega_confirmada_em: new Date().toISOString(),
        confirmacao_tipo: "funcionario",
      })
      .eq("id", pedidoId);

    if (error) throw error;

    alert("✅ Entrega confirmada com sucesso!");
    carregarPedidos();
  } catch (err) {
    console.error("Erro ao confirmar entrega:", err);
    alert("Erro ao confirmar entrega");
  }
}

async function fecharTodasMesas() {
  const { data, error } = await supa
    .from("pedidos")
    .select("id, cliente_nome, tipo_entrega, status")
    .in("status", ["pendente", "em_preparo", "pronto_entrega", "saiu_entrega"])
    .in("tipo_entrega", ["balcao", "retirada", "local"]);
  if (error || !data || data.length === 0) {
    alert("Nenhum pedido de Mesa/Retirada/Local em aberto.");
    return;
  }
  const lista = data
    .map((p) => `#${p.id} — ${p.cliente_nome || "Mesa"} (${p.tipo_entrega})`)
    .join("\n");
  if (
    !confirm(`Baixar ${data.length} pedido(s) Mesa/Retirada/Local?\n\n${lista}`)
  )
    return;
  const now = new Date().toISOString();
  const { error: err } = await supa
    .from("pedidos")
    .update({ status: "entregue", tempo_entregue: now })
    .in(
      "id",
      data.map((p) => p.id),
    );
  if (err) {
    alert("Erro: " + err.message);
    return;
  }
  alert(`✅ ${data.length} pedido(s) baixado(s)!`);
  carregarPedidos();
  carregarMonitorMesas();
  if (typeof calcularFinanceiro === "function") calcularFinanceiro();
}

async function baixarTodosNaoDelivery() {
  const { data, error } = await supa
    .from("pedidos")
    .select("id, cliente_nome, status")
    .in("status", ["saiu_entrega", "pronto_entrega"])
    .eq("tipo_entrega", "delivery");
  if (error || !data || data.length === 0) {
    alert("Nenhum delivery para confirmar entrega.");
    return;
  }
  const lista = data
    .map((p) => `#${p.id} — ${p.cliente_nome || "Cliente"}`)
    .join("\n");
  if (!confirm(`Confirmar entrega de ${data.length} delivery(s)?\n\n${lista}`))
    return;
  const now = new Date().toISOString();
  const { error: err } = await supa
    .from("pedidos")
    .update({
      status: "entregue",
      tempo_entregue: now,
      entrega_confirmada_em: now,
      confirmacao_tipo: "massa",
    })
    .in(
      "id",
      data.map((p) => p.id),
    );
  if (err) {
    alert("Erro: " + err.message);
    return;
  }
  alert(`✅ ${data.length} delivery(s) confirmado(s)!`);
  carregarPedidos();
  if (typeof calcularFinanceiro === "function") calcularFinanceiro();
}

let graficoInstance = null;

// ===== ABRIR MODAL DE GRÁFICOS =====
function abrirGraficos() {
  const modal = document.getElementById("modal-graficos");
  if (!modal) {
    console.error("Modal de gráficos não encontrado");
    return;
  }
  modal.style.display = "flex";

  // Carrega dados padrão de 7 dias
  carregarDadosGrafico("7");
}

// ===== CARREGAR DADOS DO GRÁFICO =====
async function carregarDadosGrafico(dias) {
  try {
    // Atualiza botões visuais
    document.querySelectorAll(".btn-periodo").forEach((btn) => {
      const btnDias = btn.getAttribute("data-dias");
      if (btnDias === dias) {
        btn.style.background = "#8e44ad";
        btn.style.color = "#fff";
      } else {
        btn.style.background = "#bdc3c7";
        btn.style.color = "#333";
      }
    });

    // Calcula data de início
    const dataFim = new Date();
    const dataInicio = new Date();
    dataInicio.setDate(dataInicio.getDate() - parseInt(dias));

    // Busca pedidos no período
    const { data: pedidos, error } = await supa
      .from("pedidos")
      .select("*")
      .gte("created_at", dataInicio.toISOString())
      .lte("created_at", dataFim.toISOString())
      .neq("status", "cancelado");

    if (error) throw error;

    // Processa dados
    processarDadosGrafico(pedidos, dias);
  } catch (err) {
    console.error("Erro ao carregar dados do gráfico:", err);
    alert("Erro ao carregar gráfico");
  }
}

// ===== PROCESSAR E EXIBIR DADOS =====
function processarDadosGrafico(pedidos, dias) {
  // Agrupa vendas por dia
  const vendasPorDia = {};
  let totalPeriodo = 0;

  pedidos.forEach((p) => {
    const data = new Date(p.created_at).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
    });
    const valor = p.total_geral || 0;
    vendasPorDia[data] = (vendasPorDia[data] || 0) + valor;
    totalPeriodo += valor;
  });

  // Ordena por data
  const datasOrdenadas = Object.keys(vendasPorDia).sort((a, b) => {
    const [diaA, mesA] = a.split("/");
    const [diaB, mesB] = b.split("/");
    return new Date(2024, mesA - 1, diaA) - new Date(2024, mesB - 1, diaB);
  });

  const valores = datasOrdenadas.map((d) => vendasPorDia[d]);

  // Calcula estatísticas
  const mediaPorDia = totalPeriodo / parseInt(dias);
  const melhorValor = Math.max(...valores);
  const piorValor = Math.min(...valores);
  const melhorDia = datasOrdenadas[valores.indexOf(melhorValor)];
  const piorDia = datasOrdenadas[valores.indexOf(piorValor)];

  // Atualiza cards
  document.getElementById("graf-total-periodo").textContent =
    `Gs ${totalPeriodo.toLocaleString("es-PY")}`;
  document.getElementById("graf-media-dia").textContent =
    `Gs ${Math.round(mediaPorDia).toLocaleString("es-PY")}`;
  document.getElementById("graf-melhor-dia").textContent =
    `${melhorDia} - Gs ${melhorValor.toLocaleString("es-PY")}`;
  document.getElementById("graf-pior-dia").textContent =
    `${piorDia} - Gs ${piorValor.toLocaleString("es-PY")}`;

  // Gera cores das barras
  const cores = valores.map((v) => {
    if (v === melhorValor) return "#27ae60"; // Verde para melhor
    if (v === piorValor) return "#e74c3c"; // Vermelho para pior
    return "#3498db"; // Azul para demais
  });

  // Renderiza gráfico
  renderizarGrafico(datasOrdenadas, valores, cores);
}

// ══════════════════════════════════════════════════════════════════════
//  ESTATÍSTICAS DE VENDAS
// ══════════════════════════════════════════════════════════════════════

let _estChart = null;
let _estDados = [];
let _estCategorias = [];

function initEstatisticas() {
  // Define datas padrão: últimos 30 dias
  const hoje = new Date();
  const ini = new Date(hoje);
  ini.setDate(ini.getDate() - 30);
  const fmt = (d) => d.toISOString().split("T")[0];
  const iniEl = document.getElementById("est-ini");
  const fimEl = document.getElementById("est-fim");
  if (iniEl && !iniEl.value) iniEl.value = fmt(ini);
  if (fimEl && !fimEl.value) fimEl.value = fmt(hoje);
  gerarEstatisticas();
}

async function _estPopularCategorias() {
  const sel = document.getElementById("est-filtro-cat");
  if (!sel || sel.options.length > 1) return;
  try {
    const { data } = await supa
      .from("categorias")
      .select("slug, nome")
      .order("nome");
    (data || []).forEach((c) => {
      const o = document.createElement("option");
      o.value = c.slug;
      o.textContent = c.nome;
      sel.appendChild(o);
    });
  } catch (_) {}
}

async function gerarEstatisticas() {
  const loading = document.getElementById("est-loading");
  if (loading) loading.style.display = "flex";

  const ini = document.getElementById("est-ini")?.value;
  const fim = document.getElementById("est-fim")?.value;

  try {
    let query = supa
      .from("pedidos")
      .select("itens, total_geral, subtotal, created_at")
      .eq("status", "entregue");
    if (ini) query = query.gte("created_at", ini + "T00:00:00");
    if (fim) query = query.lte("created_at", fim + "T23:59:59");
    const { data, error } = await query;
    if (error) throw error;

    // Agrega por produto
    const mapa = {};
    let faturamentoTotal = 0;
    let totalPedidos = (data || []).length;

    (data || []).forEach((ped) => {
      faturamentoTotal += ped.total_geral || ped.subtotal || 0;
      (Array.isArray(ped.itens) ? ped.itens : []).forEach((item) => {
        const nome = item.nome || item.n || "Produto";
        const preco = item.preco || item.p || 0;
        const qtd = item.qtd || item.q || 1;
        const cat = item.categoria_slug || item.cat || "";
        const unid = item.unidade_venda || item.unid || "un";
        if (!mapa[nome])
          mapa[nome] = { nome, preco, cat, unid, qtd: 0, fat: 0 };
        mapa[nome].qtd += qtd;
        mapa[nome].fat += preco * qtd;
      });
    });

    _estDados = Object.values(mapa).sort((a, b) => b.fat - a.fat);

    // KPIs
    const ticket =
      totalPedidos > 0 ? Math.round(faturamentoTotal / totalPedidos) : 0;
    const lucroEst = Math.round(faturamentoTotal * 0.3); // estimado 30%
    const setKpi = (id, v) => {
      const el = document.getElementById(id);
      if (el) el.textContent = v;
    };
    setKpi(
      "est-kpi-faturamento",
      "Gs " + faturamentoTotal.toLocaleString("es-PY"),
    );
    setKpi("est-kpi-ticket", "Gs " + ticket.toLocaleString("es-PY"));
    setKpi("est-kpi-lucro", "Gs " + lucroEst.toLocaleString("es-PY"));
    setKpi("est-kpi-pedidos", totalPedidos.toLocaleString("es-PY"));

    estAplicarFiltros();
  } catch (e) {
    alert("Erro ao carregar estatísticas: " + e.message);
  } finally {
    if (loading) loading.style.display = "none";
  }
}

function estAplicarFiltros() {
  const cat = document.getElementById("est-filtro-cat")?.value || "";
  const unid = document.getElementById("est-filtro-unidade")?.value || "";
  let lista = _estDados.slice();
  if (cat) lista = lista.filter((p) => p.cat === cat);
  if (unid) lista = lista.filter((p) => p.unid === unid);

  // Gráfico top 15
  const top15 = lista.slice(0, 15);
  _estDesenharGrafico(top15);

  // Tabela completa
  const tbody = document.getElementById("est-tabela-body");
  if (!tbody) return;
  if (!lista.length) {
    tbody.innerHTML =
      '<tr><td colspan="5" style="text-align:center;color:#aaa;padding:20px">Nenhum dado no período</td></tr>';
    return;
  }
  tbody.innerHTML = lista
    .map((p) => {
      const markup =
        p.preco > 0
          ? Math.round((p.fat / (p.preco * p.qtd * 0.6) - 1) * 100)
          : 0;
      return `<tr>
      <td style="font-weight:600">${p.nome}</td>
      <td style="color:#888;font-size:0.82rem">${p.cat || "—"}</td>
      <td style="text-align:center">${p.unid === "kg" ? p.qtd.toFixed(3) + " kg" : p.qtd + " un"}</td>
      <td style="text-align:center;color:${markup > 0 ? "#16a34a" : "#888"}">${markup > 0 ? markup + "%" : "—"}</td>
      <td style="text-align:right;font-weight:700;color:#1a7a2e">Gs ${p.fat.toLocaleString("es-PY")}</td>
    </tr>`;
    })
    .join("");
}

function _estDesenharGrafico(dados) {
  const canvas = document.getElementById("est-grafico");
  if (!canvas) return;
  if (_estChart) {
    _estChart.destroy();
    _estChart = null;
  }
  if (!dados.length) return;
  const ctx = canvas.getContext("2d");
  _estChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: dados.map((p) =>
        p.nome.length > 20 ? p.nome.slice(0, 18) + "…" : p.nome,
      ),
      datasets: [
        {
          label: "Faturamento (Gs)",
          data: dados.map((p) => p.fat),
          backgroundColor: "rgba(26,122,46,0.75)",
          borderRadius: 6,
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => "Gs " + ctx.parsed.y.toLocaleString("es-PY"),
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { callback: (v) => "Gs " + (v / 1000).toFixed(0) + "k" },
        },
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
      },
    },
  });
}

// ══════════════════════════════════════════════════════════════════════
//  FICHA TÉCNICA — init stub (lógica real já existe via ftMostrarPanel)
// ══════════════════════════════════════════════════════════════════════

function initFichaTecnica() {
  ftMostrarPanel("insumos");
}

// ══════════════════════════════════════════════════════════════════════
//  CRM — Clientes & Cashback
// ══════════════════════════════════════════════════════════════════════

let _crmClientes = [];
let _crmAbaAtual = "todos";
let _crmCashbackPct = 2;
let _crmCashbackVal = 30;

async function initCRM() {
  await _crmCarregarConfig();
  await _crmCarregarClientes();
}

async function _crmCarregarConfig() {
  try {
    const { data } = await supa
      .from("configuracoes")
      .select("cashback_pct, cashback_validade_dias")
      .maybeSingle();
    if (data) {
      _crmCashbackPct = data.cashback_pct ?? 2;
      _crmCashbackVal = data.cashback_validade_dias ?? 30;
      const pctEl = document.getElementById("crm-cfg-pct");
      const valEl = document.getElementById("crm-cfg-val");
      if (pctEl) pctEl.value = _crmCashbackPct;
      if (valEl) valEl.value = _crmCashbackVal;
    }
  } catch (_) {}
}

async function crmSalvarConfig() {
  const pct = parseFloat(document.getElementById("crm-cfg-pct")?.value) || 0;
  const val = parseInt(document.getElementById("crm-cfg-val")?.value) || 30;
  try {
    await supa
      .from("configuracoes")
      .update({ cashback_pct: pct, cashback_validade_dias: val })
      .gt("id", 0);
    _crmCashbackPct = pct;
    _crmCashbackVal = val;
    alert("✅ Configurações de cashback salvas!");
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

async function _crmCarregarClientes() {
  try {
    const { data, error } = await supa
      .from("clientes")
      .select(
        "id, nome, telefone, nascimento, cashback_saldo, total_gasto, created_at",
      )
      .order("nome");
    if (error) throw error;
    _crmClientes = data || [];
    _crmAtualizarKPIs();
    _crmRenderizarAniversariantes();
    crmMudarAba(_crmAbaAtual);
  } catch (e) {
    const tbody = document.getElementById("crm-lista-clientes");
    if (tbody)
      tbody.innerHTML = `<tr><td colspan="6" style="color:#e74c3c;padding:20px;text-align:center">Erro: ${e.message}</td></tr>`;
  }
}

function _crmAtualizarKPIs() {
  const total = _crmClientes.length;
  const comSaldo = _crmClientes.filter(
    (c) => (c.cashback_saldo || 0) > 0,
  ).length;
  const cashTot = _crmClientes.reduce((s, c) => s + (c.cashback_saldo || 0), 0);
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set("crm-kpi-total", total);
  set("crm-kpi-comSaldo", comSaldo);
  set("crm-kpi-cashback", "Gs " + cashTot.toLocaleString("es-PY"));
}

function _crmRenderizarAniversariantes() {
  const el = document.getElementById("crm-widget-aniversariantes");
  if (!el) return;
  const hoje = new Date();
  const mm = hoje.getMonth() + 1;
  const dd = hoje.getDate();
  const aniv = _crmClientes.filter((c) => {
    if (!c.nascimento) return false;
    const [, m, d] = c.nascimento.split("-");
    return parseInt(m) === mm && parseInt(d) === dd;
  });
  el.innerHTML = aniv.length
    ? aniv
        .map(
          (c) =>
            `<div>🎂 <b>${c.nome}</b> <span style="color:#888">${c.telefone || ""}</span></div>`,
        )
        .join("")
    : '<span style="color:#aaa;font-size:0.8rem">Nenhum aniversariante hoje</span>';
}

function crmMudarAba(aba) {
  _crmAbaAtual = aba;
  document
    .querySelectorAll(".crm-aba-btn")
    .forEach((b) => b.classList.remove("active"));
  const btn = document.getElementById(`crm-aba-${aba}`);
  if (btn) btn.classList.add("active");
  crmFiltrarClientes(
    document.querySelector("#crm input[type=text]")?.value || "",
  );
}

function crmFiltrarClientes(busca) {
  busca = (busca || "").toLowerCase();
  const hoje = new Date();
  const mm = hoje.getMonth() + 1;
  let lista = _crmClientes.slice();
  if (_crmAbaAtual === "aniversariantes") {
    lista = lista.filter((c) => {
      if (!c.nascimento) return false;
      const [, m] = c.nascimento.split("-");
      return parseInt(m) === mm;
    });
  }
  if (busca) {
    lista = lista.filter(
      (c) =>
        (c.nome || "").toLowerCase().includes(busca) ||
        (c.telefone || "").includes(busca),
    );
  }
  _crmRenderizarTabela(lista);
}

function _crmRenderizarTabela(lista) {
  const tbody = document.getElementById("crm-lista-clientes");
  if (!tbody) return;
  if (!lista.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:#aaa;padding:24px">Nenhum cliente encontrado</td></tr>';
    return;
  }
  tbody.innerHTML = lista
    .map((c) => {
      const saldo = (c.cashback_saldo || 0).toLocaleString("es-PY");
      const gasto = (c.total_gasto || 0).toLocaleString("es-PY");
      const nasc = c.nascimento
        ? new Date(c.nascimento + "T12:00:00").toLocaleDateString("pt-BR")
        : "—";
      return `<tr>
      <td style="font-weight:600">${c.nome || "—"}</td>
      <td>${c.telefone || "—"}</td>
      <td>${nasc}</td>
      <td style="color:${c.cashback_saldo > 0 ? "#27ae60" : "#aaa"};font-weight:700">Gs ${saldo}</td>
      <td>Gs ${gasto}</td>
      <td style="text-align:center">
        <button onclick="crmAbrirModalCliente(${c.id})"
          style="padding:5px 10px;background:#e8f5e9;color:#1a7a2e;border:1px solid #a5d6a7;border-radius:6px;cursor:pointer;font-size:0.75rem;font-weight:700;margin-right:4px">
          ✏️ Editar
        </button>
        <button onclick="crmAbrirHistorico(${c.id})"
          style="padding:5px 10px;background:#e3f2fd;color:#1565c0;border:1px solid #90caf9;border-radius:6px;cursor:pointer;font-size:0.75rem;font-weight:700">
          📋 Histórico
        </button>
      </td>
    </tr>`;
    })
    .join("");
}

function crmAbrirModalCliente(id = null) {
  const cli = id ? _crmClientes.find((c) => c.id === id) : null;
  document.getElementById("crm-cli-id").value = cli?.id || "";
  document.getElementById("crm-cli-nome").value = cli?.nome || "";
  document.getElementById("crm-cli-tel").value = cli?.telefone || "";
  document.getElementById("crm-cli-nasc").value = cli?.nascimento || "";
  document.getElementById("crm-cli-saldo").value = cli?.cashback_saldo || 0;
  const modal = document.getElementById("modal-crm-cliente");
  if (modal) modal.style.display = "flex";
}

async function crmSalvarCliente() {
  const id = document.getElementById("crm-cli-id").value;
  const dados = {
    nome: document.getElementById("crm-cli-nome").value.trim(),
    telefone: document.getElementById("crm-cli-tel").value.trim(),
    nascimento: document.getElementById("crm-cli-nasc").value || null,
    cashback_saldo:
      parseFloat(document.getElementById("crm-cli-saldo").value) || 0,
  };
  if (!dados.nome) {
    alert("⚠️ Nome é obrigatório.");
    return;
  }
  try {
    if (id) {
      await supa.from("clientes").update(dados).eq("id", id);
    } else {
      await supa.from("clientes").insert([dados]);
    }
    fecharModal("modal-crm-cliente");
    await _crmCarregarClientes();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

async function crmAbrirHistorico(clienteId) {
  const modal = document.getElementById("modal-crm-hist");
  if (!modal) return;
  const tbody = document.getElementById("crm-hist-body");
  if (tbody)
    tbody.innerHTML =
      '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:20px">Carregando...</td></tr>';
  modal.style.display = "flex";
  try {
    const { data } = await supa
      .from("pedidos")
      .select("id, created_at, total_geral, forma_pagamento, status")
      .eq("cliente_id", clienteId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (tbody) {
      tbody.innerHTML = (data || []).length
        ? (data || [])
            .map(
              (p) => `<tr>
            <td>${new Date(p.created_at).toLocaleDateString("pt-BR")}</td>
            <td>${p.forma_pagamento || "—"}</td>
            <td>${p.status || "—"}</td>
            <td style="font-weight:700">Gs ${(p.total_geral || 0).toLocaleString("es-PY")}</td>
          </tr>`,
            )
            .join("")
        : '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:20px">Nenhum pedido encontrado</td></tr>';
    }
  } catch (e) {
    if (tbody)
      tbody.innerHTML = `<tr><td colspan="4" style="color:#e74c3c;padding:20px">Erro: ${e.message}</td></tr>`;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  FILIAIS / SUCURSALES
// ══════════════════════════════════════════════════════════════════════

let _filiais = [];

async function initFiliais() {
  await _filiaisCarregar();
  await _filiaisCarregarUsuarios();
}

async function _filiaisCarregar() {
  try {
    const { data } = await supa.from("filiais").select("*").order("nome");
    _filiais = data || [];
    _filiaisRenderizar(_filiais);
  } catch (e) {
    const el = document.getElementById("filiais-lista");
    if (el)
      el.innerHTML = `<div style="color:#e74c3c;padding:20px">Erro: ${e.message}</div>`;
  }
}

function _filiaisRenderizar(lista) {
  const el = document.getElementById("filiais-lista");
  if (!el) return;
  if (!lista.length) {
    el.innerHTML =
      '<div style="text-align:center;color:#aaa;padding:32px">Nenhuma sucursal cadastrada</div>';
    return;
  }
  const statusLabel = {
    ativa: "✅ Activa",
    inativa: "⛔ Inactiva",
    manutencao: "🔧 Mantenimiento",
  };
  el.innerHTML = lista
    .map(
      (f) => `
    <div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px 20px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
      <div>
        <div style="font-weight:700;font-size:1rem">${f.nome}</div>
        <div style="color:#6b7280;font-size:0.83rem">${f.endereco || ""}</div>
        <div style="font-size:0.8rem;margin-top:4px">${statusLabel[f.status] || f.status}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="abrirModalFilial(${f.id})"
          style="padding:7px 14px;background:#e8f5e9;color:#1a7a2e;border:1px solid #a5d6a7;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.8rem">
          ✏️ Editar
        </button>
        <button onclick="excluirFilial(${f.id})"
          style="padding:7px 14px;background:#fef2f2;color:#e74c3c;border:1px solid #fca5a5;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.8rem">
          🗑️
        </button>
      </div>
    </div>`,
    )
    .join("");
}

async function _filiaisCarregarUsuarios() {
  try {
    const { data } = await supa
      .from("perfis")
      .select("id, nome, email, perfil, ativo, filial_id")
      .order("nome");
    const tbody = document.getElementById("filiais-usuarios-body");
    if (!tbody) return;
    if (!(data || []).length) {
      tbody.innerHTML =
        '<tr><td colspan="5" style="text-align:center;color:#aaa;padding:20px">Sin usuarios</td></tr>';
      return;
    }
    tbody.innerHTML = (data || [])
      .map((u) => {
        const filNome = _filiais.find((f) => f.id === u.filial_id)?.nome || "—";
        return `<tr>
        <td style="padding:12px 16px;font-weight:600">${u.nome || u.email || "—"}</td>
        <td style="padding:12px 16px;font-size:0.82rem;color:#6b7280">${u.perfil || "—"}</td>
        <td style="padding:12px 16px;font-size:0.82rem">${filNome}</td>
        <td style="padding:12px 16px;text-align:center">${u.ativo ? "✅" : "⛔"}</td>
        <td style="padding:12px 16px;text-align:center">
          <button onclick="abrirModalUsuarioAdmin('${u.id}')"
            style="padding:5px 12px;background:#e8f5e9;color:#1a7a2e;border:1px solid #a5d6a7;border-radius:6px;cursor:pointer;font-size:0.75rem;font-weight:700">
            Editar
          </button>
        </td>
      </tr>`;
      })
      .join("");
  } catch (e) {}
}

function abrirModalFilial(id = null) {
  const f = id ? _filiais.find((x) => x.id === id) : null;
  const titulo = document.getElementById("filial-modal-titulo");
  if (titulo) titulo.textContent = f ? "Editar Sucursal" : "Nueva Sucursal";
  document.getElementById("filial-id").value = f?.id || "";
  document.getElementById("filial-nome").value = f?.nome || "";
  document.getElementById("filial-endereco").value = f?.endereco || "";
  document.getElementById("filial-lat").value = f?.lat || "";
  document.getElementById("filial-lng").value = f?.lng || "";
  document.getElementById("filial-whatsapp").value = f?.whatsapp || "";
  document.getElementById("filial-raio").value = f?.raio_km || 10;
  document.getElementById("filial-taxa").value = f?.taxa_frete || 0;
  document.getElementById("filial-status").value = f?.status || "ativa";
  const modal = document.getElementById("modal-filial");
  if (modal) modal.style.display = "flex";
}

async function salvarFilial() {
  const id = document.getElementById("filial-id").value;
  const dados = {
    nome: document.getElementById("filial-nome").value.trim(),
    endereco: document.getElementById("filial-endereco").value.trim(),
    lat: parseFloat(document.getElementById("filial-lat").value) || null,
    lng: parseFloat(document.getElementById("filial-lng").value) || null,
    whatsapp: document.getElementById("filial-whatsapp").value.trim(),
    raio_km: parseFloat(document.getElementById("filial-raio").value) || 10,
    taxa_frete: parseFloat(document.getElementById("filial-taxa").value) || 0,
    status: document.getElementById("filial-status").value,
  };
  if (!dados.nome) {
    alert("⚠️ Nome é obrigatório.");
    return;
  }
  try {
    if (id) {
      await supa.from("filiais").update(dados).eq("id", id);
    } else {
      await supa.from("filiais").insert([dados]);
    }
    fecharModal("modal-filial");
    await _filiaisCarregar();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

async function excluirFilial(id) {
  if (!confirm("Excluir esta sucursal?")) return;
  try {
    await supa.from("filiais").delete().eq("id", id);
    await _filiaisCarregar();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

function abrirModalUsuarioAdmin(perfilId) {
  const modal = document.getElementById("modal-filial-usuario");
  if (!modal) return;
  document.getElementById("ua-perfil-id").value = perfilId;
  // Popula select de filiais
  const selFil = document.getElementById("ua-filial");
  if (selFil) {
    selFil.innerHTML =
      '<option value="">— Sem filial —</option>' +
      _filiais
        .map((f) => `<option value="${f.id}">${f.nome}</option>`)
        .join("");
  }
  modal.style.display = "flex";
}

function onRoleChange() {
  const role = document.getElementById("ua-role")?.value;
  const row = document.getElementById("ua-filial-row");
  if (row)
    row.style.display =
      role === "adminMaster" || role === "gerente" ? "none" : "";
}

async function salvarUsuarioAdmin() {
  const id = document.getElementById("ua-perfil-id").value;
  const dados = {
    nome: document.getElementById("ua-nome")?.value.trim(),
    perfil: document.getElementById("ua-role")?.value,
    filial_id: document.getElementById("ua-filial")?.value || null,
    ativo: document.getElementById("ua-ativo")?.checked ?? true,
  };
  try {
    await supa.from("perfis").update(dados).eq("id", id);
    fecharModal("modal-filial-usuario");
    await _filiaisCarregarUsuarios();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  MENSALISTAS / PLANOS
// ══════════════════════════════════════════════════════════════════════

let _mensPlanos = [];
let _mensFiltrado = [];

async function initMensalistas() {
  await _mensCarregarPlanos();
  await _mensPopularSelects();
}

async function _mensCarregarPlanos() {
  const loading = document.getElementById("mens-loading");
  if (loading) loading.style.display = "flex";
  try {
    const { data, error } = await supa
      .from("planos_mensalistas")
      .select("*, clientes(nome, telefone)")
      .order("created_at", { ascending: false });
    if (error) throw error;
    _mensPlanos = data || [];
    _mensAtualizarKPIs();
    mensFiltrar();
  } catch (e) {
    const el = document.getElementById("mens-lista-planos");
    if (el)
      el.innerHTML = `<div style="color:#e74c3c;padding:20px">Erro: ${e.message}<br><small>Verifique se a tabela "planos_mensalistas" existe no Supabase.</small></div>`;
  } finally {
    if (loading) loading.style.display = "none";
  }
}

function _mensAtualizarKPIs() {
  const total = _mensPlanos.length;
  const ativos = _mensPlanos.filter((p) => p.ativo).length;
  const receita = _mensPlanos
    .filter((p) => p.ativo)
    .reduce((s, p) => s + (p.valor || 0), 0);
  const itens = _mensPlanos
    .filter((p) => p.ativo)
    .reduce((s, p) => s + ((p.qtd_total || 0) - (p.qtd_usada || 0)), 0);
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set("mens-kpi-total", total);
  set("mens-kpi-ativos", ativos);
  set("mens-kpi-receita", "Gs " + receita.toLocaleString("es-PY"));
  set("mens-kpi-itens", itens);
}

function mensFiltrar() {
  const busca = (
    document.getElementById("mens-busca")?.value || ""
  ).toLowerCase();
  const status =
    document.getElementById("mens-filtro-status")?.value || "todos";
  _mensFiltrado = _mensPlanos.filter((p) => {
    const nome = (p.clientes?.nome || "").toLowerCase();
    const tel = p.clientes?.telefone || "";
    const produto = (p.produto || "").toLowerCase();
    const matchB =
      !busca ||
      nome.includes(busca) ||
      tel.includes(busca) ||
      produto.includes(busca);
    const matchS =
      status === "todos" ||
      (status === "ativo" && p.ativo) ||
      (status === "inativo" && !p.ativo);
    return matchB && matchS;
  });
  _mensRenderizar(_mensFiltrado);
}

function _mensRenderizar(lista) {
  const el = document.getElementById("mens-lista-planos");
  if (!el) return;
  if (!lista.length) {
    el.innerHTML =
      '<div style="text-align:center;color:#aaa;padding:32px">Nenhum plano encontrado</div>';
    return;
  }
  el.innerHTML = lista
    .map((p) => {
      const restante = (p.qtd_total || 0) - (p.qtd_usada || 0);
      const pct =
        p.qtd_total > 0
          ? Math.round(((p.qtd_usada || 0) / p.qtd_total) * 100)
          : 0;
      const barColor =
        pct >= 90 ? "#e74c3c" : pct >= 60 ? "#f39c12" : "#1a7a2e";
      const fim = p.data_fim
        ? new Date(p.data_fim + "T12:00:00").toLocaleDateString("pt-BR")
        : "—";
      return `<div style="background:#fff;border:1.5px solid ${p.ativo ? "#e5e7eb" : "#fca5a5"};border-radius:14px;padding:18px 20px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-weight:800;font-size:1rem">${p.clientes?.nome || "—"}</div>
          <div style="color:#6b7280;font-size:0.82rem">${p.clientes?.telefone || ""} • ${p.produto || "—"}</div>
          <div style="font-size:0.8rem;margin-top:4px;color:#555">Vence: ${fim} • Gs ${(p.valor || 0).toLocaleString("es-PY")}</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button onclick="mensAbrirEntrega(${p.id})"
            style="padding:6px 12px;background:#e8f5e9;color:#1a7a2e;border:1px solid #a5d6a7;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.78rem">
            📦 Entregar
          </button>
          <button onclick="mensAbrirHistorico(${p.id})"
            style="padding:6px 12px;background:#e3f2fd;color:#1565c0;border:1px solid #90caf9;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.78rem">
            📋 Histórico
          </button>
          <button onclick="mensAbrirModalPlano(${p.id})"
            style="padding:6px 12px;background:#f9fafb;color:#4b5563;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer;font-weight:700;font-size:0.78rem">
            ✏️
          </button>
        </div>
      </div>
      <div style="margin-top:12px">
        <div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:4px">
          <span>${p.qtd_usada || 0} / ${p.qtd_total || 0} itens usados</span>
          <span style="color:${barColor};font-weight:700">${restante} restantes</span>
        </div>
        <div style="background:#f3f4f6;border-radius:4px;height:8px">
          <div style="background:${barColor};width:${pct}%;height:8px;border-radius:4px;transition:width 0.3s"></div>
        </div>
      </div>
    </div>`;
    })
    .join("");
}

async function _mensPopularSelects() {
  // Clientes
  try {
    const { data: clis } = await supa
      .from("clientes")
      .select("id, nome")
      .order("nome");
    const selCli = document.getElementById("mens-plano-cli-sel");
    if (selCli) {
      selCli.innerHTML =
        '<option value="">— Selecione o cliente —</option>' +
        (clis || [])
          .map((c) => `<option value="${c.id}">${c.nome}</option>`)
          .join("");
    }
  } catch (_) {}
  // Produtos
  try {
    const { data: prods } = await supa
      .from("produtos")
      .select("id, nome")
      .order("nome");
    const selProd = document.getElementById("mens-plano-prod-sel");
    if (selProd) {
      selProd.innerHTML =
        '<option value="">— Selecione do cardápio —</option>' +
        (prods || [])
          .map((p) => `<option value="${p.id}">${p.nome}</option>`)
          .join("");
      selProd.onchange = function () {
        const nome = this.options[this.selectedIndex]?.text || "";
        const inp = document.getElementById("mens-plano-produto");
        if (inp && nome && nome !== "— Selecione do cardápio —")
          inp.value = nome;
      };
    }
  } catch (_) {}
}

async function mensAbrirModalPlano(id = null) {
  const p = id ? _mensPlanos.find((x) => x.id === id) : null;
  document.getElementById("mens-plano-id").value = p?.id || "";
  document.getElementById("mens-plano-cli-id").value = p?.cliente_id || "";
  document.getElementById("mens-plano-produto").value = p?.produto || "";
  document.getElementById("mens-plano-qtd").value = p?.qtd_total || "";
  document.getElementById("mens-plano-valor").value = p?.valor || "";
  document.getElementById("mens-plano-ini").value =
    p?.data_inicio?.split("T")[0] || "";
  document.getElementById("mens-plano-fim").value =
    p?.data_fim?.split("T")[0] || "";
  document.getElementById("mens-plano-ativo").checked = p
    ? (p.ativo ?? true)
    : true;
  if (p?.cliente_id) {
    const sel = document.getElementById("mens-plano-cli-sel");
    if (sel) sel.value = p.cliente_id;
  }
  const renovInfo = document.getElementById("mens-renov-info");
  if (renovInfo && p) {
    renovInfo.innerHTML = `<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:10px 14px;font-size:0.8rem;margin-bottom:14px">
      Usados: <b>${p.qtd_usada || 0}</b> / ${p.qtd_total || 0} itens
    </div>`;
  } else if (renovInfo) {
    renovInfo.innerHTML = "";
  }
  await _mensPopularSelects();
  const modal = document.getElementById("modal-mens-plano");
  if (modal) modal.style.display = "flex";
}

async function mensSalvarPlano() {
  const id = document.getElementById("mens-plano-id").value;
  const cliSel = document.getElementById("mens-plano-cli-sel")?.value;
  const cliId = cliSel || document.getElementById("mens-plano-cli-id").value;
  const produto = document.getElementById("mens-plano-produto").value.trim();
  const qtd = parseInt(document.getElementById("mens-plano-qtd").value) || 0;
  const valor =
    parseFloat(document.getElementById("mens-plano-valor").value) || 0;
  if (!cliId) {
    alert("⚠️ Selecione o cliente.");
    return;
  }
  if (!produto) {
    alert("⚠️ Informe o produto.");
    return;
  }
  if (qtd <= 0) {
    alert("⚠️ Quantidade inválida.");
    return;
  }
  const dados = {
    cliente_id: parseInt(cliId),
    produto,
    qtd_total: qtd,
    valor,
    data_inicio: document.getElementById("mens-plano-ini").value || null,
    data_fim: document.getElementById("mens-plano-fim").value || null,
    ativo: document.getElementById("mens-plano-ativo").checked,
    ...(id ? {} : { qtd_usada: 0 }),
  };
  try {
    if (id) {
      await supa.from("planos_mensalistas").update(dados).eq("id", id);
    } else {
      await supa.from("planos_mensalistas").insert([dados]);
    }
    fecharModal("modal-mens-plano");
    await _mensCarregarPlanos();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

function mensAbrirEntrega(planoId) {
  const p = _mensPlanos.find((x) => x.id === planoId);
  if (!p) return;
  document.getElementById("mens-ent-plano-id").value = planoId;
  document.getElementById("mens-ent-cliente").textContent =
    p.clientes?.nome || "—";
  document.getElementById("mens-ent-tel").textContent =
    p.clientes?.telefone || "";
  document.getElementById("mens-ent-produto").textContent = p.produto || "—";
  const rest = (p.qtd_total || 0) - (p.qtd_usada || 0);
  document.getElementById("mens-ent-saldo").textContent = `${rest} disponíveis`;
  const valorUnit = p.qtd_total > 0 ? Math.round(p.valor / p.qtd_total) : 0;
  document.getElementById("mens-ent-valor-unit").textContent =
    valorUnit > 0 ? `Gs ${valorUnit.toLocaleString("es-PY")}/item` : "";
  document.getElementById("mens-ent-qtd").value = 1;
  document.getElementById("mens-ent-obs").value = "";
  const modal = document.getElementById("modal-mens-entrega");
  if (modal) modal.style.display = "flex";
}

async function mensSalvarEntrega() {
  const planoId = parseInt(document.getElementById("mens-ent-plano-id").value);
  const qtd = parseInt(document.getElementById("mens-ent-qtd").value) || 1;
  const obs = document.getElementById("mens-ent-obs").value.trim();
  const plano = _mensPlanos.find((p) => p.id === planoId);
  if (!plano) return;
  const restante = (plano.qtd_total || 0) - (plano.qtd_usada || 0);
  if (qtd > restante) {
    alert(`⚠️ Só restam ${restante} itens no plano.`);
    return;
  }
  try {
    const novaUsada = (plano.qtd_usada || 0) + qtd;
    await supa
      .from("planos_mensalistas")
      .update({ qtd_usada: novaUsada })
      .eq("id", planoId);
    // Registra no histórico se a tabela existir
    try {
      await supa.from("planos_entregas").insert([
        {
          plano_id: planoId,
          cliente_id: plano.cliente_id,
          qtd,
          obs,
          data: new Date().toISOString(),
        },
      ]);
    } catch (_) {
      /* tabela pode não existir */
    }
    fecharModal("modal-mens-entrega");
    await _mensCarregarPlanos();
    alert(`✅ ${qtd} item(s) entregue(s) com sucesso!`);
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

async function mensAbrirHistorico(planoId) {
  const p = _mensPlanos.find((x) => x.id === planoId);
  const modal = document.getElementById("modal-mens-hist");
  if (!modal) return;
  document.getElementById("mens-hist-nome").textContent =
    p?.clientes?.nome || "—";
  document.getElementById("mens-hist-produto").textContent = p?.produto || "—";
  document.getElementById("mens-hist-plano-total").textContent =
    p?.qtd_total || 0;
  const rest = (p?.qtd_total || 0) - (p?.qtd_usada || 0);
  document.getElementById("mens-hist-plano-rest").textContent = rest;
  document.getElementById("mens-hist-entregues").textContent =
    p?.qtd_usada || 0;
  modal.style.display = "flex";
  const tbody = document.getElementById("mens-hist-tbody");
  if (!tbody) return;
  tbody.innerHTML =
    '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:16px">Carregando...</td></tr>';
  try {
    const { data } = await supa
      .from("planos_entregas")
      .select("*")
      .eq("plano_id", planoId)
      .order("data", { ascending: false });
    tbody.innerHTML = (data || []).length
      ? (data || [])
          .map(
            (e) => `<tr>
          <td style="padding:8px 6px">${new Date(e.data).toLocaleDateString("pt-BR")}</td>
          <td style="text-align:center;padding:8px 6px;font-weight:700">${e.qtd}</td>
          <td style="padding:8px 6px;color:#6b7280">${e.obs || "—"}</td>
          <td style="text-align:center;padding:8px 6px">—</td>
        </tr>`,
          )
          .join("")
      : '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:16px">Nenhuma entrega registrada</td></tr>';
  } catch (_) {
    tbody.innerHTML =
      '<tr><td colspan="4" style="text-align:center;color:#aaa;padding:16px">Histórico não disponível</td></tr>';
  }
}

// ===== RENDERIZAR GRÁFICO COM CHART.JS =====
function renderizarGrafico(labels, data, cores) {
  const canvas = document.getElementById("canvas-grafico");
  if (!canvas) {
    console.error("Canvas do gráfico não encontrado");
    return;
  }

  const ctx = canvas.getContext("2d");

  // Destroi gráfico anterior se existir
  if (graficoInstance) {
    graficoInstance.destroy();
  }

  // Cria novo gráfico
  graficoInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Vendas (Gs)",
          data: data,
          backgroundColor: cores,
          borderWidth: 0,
          borderRadius: 8,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          callbacks: {
            label: function (context) {
              return "Gs " + context.parsed.y.toLocaleString("es-PY");
            },
          },
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: function (value) {
              return "Gs " + (value / 1000).toFixed(0) + "k";
            },
          },
        },
        x: {
          grid: {
            display: false,
          },
        },
      },
    },
  });
}

// ===== FECHAR MODAL (se não existir função genérica) =====
if (typeof fecharModal !== "function") {
  function fecharModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.style.display = "none";
    }
  }
}
/* ══════════════════════════════════════════════════════════════
   HELPERS ESTOQUE + PDV
   ══════════════════════════════════════════════════════════════ */

// 🔧 Torna falhas de estoque visíveis para o operador em vez de silenciosas
// no console (que ninguém abre durante o expediente). Chamar sempre depois
// de _descontarEstoqueVenda / _descontarEstoqueVendaItens / _reporEstoqueCancelamento.
async function _alertarFalhaEstoque(resultado, contexto) {
  if (!resultado || resultado.ok !== false || !resultado.falhas?.length) return;
  const linhas = resultado.falhas
    .map((f) => `• ${f.nome || f.tipo + " #" + f.id}: ${f.motivo}`)
    .join("\n");

  // 🔎 Diagnóstico extra: captura o estado da sessão no exato momento da
  // falha. As policies de RLS em `produtos`/`inventario` liberam tudo para
  // auth.role() = 'authenticated' — então, se o update falhou com "0 linhas
  // afetadas", o suspeito nº1 é a sessão do painel ter expirado/não estar
  // autenticada nesse instante. Isso aparece aqui no console pra confirmar.
  let _sessaoInfo = "não foi possível checar a sessão";
  try {
    const { data: _sess, error: _sessErr } = await supa.auth.getSession();
    if (_sessErr) {
      _sessaoInfo = `erro ao obter sessão: ${_sessErr.message}`;
    } else if (!_sess?.session) {
      _sessaoInfo = "SEM SESSÃO ATIVA (usuário não autenticado / token expirado) — provável causa da falha";
    } else {
      const exp = _sess.session.expires_at
        ? new Date(_sess.session.expires_at * 1000).toLocaleString("pt-BR")
        : "desconhecido";
      _sessaoInfo = `sessão presente, role="${_sess.session.user?.role || "?"}", expira em ${exp}`;
    }
  } catch (e) {
    _sessaoInfo = `exceção ao checar sessão: ${e.message}`;
  }

  console.error(`❌ [Estoque] Falha em "${contexto}":`, resultado.falhas, "| Sessão:", _sessaoInfo);
  alert(
    `⚠️ ATENÇÃO: o pedido foi salvo, mas o estoque NÃO foi atualizado corretamente ` +
    `para ${resultado.falhas.length} item(ns):\n\n${linhas}\n\n` +
    `Diagnóstico da sessão: ${_sessaoInfo}\n\n` +
    `Ajuste o estoque manualmente na tela de Produtos/Estoque. Se o diagnóstico acima ` +
    `indicar sessão expirada, faça login novamente e avise o suporte técnico com este print.`,
  );
}

// Categorias/tipos que NÃO vão para a cozinha (servido imediatamente)
const _TIPOS_SEM_COZINHA = ["acai", "shake", "suco", "sorvete"];

function _todosSemCozinha(itens) {
  if (!itens || !itens.length) return false;
  return itens.every((i) => {
    const cat = (i.categoria_slug || "").toLowerCase();
    const tipo = i._tipo || "";
    return _TIPOS_SEM_COZINHA.some(
      (t) =>
        cat.includes(t) ||
        tipo === t ||
        cat.includes("bebida") ||
        cat.includes("drink"),
    );
  });
}

// Alias mantido para compatibilidade com código existente
function _todosBebidas(itens) {
  return _todosSemCozinha(itens);
}

// Desconta estoque a partir de uma lista de itens (para UPDATE de mesa)
//
// ⚠️ CORREÇÃO — race condition: agora usa a RPC atômica
// `descontar_estoque_atomico` (criada no SQL do Fix 3 anterior).
// Antes fazia SELECT → JS → UPDATE, o que causava race quando dois
// operadores adicionavam itens à mesma mesa simultaneamente.
async function _descontarEstoqueVendaItens(itens) {
  const falhas = [];
  try {
    if (!itens?.length) return { ok: true, falhas };

    // ── Sanitiza IDs ──
    const prodIds = [
      ...new Set(
        itens
          .map((i) => Number(i.produto_id ?? i.id))
          .filter((id) => Number.isInteger(id) && id > 0)
      ),
    ];
    const varIds = [
      ...new Set(
        itens
          .map((i) => Number(i.variacao_id))
          .filter((id) => Number.isInteger(id) && id > 0)
      ),
    ];

    if (!prodIds.length && !varIds.length) return { ok: true, falhas };

    // ── Busca produtos e variações em paralelo ──────────────────
    const [{ data: prods, error: errProds }, { data: variacoes }] =
      await Promise.all([
        prodIds.length
          ? supa.from("produtos")
              .select("id, nome, inventario_id, estoque_qtd")
              .in("id", prodIds)
          : Promise.resolve({ data: [] }),
        varIds.length
          ? supa.from("produto_variacoes")
              .select("id, produto_id, nome, estoque_qtd, controlar_estoque")
              .in("id", varIds)
          : Promise.resolve({ data: [] }),
      ]);

    if (errProds) {
      falhas.push({ tipo: "query_produtos", motivo: errProds.message });
      return { ok: false, falhas };
    }

    const getQtd = (item) =>
      parseInt(item.qtd ?? item.q ?? item.quantidade ?? 1) || 1;

    // ── 1. Desconto em variações ────────────────────────────────
    const mapaVariacoes = {};
    (variacoes || []).forEach((v) => { mapaVariacoes[v.id] = v; });

    const qtdPorVariacao = {};
    itens.forEach((item) => {
      const vid = Number(item.variacao_id);
      if (!Number.isInteger(vid) || vid <= 0) return;
      qtdPorVariacao[vid] = (qtdPorVariacao[vid] || 0) + getQtd(item);
    });

    for (const [vid, qtd] of Object.entries(qtdPorVariacao)) {
      const v = mapaVariacoes[vid];
      if (!v) {
        falhas.push({ tipo: "variacao", id: vid, motivo: "Variação não encontrada" });
        continue;
      }
      if (v.controlar_estoque === false) continue;

      const { data: fresh } = await supa
        .from("produto_variacoes").select("estoque_qtd").eq("id", vid).single();
      const atual = fresh?.estoque_qtd ?? v.estoque_qtd ?? 0;
      const { data: _r, error: _e } = await supa
        .from("produto_variacoes")
        .update({ estoque_qtd: Math.max(0, atual - qtd) })
        .eq("id", vid).select("id");
      if (_e || !_r?.length) {
        falhas.push({
          tipo: "variacao", id: vid, nome: v.nome,
          motivo: _e?.message || "0 linhas afetadas",
        });
      }
    }

    // ── 2. Desconto em produtos SEM variação ────────────────────
    const prodsSemVar = (prods || []).filter(
      (p) => !itens.some((i) =>
        Number(i.produto_id ?? i.id) === p.id && Number(i.variacao_id) > 0,
      ),
    );

    const qtdPorProduto = {};
    itens.forEach((item) => {
      if (Number(item.variacao_id) > 0) return;
      const pid = Number(item.produto_id ?? item.id);
      if (!Number.isInteger(pid) || pid <= 0) return;
      qtdPorProduto[pid] = (qtdPorProduto[pid] || 0) + getQtd(item);
    });

    // Caminho inventario
    const descontosInv = {};
    prodsSemVar.forEach((p) => {
      if (!p.inventario_id) return;
      const q = qtdPorProduto[p.id];
      if (!q) return;
      descontosInv[p.inventario_id] = (descontosInv[p.inventario_id] || 0) + q;
    });

    if (Object.keys(descontosInv).length > 0) {
      const invIds = Object.keys(descontosInv).map(Number);
      const { data: estoques } = await supa
        .from("inventario").select("id, quantidade").in("id", invIds);
      for (const est of estoques || []) {
        const nova = Math.max(0, Number(est.quantidade ?? 0) - descontosInv[est.id]);
        const { data: _rows, error: _err } = await supa
          .from("inventario").update({ quantidade: nova })
          .eq("id", est.id).select("id");
        if (_err || !_rows?.length) {
          falhas.push({
            tipo: "inventario", id: est.id,
            motivo: _err?.message || "0 linhas afetadas",
          });
        } else {
          await supa.from("inventario_movimentos").insert([{
            inventario_id: est.id,
            tipo: "sub",
            quantidade: descontosInv[est.id],
            motivo: "Venda PDV (mesa — itens adicionados)",
            usuario_email: "sistema",
          }]).then(() => {}).catch(() => {});
        }
      }
    }

    // Caminho estoque_qtd + RPC
    for (const prod of prodsSemVar) {
      if (prod.estoque_qtd === null || prod.estoque_qtd === undefined) continue;
      const qtdVendida = qtdPorProduto[prod.id];
      if (!qtdVendida) continue;

      const { data: rpc, error: rpcErr } = await supa
        .rpc("descontar_estoque_atomico", {
          p_produto_id: prod.id,
          p_qtd: qtdVendida,
        });

      if (rpcErr) {
        const { data: fresh } = await supa
          .from("produtos").select("estoque_qtd").eq("id", prod.id).single();
        const atual = fresh?.estoque_qtd ?? prod.estoque_qtd;
        const novaQtd = Math.max(0, atual - qtdVendida);
        const payload = { estoque_qtd: novaQtd };
        if (novaQtd === 0) payload.ativo = false;
        const { data: _r, error: _e } = await supa
          .from("produtos").update(payload).eq("id", prod.id).select("id");
        if (_e || !_r?.length) {
          falhas.push({
            tipo: "produto", id: prod.id, nome: prod.nome,
            motivo: _e?.message || "0 linhas afetadas",
          });
        }
      } else if (rpc && rpc[0] && !rpc[0].sucesso) {
        falhas.push({
          tipo: "produto", id: prod.id, nome: prod.nome,
          motivo: rpc[0].motivo || "RPC retornou sucesso=false",
        });
      }
    }

    if (falhas.length) {
      console.error("❌ Falha ao descontar estoque (itens):", falhas);
    } else {
      const total =
        Object.keys(descontosInv).length +
        Object.keys(qtdPorVariacao).length +
        prodsSemVar.length;
      console.log(`✅ Estoque descontado (itens): ${total} item(s)`);
    }
    return { ok: falhas.length === 0, falhas };
  } catch (e) {
    console.warn("Estoque desconto (itens):", e.message);
    falhas.push({ tipo: "excecao", motivo: e.message });
    return { ok: false, falhas };
  }
}

/**
 * Desconta estoque a partir de pedidoId OU lista de itens.
 *
 * ⚠️ MUDANÇA ARQUITETURAL — race condition:
 * A versão anterior fazia `SELECT → JS calcula → UPDATE`, o que causa
 * race condition quando 2 vendas simultâneas leem o mesmo estoque e
 * gravam o mesmo valor (perde 1 unidade de baixa). Agora usamos a RPC
 * `descontar_estoque_atomico` que faz lock + update em uma única
 * transação Postgres.
 *
 * Continua suportando DOIS mecanismos:
 *   a) produtos.inventario_id → tabela `inventario`
 *   b) produtos.estoque_qtd   → estoque direto na linha do produto
 */
async function _descontarEstoqueVenda(pedidoId, itensDireto) {
  const falhas = [];
  try {
    let itens = itensDireto;
    if (!itens) {
      const { data: pedido } = await supa
        .from("pedidos").select("itens").eq("id", pedidoId).single();
      itens = pedido?.itens;
    }
    if (!itens?.length) return { ok: true, falhas };

    // ── Sanitiza IDs: só inteiros > 0 ──
    const prodIds = [
      ...new Set(
        itens
          .map((i) => Number(i.produto_id ?? i.id))
          .filter((id) => Number.isInteger(id) && id > 0)
      ),
    ];

    // 🔧 IDs de variação (se houver)
    const varIds = [
      ...new Set(
        itens
          .map((i) => Number(i.variacao_id))
          .filter((id) => Number.isInteger(id) && id > 0)
      ),
    ];

    if (!prodIds.length) return { ok: true, falhas };

    // 🔧 Busca produtos E variações em paralelo
    const [{ data: prods, error: errProds }, { data: variacoes, error: errVars }] =
      await Promise.all([
        supa.from("produtos")
          .select("id, nome, inventario_id, estoque_qtd")
          .in("id", prodIds),
        varIds.length
          ? supa.from("produto_variacoes")
              .select("id, produto_id, nome, estoque_qtd, controlar_estoque")
              .in("id", varIds)
          : Promise.resolve({ data: [], error: null }),
      ]);

    if (errProds) {
      falhas.push({ tipo: "query_produtos", motivo: errProds.message });
      return { ok: false, falhas };
    }
    if (!prods?.length) {
      falhas.push({
        tipo: "produtos_nao_encontrados",
        motivo: `IDs: ${prodIds.join(", ")}`,
      });
      return { ok: false, falhas };
    }

    const getQtd = (item) =>
      parseInt(item.qtd ?? item.q ?? item.quantidade ?? 1) || 1;

    // ═══════════════════════════════════════════════════════════════
    //  🔧 CORREÇÃO CRÍTICA #2 — Deduza variações ANTES do produto-pai
    //
    //  Se o item tem `variacao_id`, desconta em produto_variacoes
    //  e não toca no estoque_qtd do produto-pai (que costuma ser NULL).
    // ═══════════════════════════════════════════════════════════════
    const mapaVariacoes = {};
    (variacoes || []).forEach((v) => { mapaVariacoes[v.id] = v; });

    // Mapa: variacao_id → qtd vendida
    const qtdPorVariacao = {};
    itens.forEach((item) => {
      const vid = Number(item.variacao_id);
      if (!Number.isInteger(vid) || vid <= 0) return;
      qtdPorVariacao[vid] = (qtdPorVariacao[vid] || 0) + getQtd(item);
    });

    // Produtos que NÃO têm variação_id — descontam normalmente
    const produtosSemVariacao = new Set(prodIds);
    itens.forEach((item) => {
      if (Number(item.variacao_id) > 0) {
        produtosSemVariacao.delete(Number(item.produto_id ?? item.id));
      }
    });

    // ── 2a. Desconto em produto_variacoes ────────────────────────
    for (const [vid, qtd] of Object.entries(qtdPorVariacao)) {
      const v = mapaVariacoes[vid];
      if (!v) {
        falhas.push({ tipo: "variacao", id: vid, motivo: "Variação não encontrada" });
        continue;
      }
      if (v.controlar_estoque === false) continue;

      const { data: _r, error: _e } = await supa
        .from("produto_variacoes")
        .update({ estoque_qtd: Math.max(0, (v.estoque_qtd || 0) - qtd) })
        .eq("id", vid)
        .eq("estoque_qtd", v.estoque_qtd)  // 🔒 optimistic lock
        .select("id");

      if (_e || !_r?.length) {
        // Tentar com o valor atual novamente (fallback sem lock)
        const { data: fresh } = await supa
          .from("produto_variacoes").select("estoque_qtd").eq("id", vid).single();
        const atual = fresh?.estoque_qtd ?? v.estoque_qtd;
        const { data: _r2, error: _e2 } = await supa
          .from("produto_variacoes")
          .update({ estoque_qtd: Math.max(0, atual - qtd) })
          .eq("id", vid)
          .select("id");
        if (_e2 || !_r2?.length) {
          falhas.push({
            tipo: "variacao",
            id: vid,
            nome: v.nome,
            motivo: _e2?.message || "0 linhas afetadas",
          });
        }
      }
    }

    // ── 2b. Desconto em produtos (sem variação) ──────────────────
    const prodsParaDescontar = prods.filter(
      (p) => produtosSemVariacao.has(p.id),
    );

    // Caminho 1: inventario_id
    const descontosInv = {};
    prodsParaDescontar.forEach((prod) => {
      if (!prod.inventario_id) return;
      const qtd = qtdVendidaPorProdutoMapa(itens, prod.id);
      if (!qtd) return;
      descontosInv[prod.inventario_id] =
        (descontosInv[prod.inventario_id] || 0) + qtd;
    });

    function qtdVendidaPorProdutoMapa(arr, pid) {
      let total = 0;
      arr.forEach((item) => {
        const p = Number(item.produto_id ?? item.id);
        if (p !== pid) return;
        if (Number(item.variacao_id) > 0) return; // já tratado nas variações
        total += getQtd(item);
      });
      return total;
    }

    if (Object.keys(descontosInv).length > 0) {
      const invIds = Object.keys(descontosInv).map(Number);
      const { data: estoques, error: errEst } = await supa
        .from("inventario").select("id, quantidade").in("id", invIds);
      if (errEst) {
        falhas.push({ tipo: "query_inventario", motivo: errEst.message });
      } else {
        for (const est of estoques || []) {
          const nova = Math.max(0, Number(est.quantidade ?? 0) - descontosInv[est.id]);
          const { data: _rows, error: _err } = await supa
            .from("inventario").update({ quantidade: nova })
            .eq("id", est.id).select("id");
          if (_err || !_rows?.length) {
            falhas.push({
              tipo: "inventario", id: est.id,
              motivo: _err?.message || "0 linhas afetadas",
            });
          } else {
            await supa.from("inventario_movimentos").insert([{
              inventario_id: est.id,
              tipo: "sub",
              quantidade: descontosInv[est.id],
              motivo: pedidoId ? `Venda — Pedido #${pedidoId}` : "Venda PDV",
              usuario_email: "sistema",
            }]).then(() => {}).catch(() => {});
          }
        }
      }
    }

    // Caminho 2: estoque_qtd direto → RPC atômica
    const produtosComEstoqueQtd = prodsParaDescontar.filter(
      (p) => p.estoque_qtd !== null && p.estoque_qtd !== undefined,
    );

    for (const prod of produtosComEstoqueQtd) {
      const qtdVendida = qtdVendidaPorProdutoMapa(itens, prod.id);
      if (!qtdVendida) continue;

      const { data: rpc, error: rpcErr } = await supa
        .rpc("descontar_estoque_atomico", {
          p_produto_id: prod.id,
          p_qtd: qtdVendida,
        });

      if (rpcErr) {
        console.warn(
          `[Estoque] RPC falhou para #${prod.id}, caindo p/ UPDATE direto:`,
          rpcErr.message,
        );
        const { data: fresh } = await supa
          .from("produtos").select("estoque_qtd").eq("id", prod.id).single();
        const atual = fresh?.estoque_qtd ?? prod.estoque_qtd;
        const novaQtd = Math.max(0, atual - qtdVendida);
        const updatePayload = { estoque_qtd: novaQtd };
        if (novaQtd === 0) updatePayload.ativo = false;

        const { data: _rows, error: _err } = await supa
          .from("produtos").update(updatePayload)
          .eq("id", prod.id).select("id");
        if (_err || !_rows?.length) {
          falhas.push({
            tipo: "produto", id: prod.id, nome: prod.nome,
            motivo: _err?.message || "0 linhas afetadas",
          });
        }
      } else if (rpc && rpc[0] && !rpc[0].sucesso) {
        falhas.push({
          tipo: "produto", id: prod.id, nome: prod.nome,
          motivo: rpc[0].motivo || "RPC retornou sucesso=false",
        });
      }
    }

    // ── Log final ────────────────────────────────────────────────
    const total = Object.keys(descontosInv).length +
                  Object.keys(qtdPorVariacao).length +
                  produtosComEstoqueQtd.length;

    if (falhas.length) {
      console.error(
        `❌ Falha ao descontar estoque — pedido ${pedidoId || "(PDV)"}:`, falhas,
      );
    } else {
      console.log(
        `✅ Estoque descontado: pedido ${pedidoId || "(PDV)"}, ${total} item(s)`,
      );
    }
    return { ok: falhas.length === 0, falhas };
  } catch (e) {
    console.warn("Estoque desconto:", e.message);
    falhas.push({ tipo: "excecao", motivo: e.message });
    return { ok: false, falhas };
  }
}

/* ══════════════════════════════════════════════════════════════
   BUG #7 CORRIGIDO — Repõe estoque quando um pedido é cancelado
   ══════════════════════════════════════════════════════════════ */
async function _reporEstoqueCancelamento(pedidoId) {
  const falhas = [];
  try {
    const { data: pedido } = await supa
      .from("pedidos").select("itens").eq("id", pedidoId).single();
    const itens = pedido?.itens;
    if (!itens?.length) return { ok: true, falhas };

    const prodIds = [
      ...new Set(
        itens
          .map((i) => Number(i.produto_id ?? i.id))
          .filter((id) => Number.isInteger(id) && id > 0)
      ),
    ];
    const varIds = [
      ...new Set(
        itens
          .map((i) => Number(i.variacao_id))
          .filter((id) => Number.isInteger(id) && id > 0)
      ),
    ];

    // Busca produtos e variações
    const [{ data: prods, error: errProds }, { data: variacoes }] =
      await Promise.all([
        prodIds.length
          ? supa.from("produtos")
              .select("id, nome, inventario_id, estoque_qtd, ativo")
              .in("id", prodIds)
          : Promise.resolve({ data: [] }),
        varIds.length
          ? supa.from("produto_variacoes")
              .select("id, nome, estoque_qtd, controlar_estoque")
              .in("id", varIds)
          : Promise.resolve({ data: [] }),
      ]);

    if (errProds) {
      falhas.push({ tipo: "query_produtos", motivo: errProds.message });
      return { ok: false, falhas };
    }

    const getQtd = (item) =>
      parseInt(item.qtd ?? item.q ?? item.quantidade ?? 1) || 1;

    // ── 1. Repõe variações ─────────────────────────────────────
    const mapaVariacoes = {};
    (variacoes || []).forEach((v) => { mapaVariacoes[v.id] = v; });

    const qtdPorVariacao = {};
    itens.forEach((item) => {
      const vid = Number(item.variacao_id);
      if (!Number.isInteger(vid) || vid <= 0) return;
      qtdPorVariacao[vid] = (qtdPorVariacao[vid] || 0) + getQtd(item);
    });

    for (const [vid, qtd] of Object.entries(qtdPorVariacao)) {
      const v = mapaVariacoes[vid];
      if (!v) {
        falhas.push({ tipo: "variacao", id: vid, motivo: "Variação não encontrada" });
        continue;
      }
      if (v.controlar_estoque === false) continue;

      const { data: fresh } = await supa
        .from("produto_variacoes").select("estoque_qtd").eq("id", vid).single();
      const atual = fresh?.estoque_qtd ?? v.estoque_qtd ?? 0;
      const { data: _r, error: _e } = await supa
        .from("produto_variacoes")
        .update({ estoque_qtd: atual + qtd })
        .eq("id", vid).select("id");
      if (_e || !_r?.length) {
        falhas.push({
          tipo: "variacao", id: vid, nome: v.nome,
          motivo: _e?.message || "0 linhas afetadas",
        });
      }
    }

    // ── 2. Repõe produtos (sem variação) ───────────────────────
    const qtdPorProduto = {};
    itens.forEach((item) => {
      if (Number(item.variacao_id) > 0) return;
      const pid = Number(item.produto_id || item.id);
      if (!Number.isInteger(pid) || pid <= 0) return;
      qtdPorProduto[pid] = (qtdPorProduto[pid] || 0) + getQtd(item);
    });

    // Caminho inventario
    const reposicoes = {};
    (prods || []).forEach((prod) => {
      if (!prod.inventario_id) return;
      const qtd = qtdPorProduto[prod.id];
      if (!qtd) return;
      reposicoes[prod.inventario_id] = (reposicoes[prod.inventario_id] || 0) + qtd;
    });

    if (Object.keys(reposicoes).length > 0) {
      const invIds = Object.keys(reposicoes).map(Number);
      const { data: estoques } = await supa
        .from("inventario").select("id, quantidade").in("id", invIds);
      for (const est of estoques || []) {
        const nova = (Number(est.quantidade) || 0) + reposicoes[est.id];
        const { data: _r, error: _e } = await supa
          .from("inventario").update({ quantidade: nova })
          .eq("id", est.id).select("id");
        if (_e || !_r?.length) {
          falhas.push({
            tipo: "inventario", id: est.id,
            motivo: _e?.message || "0 linhas afetadas",
          });
        } else {
          await supa.from("inventario_movimentos").insert([{
            inventario_id: est.id,
            tipo: "ajuste",
            quantidade: reposicoes[est.id],
            motivo: `Cancelamento — Pedido #${pedidoId}`,
            usuario_email: "sistema",
          }]).then(() => {}).catch(() => {});
        }
      }
    }

    // Caminho estoque_qtd
    const prodsComEstoque = (prods || []).filter(
      (p) => p.estoque_qtd !== null && p.estoque_qtd !== undefined,
    );
    for (const prod of prodsComEstoque) {
      const qtd = qtdPorProduto[prod.id];
      if (!qtd) continue;
      const novaQtd = (prod.estoque_qtd || 0) + qtd;
      const updatePayload = { estoque_qtd: novaQtd };
      if (novaQtd > 0 && prod.ativo === false) updatePayload.ativo = true;
      const { data: _r, error: _e } = await supa
        .from("produtos").update(updatePayload).eq("id", prod.id).select("id");
      if (_e || !_r?.length) {
        falhas.push({
          tipo: "produto", id: prod.id, nome: prod.nome,
          motivo: _e?.message || "0 linhas afetadas",
        });
      }
    }

    if (falhas.length) {
      console.error(
        `❌ Falha ao repor estoque — pedido cancelado #${pedidoId}:`, falhas,
      );
    } else {
      console.log(`✅ Estoque reposto: pedido cancelado #${pedidoId}`);
    }
    return { ok: falhas.length === 0, falhas };
  } catch (e) {
    console.warn("_reporEstoqueCancelamento:", e.message);
    falhas.push({ tipo: "excecao", motivo: e.message });
    return { ok: false, falhas };
  }
}

/* ══════════════════════════════════════════════════════════════
   BUG #6 CORRIGIDO — Estorna cashback gerado ao cancelar pedido.
   Busca a transação de crédito vinculada ao pedido e:
   1. Insere um débito igual para zerar o saldo.
   2. Atualiza clientes.cashback_saldo subtraindo o valor.
   ══════════════════════════════════════════════════════════════ */
async function _estornarCashbackCancelamento(pedidoId) {
  try {
    const { data: txs } = await supa
      .from("cashback_transacoes")
      .select("id, cliente_id, cliente_telefone, valor")
      .eq("pedido_id", pedidoId)
      .eq("tipo", "credito")
      .eq("usado", false); // só estorna crédito ainda não utilizado

    if (!txs?.length) return;

    for (const tx of txs) {
      // Marca a transação original como estornada
      await supa
        .from("cashback_transacoes")
        .update({ usado: true })
        .eq("id", tx.id);

      // Insere débito de estorno
      await supa.from("cashback_transacoes").insert([{
        cliente_id:       tx.cliente_id,
        cliente_telefone: tx.cliente_telefone,
        pedido_id:        pedidoId,
        tipo:             "debito",
        valor:            tx.valor,
        validade_dias:    0,
        usado:            true,
      }]);

      // Atualiza saldo do cliente
      if (tx.cliente_id) {
        const { data: cli } = await supa
          .from("clientes")
          .select("cashback_saldo")
          .eq("id", tx.cliente_id)
          .single();
        if (cli) {
          const novoSaldo = Math.max(0, (cli.cashback_saldo || 0) - tx.valor);
          await supa
            .from("clientes")
            .update({ cashback_saldo: novoSaldo })
            .eq("id", tx.cliente_id);
        }
      }
      console.log(`✅ Cashback estornado: Gs ${tx.valor} — pedido #${pedidoId}`);
    }
  } catch (e) {
    console.warn("_estornarCashbackCancelamento:", e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   SIDEBAR RETRÁTIL (desktop)
   ══════════════════════════════════════════════════════════════ */
function toggleSidebar() {
  const sidebar = document.querySelector(".sidebar");
  const main = document.querySelector(".main-content");
  const btn = document.getElementById("btn-toggle-sidebar");
  if (!sidebar) return;
  const collapsed = sidebar.classList.toggle("collapsed");
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  if (btn)
    btn.innerHTML = collapsed
      ? '<i class="fas fa-bars"></i>'
      : '<i class="fas fa-chevron-left"></i>';
  localStorage.setItem("app_sidebar_collapsed", collapsed ? "1" : "0");
}

// Restaura estado da sidebar ao carregar
document.addEventListener("DOMContentLoaded", () => {
  if (localStorage.getItem("app_sidebar_collapsed") === "1") {
    document.querySelector(".sidebar")?.classList.add("collapsed");
    document.body.classList.add("sidebar-collapsed");
    const btn = document.getElementById("btn-toggle-sidebar");
    if (btn) btn.innerHTML = '<i class="fas fa-bars"></i>';
  }
});

/* ══════════════════════════════════════════════════════════════
   MANIFEST DINÂMICO
   ══════════════════════════════════════════════════════════════ */
function _atualizarManifestDinamico(logoUrl) {
  try {
    const manifest = {
      name: NOME_RESTAURANTE || "Restaurante",
      short_name: NOME_RESTAURANTE || "App",
      description: "Sistema de pedidos online",
      start_url: "/index.html",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#ffffff",
      theme_color: "#1d1d1d",
      icons: [
        {
          src: logoUrl,
          sizes: "192x192",
          type: "image/png",
          purpose: "any maskable",
        },
        {
          src: logoUrl,
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable",
        },
      ],
    };
    const blob = new Blob([JSON.stringify(manifest)], {
      type: "application/manifest+json",
    });
    let el = document.querySelector('link[rel="manifest"]');
    if (!el) {
      el = document.createElement("link");
      el.rel = "manifest";
      document.head.appendChild(el);
    }
    el.href = URL.createObjectURL(blob);
    console.log("✅ Manifest atualizado");
  } catch (e) {
    console.warn("Manifest:", e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   INVENTÁRIO — Card Layout
   ══════════════════════════════════════════════════════════════ */
let _inventarioItems = [];
let _tipoAjuste = "add";

async function carregarInventario() {
  if (
    perfilUsuario !== "dono" &&
    perfilUsuario !== "gerente" &&
    perfilUsuario !== "adminMaster"
  )
    return;
  const container = document.getElementById("inventario-lista");
  if (!container) return;
  container.innerHTML =
    '<div style="text-align:center;padding:30px;color:#aaa"><i class="fas fa-spinner fa-spin"></i></div>';
  const { data, error } = await supa
    .from("inventario")
    .select(
      "id, nome, quantidade, unidade, quantidade_minima, observacoes, produto_id, perecivel, data_validade, produtos!inventario_produto_id_fkey(nome)",
    )
    .order("nome");
  if (error) {
    const { data: d2 } = await supa
      .from("inventario")
      .select("*")
      .order("nome");
    _inventarioItems = (d2 || []).map((i) => ({ ...i, produtos: null }));
  } else {
    _inventarioItems = data || [];
  }
  _renderInventarioCards();
  _verificarAlertasEstoque();
}

function _renderInventarioCards() {
  const container = document.getElementById("inventario-lista");
  if (!container) return;
  if (!_inventarioItems.length) {
    container.innerHTML =
      '<div style="text-align:center;padding:40px;color:#aaa">Nenhum item. Clique em "+ Novo Item".</div>';
    return;
  }
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  container.innerHTML = _inventarioItems
    .map((item) => {
      const qtd = item.quantidade ?? 0;
      const min = item.quantidade_minima ?? 0;
      let bg = "",
        badgeStyle = "",
        badgeText = "";
      if (qtd <= 0) {
        bg = "#fff5f5";
        badgeStyle = "background:#fee2e2;color:#dc2626";
        badgeText = "🔴 Zerado";
      } else if (min > 0 && qtd <= min) {
        bg = "#fffbeb";
        badgeStyle = "background:#fef3c7;color:#d97706";
        badgeText = "⚠️ Baixo";
      } else {
        badgeStyle = "background:#dcfce7;color:#16a34a";
        badgeText = "✅ OK";
      }
      let validadeHtml = "";
      if (item.perecivel && item.data_validade) {
        const val = new Date(item.data_validade);
        val.setHours(0, 0, 0, 0);
        const dias = Math.ceil((val - hoje) / 86400000);
        if (dias < 0) {
          validadeHtml = `<span style="font-size:0.72rem;color:#dc2626;font-weight:600">🚫 VENCIDO</span>`;
          bg = "#fff0f0";
        } else if (dias <= 20) {
          validadeHtml = `<span style="font-size:0.72rem;color:#d97706;font-weight:600">⏰ Vence em ${dias}d</span>`;
          if (!bg) bg = "#fffbeb";
        } else
          validadeHtml = `<span style="font-size:0.72rem;color:#888">📅 Val: ${new Date(item.data_validade).toLocaleDateString("pt-BR")}</span>`;
      }
      const prodNome = item.produtos
        ? `<span style="font-size:0.72rem;background:#e8f4fd;color:#1a6eb5;padding:2px 8px;border-radius:10px">${item.produtos.nome}</span>`
        : "";
      const nEsc = (item.nome || "").replace(/'/g, "\\'");
      const qtdColor =
        qtd <= 0 ? "#dc2626" : min > 0 && qtd <= min ? "#d97706" : "#16a34a";
      return `<div class="inv-card" style="background:${bg}" data-id="${item.id}" data-nome="${(item.nome || "").replace(/"/g, "&quot;")}" data-status="${qtd <= 0 ? "zerado" : min > 0 && qtd <= min ? "baixo" : "ok"}">
      <div class="inv-card-top">
        <div class="inv-card-nome">${item.nome || ""}${item.perecivel ? " 🥛" : ""}${validadeHtml ? "<br>" + validadeHtml : ""}${item.observacoes ? `<br><small style="color:#888;font-weight:400">${item.observacoes}</small>` : ""}</div>
        <span class="inv-card-status-badge" style="${badgeStyle}">${badgeText}</span>
      </div>
      <div class="inv-card-row">
        <div><div class="inv-card-info">Unid: <strong>${item.unidade || "un"}</strong>${min > 0 ? ` · Mín: ${min}` : ""}</div>${prodNome}</div>
        <div class="inv-qtd-controls">
          <button class="inv-qtd-btn minus" onclick="ajusteRapido(${item.id},'sub','${nEsc}',${qtd})">−</button>
          <span class="inv-qtd-val" style="color:${qtdColor}">${qtd}</span>
          <button class="inv-qtd-btn plus" onclick="ajusteRapido(${item.id},'add','${nEsc}',${qtd})">+</button>
        </div>
      </div>
      <div class="inv-card-actions">
        <button style="background:#f59e0b;color:#fff" onclick="abrirModalInventario(${item.id})">✏️ Editar</button>
        <button style="background:#fee2e2;color:#dc2626" onclick="excluirInventario(${item.id})">🗑️</button>
      </div>
    </div>`;
    })
    .join("");
}

function filtrarInventario() {
  const busca = (
    document.getElementById("inv-busca")?.value || ""
  ).toLowerCase();
  const status = document.getElementById("inv-filtro-status")?.value || "";
  document
    .querySelectorAll("#inventario-lista .inv-card[data-id]")
    .forEach((card) => {
      const m1 =
        !busca || (card.dataset.nome || "").toLowerCase().includes(busca);
      const m2 = !status || card.dataset.status === status;
      card.style.display = m1 && m2 ? "" : "none";
    });
}

function _verificarAlertasEstoque() {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const alertas = [];
  _inventarioItems.forEach((i) => {
    const q = i.quantidade ?? 0,
      m = i.quantidade_minima ?? 0;
    if (q <= 0) alertas.push(`${i.nome} (zerado)`);
    else if (m > 0 && q <= m)
      alertas.push(`${i.nome} (${q} ${i.unidade || "un"})`);
    if (i.perecivel && i.data_validade) {
      // Não alertar validade se item sem estoque
      if (q > 0) {
        const val = new Date(i.data_validade);
        val.setHours(0, 0, 0, 0);
        const dias = Math.ceil((val - hoje) / 86400000);
        if (dias <= 20)
          alertas.push(
            `${i.nome} vence ${dias <= 0 ? "VENCIDO" : "em " + dias + "d"}`,
          );
      }
    }
  });
  const el = document.getElementById("alerta-estoque-baixo");
  const li = document.getElementById("alerta-estoque-lista");
  if (!el) return;
  if (alertas.length) {
    el.style.display = "block";
    li.textContent = alertas.join(" • ");
  } else el.style.display = "none";
}

function ajusteRapido(id, tipo, nome, qtdAtual) {
  abrirModalAjuste(id, nome, qtdAtual);
  setTipoAjuste(tipo);
}

async function abrirModalInventario(id = null) {
  document.getElementById("inv-id").value = id || "";
  ["inv-nome", "inv-qtd", "inv-minimo", "inv-obs", "inv-validade"].forEach(
    (i) => {
      const el = document.getElementById(i);
      if (el) el.value = "";
    },
  );
  const per = document.getElementById("inv-perecivel");
  if (per) per.checked = false;
  const valA = document.getElementById("inv-validade-area");
  if (valA) valA.style.display = "none";
  document.getElementById("inv-unidade").value = "un";
  document.getElementById("inv-produto-id").innerHTML =
    '<option value="">— Sem vínculo —</option>';
  document.getElementById("modal-inv-titulo").textContent = id
    ? "✏️ Editar Item"
    : "📦 Novo Item de Estoque";
  const { data: prods } = await supa
    .from("produtos")
    .select("id, nome")
    .eq("ativo", true)
    .order("nome");
  if (prods) {
    const sel = document.getElementById("inv-produto-id");
    prods.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.nome;
      sel.appendChild(o);
    });
  }
  if (id) {
    const item = _inventarioItems.find((i) => i.id === id);
    if (item) {
      document.getElementById("inv-nome").value = item.nome || "";
      document.getElementById("inv-qtd").value = item.quantidade ?? "";
      document.getElementById("inv-unidade").value = item.unidade || "un";
      document.getElementById("inv-minimo").value =
        item.quantidade_minima ?? "";
      document.getElementById("inv-obs").value = item.observacoes || "";
      if (item.produto_id)
        document.getElementById("inv-produto-id").value = item.produto_id;
      if (item.perecivel && per) {
        per.checked = true;
        if (valA) valA.style.display = "block";
        const vi = document.getElementById("inv-validade");
        if (vi && item.data_validade)
          vi.value = item.data_validade.split("T")[0];
      }
    }
  }
  document.getElementById("modal-inventario").style.display = "flex";
}

function togglePerecivel() {
  const c = document.getElementById("inv-perecivel")?.checked;
  const a = document.getElementById("inv-validade-area");
  if (a) a.style.display = c ? "block" : "none";
}

async function salvarInventario() {
  const id = document.getElementById("inv-id").value;
  const nome = document.getElementById("inv-nome").value.trim();
  if (!nome) {
    alert("Informe o nome do item.");
    return;
  }
  const perecivel = document.getElementById("inv-perecivel")?.checked || false;
  const dados = {
    nome,
    quantidade: parseFloat(document.getElementById("inv-qtd").value) || 0,
    unidade: document.getElementById("inv-unidade").value,
    quantidade_minima:
      parseFloat(document.getElementById("inv-minimo").value) || null,
    observacoes: document.getElementById("inv-obs").value.trim() || null,
    produto_id:
      parseInt(document.getElementById("inv-produto-id").value) || null,
    perecivel,
    data_validade:
      perecivel && document.getElementById("inv-validade").value
        ? document.getElementById("inv-validade").value
        : null,
  };
  const { error } = id
    ? await supa.from("inventario").update(dados).eq("id", id)
    : await supa.from("inventario").insert([dados]);
  if (error) {
    alert("Erro: " + error.message);
    return;
  }
  fecharModal("modal-inventario");
  carregarInventario();
}

async function excluirInventario(id) {
  if (!confirm("Excluir este item?")) return;
  await supa.from("inventario").delete().eq("id", id);
  carregarInventario();
}

function setTipoAjuste(tipo) {
  _tipoAjuste = tipo;
  ["add", "sub", "set"].forEach((t) => {
    const btn = document.getElementById(`btn-ajuste-${t}`);
    if (btn) btn.style.opacity = t === tipo ? "1" : "0.5";
  });
  const labels = {
    add: "Quantidade a adicionar",
    sub: "Quantidade a remover",
    set: "Nova quantidade total",
  };
  const el = document.getElementById("ajuste-qtd-label");
  if (el) el.textContent = labels[tipo];
}

function abrirModalAjuste(id, nome, qtdAtual) {
  _tipoAjuste = "add";
  document.getElementById("ajuste-inv-id").value = id;
  document.getElementById("ajuste-inv-nome").textContent =
    `${nome} — Atual: ${qtdAtual}`;
  document.getElementById("ajuste-qtd").value = "";
  document.getElementById("ajuste-motivo").value = "";
  setTipoAjuste("add");
  document.getElementById("modal-ajuste-estoque").style.display = "flex";
}

async function confirmarAjuste() {
  const id = document.getElementById("ajuste-inv-id").value;
  const qtd = parseFloat(document.getElementById("ajuste-qtd").value);
  if (isNaN(qtd) || qtd < 0) {
    alert("Quantidade inválida.");
    return;
  }
  const item = _inventarioItems.find((i) => i.id == id);
  const atual = item ? (item.quantidade ?? 0) : 0;
  const nova =
    _tipoAjuste === "add"
      ? atual + qtd
      : _tipoAjuste === "sub"
        ? Math.max(0, atual - qtd)
        : qtd;
  const { error } = await supa
    .from("inventario")
    .update({ quantidade: nova })
    .eq("id", id);
  if (error) {
    alert("Erro: " + error.message);
    return;
  }
  const motivo = document.getElementById("ajuste-motivo").value.trim();
  const userEmail = (await supa.auth.getUser()).data?.user?.email || "";
  await supa
    .from("inventario_movimentos")
    .insert([
      {
        inventario_id: parseInt(id),
        tipo: _tipoAjuste,
        quantidade: qtd,
        motivo: motivo || null,
        usuario_email: userEmail,
      },
    ])
    .then(() => {})
    .catch(() => {});
  fecharModal("modal-ajuste-estoque");
  carregarInventario();
}

async function _carregarSelectInventario(selectedId = null) {
  const sel = document.getElementById("prod-inventario-id");
  if (!sel) return;
  sel.innerHTML = '<option value="">— Selecione o item —</option>';
  const { data } = await supa
    .from("inventario")
    .select("id, nome, quantidade, unidade")
    .order("nome");
  if (data) {
    data.forEach((i) => {
      const opt = document.createElement("option");
      opt.value = i.id;
      opt.textContent = `${i.nome} (${i.quantidade ?? 0} ${i.unidade || "un"})`;
      if (selectedId && i.id == selectedId) opt.selected = true;
      sel.appendChild(opt);
    });
  }
}

// ── ESTOQUE DIRETO (novo — sem inventário vinculado) ─────────
// ── PRODUTO PERECÍVEL (modal de produto) ─────────────────────
function togglePerecivelFields(on) {
  const area = document.getElementById("perecivel-area");
  if (area) area.style.display = on ? "block" : "none";
  if (!on) {
    const dt = document.getElementById("prod-data-validade");
    if (dt) dt.value = "";
  }
}

function toggleEstoqueDireto(on) {
  const area = document.getElementById("estoque-direto-area");
  if (area) area.style.display = on ? "block" : "none";
}

// Alias de compatibilidade — o modal agora chama toggleEstoqueDireto
function toggleEstoqueProduto() {
  const checked = document.getElementById("prod-tem-estoque")?.checked;
  toggleEstoqueDireto(!!checked);
}

// ── VENDA POR KG ─────────────────────────────────────────────
function toggleVendaKg(on) {
  const area = document.getElementById("venda-kg-area");
  if (area) area.style.display = on ? "block" : "none";
  // Quando Kg ativado, define unidade de venda como "kg" automaticamente
  if (on) {
    const unid = document.getElementById("prod-unidade-venda");
    if (unid) unid.value = "kg";
  }
}

// =========================================
// FRETE PDV — ROTA REAL (OSRM)
// =========================================

function toggleDeliveryRowPDV(tipo) {
  const row = document.getElementById("pdv-delivery-row");
  if (!row) return;
  row.style.display = tipo === "delivery" ? "block" : "none";
  if (tipo !== "delivery") {
    const freteInput = document.getElementById("balcao-frete");
    const msg = document.getElementById("frete-msg-pdv");
    if (freteInput) freteInput.value = "";
    if (msg) msg.innerHTML = "";
  }
  atualizarCarrinhoPDV();
}

// Toggle switch de Delivery no PDV (chamado pelo HTML via onclick)
// ── Toggle dados do cliente no PDV ─────────────────────────────────────
function pdvToggleDados() {
  const painel = document.querySelector('.pdv-dir-dados');
  const icon   = document.getElementById('pdv-toggle-dados-icon');
  if (!painel) return;
  const aberto = painel.classList.toggle('pdv-dados-aberto');
  if (icon) {
    icon.className = aberto
      ? 'fas fa-chevron-up'
      : 'fas fa-chevron-down';
  }
}

function pdvToggleDelivery(el) {
  const isDelivery = !el.classList.contains("active");
  el.classList.toggle("active", isDelivery);
  const inp = document.getElementById("balcao-tipo-entrega");
  if (inp) inp.value = isDelivery ? "delivery" : "balcao";
  const chip = document.getElementById("pdv-tipo-chip");
  if (chip) chip.textContent = isDelivery ? "🛵 Delivery" : "🏪 Balcão";
  // Ao ativar delivery, garante que o painel de dados do cliente esteja visível
  if (isDelivery) {
    const painel = document.querySelector('.pdv-dir-dados');
    const icon   = document.getElementById('pdv-toggle-dados-icon');
    if (painel && !painel.classList.contains('pdv-dados-aberto')) {
      painel.classList.add('pdv-dados-aberto');
      if (icon) icon.className = 'fas fa-chevron-up';
    }
  }
  toggleDeliveryRowPDV(isDelivery ? "delivery" : "balcao");
}


async function calcularFretePDV() {
  const btn        = document.getElementById("btn-gps-pdv");
  const msg        = document.getElementById("frete-msg-pdv");
  const freteInput = document.getElementById("balcao-frete");

  // Guard: se o HTML estiver desatualizado (sem id no botão), ainda
  // assim a função roda — apenas não muda o estado visual do botão.
  // Sem isso, a função quebrava na linha 2 com "Cannot set properties
  // of null" e o operador via como botão travado.
  const _resetBtn = () => {
    if (!btn) return;
    btn.disabled = false;
    btn.innerText = "📍 Rota";
  };
  const _setLoading = (txt) => {
    if (!btn) return;
    btn.disabled = true;
    btn.innerText = txt;
  };

  if (!msg || !freteInput) {
    console.warn("[calcularFretePDV] Elementos #frete-msg-pdv ou #balcao-frete não encontrados.");
    return;
  }

  _setLoading("⏳");
  msg.innerHTML = '<span style="color:#888">Localizando...</span>';

  // ── Watchdog: destrava o botão em 15s mesmo se nada acontecer ────────
  // (geolocation.getCurrentPosition pode não disparar nenhum callback em
  //  iOS com permissão pendente, deixando o botão travado pra sempre)
  let _finalizado = false;
  const _watchdog = setTimeout(() => {
    if (_finalizado) return;
    _finalizado = true;
    msg.innerHTML =
      '<span style="color:#e74c3c">⚠️ GPS não respondeu. Cole um link do Google Maps no endereço.</span>';
    _resetBtn();
  }, 15000);

  const _finalizar = () => {
    _finalizado = true;
    clearTimeout(_watchdog);
    _resetBtn();
  };

  // ── Tenta extrair coordenadas do link colado no campo endereço ──────
  const endVal = (document.getElementById("balcao-endereco")?.value || "").trim();
  let lat = null,
    lng = null;

  if (endVal) {
    // Formatos comuns do Google Maps:
    // https://maps.google.com/?q=-25.2867,-57.6471
    // https://www.google.com/maps/@-25.2867,-57.6471,17z
    // https://goo.gl/maps/... (encurtado — não parseable sem request)
    // https://maps.app.goo.gl/... (novo encurtado)
    // https://www.google.com/maps/place/.../@-25.2867,-57.6471,...
    const patterns = [
      /[?&]q=(-?\d+\.?\d*),(-?\d+\.?\d*)/,
      /@(-?\d+\.?\d*),(-?\d+\.?\d*)/,
      /\/place\/[^/@]*\/@(-?\d+\.?\d*),(-?\d+\.?\d*)/,
      /maps\?.*ll=(-?\d+\.?\d*),(-?\d+\.?\d*)/,
    ];
    for (const rx of patterns) {
      const m = endVal.match(rx);
      if (m) {
        lat = parseFloat(m[1]);
        lng = parseFloat(m[2]);
        break;
      }
    }
  }

  // ── Se não extraiu do link, usa GPS do dispositivo ──────────────────
  if (lat === null || lng === null) {
    if (!navigator.geolocation) {
      msg.innerHTML =
        '<span style="color:#e74c3c">Cole um link do Google Maps ou use um celular com GPS</span>';
      _finalizar();
      return;
    }
    let position;
    try {
      position = await new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
        }),
      );
    } catch {
      msg.innerHTML =
        '<span style="color:#e74c3c">Cole um link do Google Maps no campo endereço, ou permita o GPS</span>';
      _finalizar();
      return;
    }
    lat = position.coords.latitude;
    lng = position.coords.longitude;
  }

  // ── Salva coords no campo oculto para usar no insert ────────────────
  const _geoLatEl = document.getElementById("balcao-geo-lat");
  const _geoLngEl = document.getElementById("balcao-geo-lng");
  if (_geoLatEl) _geoLatEl.value = lat;
  if (_geoLngEl) _geoLngEl.value = lng;

  msg.innerHTML = '<span style="color:#888">⏳ Calculando rota...</span>';
  let dist = await obterDistanciaPelaRota(lat, lng);

  // ── OSRM falhou → taxa padrão (2,1–3 km) ────────────────────────────
  if (dist === null) {
    const r = calcularFreteSemLocalizacao(TABELA_FRETE_ADMIN);

    if (r.acombinar === true) {
      freteInput.value = "";
      msg.innerHTML = `<span style="color:#e67e22">⚠️ Rota indisponível — Frete <strong>a combinar</strong></span>`;
    } else {
      freteInput.value = r.loja;
      msg.innerHTML = `<span style="color:#e67e22">⚠️ Rota indisponível. Taxa padrão: Gs ${r.loja.toLocaleString("es-PY")}</span>`;
    }
    _finalizar();
    atualizarCarrinhoPDV();
    return;
  }

  // ── OSRM OK → aplica faixa real (ou "a combinar" se admin marcou) ──
  const r = calcularFretePorDistancia(dist, TABELA_FRETE_ADMIN);

  if (r.acombinar === true) {
    freteInput.value = "";
    msg.innerHTML = `<span style="color:#e67e22">✅ Rota: ${dist.toFixed(1)}km — Frete <strong>a combinar</strong></span>`;
  } else {
    freteInput.value = r.loja;
    msg.innerHTML = `<span style="color:#27ae60">✅ Rota: ${dist.toFixed(1)}km → Gs ${r.loja.toLocaleString("es-PY")}</span>`;
  }

  _finalizar();
  atualizarCarrinhoPDV();
}

// ═══════════════════════════════════════════════════════════════
// ONBOARDING — Configuração inicial do restaurante
// ═══════════════════════════════════════════════════════════════

const _OB_STEPS = [
  {
    id: "identidade",
    titulo: "🏪 Identidade da Loja",
    descricao: "Como seu restaurante vai aparecer para os clientes.",
    campos: [
      {
        id: "ob-nome",
        label: "Nome do restaurante *",
        tipo: "text",
        placeholder: "Ex: Açaí do João",
        db: "nome_restaurante",
      },
      {
        id: "ob-descricao",
        label: "Descrição curta",
        tipo: "text",
        placeholder: "Ex: O melhor açaí da cidade",
        db: "descricao_loja",
      },
      {
        id: "ob-whatsapp",
        label: "WhatsApp (com DDI)",
        tipo: "text",
        placeholder: "Ex: 595981234567",
        db: "whatsapp_loja",
      },
      {
        id: "ob-logo",
        label: "URL do Logo",
        tipo: "url",
        placeholder: "https://...",
        db: "logo_url",
      },
    ],
  },
  {
    id: "visual",
    titulo: "🎨 Identidade Visual",
    descricao: "Cor principal que aparece no app do cliente.",
    campos: [
      {
        id: "ob-cor",
        label: "Cor primária",
        tipo: "color",
        placeholder: "#1a7a2e",
        db: "cor_primaria",
        extra: `<input type="text" id="ob-cor-hex" maxlength="7" placeholder="#1a7a2e"
                  style="padding:8px 12px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.9rem;width:120px;margin-left:8px"
                  oninput="var v=this.value;if(v.startsWith('#')&&v.length===7){document.getElementById('ob-cor').value=v;document.documentElement.style.setProperty('--primary',v);}">
                <span style="font-size:0.8rem;color:#888;margin-left:8px">← ou digita o hex</span>`,
      },
    ],
  },
  {
    id: "localizacao",
    titulo: "📍 Localização da Loja",
    descricao: "Coordenadas usadas para calcular o frete de entrega.",
    campos: [
      {
        id: "ob-lat",
        label: "Latitude *",
        tipo: "text",
        placeholder: "Ex: -25.2866",
        db: "coord_lat",
      },
      {
        id: "ob-lng",
        label: "Longitude *",
        tipo: "text",
        placeholder: "Ex: -57.6470",
        db: "coord_lng",
      },
    ],
    dica: `<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:12px;margin-top:12px;font-size:0.83rem">
      💡 <strong>Como pegar as coordenadas:</strong><br>
      Abra <a href="https://maps.google.com" target="_blank" style="color:#2980b9">Google Maps</a>,
      clique com o botão direito no seu endereço e copie os números que aparecem (Ex: -25.286, -57.647).
    </div>`,
  },
  {
    id: "pagamento",
    titulo: "💳 Formas de Pagamento",
    descricao: "Configure PIX e Alias/Transferência para receber pagamentos.",
    campos: [
      {
        id: "ob-pix",
        label: "Chave PIX",
        tipo: "text",
        placeholder: "CPF, CNPJ, e-mail ou telefone",
        db: "chave_pix",
      },
      {
        id: "ob-nome-pix",
        label: "Nome no PIX",
        tipo: "text",
        placeholder: "Nome que aparece no QR Code",
        db: "nome_pix",
      },
      {
        id: "ob-alias",
        label: "Alias / Cuenta",
        tipo: "text",
        placeholder: "banco@alias.com.py",
        db: "dados_alias",
      },
      {
        id: "ob-cotacao",
        label: "Cotação do Real (Gs)",
        tipo: "number",
        placeholder: "1100",
        db: "cotacao_real",
      },
    ],
  },
  {
    id: "horario",
    titulo: "🕐 Horário de Funcionamento",
    descricao:
      "Configure o horário padrão. Pode afinar por dia depois em Configurações.",
    campos: [],
    custom: `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px">
        <div>
          <label style="font-size:0.82rem;font-weight:600;color:#555;display:block;margin-bottom:4px">Abre às</label>
          <input type="time" id="ob-hora-abre" value="10:00"
            style="width:100%;padding:10px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:1rem">
        </div>
        <div>
          <label style="font-size:0.82rem;font-weight:600;color:#555;display:block;margin-bottom:4px">Fecha às</label>
          <input type="time" id="ob-hora-fecha" value="23:00"
            style="width:100%;padding:10px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:1rem">
        </div>
      </div>
      <p style="font-size:0.78rem;color:#999;margin-top:8px">Este horário será aplicado a todos os dias da semana.</p>
    `,
  },
];

let _obStep = 0;
let _obData = {};

async function iniciarOnboarding() {
  // ── 1. Flag local por usuário: se já foi mostrado/concluído neste
  //        navegador para este usuário, não verifica nem abre de novo. ──
  const _obKey = `onboarding_done_${_perfilId || "anon"}`;
  if (localStorage.getItem(_obKey) === "1") return;

  try {
    const { data, error } = await supa
      .from("configuracoes")
      .select("nome_restaurante, logo_url, icone_url, whatsapp_loja, coord_lat, coord_lng")
      .maybeSingle();

    if (error) {
      // Fail-open: erro de rede/RLS não abre o onboarding nem quebra o painel
      console.warn("[onboarding] Erro ao verificar config:", error.message);
      return;
    }

    // ── 2. Verifica se o banco JÁ tem dados de identidade.
    //    Um nome só com espaços ou vazio NÃO conta como configurado. ──
    const nomeOk   = (data?.nome_restaurante || "").trim().length > 0;
    const logoOk   = (data?.logo_url || data?.icone_url || "").trim().length > 0;
    const whatsOk  = (data?.whatsapp_loja || "").trim().length > 0;
    const coordOk  = !!(data?.coord_lat && data?.coord_lng);

    if (nomeOk || logoOk || whatsOk || coordOk) {
      // Já está configurado → marca a flag e nunca mais verifica
      localStorage.setItem(_obKey, "1");
      return;
    }

    // ── 3. Sem dados de identidade → mostra onboarding (primeira vez). ──
    _obStep = 0;
    _obData = {};
    _obRender();
    document.getElementById("modal-onboarding").style.display = "flex";
  } catch (e) {
    // Qualquer exceção → fail-open, não abre onboarding por engano
    console.warn("[onboarding] Erro inesperado:", e.message);
  }
}

function _obRender() {
  const step = _OB_STEPS[_obStep];
  const total = _OB_STEPS.length;
  const isLast = _obStep === total - 1;
  const isFirst = _obStep === 0;

  // Dots
  const dots = document.getElementById("ob-dots");
  if (dots) {
    dots.innerHTML = _OB_STEPS
      .map(
        (s, i) => `
      <div style="height:6px;flex:1;border-radius:3px;background:${i <= _obStep ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.25)"}"></div>
    `,
      )
      .join("");
  }

  // Step label
  const lbl = document.getElementById("ob-step-label");
  if (lbl) lbl.textContent = `Passo ${_obStep + 1} de ${total}`;

  // Prev/Next buttons
  const prev = document.getElementById("ob-btn-prev");
  const next = document.getElementById("ob-btn-next");
  if (prev) prev.style.visibility = isFirst ? "hidden" : "visible";
  if (next) next.textContent = isLast ? "✅ Salvar & Concluir" : "Próximo →";

  // Body
  const body = document.getElementById("ob-body");
  if (!body) return;

  let html = `
    <h3 style="font-size:1.15rem;font-weight:800;color:#1a1a1a;margin-bottom:4px">${step.titulo}</h3>
    <p style="font-size:0.85rem;color:#666;margin-bottom:18px">${step.descricao}</p>
  `;

  // Campos padrão
  (step.campos || []).forEach((c) => {
    const savedVal = _obData[c.db] || "";
    if (c.tipo === "color") {
      html += `
        <div style="margin-bottom:14px">
          <label style="font-size:0.82rem;font-weight:600;color:#555;display:block;margin-bottom:6px">${c.label}</label>
          <div style="display:flex;align-items:center;gap:8px">
            <input type="color" id="${c.id}" value="${savedVal || "#1a7a2e"}"
              style="width:52px;height:38px;border:none;border-radius:8px;cursor:pointer;padding:2px"
              oninput="document.getElementById('ob-cor-hex').value=this.value;document.documentElement.style.setProperty('--primary',this.value)">
            ${c.extra || ""}
          </div>
        </div>`;
    } else {
      html += `
        <div style="margin-bottom:14px">
          <label style="font-size:0.82rem;font-weight:600;color:#555;display:block;margin-bottom:6px">${c.label}</label>
          <input type="${c.tipo}" id="${c.id}" value="${savedVal}"
            placeholder="${c.placeholder}"
            style="width:100%;padding:10px 12px;border:1.5px solid #e0e0e0;border-radius:8px;font-size:0.92rem;transition:border-color .2s"
            onfocus="this.style.borderColor='var(--primary,#1a7a2e)'" onblur="this.style.borderColor='#e0e0e0'">
        </div>`;
    }
  });

  // Custom HTML (horário)
  if (step.custom) html += step.custom;

  // Dica
  if (step.dica) html += step.dica;

  body.innerHTML = html;

  // Restaura valor cor hex se voltou ao passo
  if (step.id === "visual") {
    const corVal = _obData["cor_primaria"] || "#1a7a2e";
    const hexEl = document.getElementById("ob-cor-hex");
    if (hexEl) hexEl.value = corVal;
    document.documentElement.style.setProperty("--primary", corVal);
  }
}

function _obColetar() {
  const step = _OB_STEPS[_obStep];

  (step.campos || []).forEach((c) => {
    const el = document.getElementById(c.id);
    if (el) _obData[c.db] = el.value.trim();
  });

  // Horário: monta grade semanal simples
  if (step.id === "horario") {
    const abre = document.getElementById("ob-hora-abre")?.value || "10:00";
    const fecha = document.getElementById("ob-hora-fecha")?.value || "23:00";
    const dias = ["seg", "ter", "qua", "qui", "sex", "sab", "dom"];
    const grade = {};
    dias.forEach((d) => {
      grade[d] = { fechado: false, turnos: [{ abre, fecha }] };
    });
    _obData["horarios_semanais"] = grade;
    _obData["loja_aberta"] = true;
  }
}

function _obNext() {
  _obColetar();
  if (_obStep < _OB_STEPS.length - 1) {
    _obStep++;
    _obRender();
  } else {
    _obSalvar();
  }
}

function _obPrev() {
  _obColetar();
  if (_obStep > 0) {
    _obStep--;
    _obRender();
  }
}

function _obSkip() {
  if (
    !confirm(
      "Pular a configuração inicial? Você pode configurar depois em Configurações.",
    )
  )
    return;

  // Marca como "já mostrado" — nunca mais abre neste navegador para este usuário
  const _obKey = `onboarding_done_${_perfilId || "anon"}`;
  localStorage.setItem(_obKey, "1");

  document.getElementById("modal-onboarding").style.display = "none";
}

async function _obSalvar() {
  const btn = document.getElementById("ob-btn-next");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Salvando...";
  }

  try {
    // Prepara dados — filtra vazios
    const payload = {};
    Object.entries(_obData).forEach(([k, v]) => {
      if (v !== "" && v !== null && v !== undefined) payload[k] = v;
    });

    // Numérico
    if (payload.cotacao_real)
      payload.cotacao_real = parseFloat(payload.cotacao_real) || 1100;
    if (payload.coord_lat)
      payload.coord_lat = parseFloat(payload.coord_lat) || 0;
    if (payload.coord_lng)
      payload.coord_lng = parseFloat(payload.coord_lng) || 0;

    // Sincroniza logo_url e icone_url
    if (payload.logo_url) payload.icone_url = payload.logo_url;

    const { error } = await supa
      .from("configuracoes")
      .update(payload)
      .gt("id", 0);

    if (error) throw new Error(error.message);

    // Aplica cor imediatamente
    if (payload.cor_primaria)
      document.documentElement.style.setProperty(
        "--primary",
        payload.cor_primaria,
      );

    // ── Marca como concluído — nunca mais abre para este usuário. ──
    const _obKey = `onboarding_done_${_perfilId || "anon"}`;
    localStorage.setItem(_obKey, "1");

    document.getElementById("modal-onboarding").style.display = "none";

    // Toast de sucesso
    _pdvToast?.("✅ Configuração salva! O app já reflete os dados.") ||
      alert("✅ Configuração inicial salva com sucesso!");

    // Recarrega a aba de configurações se estiver aberta
    if (
      document.getElementById("configuracoes")?.classList.contains("active")
    ) {
      carregarConfiguracoes();
    }

    // Atualiza brand
    if (payload.nome_restaurante) {
      const b = document.getElementById("brand-text");
      if (b) b.textContent = payload.nome_restaurante.toUpperCase() + " ADMIN";
      NOME_RESTAURANTE = payload.nome_restaurante;
    }
  } catch (e) {
    alert("Erro ao salvar: " + e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✅ Salvar & Concluir";
    }
  }
}

// Chamado no DOMContentLoaded após auth — só mostra se banco não configurado
// (injeta no fluxo de inicialização existente)
document.addEventListener("DOMContentLoaded", () => {
  // Aguarda auth (1.5s) para não conflitar com o auth-overlay
  setTimeout(async () => {
    if (perfilUsuario && ["dono", "adminMaster"].includes(perfilUsuario)) {
      await iniciarOnboarding();
    }
  }, 1500);
});

function ftMostrarPanel(panel) {
  ["insumos", "fichas"].forEach((p) => {
    const el = document.getElementById(`ft-panel-${p}`);
    const btn = document.getElementById(`ft-nav-${p}`);
    if (el) el.style.display = p === panel ? "block" : "none";
    if (btn) {
      // ft-tab-ativo = fundo preenchido; sem ela = outline com texto/borda coloridos
      btn.classList.toggle("ft-tab-ativo", p === panel);
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  PATCH 7 — Editar/Excluir Despesas (porta da aplicação-modelo)
//  Se estas funções NÃO existirem no seu admin.js atual, adicione-as:
// ─────────────────────────────────────────────────────────────
function abrirEditarDespesa(dadosEncoded) {
  try {
    const d = JSON.parse(decodeURIComponent(dadosEncoded));
    document.getElementById("edit-despesa-id").value = d.id;
    document.getElementById("edit-despesa-valor").value = d.valor;
    document.getElementById("edit-despesa-desc").value = d.descricao;
    const tipoSel = document.getElementById("edit-despesa-tipo");
    if (tipoSel) tipoSel.value = d.tipo_despesa || "despesas_gerais";
    const outroBox = document.getElementById("edit-box-outro");
    const outroInput = document.getElementById("edit-despesa-outro");
    if (d.tipo_despesa === "outro") {
      if (outroBox) outroBox.style.display = "block";
      if (outroInput) outroInput.value = d.descricao_outro || "";
    } else {
      if (outroBox) outroBox.style.display = "none";
      if (outroInput) outroInput.value = "";
    }
    document.getElementById("modal-editar-despesa").style.display = "flex";
  } catch (e) {
    alert("Erro ao abrir edição: " + e.message);
  }
}

async function salvarEdicaoDespesa() {
  const id = document.getElementById("edit-despesa-id").value;
  const valor = parseFloat(document.getElementById("edit-despesa-valor").value);
  const desc = document.getElementById("edit-despesa-desc").value.trim();
  const tipo = document.getElementById("edit-despesa-tipo").value;

  if (!id || !valor || valor <= 0) {
    alert("Preencha o valor corretamente.");
    return;
  }

  let descOutro = null;
  if (tipo === "outro") {
    descOutro =
      document.getElementById("edit-despesa-outro")?.value?.trim() || "";
    if (!descOutro) {
      alert("Descreva o tipo da despesa.");
      return;
    }
  }

  const { error } = await supa
    .from("movimentacoes_caixa")
    .update({
      valor,
      descricao: desc,
      tipo_despesa: tipo,
      descricao_outro: descOutro,
    })
    .eq("id", id);

  if (error) {
    alert("Erro ao salvar: " + error.message);
    return;
  }
  fecharModal("modal-editar-despesa");
  calcularFinanceiro();
}

async function excluirDespesa(id) {
  if (!confirm("Excluir esta despesa? Esta ação não pode ser desfeita."))
    return;
  const { error } = await supa
    .from("movimentacoes_caixa")
    .delete()
    .eq("id", id);
  if (error) {
    alert("Erro ao excluir: " + error.message);
    return;
  }
  calcularFinanceiro();
}
// ══════════════════════════════════════════════════════════════
//  VERIFICAÇÃO DE CONTRATO
//  Regras:
//   • adminMaster → bypass total (nunca vê contrato).
//   • dono        → vê contrato APENAS se ainda não assinou.
//   • outros      → bypass (não são parte do contrato).
//  Fail-open: qualquer erro de leitura NÃO bloqueia o painel.
// ══════════════════════════════════════════════════════════════
async function verificarContratoAdmin(session) {
  if (!session?.user?.id) return;

  try {
    // ── 1. Busca o cargo do usuário. Se a query falhar, NÃO assume "dono". ──
    const { data: perfil, error: errPerfil } = await supa
      .from("perfis_acesso")
      .select("cargo")
      .eq("id", session.user.id)
      .limit(1);

    if (errPerfil || !perfil?.length || !perfil[0]?.cargo) {
      console.warn(
        "[verificarContratoAdmin] Não foi possível determinar o cargo — pulando verificação (fail-open).",
        errPerfil?.message || "sem registro em perfis_acesso",
      );
      return;
    }

    const cargo = perfil[0].cargo;

    // ── 2. Só "dono" assina contrato. Todos os demais passam direto. ──
    if (cargo !== "dono") return;

    // ── 3. Verifica se o dono já aceitou.
    //    Usa .limit(1) em vez de .maybeSingle() — assim múltiplos registros
    //    históricos de aceite NÃO causam erro PGRST116 (que zerava `data`
    //    e fazia o contrato reaparecer). ──
    const { data: aceites, error: errAceite } = await supa
      .from("contratos_aceites")
      .select("id")
      .eq("usuario_id", session.user.id)
      .eq("aceito", true)
      .limit(1);

    if (errAceite) {
      // Erro de leitura → fail-open, não bloqueia o painel
      console.warn(
        "[verificarContratoAdmin] Erro ao consultar aceites — pulando verificação.",
        errAceite.message,
      );
      return;
    }

    // Se achou ao menos 1 aceite → já assinou. Nunca mais mostra.
    if (aceites && aceites.length > 0) return;

    // ── 4. Nunca aceitou → mostra overlay de assinatura. ──
    _admMostrarContratoOverlay(session);
  } catch (e) {
    // Fail-open: nunca bloqueia por exceção interna
    console.warn("[verificarContratoAdmin] Erro inesperado:", e.message);
  }
}

function _admMostrarContratoOverlay(session) {
  const overlay = document.getElementById("contrato-admin-overlay");
  if (!overlay) {
    // Fallback se o HTML não foi atualizado
    alert("Você precisa aceitar o contrato de serviços para continuar.");
    supa.auth.signOut().then(() => {
      window.location.href = "login.html";
    });
    return;
  }

  const hoje = new Date();
  const meses = [
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
  ];
  const el = (id) => document.getElementById(id);
  if (el("adm-ct-dia")) el("adm-ct-dia").textContent = hoje.getDate();
  if (el("adm-ct-mes")) el("adm-ct-mes").textContent = meses[hoje.getMonth()];
  if (el("adm-ct-ano")) el("adm-ct-ano").textContent = hoje.getFullYear();

  window._admContratoSession = session;
  overlay.style.display = "flex";

  setTimeout(() => {
    const scrollArea = el("adm-contrato-scroll");
    if (scrollArea) scrollArea.scrollTop = 0;
  }, 100);
}

// ──────────────────────────────────────────────────────────────
//  FUNÇÕES DO OVERLAY DE CONTRATO (admin.html)
// ──────────────────────────────────────────────────────────────
let _admContratoScrollCompleto = false;

function admOnScrollContrato() {
  const area = document.getElementById("adm-contrato-scroll");
  const bar = document.getElementById("adm-contrato-bar");
  const hint = document.getElementById("adm-scroll-hint");
  if (!area) return;

  const pct = Math.min(
    100,
    Math.round(
      (area.scrollTop / (area.scrollHeight - area.clientHeight)) * 100,
    ),
  );
  if (bar) bar.style.width = pct + "%";

  if (pct >= 90 && !_admContratoScrollCompleto) {
    _admContratoScrollCompleto = true;
    const chk = document.getElementById("adm-chk-aceite");
    if (chk) chk.disabled = false;
    if (hint) hint.style.display = "none";
  }
}

function admAtualizarNome(val) {
  const el = document.getElementById("adm-ct-nombre");
  if (el) el.textContent = val || "[Nome do Cliente]";
}

function admAtualizarDoc(val) {
  const el = document.getElementById("adm-ct-doc");
  if (el) el.textContent = val || "[Documento]";
}

function admToggleBtnAceitar() {
  const chk = document.getElementById("adm-chk-aceite");
  const btn = document.getElementById("adm-btn-aceitar");
  const nome = document.getElementById("adm-c-nome")?.value?.trim();
  const doc = document.getElementById("adm-c-doc")?.value?.trim();
  const ok = chk?.checked && nome && doc;
  if (btn) {
    btn.disabled = !ok;
    btn.style.opacity = ok ? "1" : "0.45";
    btn.style.cursor = ok ? "pointer" : "not-allowed";
  }
}

async function admAceitarContrato() {
  const session = window._admContratoSession;
  if (!session?.user?.id) return;

  const nome = document.getElementById("adm-c-nome")?.value?.trim();
  const doc = document.getElementById("adm-c-doc")?.value?.trim();

  if (!nome || !doc) {
    alert("Preencha seu nome completo e RUC/C.I. para assinar.");
    return;
  }

  const btn = document.getElementById("adm-btn-aceitar");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Registrando assinatura...";
  }

  try {
    // Coleta IP (falha silenciosa — não impede a assinatura)
    let ip = "";
    try {
      const r = await fetch("https://api.ipify.org?format=json");
      ip = (await r.json()).ip || "";
    } catch (_) {}

    const payload = {
      usuario_id: session.user.id,
      aceito: true,
      nome_assinante: nome,
      doc_assinante: doc,
      ip_assinante: ip,
      user_agent: navigator.userAgent,
      aceito_em: new Date().toISOString(),
    };

    // ── UPSERT: se já existir registro deste usuário, atualiza; senão, insere.
    //    Requer UNIQUE em contratos_aceites.usuario_id (ver migration SQL abaixo). ──
    let { error } = await supa
      .from("contratos_aceites")
      .upsert([payload], { onConflict: "usuario_id" });

    // ── Fallback defensivo: se a UNIQUE constraint não existir ainda,
    //    cai para o fluxo antigo (UPDATE → INSERT). ──
    if (error && /no unique|there is no unique|onConflict/i.test(error.message || "")) {
      const { data: existing } = await supa
        .from("contratos_aceites")
        .select("id")
        .eq("usuario_id", session.user.id)
        .limit(1);

      if (existing && existing.length > 0) {
        await supa
          .from("contratos_aceites")
          .update(payload)
          .eq("usuario_id", session.user.id);
      } else {
        await supa.from("contratos_aceites").insert([payload]);
      }
      error = null;
    }

    if (error) throw error;

    const overlay = document.getElementById("contrato-admin-overlay");
    if (overlay) overlay.style.display = "none";
    console.log("✅ Contrato aceito com sucesso para usuário", session.user.id);
  } catch (e) {
    alert("Erro ao registrar assinatura: " + e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✍️ ASSINAR E CONTINUAR";
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  VAREJO — Adições ao admin.js
//  Cole este bloco no final do seu admin.js existente.
//
//  PASSO DE ATIVAÇÃO:
//    No formulário de produto (modal-produto no admin.html),
//    adicione logo antes do botão "Salvar":
//
//      <!-- Seção de Variações de Estoque (Varejo) -->
//      <div id="secao-variacoes-estoque"></div>
//
//    O JS preenche e gerencia essa seção automaticamente
//    quando o tipo de produto é "variacoes" ou "padrao" em
//    modo varejo.
//
//  DEPENDÊNCIAS:
//    - supabaseClient.js (window.supa)
//    - A tabela produto_variacoes do banco (ver varejo-sql.sql)
// ══════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────
//  Estado local do gerenciador de variações
// ──────────────────────────────────────────────────────────────
let _ve_variacoes = []; // variações em edição no modal
let _ve_prodId = null; // produto_id sendo editado (null = novo)
let _ve_variacoesSalvas = []; // snapshot do banco (para detectar exclusões)

// ──────────────────────────────────────────────────────────────
//  1. veIniciarSecao()
//     Renderiza o HTML da seção dentro de #secao-variacoes-estoque.
//     Chame ao abrir o modal de produto (ou ao mudar o tipo para
//     "variacoes" / "padrao").
// ──────────────────────────────────────────────────────────────
function veIniciarSecao(prodId = null) {
  _ve_prodId = prodId;

  const cont = document.getElementById("secao-variacoes-estoque");
  if (!cont) return;

  cont.innerHTML = `
    <!-- ── Cabeçalho ─────────────────────────────────────────── -->
    <div class="var-estoque-section-header" style="margin-top:20px">
      <h4>📦 Variações e Estoque</h4>
      <button
        type="button"
        class="btn btn-sm btn-primary"
        onclick="veAdicionarLinha()"
        title="Adicionar variação"
      >
        + Adicionar Variação
      </button>
    </div>

    <!-- Ajuda contextual -->
    <p style="font-size:0.78rem;color:#888;margin-bottom:10px;line-height:1.5">
      Use para Tamanho/Cor (roupas), Voltagem (eletrônicos), Sabor (pods/suplementos).<br>
      Deixe <b>Controlar estoque</b> desmarcado para estoque ilimitado.
    </p>

    <!-- Lista de linhas de variação -->
    <div id="ve-lista"></div>

    <!-- Totalizador de estoque -->
    <div id="ve-totalizador" style="
      background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:10px;
      padding:10px 14px;font-size:0.82rem;font-weight:600;color:#166534;
      margin-top:6px;display:none
    ">
      📊 Estoque total: <span id="ve-total-qtd">0</span> unidades
    </div>
  `;

  // Carrega variações existentes se for edição
  if (prodId) {
    veCarregarDosBanco(prodId);
  }
}

// ──────────────────────────────────────────────────────────────
//  2. veCarregarDosBanco(prodId)
//     Busca variações existentes e preenche a lista.
// ──────────────────────────────────────────────────────────────
async function veCarregarDosBanco(prodId) {
  const { data, error } = await supa
    .from("produto_variacoes")
    .select("*")
    .eq("produto_id", prodId)
    .order("ordem")
    .order("nome");

  if (error) {
    console.warn("veCarregarDosBanco:", error.message);
    return;
  }

  _ve_variacoes = data || [];
  _ve_variacoesSalvas = JSON.parse(JSON.stringify(_ve_variacoes));

  _veRenderizarLista();
}

// ──────────────────────────────────────────────────────────────
//  3. veAdicionarLinha(dados)
//     Adiciona uma linha de variação ao estado local e re-renderiza.
// ──────────────────────────────────────────────────────────────
function veAdicionarLinha(dados = {}) {
  _ve_variacoes.push({
    _tempId: Date.now() + Math.random(), // ID temporário (antes de salvar)
    id: dados.id || null,
    nome: dados.nome || "",
    sku: dados.sku || "",
    estoque_qtd: dados.estoque_qtd ?? 0,
    controlar_estoque: dados.controlar_estoque !== false, // default: controla
    preco_adicional: dados.preco_adicional ?? 0,
    preco_absoluto: dados.preco_absoluto || false,
    ativo: dados.ativo !== false,
  });
  _veRenderizarLista();
}

// ──────────────────────────────────────────────────────────────
//  4. _veRenderizarLista()
//     Rebuilda o HTML de todas as linhas de variação.
// ──────────────────────────────────────────────────────────────
function _veRenderizarLista() {
  const lista = document.getElementById("ve-lista");
  if (!lista) return;

  if (!_ve_variacoes.length) {
    lista.innerHTML =
      '<p style="color:#aaa;font-size:0.82rem;text-align:center;padding:14px">Nenhuma variação adicionada. Clique em "+ Adicionar Variação".</p>';
    _veAtualizarTotalizador();
    return;
  }

  lista.innerHTML = "";
  _ve_variacoes.forEach((v, idx) => {
    lista.appendChild(_veCriarLinhaDOM(v, idx));
  });

  _veAtualizarTotalizador();
}

// ──────────────────────────────────────────────────────────────
//  5. _veCriarLinhaDOM(v, idx)
//     Cria o elemento DOM de uma linha de variação.
// ──────────────────────────────────────────────────────────────
function _veCriarLinhaDOM(v, idx) {
  const esgotado = v.controlar_estoque && v.estoque_qtd <= 0;
  const row = document.createElement("div");
  row.className = "var-estoque-row" + (esgotado ? " sem-estoque-admin" : "");
  row.dataset.idx = idx;

  row.innerHTML = `
    <!-- Nome da variação -->
    <div style="display:flex;flex-direction:column;gap:6px">
      <input
        type="text"
        class="form-control ve-nome"
        value="${_esc(v.nome)}"
        placeholder="Ex: Azul - M, 110v, Melancia"
        oninput="_veAtualizar(${idx}, 'nome', this.value)"
        style="font-weight:600"
      >
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <!-- SKU -->
        <input
          type="text"
          class="form-control"
          value="${_esc(v.sku || "")}"
          placeholder="SKU / Cód. barras (opcional)"
          oninput="_veAtualizar(${idx}, 'sku', this.value)"
          style="flex:1;min-width:110px;font-size:0.8rem;color:#777"
        >
        <!-- Sobrepreço -->
        <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
          <span style="font-size:0.78rem;color:#777;white-space:nowrap">
            <input
              type="checkbox"
              title="Preço absoluto (substitui preço base)"
              ${v.preco_absoluto ? "checked" : ""}
              onchange="_veAtualizar(${idx}, 'preco_absoluto', this.checked)"
              style="margin-right:3px"
            >+ Gs
          </span>
          <input
            type="number"
            class="form-control"
            value="${v.preco_adicional || 0}"
            min="0"
            oninput="_veAtualizar(${idx}, 'preco_adicional', parseFloat(this.value)||0)"
            style="width:110px"
            title="Sobrepreço (0 = usa preço base). Marque ☑ para preço fixo absoluto."
          >
        </div>
      </div>
      <!-- Controla estoque toggle -->
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:0.8rem;color:#555">
        <input
          type="checkbox"
          ${v.controlar_estoque ? "checked" : ""}
          onchange="_veAtualizar(${idx}, 'controlar_estoque', this.checked); _veRenderizarLista()"
        >
        Controlar estoque
      </label>
    </div>

    <!-- Quantidade em estoque -->
    <div class="var-estoque-row__estoque" style="display:flex;flex-direction:column;align-items:center;gap:4px">
      <label style="font-size:0.7rem;color:#777;font-weight:700;text-align:center">ESTOQUE</label>
      <div style="display:flex;align-items:center;gap:4px">
        <button type="button"
          onclick="_veAlterarQtd(${idx}, -1)"
          style="width:28px;height:28px;border-radius:6px;border:1.5px solid #ccc;background:#fff;cursor:pointer;font-size:1rem;line-height:1"
          ${!v.controlar_estoque ? 'disabled style="opacity:0.3;cursor:not-allowed"' : ""}
        >−</button>
        <input
          type="number"
          class="form-control ve-qtd"
          value="${v.estoque_qtd}"
          min="0"
          oninput="_veAtualizar(${idx}, 'estoque_qtd', parseInt(this.value)||0); _veAtualizarTotalizador()"
          style="width:56px;text-align:center;font-weight:700"
          ${!v.controlar_estoque ? 'disabled placeholder="∞"' : ""}
        >
        <button type="button"
          onclick="_veAlterarQtd(${idx}, 1)"
          style="width:28px;height:28px;border-radius:6px;border:1.5px solid #ccc;background:#fff;cursor:pointer;font-size:1rem;line-height:1"
          ${!v.controlar_estoque ? 'disabled style="opacity:0.3;cursor:not-allowed"' : ""}
        >+</button>
      </div>
      ${esgotado ? '<span class="var-estoque-row__badge">Esgotado</span>' : ""}
      ${!v.controlar_estoque ? '<span style="font-size:0.68rem;color:#888">∞ ilimitado</span>' : ""}
    </div>

    <!-- Ativo toggle -->
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
      <label style="font-size:0.7rem;color:#777;font-weight:700">STATUS</label>
      <label class="toggle-switch" title="${v.ativo ? "Disponível" : "Pausado"}">
        <input
          type="checkbox"
          ${v.ativo ? "checked" : ""}
          onchange="_veAtualizar(${idx}, 'ativo', this.checked)"
        >
        <span class="toggle-slider"></span>
      </label>
      <span style="font-size:0.68rem;color:${v.ativo ? "#16a34a" : "#dc2626"}">${v.ativo ? "Disponível" : "Pausado"}</span>
    </div>

    <!-- Botão remover -->
    <button
      type="button"
      class="btn btn-sm btn-danger"
      onclick="veRemoverLinha(${idx})"
      title="Remover variação"
      style="align-self:start"
    >✕</button>
  `;

  return row;
}

// Utilitário de escape HTML
function _esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ──────────────────────────────────────────────────────────────
//  6. Helpers de atualização de estado
// ──────────────────────────────────────────────────────────────
function _veAtualizar(idx, campo, valor) {
  if (!_ve_variacoes[idx]) return;
  _ve_variacoes[idx][campo] = valor;
  _veAtualizarTotalizador();
}

function _veAlterarQtd(idx, delta) {
  if (!_ve_variacoes[idx] || !_ve_variacoes[idx].controlar_estoque) return;
  const novaQtd = Math.max(0, (_ve_variacoes[idx].estoque_qtd || 0) + delta);
  _ve_variacoes[idx].estoque_qtd = novaQtd;
  _veRenderizarLista();
}

function veRemoverLinha(idx) {
  _ve_variacoes.splice(idx, 1);
  _veRenderizarLista();
}

function _veAtualizarTotalizador() {
  const el = document.getElementById("ve-totalizador");
  const qtdEl = document.getElementById("ve-total-qtd");
  if (!el || !qtdEl) return;

  const total = _ve_variacoes.reduce((s, v) => {
    return s + (v.controlar_estoque ? v.estoque_qtd || 0 : 0);
  }, 0);

  if (_ve_variacoes.length > 0) {
    el.style.display = "block";
    qtdEl.textContent = total.toLocaleString("es-PY");
  } else {
    el.style.display = "none";
  }
}

// ──────────────────────────────────────────────────────────────
//  7. veSalvarVariacoes(prodId)
//     Persiste as variações no banco (upsert + delete de removidas).
//     Chame isso dentro da sua função salvarProduto() APÓS salvar
//     o produto principal, usando o prodId retornado.
//
//  Uso:
//    const prodIdSalvo = ...; // id retornado pelo INSERT/UPDATE
//    const ok = await veSalvarVariacoes(prodIdSalvo);
//    if (!ok) { alert('Erro ao salvar variações'); return; }
// ──────────────────────────────────────────────────────────────
async function veSalvarVariacoes(prodId) {
  try {
    // ── Sincroniza estado dos inputs com _ve_variacoes ─────────
    _veLerDOMParaEstado();

    // ── IDs que existiam antes (para detectar exclusões) ───────
    const idsSalvos = _ve_variacoesSalvas.filter((v) => v.id).map((v) => v.id);

    const idsAtuais = _ve_variacoes.filter((v) => v.id).map((v) => v.id);

    const idsRemovidos = idsSalvos.filter((id) => !idsAtuais.includes(id));

    // ── Exclui variações removidas ──────────────────────────────
    if (idsRemovidos.length > 0) {
      const { error } = await supa
        .from("produto_variacoes")
        .delete()
        .in("id", idsRemovidos);
      if (error) throw new Error("Erro ao excluir variações: " + error.message);
    }

    // ── Upsert das variações restantes ─────────────────────────
    if (_ve_variacoes.length > 0) {
      const payload = _ve_variacoes
        .filter((v) => v.nome && v.nome.trim()) // ignora linhas sem nome
        .map((v, i) => {
          const obj = {
            produto_id: prodId,
            nome: v.nome.trim(),
            sku: v.sku?.trim() || null,
            estoque_qtd: v.controlar_estoque
              ? Math.max(0, parseInt(v.estoque_qtd) || 0)
              : 0,
            controlar_estoque: !!v.controlar_estoque,
            preco_adicional: parseFloat(v.preco_adicional) || 0,
            preco_absoluto: !!v.preco_absoluto,
            ativo: v.ativo !== false,
            ordem: i,
          };
          if (v.id) obj.id = v.id; // inclui id para UPDATE
          return obj;
        });

      if (payload.length > 0) {
        const { error } = await supa
          .from("produto_variacoes")
          .upsert(payload, { onConflict: "id" });
        if (error)
          throw new Error("Erro ao salvar variações: " + error.message);
      }
    }

    console.log(
      "[varejo-admin] Variações salvas com sucesso para produto",
      prodId,
    );
    return true;
  } catch (e) {
    console.error("[varejo-admin] veSalvarVariacoes:", e.message);
    alert("❌ " + e.message);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
//  8. _veLerDOMParaEstado()
//     Antes de salvar, lê todos os inputs do DOM de volta para
//     _ve_variacoes (garante valores mais recentes sem depender
//     só dos oninput).
// ──────────────────────────────────────────────────────────────
function _veLerDOMParaEstado() {
  const rows = document.querySelectorAll("#ve-lista .var-estoque-row");
  rows.forEach((row, idx) => {
    if (!_ve_variacoes[idx]) return;
    const nomeEl = row.querySelector(".ve-nome");
    const qtdEl = row.querySelector(".ve-qtd");
    if (nomeEl) _ve_variacoes[idx].nome = nomeEl.value.trim();
    if (qtdEl) _ve_variacoes[idx].estoque_qtd = parseInt(qtdEl.value) || 0;
  });
}

// ──────────────────────────────────────────────────────────────
//  9. Painel de estoque baixo (alertas no admin)
// ── ALERTA DE VALIDADE PRÓXIMA — Produtos ─────────────────────
//     Varre _todosProdutos após carregamento e exibe banner na
//     aba Produtos para itens vencidos ou vencendo em ≤ diasAlerta.
// ──────────────────────────────────────────────────────────────
function ptVerificarValidadeProdutos(diasAlertaPadrao = 7) {
  const el = document.getElementById("pt-alerta-validade");
  const li = document.getElementById("pt-alerta-validade-lista");
  if (!el || !li) return;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const alertas = [];
  (_todosProdutos || []).forEach((p) => {
    if (!p.perecivel || !p.data_validade) return;
    // Não alertar se produto está sem estoque (zerado ou pausado)
    if (p.ativo === false) return;
    if (p.estoque_qtd !== null && p.estoque_qtd !== undefined && p.estoque_qtd <= 0) return;
    const val = new Date(p.data_validade + "T00:00:00");
    const dias = Math.ceil((val - hoje) / 86400000);
    // Cada produto pode ter sua própria antecedência (7/15/30 dias);
    // cai no padrão (7) se o produto ainda não tiver o campo preenchido.
    const diasAlerta = p.dias_alerta_validade || diasAlertaPadrao;
    if (dias <= diasAlerta) {
      const label =
        dias < 0
          ? `${p.nome} (VENCIDO)`
          : dias === 0
            ? `${p.nome} (vence HOJE)`
            : `${p.nome} (vence em ${dias}d)`;
      alertas.push(label);
    }
  });
  if (alertas.length) {
    el.style.display = "block";
    li.textContent = alertas.join(" • ");
  } else {
    el.style.display = "none";
  }
}

//     Exibe badge de alerta na aba de Produtos quando há variações
//     com estoque crítico (≤ limiteAlerta).
// ──────────────────────────────────────────────────────────────
async function veVerificarEstoqueBaixo(limiteAlerta = 5) {
  const { data, error } = await supa
    .from("produto_variacoes")
    .select(
      "id, produto_id, nome, estoque_qtd, controlar_estoque, produtos(nome)",
    )
    .eq("ativo", true)
    .eq("controlar_estoque", true)
    .lte("estoque_qtd", limiteAlerta)
    .order("estoque_qtd");

  if (error || !data) return;

  // Filtrar: não exibir se estoque = 0 (esgotado — produto pausado automaticamente)
  const alertaveis = data.filter((v) => v.estoque_qtd > 0);

  const cont = document.getElementById("ve-alertas-estoque");
  if (!cont) return;

  if (!alertaveis.length) {
    cont.style.display = "none";
    return;
  }

  cont.style.display = "block";
  cont.innerHTML = `
    <div style="background:#fff3cd;border:1.5px solid #f0a500;border-radius:10px;padding:12px 16px;font-size:0.83rem">
      <b>⚠️ Estoque baixo (≤ ${limiteAlerta} unidades)</b>
      <ul style="margin-top:8px;padding-left:18px;line-height:1.9">
        ${alertaveis
          .map(
            (v) => `
          <li>
            <b>${v.produtos?.nome || "#" + v.produto_id}</b> — ${v.nome}:
            <span style="color:#e67e22;font-weight:700">
              ${v.estoque_qtd} un
            </span>
          </li>
        `,
          )
          .join("")}
      </ul>
    </div>
  `;
}

// ──────────────────────────────────────────────────────────────
//  10. INTEGRAÇÃO COM salvarProduto() EXISTENTE
//
//  Localize a sua função salvarProduto() em admin.js e, após
//  a linha que salva no banco:
//
//    if (id) await supa.from('produtos').update(dados).eq('id', id);
//    else    await supa.from('produtos').insert([dados]);
//
//  Adicione estas linhas (copie e cole):
//
//    // ── Salva variações de estoque (varejo) ──────────────────
//    const _prodIdSalvo = id
//      ? parseInt(id)
//      : (await supa.from('produtos').select('id').order('id', {ascending:false}).limit(1).single()).data?.id;
//    if (_prodIdSalvo && document.getElementById('secao-variacoes-estoque')) {
//      await veSalvarVariacoes(_prodIdSalvo);
//    }
//    // ── Fim variações ────────────────────────────────────────
//
//  E na função abrirModalProduto(), ao abrir com produto existente,
//  adicione:
//
//    veIniciarSecao(produto?.id || null);
//
//  E ao abrir para novo produto:
//
//    veIniciarSecao(null);
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
//  11. Painel de Estoque — aba standalone no admin
//      Renderiza tabela completa de variações com edição rápida
//      de quantidade. Adicione no admin.html uma aba com id="estoque"
//      e um div id="painel-estoque" dentro dela.
// ──────────────────────────────────────────────────────────────
async function veRenderizarPainelEstoque() {
  const cont = document.getElementById("painel-estoque");
  if (!cont) return;

  cont.innerHTML =
    '<div style="text-align:center;padding:30px;color:#aaa">Carregando...</div>';

  const { data, error } = await supa
    .from("produto_variacoes")
    .select(
      "id, produto_id, nome, sku, estoque_qtd, controlar_estoque, ativo, produtos(nome, categoria_slug, imagem_url)",
    )
    .order("produtos(nome)")
    .order("nome");

  if (error) {
    cont.innerHTML = `<p style="color:#e74c3c">Erro: ${error.message}</p>`;
    return;
  }

  if (!data || data.length === 0) {
    cont.innerHTML =
      '<p style="color:#aaa;text-align:center;padding:30px">Nenhuma variação cadastrada. Edite um produto para adicionar variações.</p>';
    return;
  }

  // Agrupa por produto
  const porProduto = {};
  data.forEach((v) => {
    const pid = v.produto_id;
    if (!porProduto[pid]) {
      porProduto[pid] = {
        nome: v.produtos?.nome || `#${pid}`,
        cat: v.produtos?.categoria_slug || "",
        img: v.produtos?.imagem_url || "",
        variacoes: [],
      };
    }
    porProduto[pid].variacoes.push(v);
  });

  // Filtragem rápida por nome
  const searchId = "ve-painel-busca-" + Date.now();
  cont.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      <input id="${searchId}" type="text" class="form-control"
        placeholder="🔍 Buscar produto ou variação..."
        oninput="veFiltrarPainel(this.value)"
        style="max-width:320px">
      <button class="btn btn-sm btn-success" onclick="veRenderizarPainelEstoque()">↺ Atualizar</button>
    </div>
    <div id="ve-painel-lista"></div>
  `;

  window._vePainelDados = porProduto; // guarda para filtro
  _veRenderizarTabelaPainel(porProduto);
}

function veFiltrarPainel(termo) {
  if (!window._vePainelDados) return;
  const t = termo.toLowerCase().trim();
  if (!t) {
    _veRenderizarTabelaPainel(window._vePainelDados);
    return;
  }
  const filtrado = {};
  Object.entries(window._vePainelDados).forEach(([pid, p]) => {
    const varFiltradas = p.variacoes.filter(
      (v) =>
        v.nome.toLowerCase().includes(t) ||
        (v.sku || "").toLowerCase().includes(t),
    );
    const nomeMatch = p.nome.toLowerCase().includes(t);
    if (nomeMatch || varFiltradas.length > 0) {
      filtrado[pid] = {
        ...p,
        variacoes: nomeMatch ? p.variacoes : varFiltradas,
      };
    }
  });
  _veRenderizarTabelaPainel(filtrado);
}

function _veRenderizarTabelaPainel(porProduto) {
  const lista = document.getElementById("ve-painel-lista");
  if (!lista) return;

  lista.innerHTML =
    Object.entries(porProduto)
      .map(([pid, p]) => {
        const linhas = p.variacoes
          .map((v) => {
            const esgotado = v.controlar_estoque && v.estoque_qtd <= 0;
            return `
        <tr style="background:${esgotado ? "#fff5f5" : "#fff"}">
          <td style="font-weight:600;padding:8px 12px">${_esc(v.nome)}</td>
          <td style="text-align:center;padding:8px 12px;color:#777;font-size:0.82rem">${_esc(v.sku || "—")}</td>
          <td style="text-align:center;padding:8px 12px">
            ${
              v.controlar_estoque
                ? `<div style="display:flex;align-items:center;justify-content:center;gap:6px">
                  <button onclick="veQuickUpdate(${v.id}, ${v.estoque_qtd - 1})"
                    style="width:24px;height:24px;border-radius:5px;border:1px solid #ccc;background:#fff;cursor:pointer">−</button>
                  <b style="color:${esgotado ? "#dc2626" : "#166534"};min-width:28px;text-align:center">${v.estoque_qtd}</b>
                  <button onclick="veQuickUpdate(${v.id}, ${v.estoque_qtd + 1})"
                    style="width:24px;height:24px;border-radius:5px;border:1px solid #ccc;background:#fff;cursor:pointer">+</button>
                </div>`
                : '<span style="color:#888;font-size:0.8rem">∞</span>'
            }
          </td>
          <td style="text-align:center;padding:8px 12px">
            <span style="background:${v.ativo ? "#dcfce7" : "#fee2e2"};color:${v.ativo ? "#166534" : "#dc2626"};
              border-radius:20px;padding:2px 10px;font-size:0.72rem;font-weight:700">
              ${v.ativo ? "●  Ativo" : "○  Pausado"}
            </span>
          </td>
        </tr>
      `;
          })
          .join("");

        return `
      <div style="background:#fff;border:1.5px solid #e5e7eb;border-radius:12px;margin-bottom:14px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f9fafb;border-bottom:1px solid #e5e7eb">
          ${p.img ? `<img src="${p.img}" style="width:36px;height:36px;border-radius:7px;object-fit:cover">` : '<div style="width:36px;height:36px;border-radius:7px;background:#eee;display:flex;align-items:center;justify-content:center;color:#ccc">📦</div>'}
          <div>
            <b style="font-size:0.95rem">${_esc(p.nome)}</b>
            ${p.cat ? `<span style="font-size:0.72rem;color:#888;margin-left:8px">${p.cat}</span>` : ""}
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f3f4f6;font-size:0.72rem;color:#777;text-transform:uppercase;letter-spacing:0.04em">
              <th style="padding:6px 12px;text-align:left">Variação</th>
              <th style="padding:6px 12px;text-align:center">SKU</th>
              <th style="padding:6px 12px;text-align:center">Estoque</th>
              <th style="padding:6px 12px;text-align:center">Status</th>
            </tr>
          </thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    `;
      })
      .join("") ||
    '<p style="color:#aaa;text-align:center;padding:20px">Nenhum resultado.</p>';
}

// ──────────────────────────────────────────────────────────────
//  12. veQuickUpdate — atualiza estoque direto do painel
// ──────────────────────────────────────────────────────────────
async function veQuickUpdate(variacaoId, novaQtd) {
  novaQtd = Math.max(0, novaQtd);
  const { error } = await supa
    .from("produto_variacoes")
    .update({ estoque_qtd: novaQtd })
    .eq("id", variacaoId);

  if (error) {
    if (typeof mostrarToast === "function")
      mostrarToast("Erro ao atualizar estoque", "error");
    return;
  }

  // Atualiza o dado em memória
  if (window._vePainelDados) {
    Object.values(window._vePainelDados).forEach((p) => {
      const v = p.variacoes.find((v) => v.id === variacaoId);
      if (v) v.estoque_qtd = novaQtd;
    });
    _veRenderizarTabelaPainel(window._vePainelDados);
  }

  if (typeof mostrarToast === "function")
    mostrarToast("Estoque atualizado!", "success", 1500);
}

// ══════════════════════════════════════════════════════════════
//  VAREJO — Sugestões de variações por tipo
// ══════════════════════════════════════════════════════════════

/**
 * Mostra chips de sugestão de variações quando a lista está vazia.
 * Clique em um chip adiciona automaticamente a variação com qtd=10.
 */
function _veMostrarSugestoes(sugestoes) {
  const lista = document.getElementById("ve-lista");
  if (!lista || _ve_variacoes.length > 0) return;

  const wrap = document.createElement("div");
  wrap.id = "ve-sugestoes-wrap";
  wrap.style.cssText = "margin-bottom:10px";
  wrap.innerHTML = `
    <p style="font-size:0.75rem;color:#888;margin-bottom:6px">
      💡 Sugestões rápidas — clique para adicionar:
    </p>
    <div style="display:flex;flex-wrap:wrap;gap:7px">
      ${sugestoes
        .map(
          (s) => `
        <button type="button"
          onclick="_veAdicionarSugestao('${s.replace(/'/g, "\\'")}')"
          style="padding:5px 12px;border:1.5px dashed #c4b5fd;background:#faf5ff;
                 border-radius:20px;font-size:0.78rem;color:#7c3aed;cursor:pointer">
          + ${s}
        </button>
      `,
        )
        .join("")}
    </div>
  `;

  // Insere antes da lista real
  const cont = document.getElementById("secao-variacoes-estoque");
  const headerEl = cont?.querySelector(".var-estoque-section-header");
  if (headerEl) headerEl.after(wrap);
}

function _veAdicionarSugestao(nome) {
  // Remove o painel de sugestões após primeiro uso
  document.getElementById("ve-sugestoes-wrap")?.remove();
  veAdicionarLinha({ nome, estoque_qtd: 10 });
}

// ══════════════════════════════════════════════════════════════
//  MOEDA DUPLA — Admin (Configurações + preview modal)
// ══════════════════════════════════════════════════════════════

// ── Chaves no localStorage ────────────────────────────────────
const _VC_KEY_ATIVO = "vc_ativo";
const _VC_KEY_TAXA = "vc_taxa";
const _VC_KEY_POSICAO = "vc_posicao";

/**
 * Carrega config salva e preenche os campos da aba Configurações.
 * Chame dentro de showTab('configuracoes') ou no DOMContentLoaded.
 */
function vcCarregarConfig() {
  const ativo = localStorage.getItem(_VC_KEY_ATIVO) === "true";
  const taxa = parseFloat(localStorage.getItem(_VC_KEY_TAXA)) || 0;
  const posicao = localStorage.getItem(_VC_KEY_POSICAO) || "abaixo";

  const elAtivo = document.getElementById("vc-ativo");
  const elTaxa = document.getElementById("vc-taxa");
  const elPosicao = document.getElementById("vc-posicao");

  if (elAtivo) {
    elAtivo.checked = ativo;
    vcToggle(ativo, false);
  }
  if (elTaxa) {
    elTaxa.value = taxa || "";
  }
  if (elPosicao) {
    elPosicao.value = posicao;
  }

  vcAtualizarLabel();
}

/** Atualiza o label "1 R$ = X Gs" ao vivo */
function vcAtualizarLabel() {
  const taxa = parseFloat(document.getElementById("vc-taxa")?.value) || 0;
  const el = document.getElementById("vc-taxa-label");
  if (el) el.textContent = taxa > 0 ? taxa.toLocaleString("es-PY") : "?";

  // Atualiza preview
  const prevCfg = document.getElementById("vc-preview-cfg");
  const prevBrl = document.getElementById("vc-prev-brl");
  if (!prevCfg || !prevBrl) return;

  if (taxa > 0 && document.getElementById("vc-ativo")?.checked) {
    prevCfg.style.display = "block";
    const exemplGs = 150000;
    const brl = exemplGs / taxa;
    prevBrl.textContent = `= R$ ${brl.toFixed(2)}`;
  } else {
    prevCfg.style.display = "none";
  }
}

function vcToggle(on, atualizarPreview = true) {
  const label = document.getElementById("vc-ativo-label");
  if (label) {
    label.textContent = on ? "Ativado ✅" : "Desativado";
    label.style.color = on ? "#16a34a" : "#888";
  }
  if (atualizarPreview) vcAtualizarLabel();
}

/** Salva configurações no localStorage e propaga para o app do cliente */
function vcSalvar() {
  const ativo = document.getElementById("vc-ativo")?.checked || false;
  const taxa = parseFloat(document.getElementById("vc-taxa")?.value) || 0;
  const posicao = document.getElementById("vc-posicao")?.value || "abaixo";

  if (ativo && taxa <= 0) {
    alert("Informe a taxa de conversão (Ex: 1450) para ativar o preço em R$.");
    return;
  }

  localStorage.setItem(_VC_KEY_ATIVO, String(ativo));
  localStorage.setItem(_VC_KEY_TAXA, String(taxa));
  localStorage.setItem(_VC_KEY_POSICAO, posicao);

  // Persiste também no banco (tabela configuracoes, coluna vc_config)
  if (window.supa) {
    supa
      .from("configuracoes")
      .update({ vc_config: { ativo, taxa, posicao } })
      .eq("id", 1)
      .then(({ error }) => {
        if (error) console.warn("vcSalvar banco:", error.message);
      });
  }

  if (typeof mostrarToast === "function") {
    mostrarToast(
      ativo
        ? `Taxa salva: 1 R$ = Gs ${taxa.toLocaleString("es-PY")}`
        : "Exibição em R$ desativada.",
      "success",
      2500,
    );
  } else {
    alert(
      ativo
        ? `✅ Taxa salva: 1 R$ = Gs ${taxa.toLocaleString("es-PY")}`
        : "✅ Exibição em R$ desativada.",
    );
  }
}

/**
 * Preview no modal de produto — chamado pelo oninput do campo prod-preco.
 * Exibe o equivalente em R$ abaixo do campo de preço.
 */
function vcAtualizarPreviewModal(gsValor) {
  const el = document.getElementById("vc-preview-modal");
  if (!el) return;

  const ativo = localStorage.getItem(_VC_KEY_ATIVO) === "true";
  const taxa = parseFloat(localStorage.getItem(_VC_KEY_TAXA)) || 0;
  const gs = parseFloat(gsValor) || 0;

  if (!ativo || taxa <= 0 || gs <= 0) {
    el.textContent = "";
    return;
  }

  const brl = gs / taxa;
  el.textContent = `≈ R$ ${brl.toFixed(2)} (taxa: 1 R$ = Gs ${taxa.toLocaleString("es-PY")})`;
}

// Carrega config quando a aba de configurações é aberta
(function _vcPatchShowTab() {
  const _origShowTab = window.showTab;
  if (typeof _origShowTab !== "function") return;
  window.showTab = function (tabId, event) {
    _origShowTab(tabId, event);
    if ((tabId || "").includes("configuracoes")) {
      setTimeout(vcCarregarConfig, 50);
    }
  };
})();

// ══════════════════════════════════════════════════════════════
//  PROMOÇÃO — Helpers do formulário de produto
// ══════════════════════════════════════════════════════════════

function togglePromoFields(on) {
  const fields = document.getElementById("prod-promo-fields");
  if (fields) fields.style.display = on ? "grid" : "none";
  if (on) promoAtualizarPreview();
}

function promoAtualizarPreview() {
  const tipo  = document.getElementById("prod-promo-tipo")?.value  || "percent";
  const valor = parseFloat(document.getElementById("prod-promo-valor")?.value) || 0;

  // ── Lê o preço do dataset.valorNumerico (número puro), com fallback para value
  const _p = document.getElementById("prod-preco");
  const preco =
    parseInt(
      _p?.dataset?.valorNumerico ||
      (_p?.value || "").replace(/\D/g, "") ||
      "0",
      10
    ) || 0;

  const prev  = document.getElementById("prod-promo-preview");
  const label = document.getElementById("prod-promo-valor-label");

  if (label) label.textContent = tipo === "percent" ? "Desconto (%)" : "Desconto (Gs)";
  if (!prev) return;

  if (!valor || !preco) {
    prev.textContent = "";
    return;
  }

  const precoFinal =
    tipo === "percent" ? preco * (1 - valor / 100) : preco - valor;

  if (precoFinal < 0) {
    prev.textContent = "⚠️ Desconto maior que o preço!";
    prev.style.color = "#dc2626";
    return;
  }

  prev.style.color = "#16a34a";
  prev.innerHTML = `
    De <s style="color:#aaa">Gs ${Math.round(preco).toLocaleString("es-PY")}</s>
    por <b style="color:#dc2626">Gs ${Math.round(precoFinal).toLocaleString("es-PY")}</b>
    ${tipo === "percent"
      ? `(${valor}% off)`
      : `(- Gs ${Math.round(valor).toLocaleString("es-PY")})`}
  `;
}

// ── Atualiza _TIPO_ICONS e _TIPO_NAMES com tipos varejo ──────
// (sobrescreve as versões locais dentro de renderizarCardsProdutos)
const _VAREJO_TIPO_ICONS_PATCH = {
  roupa: "👕",
  eletronico: "🔌",
  suplemento: "💪",
  pod: "☁️",
  mercado: "🛒",
};
const _VAREJO_TIPO_NAMES_PATCH = {
  roupa: "Roupa",
  eletronico: "Eletrônico",
  suplemento: "Suplemento",
  pod: "Pod",
  mercado: "Mercado",
};
// Injeta no próximo ciclo para garantir que renderizarCardsProdutos já foi definida
setTimeout(() => {
  const origRender = window.renderizarCardsProdutos;
  if (typeof origRender !== "function") return;
  window.renderizarCardsProdutos = function (lista) {
    // Injeta ícones varejo nos mapas locais da função original
    // (feito via patch do tipoKey lookup — sem reescrever a função toda)
    origRender(lista);
  };
}, 0);

// ══════════════════════════════════════════════════════════════
//  IMPORTAÇÃO / EXPORTAÇÃO DE PRODUTOS
//  Formatos suportados: CSV, JSON, XLSX (SheetJS via CDN)
// ══════════════════════════════════════════════════════════════

// ── Colunas disponíveis ───────────────────────────────────────
const _IMPEXP_COLUNAS = [
  { key: "nome", label: "Nome", obrigatorio: true },
  { key: "descricao", label: "Descrição", obrigatorio: false },
  { key: "preco", label: "Preço (Gs)", obrigatorio: true },
  { key: "categoria_slug", label: "Categoria", obrigatorio: false },
  { key: "subcategoria_slug", label: "Subcategoria", obrigatorio: false },
  { key: "unidade_venda", label: "Unidade", obrigatorio: false },
  { key: "estoque_qtd", label: "Estoque", obrigatorio: false },
  { key: "destaque", label: "Destaque", obrigatorio: false },
  { key: "ativo", label: "Ativo", obrigatorio: false },
  { key: "somente_balcao", label: "Só Balcão", obrigatorio: false },
  { key: "promo_ativo", label: "Promoção Ativa", obrigatorio: false },
  { key: "promo_tipo", label: "Tipo Desconto", obrigatorio: false },
  { key: "promo_valor", label: "Valor Desconto", obrigatorio: false },
  { key: "imagem_url", label: "URL Imagem", obrigatorio: false },
];

// Colunas marcadas por padrão
const _IMPEXP_COLUNAS_DEFAULT = [
  "nome",
  "descricao",
  "preco",
  "categoria_slug",
  "unidade_venda",
  "estoque_qtd",
  "destaque",
  "ativo",
  "promo_ativo",
  "promo_tipo",
  "promo_valor",
];

let _impexpDadosImport = []; // linhas parseadas prontas para salvar

// ── Abrir / fechar modal ──────────────────────────────────────
function impexpAbrir() {
  const modal = document.getElementById("modal-impexp");
  if (!modal) return;
  impexpMostrarAba("exportar");
  _impexpRenderizarColunas();
  _impexpCarregarCategorias();
  modal.style.display = "flex";
}

function impexpFechar() {
  const modal = document.getElementById("modal-impexp");
  if (modal) modal.style.display = "none";
  impexpLimparPreview();
}

// ── Abas internas ─────────────────────────────────────────────
function impexpMostrarAba(aba) {
  const isExp = aba === "exportar";
  document.getElementById("impexp-painel-exportar").style.display = isExp
    ? "block"
    : "none";
  document.getElementById("impexp-painel-importar").style.display = isExp
    ? "none"
    : "block";

  const btnExp = document.getElementById("impexp-tab-exp");
  const btnImp = document.getElementById("impexp-tab-imp");
  if (btnExp) {
    btnExp.style.background = isExp ? "#1a7a2e" : "transparent";
    btnExp.style.color = isExp ? "#fff" : "#555";
  }
  if (btnImp) {
    btnImp.style.background = isExp ? "transparent" : "#1a7a2e";
    btnImp.style.color = isExp ? "#555" : "#fff";
  }
}

// ── Checkboxes de colunas ─────────────────────────────────────
function _impexpRenderizarColunas() {
  const wrap = document.getElementById("impexp-colunas-wrap");
  if (!wrap) return;
  wrap.innerHTML = _IMPEXP_COLUNAS
    .map((c) => {
      const checked = _IMPEXP_COLUNAS_DEFAULT.includes(c.key) || c.obrigatorio;
      const disabled = c.obrigatorio ? "disabled" : "";
      return `
      <label style="display:flex;align-items:center;gap:5px;cursor:pointer;
        background:#f9fafb;border:1px solid #e5e7eb;border-radius:7px;
        padding:5px 10px;font-size:0.78rem;font-weight:600;
        ${c.obrigatorio ? "opacity:0.7" : ""}">
        <input type="checkbox" class="impexp-col-chk" value="${c.key}"
          ${checked ? "checked" : ""} ${disabled}>
        ${c.label}${c.obrigatorio ? ' <span style="color:#dc2626">*</span>' : ""}
      </label>`;
    })
    .join("");
}

function impexpSelecionarTodasColunas(on) {
  document
    .querySelectorAll(".impexp-col-chk:not([disabled])")
    .forEach((c) => (c.checked = on));
}

async function _impexpCarregarCategorias() {
  const sel = document.getElementById("impexp-exp-cat");
  if (!sel || sel.options.length > 1) return;
  const { data } = await supa
    .from("categorias")
    .select("slug,nome_exibicao")
    .order("nome_exibicao");
  if (data)
    data.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.slug;
      opt.textContent = c.nome_exibicao;
      sel.appendChild(opt);
    });
}

// ─────────────────────────────────────────────────────────────
//  EXPORTAÇÃO
// ─────────────────────────────────────────────────────────────
async function impexpExportar() {
  const infoEl = document.getElementById("impexp-exp-info");
  if (infoEl) infoEl.textContent = "Buscando dados…";

  // Colunas selecionadas
  const colunas = [...document.querySelectorAll(".impexp-col-chk:checked")].map(
    (c) => c.value,
  );
  if (!colunas.length) {
    alert("Selecione ao menos uma coluna.");
    return;
  }

  // Filtros
  const catFiltro = document.getElementById("impexp-exp-cat")?.value;
  const statusFiltro = document.getElementById("impexp-exp-status")?.value;

  let query = supa.from("produtos").select(colunas.join(",")).order("nome");
  if (catFiltro) query = query.eq("categoria_slug", catFiltro);
  if (statusFiltro === "ativo")
    query = query.eq("ativo", true).eq("pausado", false);
  if (statusFiltro === "pausado") query = query.eq("pausado", true);
  if (statusFiltro === "destaque") query = query.eq("destaque", true);

  const { data, error } = await query;
  if (error) {
    alert("Erro ao exportar: " + error.message);
    return;
  }
  if (!data?.length) {
    if (infoEl)
      infoEl.textContent = "Nenhum produto encontrado com esses filtros.";
    return;
  }

  const formato =
    document.querySelector("input[name='impexp-formato']:checked")?.value ||
    "csv";
  const nomeArq = `produtos_${new Date().toISOString().slice(0, 10)}`;

  if (formato === "csv") _impexpBaixarCSV(data, colunas, nomeArq + ".csv");
  if (formato === "json") _impexpBaixarJSON(data, nomeArq + ".json");
  if (formato === "xlsx") _impexpBaixarXLSX(data, colunas, nomeArq + ".xlsx");

  if (infoEl)
    infoEl.textContent = `✅ ${data.length} produto(s) exportado(s) — ${formato.toUpperCase()}`;
}

function _impexpBaixarCSV(rows, colunas, nomeArq) {
  const escapar = (v) => {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const header = colunas
    .map((c) => _IMPEXP_COLUNAS.find((x) => x.key === c)?.label || c)
    .join(",");
  const linhas = rows.map((r) => colunas.map((c) => escapar(r[c])).join(","));
  _impexpDownload(
    "\uFEFF" + [header, ...linhas].join("\r\n"), // BOM para Excel reconhecer UTF-8
    nomeArq,
    "text/csv;charset=utf-8;",
  );
}

function _impexpBaixarJSON(rows, nomeArq) {
  _impexpDownload(JSON.stringify(rows, null, 2), nomeArq, "application/json");
}

function _impexpBaixarXLSX(rows, colunas, nomeArq) {
  // Usa SheetJS (XLSX) — carregado dinamicamente se necessário
  const _fazer = () => {
    const XLSX = window.XLSX;
    if (!XLSX) {
      alert("Biblioteca XLSX não disponível. Tente CSV ou JSON.");
      return;
    }
    const wsData = [
      colunas.map((c) => _IMPEXP_COLUNAS.find((x) => x.key === c)?.label || c),
      ...rows.map((r) => colunas.map((c) => r[c] ?? "")),
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    // Larguras automáticas
    ws["!cols"] = colunas.map(() => ({ wch: 20 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Produtos");
    XLSX.writeFile(wb, nomeArq);
  };

  if (!window.XLSX) {
    const script = document.createElement("script");
    script.src =
      "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
    script.onload = _fazer;
    document.head.appendChild(script);
  } else {
    _fazer();
  }
}

function _impexpDownload(conteudo, nomeArq, mimeType) {
  const blob = new Blob([conteudo], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArq;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

// ─────────────────────────────────────────────────────────────
//  TEMPLATES PARA DOWNLOAD
// ─────────────────────────────────────────────────────────────
function impexpBaixarTemplate(formato) {
  const exemplo = [
    {
      nome: "Camiseta Básica Branca",
      descricao: "100% algodão penteado",
      preco: 85000,
      categoria_slug: "roupas",
      subcategoria_slug: "",
      unidade_venda: "un",
      estoque_qtd: 50,
      destaque: false,
      ativo: true,
      somente_balcao: false,
      promo_ativo: false,
      promo_tipo: "percent",
      promo_valor: "",
      imagem_url: "",
    },
    {
      nome: "Whey Protein Chocolate 900g",
      descricao: "Proteína isolada 80%",
      preco: 320000,
      categoria_slug: "suplementos",
      subcategoria_slug: "",
      unidade_venda: "un",
      estoque_qtd: 20,
      destaque: true,
      ativo: true,
      somente_balcao: false,
      promo_ativo: true,
      promo_tipo: "percent",
      promo_valor: 10,
      imagem_url: "",
    },
  ];

  if (formato === "csv") {
    const cols = Object.keys(exemplo[0]);
    _impexpBaixarCSV(exemplo, cols, "template_produtos.csv");
  } else {
    _impexpBaixarJSON(exemplo, "template_produtos.json");
  }
}

// ─────────────────────────────────────────────────────────────
//  IMPORTAÇÃO — parse e preview
// ─────────────────────────────────────────────────────────────
async function impexpProcessarArquivo(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    alert("Arquivo muito grande (máx 5 MB).");
    return;
  }

  const ext = file.name.split(".").pop().toLowerCase();
  const texto = await file.text();

  try {
    if (ext === "json") {
      _impexpDadosImport = JSON.parse(texto);
      if (!Array.isArray(_impexpDadosImport))
        _impexpDadosImport = [_impexpDadosImport];
    } else if (ext === "csv") {
      _impexpDadosImport = _impexpParsarCSV(texto);
    } else {
      alert("Formato não suportado. Use .csv ou .json");
      return;
    }
    _impexpRenderizarPreview(_impexpDadosImport);
  } catch (e) {
    alert("Erro ao ler arquivo: " + e.message);
  }
}

function _impexpParsarCSV(texto) {
  const linhas = texto
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l) => l.trim());
  if (linhas.length < 2) throw new Error("CSV vazio ou sem dados.");

  // Parser simples que respeita campos entre aspas
  const parseLinha = (linha) => {
    const resultado = [];
    let campo = "",
      dentro = false;
    for (let i = 0; i < linha.length; i++) {
      const ch = linha[i];
      if (ch === '"') {
        if (dentro && linha[i + 1] === '"') {
          campo += '"';
          i++;
        } else dentro = !dentro;
      } else if (ch === "," && !dentro) {
        resultado.push(campo);
        campo = "";
      } else {
        campo += ch;
      }
    }
    resultado.push(campo);
    return resultado;
  };

  // Tenta mapear cabeçalho — aceita label PT ou key EN
  const _labelParaKey = (label) => {
    const norm = label.trim().toLowerCase();
    const found = _IMPEXP_COLUNAS.find(
      (c) => c.key.toLowerCase() === norm || c.label.toLowerCase() === norm,
    );
    return found ? found.key : norm;
  };

  const cabecalho = parseLinha(linhas[0]).map(_labelParaKey);
  return linhas
    .slice(1)
    .filter((l) => l.trim())
    .map((linha) => {
      const vals = parseLinha(linha);
      const obj = {};
      cabecalho.forEach((k, i) => {
        let v = (vals[i] ?? "").trim();
        // Coerce tipos
        if (["preco", "estoque_qtd", "promo_valor"].includes(k))
          v = v === "" ? null : parseFloat(v) || 0;
        if (
          ["destaque", "ativo", "somente_balcao", "promo_ativo"].includes(k)
        ) {
          v = ["true", "1", "sim", "yes"].includes(
            (v || "").toString().toLowerCase(),
          );
        }
        obj[k] = v;
      });
      return obj;
    });
}

function _impexpRenderizarPreview(dados) {
  const wrap = document.getElementById("impexp-preview-wrap");
  const info = document.getElementById("impexp-preview-info");
  const thead = document.getElementById("impexp-preview-thead");
  const tbody = document.getElementById("impexp-preview-tbody");
  const errosEl = document.getElementById("impexp-erros");
  if (!wrap || !thead || !tbody) return;

  // Valida linhas
  const erros = [];
  dados.forEach((row, i) => {
    if (!row.nome || String(row.nome).trim() === "")
      erros.push(`Linha ${i + 2}: campo "Nome" obrigatório`);
    if (row.preco == null || isNaN(row.preco))
      erros.push(`Linha ${i + 2}: campo "Preço" inválido`);
  });

  if (errosEl) {
    if (erros.length) {
      errosEl.style.display = "block";
      errosEl.innerHTML = `
        <div style="background:#fef2f2;border:1.5px solid #fca5a5;border-radius:8px;padding:10px 14px;font-size:0.78rem;color:#991b1b">
          <b>⚠️ ${erros.length} problema(s) encontrado(s):</b>
          <ul style="margin:6px 0 0 16px;padding:0">${erros
            .slice(0, 5)
            .map((e) => `<li>${e}</li>`)
            .join("")}
            ${erros.length > 5 ? `<li>… e mais ${erros.length - 5}</li>` : ""}
          </ul>
        </div>`;
    } else {
      errosEl.style.display = "none";
    }
  }

  if (info) {
    const novos = dados.filter(
      (r) => !_todosProdutos?.find((p) => p.nome === r.nome),
    ).length;
    const update = dados.length - novos;
    info.innerHTML = `
      <span style="color:#16a34a;font-weight:700">${dados.length} linha(s)</span> — 
      <span style="color:#2563eb">${novos} novo(s)</span> · 
      <span style="color:#d97706">${update} atualização(ões)</span>`;
  }

  // Cabeçalho
  const cols = Object.keys(dados[0] || {});
  thead.innerHTML = `<tr>${cols.map((c) => `<th style="padding:6px 10px;text-align:left;font-size:0.72rem;color:#6b7280;white-space:nowrap">${c}</th>`).join("")}</tr>`;

  // Primeiras 20 linhas
  tbody.innerHTML = dados
    .slice(0, 20)
    .map(
      (row, i) => `
    <tr style="background:${i % 2 === 0 ? "#fff" : "#f9fafb"}">
      ${cols
        .map((c) => {
          const v = row[c];
          const display = v === true ? "✅" : v === false ? "—" : (v ?? "");
          return `<td style="padding:5px 10px;font-size:0.75rem;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis">${display}</td>`;
        })
        .join("")}
    </tr>`,
    )
    .join("");

  if (dados.length > 20) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="${cols.length}" style="padding:8px;text-align:center;color:#888;font-size:0.75rem">… e mais ${dados.length - 20} linha(s)</td>`;
    tbody.appendChild(tr);
  }

  wrap.style.display = "block";
  document.getElementById("impexp-salvar-label").textContent = erros.length
    ? `Salvar mesmo assim (${dados.length} produtos)`
    : `Salvar ${dados.length} produto(s) no banco`;
}

function impexpLimparPreview() {
  _impexpDadosImport = [];
  const wrap = document.getElementById("impexp-preview-wrap");
  if (wrap) wrap.style.display = "none";
  const fi = document.getElementById("impexp-file-input");
  if (fi) fi.value = "";
}

// ─────────────────────────────────────────────────────────────
//  IMPORTAÇÃO — salvar no banco (upsert por nome)
// ─────────────────────────────────────────────────────────────
async function impexpSalvar() {
  if (!_impexpDadosImport.length) return;

  const btn = document.querySelector("#impexp-preview-wrap .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Salvando…"; }

  // ── 1. Normaliza os dados (mesmo formato que você já usa) ──
  const payload = _impexpDadosImport
    .filter((r) => r.nome && String(r.nome).trim())
    .map((r) => ({
      nome: String(r.nome).trim(),
      descricao: r.descricao || "",
      preco: parseInt(r.preco) || 0,
      categoria_slug: r.categoria_slug || null,
      subcategoria_slug: r.subcategoria_slug || null,
      unidade_venda: r.unidade_venda || null,
      estoque_qtd: r.estoque_qtd != null ? parseInt(r.estoque_qtd) : null,
      destaque: !!r.destaque,
      ativo: r.ativo !== false && r.ativo !== 0,
      somente_balcao: !!r.somente_balcao,
      promo_ativo: !!r.promo_ativo,
      promo_tipo: r.promo_tipo || "percent",
      promo_valor: r.promo_valor ? parseFloat(r.promo_valor) : null,
      imagem_url: r.imagem_url || "",
      codigo_barras: r.codigo_barras || null,
    }));

  // ── 2. Deduplica por nome (o JSON tem duplicatas: "Barrinha Bless..."x2) ──
  //    Mantém o ÚLTIMO registro de cada nome (o que veio por último no array)
  const mapaUnicos = {};
  payload.forEach((p) => { mapaUnicos[p.nome] = p; });
  const payloadUnico = Object.values(mapaUnicos);

  // ── 3. Busca nomes já existentes no banco (uma query só) ──
  const nomes = payloadUnico.map((p) => p.nome);
  const { data: existentes, error: errBusca } = await supa
    .from("produtos")
    .select("id, nome")
    .in("nome", nomes);

  if (errBusca) {
    console.error("Erro ao buscar existentes:", errBusca);
    alert("❌ Erro ao consultar produtos existentes: " + errBusca.message);
    if (btn) { btn.disabled = false; btn.textContent = "Salvar"; }
    return;
  }

  const mapaExistentes = {};
  (existentes || []).forEach((e) => { mapaExistentes[e.nome] = e.id; });

  // ── 4. Separa em novos × atualizações ──
  const novos = [];
  const atualizacoes = [];
  payloadUnico.forEach((p) => {
    if (mapaExistentes[p.nome]) {
      atualizacoes.push({ id: mapaExistentes[p.nome], dados: p });
    } else {
      novos.push(p);
    }
  });

  let salvos = 0;
  let erros = 0;
  const errosDetalhados = [];

  // ── 5. INSERT dos novos em lotes de 100 ──
  const LOTE = 100;
  for (let i = 0; i < novos.length; i += LOTE) {
    const lote = novos.slice(i, i + LOTE);
    const { error } = await supa.from("produtos").insert(lote);
    if (error) {
      console.error("Insert erro:", error);
      erros += lote.length;
      errosDetalhados.push(`INSERT (lote ${Math.floor(i/LOTE)+1}): ${error.message}`);
    } else {
      salvos += lote.length;
    }
    if (btn) btn.textContent = `Salvando… (${salvos}/${payloadUnico.length})`;
  }

  // ── 6. UPDATE dos existentes (um a um, é rápido pra ~250 itens) ──
  for (const item of atualizacoes) {
    const { error } = await supa
      .from("produtos")
      .update(item.dados)
      .eq("id", item.id);
    if (error) {
      console.error("Update erro:", error);
      erros++;
      errosDetalhados.push(`UPDATE "${item.dados.nome}": ${error.message}`);
    } else {
      salvos++;
    }
    if (btn) btn.textContent = `Salvando… (${salvos}/${payloadUnico.length})`;
  }

  if (btn) {
    btn.disabled = false;
    btn.textContent = `Salvar ${payloadUnico.length} produto(s) no banco`;
  }

  // ── 7. Feedback ──
  if (erros === 0) {
    if (typeof mostrarToast === "function")
      mostrarToast(`✅ ${salvos} produto(s) importado(s)!`, "success", 3500);
    else alert(`✅ ${salvos} produto(s) importado(s)!`);
    impexpFechar();
    carregarProdutos();
  } else {
    console.warn("Erros detalhados:", errosDetalhados);
    alert(
      `⚠️ ${salvos} salvos, ${erros} com erro.\n\n` +
      errosDetalhados.slice(0, 3).join("\n") +
      (errosDetalhados.length > 3 ? `\n… e mais ${errosDetalhados.length - 3}` : "") +
      "\n\nVeja o console (F12) para detalhes."
    );
  }
}

/**
 * Gera o HTML de UMA etiqueta de produto.
 * Otimizado para impressora térmica 48mm:
 *   • 100% texto preto — nada de cinza (#666) ou cores invertidas
 *   • Layout compacto, sem bordas externas (aproveita o gap da bobina)
 *   • Suporta 3 modos de preço: tiers (varejo/atacado), preço único, ou sem preço
 *
 * @param {object} produto
 * @param {number} index   — usado para gerar ID único do SVG do barcode
 * @returns {string} HTML da etiqueta
 */

/**
 * Motor de impressão em lote.
 * Abre UM iframe, gera N etiquetas, carrega JsBarcode UMA vez,
 * renderiza todos os códigos e dispara UMA janela de impressão.
 * Cada etiqueta vira uma "página" — a impressora avança uma por vez.
 *
 * @param {Array<object>} produtos
 */

// ═══════════════════════════════════════════════════════════════
//  IMPRESSÃO DE ETIQUETAS — Sistema completo
//  - Texto 100% preto (térmica não imprime cinza)
//  - Suporta 4 larguras: 48 / 58 / 72 / 80 mm
//  - Impressão em massa com 1 clique
// ═══════════════════════════════════════════════════════════════

/**
 * Mapa de dimensões por largura de bobina.
 * Escala proporcionalmente paddings, fontes e código de barras.
 */
const _LABEL_SIZES = {
  48: { total: 48, inner: 44, pad: 1.5, scale: 1.00, barcodeH: 32, thumb: 10 },
  58: { total: 58, inner: 54, pad: 2.0, scale: 1.15, barcodeH: 38, thumb: 12 },
  72: { total: 72, inner: 68, pad: 2.5, scale: 1.40, barcodeH: 46, thumb: 14 },
  80: { total: 80, inner: 76, pad: 3.0, scale: 1.55, barcodeH: 52, thumb: 16 },
};

const _LABEL_SIZE_STORAGE_KEY = "admin_label_width_mm";
const _LABEL_SIZE_DEFAULT = 48;

/**
 * Retorna as dimensões ativas.
 */
function _getLabelSize() {
  const saved = parseInt(
    localStorage.getItem(_LABEL_SIZE_STORAGE_KEY) || String(_LABEL_SIZE_DEFAULT),
    10,
  );
  return _LABEL_SIZES[saved] || _LABEL_SIZES[_LABEL_SIZE_DEFAULT];
}

/**
 * Persiste a largura escolhida pelo operador.
 */
function _setLabelSize(mm) {
  const n = parseInt(mm, 10);
  if (!_LABEL_SIZES[n]) return;
  localStorage.setItem(_LABEL_SIZE_STORAGE_KEY, String(n));
}

/**
 * Gera o HTML de UMA etiqueta — texto preto puro,
 * suporta 3 modos: tiers (varejo/atacado), preço único, ou sem preço.
 */
function _gerarHtmlEtiqueta(produto, index) {
  const codigo = produto.codigo_barras || "";
  const nome = produto.nome || "";
  const imgUrl = produto.imagem_url || "";
  const cfg = vfBuscarConfigFaixa(produto);

  const tiers = [];
  if (cfg && cfg.unitario) {
    tiers.push({ label: "VAREJO", sub: "1 un", preco: cfg.unitario });
    if (cfg.faixa1_preco && cfg.faixa1_min) {
      tiers.push({
        label: `${cfg.faixa1_min}+ un`,
        sub: "Desconto",
        preco: cfg.faixa1_preco,
      });
    }
    if (cfg.faixa2_preco && cfg.faixa2_min) {
      tiers.push({
        label: `ATAC. ${cfg.faixa2_min}+`,
        sub: "Atacado",
        preco: cfg.faixa2_preco,
      });
    }
  }

  let colunasHtml;
  if (tiers.length > 0) {
    colunasHtml = `
      <div class="tiers" style="grid-template-columns:repeat(${tiers.length},1fr)">
        ${tiers
          .map(
            (t, i) => `
          <div class="tier ${i === 0 ? "tier-destaque" : ""}">
            <div class="tier-label">${t.label}</div>
            <div class="tier-sub">${t.sub}</div>
            <div class="tier-preco">${t.preco.toLocaleString("es-PY")}</div>
          </div>`,
          )
          .join("")}
      </div>`;
  } else {
    const precoNum = Number(produto.preco) || 0;
    colunasHtml = `
      <div class="preco-unico">
        <div class="preco-unico-val">${precoNum.toLocaleString("es-PY")}</div>
        <div class="preco-unico-lbl">Gs / unidade</div>
      </div>`;
  }

  const svgId = `barcode-${index || 0}`;
  const imgTag = imgUrl
    ? `<img class="thumb" src="${imgUrl}" onerror="this.style.display='none'">`
    : "";

  return `
    <div class="etiqueta-item">
      <div class="etiqueta">
        <div class="nome">${nome}</div>
        ${colunasHtml}
        <div class="rodape">
          ${imgTag}
          <svg id="${svgId}" class="barcode"></svg>
        </div>
      </div>
    </div>`;
}

/**
 * Motor de impressão em lote.
 * Adapta o CSS à largura configurada e imprime N etiquetas em UMA janela.
 */
function _imprimirLote(produtos) {
  if (!Array.isArray(produtos) || !produtos.length) {
    alert("Nenhum produto para imprimir.");
    return;
  }

  const size = _getLabelSize();
  const { total, inner, pad, scale, barcodeH, thumb } = size;

  const validos = produtos.filter(
    (p) => p && p.codigo_barras && String(p.codigo_barras).trim(),
  );
  const semCodigo = produtos.length - validos.length;

  if (!validos.length) {
    alert(
      "Nenhum dos produtos selecionados possui código de barras cadastrado.\n\n" +
        "Cadastre um código antes de imprimir a etiqueta.",
    );
    return;
  }

  if (semCodigo > 0) {
    const ok = confirm(
      `${semCodigo} produto(s) não possuem código de barras e serão ignorados.\n\n` +
        `Imprimir as ${validos.length} etiqueta(s) restantes?`,
    );
    if (!ok) return;
  }

  const iframe = document.createElement("iframe");
  iframe.style.cssText =
    "position:fixed;opacity:0;width:0;height:0;border:none;";
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;

  doc.body.innerHTML = validos
    .map((p, i) => _gerarHtmlEtiqueta(p, i))
    .join("");

  const style = doc.createElement("style");
  style.textContent = `
    @page { size: ${total}mm auto; margin: 1mm; }
    * {
      box-sizing: border-box; margin: 0; padding: 0;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    body { font-family: 'Arial', sans-serif; background: #fff; color: #000; padding: 0; }
    .etiqueta-item { page-break-after: always; break-after: page; padding: 0; margin: 0; }
    .etiqueta-item:last-child { page-break-after: auto; break-after: auto; }
    .etiqueta { width: ${inner}mm; background: #fff; color: #000; padding: ${pad}mm; margin: 0 auto; }
    .nome {
      font-size: ${11 * scale}px; font-weight: 900; color: #000;
      text-transform: uppercase; text-align: center;
      padding-bottom: ${1.5 * scale}mm;
      border-bottom: 1px solid #000;
      margin-bottom: ${1.5 * scale}mm;
      line-height: 1.15; word-break: break-word;
    }
    .tiers { display: grid; gap: ${1 * scale}mm; margin-bottom: ${1.5 * scale}mm; }
    .tier {
      border: 1.2px solid #000; border-radius: ${1.5 * scale}mm;
      padding: ${1.5 * scale}mm ${0.8 * scale}mm;
      text-align: center; background: #fff; color: #000;
    }
    .tier-destaque { border-width: 2px; background: #fff; color: #000; }
    .tier-label {
      font-size: ${8 * scale}px; font-weight: 900;
      letter-spacing: 0.2px; text-transform: uppercase;
      color: #000; line-height: 1.1;
    }
    .tier-sub { font-size: ${6 * scale}px; color: #000; margin-top: ${0.3 * scale}mm; line-height: 1; }
    .tier-preco {
      font-size: ${13 * scale}px; font-weight: 900;
      margin-top: ${1 * scale}mm; color: #000;
      line-height: 1; letter-spacing: -0.2px;
    }
    .preco-unico { text-align: center; padding: ${2 * scale}mm 0 ${3 * scale}mm; color: #000; }
    .preco-unico-val {
      font-size: ${26 * scale}px; font-weight: 900;
      color: #000; line-height: 1; letter-spacing: -0.5px;
    }
    .preco-unico-lbl { font-size: ${8 * scale}px; color: #000; margin-top: ${1 * scale}mm; }
    .rodape {
      display: flex; align-items: center; justify-content: center;
      gap: ${1.5 * scale}mm; padding-top: ${1.5 * scale}mm;
      border-top: 1px solid #000; color: #000;
    }
    .thumb {
      width: ${thumb}mm; height: ${thumb}mm;
      object-fit: cover; border-radius: 1mm; flex-shrink: 0;
    }
    .barcode { flex: 1; max-width: ${inner - thumb - 4}mm; height: auto; }
  `;
  doc.head.appendChild(style);

  const script = doc.createElement("script");
  script.src =
    "https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js";

  script.onload = function () {
    try {
      validos.forEach((p, i) => {
        const svgId = `barcode-${i}`;
        const code = String(p.codigo_barras).trim();
        const isEan13 = /^\d{13}$/.test(code);
        const opts = {
          width: 1.5,
          height: barcodeH,
          displayValue: true,
          fontSize: 10 * scale,
          margin: 0,
          textMargin: 1,
          fontOptions: "bold",
          lineColor: "#000000",
          background: "#ffffff",
        };

        try {
          iframe.contentWindow.JsBarcode(
            `#${svgId}`,
            code,
            Object.assign({ format: isEan13 ? "EAN13" : "CODE128" }, opts),
          );
        } catch (_) {
          iframe.contentWindow.JsBarcode(
            `#${svgId}`,
            code,
            Object.assign({ format: "CODE128" }, opts),
          );
        }
      });

      iframe.contentWindow.focus();
      setTimeout(() => {
        iframe.contentWindow.print();
        setTimeout(() => {
          if (document.body.contains(iframe)) document.body.removeChild(iframe);
        }, 3000);
      }, 500);
    } catch (err) {
      console.error("[_imprimirLote] Erro JsBarcode:", err);
      if (document.body.contains(iframe)) document.body.removeChild(iframe);
      alert("Erro ao gerar códigos de barras.");
    }
  };

  script.onerror = function () {
    if (document.body.contains(iframe)) document.body.removeChild(iframe);
    alert("Erro ao carregar biblioteca de código de barras.");
  };

  doc.head.appendChild(script);
}

/**
 * Imprime etiqueta de UM produto (chamado pelo botão dentro do card).
 * Mantém assinatura original para não quebrar o onclick existente.
 */
function imprimirCodigoBarras(codigo, nomeProduto, preco, produtoId) {
  let produto = null;
  if (produtoId && typeof _produtosMap !== "undefined") {
    produto = _produtosMap[produtoId];
  }
  if (!produto) {
    produto = {
      nome: nomeProduto || "Produto",
      codigo_barras: codigo || "",
      preco: parseInt(String(preco).replace(/\D/g, ""), 10) || 0,
      imagem_url: "",
      montagem_config: null,
    };
  }
  _imprimirLote([produto]);
}

/**
 * Imprime etiquetas de TODOS os produtos marcados na lista.
 * Chamada pelo botão "Imprimir Etiquetas" da barra de ações em massa.
 */
function imprimirEtiquetasEmMassa() {
  const ids = _ptGetIdsSelecionados();
  if (!ids.length) {
    alert("Selecione ao menos 1 produto para imprimir etiquetas.");
    return;
  }

  const produtos = ids
    .map((id) =>
      typeof _produtosMap !== "undefined" ? _produtosMap[id] : null,
    )
    .filter(Boolean);

  if (!produtos.length) {
    alert("Produtos selecionados não foram encontrados no cache.");
    return;
  }

  _imprimirLote(produtos);
}

// ══════════════════════════════════════════════════════════════
//  FAIXAS DE PREÇO (Varejo / Atacado) — Admin
// ══════════════════════════════════════════════════════════════

function toggleFaixasPreco(on) {
  const area = document.getElementById("faixas-preco-area");
  if (area) area.style.display = on ? "block" : "none";
  if (on) _faixaAtualizarPreview();
}

/**
 * Chamado nos oninput dos 5 campos — atualiza o preview em tempo real.
 * Precisa ser chamado também pelos oninput do HTML.
 */
function _faixaAtualizarPreview() {
  const prev = document.getElementById("faixas-preview");
  if (!prev) return;

  const unitario   = parseInt(document.getElementById("prod-faixa-unitario")?.value)   || 0;
  const f1Min      = parseInt(document.getElementById("prod-faixa1-min")?.value)       || 0;
  const f1Preco    = parseInt(document.getElementById("prod-faixa1-preco")?.value)     || 0;
  const f2Min      = parseInt(document.getElementById("prod-faixa2-min")?.value)       || 0;
  const f2Preco    = parseInt(document.getElementById("prod-faixa2-preco")?.value)     || 0;

  if (!unitario) { prev.textContent = "Informe o preço unitário base."; return; }

  const linhas = [`• 1 un → ${vfFmtGs(unitario)}`];

  if (f1Min && f1Preco) {
    linhas.push(`• ${f1Min}–${f2Min && f2Preco ? (f2Min - 1) : "∞"} un → ${vfFmtGs(f1Preco)} (economia ${(100 - f1Preco/unitario*100).toFixed(0)}%)`);
  }
  if (f2Min && f2Preco) {
    linhas.push(`• ${f2Min}+ un → ${vfFmtGs(f2Preco)} (economia ${(100 - f2Preco/unitario*100).toFixed(0)}%)`);
  }

  prev.innerHTML = linhas.join("<br>");
}

/**
 * Lê os inputs e retorna o objeto faixas_preco. Retorna null se inválido.
 *
 * Sincroniza automaticamente com o campo principal #prod-preco:
 *  - Se o operador preencheu só o preço principal, herda como "unitario"
 *  - Se o operador preencheu só a faixa, o preço principal herda a faixa
 *  (evita salvar produtos com preco = 0, que quebram a exibição na loja)
 */
function _coletarFaixasPreco() {
  const ativo = document.getElementById("prod-tem-faixas")?.checked;
  if (!ativo) return null;

  const _faixaUniEl  = document.getElementById("prod-faixa-unitario");
  const _precoMainEl = document.getElementById("prod-preco");

  // ── Auto-sync 1: campo unitário vazio mas preço principal preenchido ──
  if (_faixaUniEl && (!_faixaUniEl.value || _faixaUniEl.value === "0")) {
    const _herdado = parseInt(
      _precoMainEl?.dataset?.valorNumerico ||
        (_precoMainEl?.value || "").replace(/\D/g, "") ||
        "0",
      10,
    ) || 0;
    if (_herdado > 0) _faixaUniEl.value = _herdado;
  }

  const unitario = parseInt(_faixaUniEl?.value) || 0;
  if (!unitario) {
    alert(
      "⚠️ Para ativar preços por quantidade, informe o 'Preço unitário (1 un)' na seção de faixas.",
    );
    return null;
  }

  // ── Auto-sync 2: preço principal vazio mas faixa unitária preenchida ──
  if (_precoMainEl && (!_precoMainEl.value || _precoMainEl.value === "0")) {
    _precoMainEl.value = unitario.toLocaleString("es-PY");
    _precoMainEl.dataset.valorNumerico = String(unitario);
  }

  const faixa1_min   = parseInt(document.getElementById("prod-faixa1-min")?.value)   || null;
  const faixa1_preco = parseInt(document.getElementById("prod-faixa1-preco")?.value) || null;
  const faixa2_min   = parseInt(document.getElementById("prod-faixa2-min")?.value)   || null;
  const faixa2_preco = parseInt(document.getElementById("prod-faixa2-preco")?.value) || null;

  // ── Validações com aviso explícito (antes falhavam em silêncio) ──
  if (faixa1_min && faixa1_min < 2) {
    alert(
      "⚠️ 'A partir de' da Faixa 1 precisa ser ≥ 2.\nA faixa de 1 unidade é o preço unitário base.",
    );
    return null;
  }
  if (faixa2_min && faixa1_min && faixa2_min <= faixa1_min) {
    alert("⚠️ 'Atacado a partir de' deve ser maior que a 'Faixa 1'.");
    return null;
  }

  const out = { unitario };
  if (faixa1_min && faixa1_preco) {
    out.faixa1_min   = faixa1_min;
    out.faixa1_preco = faixa1_preco;
  }
  if (faixa2_min && faixa2_preco) {
    out.faixa2_min   = faixa2_min;
    out.faixa2_preco = faixa2_preco;
  }

  return out;
}

/**
 * Preenche os inputs a partir de montagem_config.
 * Chamado em abrirModalProduto.
 */
function _renderizarFaixasPreco(produto) {
  const chk   = document.getElementById("prod-tem-faixas");
  const area  = document.getElementById("faixas-preco-area");
  if (!chk || !area) return;

  // Reset
  ["prod-faixa-unitario","prod-faixa1-min","prod-faixa1-preco","prod-faixa2-min","prod-faixa2-preco"]
    .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });
  const prev = document.getElementById("faixas-preview");
  if (prev) prev.textContent = "";

  const cfg = vfBuscarConfigFaixa(produto);
  if (!cfg || !cfg.unitario) {
    chk.checked = false;
    toggleFaixasPreco(false);
    return;
  }

  chk.checked = true;
  toggleFaixasPreco(true);

  document.getElementById("prod-faixa-unitario").value = cfg.unitario || "";
  if (cfg.faixa1_min)   document.getElementById("prod-faixa1-min").value   = cfg.faixa1_min;
  if (cfg.faixa1_preco) document.getElementById("prod-faixa1-preco").value = cfg.faixa1_preco;
  if (cfg.faixa2_min)   document.getElementById("prod-faixa2-min").value   = cfg.faixa2_min;
  if (cfg.faixa2_preco) document.getElementById("prod-faixa2-preco").value = cfg.faixa2_preco;

  _faixaAtualizarPreview();
}

// ══════════════════════════════════════════════════════════════
//  PDV — Multiplicador de quantidade & prefixo "10+"
// ══════════════════════════════════════════════════════════════

// Estado global do multiplicador
window._pdvQtyMultiplier = 1;

function pdvSetQtyMultiplier(n) {
  window._pdvQtyMultiplier = Math.max(1, parseInt(n, 10) || 1);
  // Atualiza UI dos botões
  document.querySelectorAll(".pdv-qty-mult-btn").forEach((b) => {
    b.classList.toggle("active", parseInt(b.dataset.qty, 10) === window._pdvQtyMultiplier);
  });
  const badge = document.getElementById("pdv-qty-mult-badge");
  if (badge) {
    if (window._pdvQtyMultiplier > 1) {
      badge.textContent = `×${window._pdvQtyMultiplier}`;
      badge.style.display = "inline-block";
    } else {
      badge.style.display = "none";
    }
  }
}

/**
 * Parseia prefixo "10+codigo", "10xcodigo" ou "codigo".
 * Retorna { qty, code }.
 */
function _pdvParseQtyPrefix(input) {
  const s = (input || "").trim();
  const m = s.match(/^(\d+)\s*[x+]\s*(.+)$/i);
  if (m) return { qty: parseInt(m[1], 10) || 1, code: m[2].trim() };
  return { qty: 1, code: s };
}

// ══════════════════════════════════════════════════════════════
//  PDV — Realoca a busca para o TOPO da coluna esquerda
//  (a versão "live" tinha a busca no topo; na local ela
//   acabou abaixo do carrinho. Este helper conserta isso
//   na marra sem editar o admin.html.)
// ══════════════════════════════════════════════════════════════
function _pdvRealocarBuscaParaTopo() {
  const colEsq = document.getElementById("pdv-panel-produtos");
  if (!colEsq) return;

  const buscaWrap = colEsq.querySelector(".pdv-busca-wrap");
  if (!buscaWrap) return;

  // Âncora: o título "🛒 Itens do Pedido"
  const titulo = colEsq.querySelector(".pdv-dir-titulo");
  if (!titulo) return;

  // Já está no lugar certo? Sai.
  if (titulo.nextElementSibling === buscaWrap) return;

  // Insere logo após o título
  titulo.after(buscaWrap);

  // Move também a barra de Qtd para DEPOIS da busca
  // (na versão live ela fica em segundo plano ou escondida)
  const qtyBar = [...colEsq.children].find(el =>
    el.querySelector?.("input[type=number], .pdv-qty-mult-btn") &&
    !el.classList.contains("pdv-busca-wrap")
  );
  if (qtyBar && buscaWrap.nextElementSibling !== qtyBar) {
    buscaWrap.after(qtyBar);
  }

  // Move o chip F2 para logo abaixo da busca, se ele estiver solto
  // (a versão live tinha o F2 acima dos resultados, não ao lado)
  const f2Badge = document.getElementById("pdv-f2-badge");
  const f2Btn   = document.getElementById("pdv-f2-btn");
  if (f2Badge && f2Badge.parentElement !== buscaWrap) {
    buscaWrap.appendChild(f2Badge);
  }
  if (f2Btn && f2Btn.parentElement !== buscaWrap) {
    buscaWrap.appendChild(f2Btn);
  }
}

/**
 * Injeta o badge numérico dentro do item "PDV" do menu lateral.
 * Só roda uma vez; chamadas subsequentes não duplicam.
 * O badge fica oculto por padrão e é ativado por
 * _atualizarBadgePedidosPendentes() quando houver pedidos pendentes.
 */
function _injetarBadgeNoMenuPDV() {
  const menuPDV = document.getElementById("menu-pdv");
  if (!menuPDV) return;
  if (document.getElementById("menu-pdv-badge")) return; // já injetado

  const badge = document.createElement("span");
  badge.id = "menu-pdv-badge";
  badge.textContent = "0";
  badge.style.display = "none";
  menuPDV.appendChild(badge);
}

/**
 * Consulta o banco e atualiza, de uma só vez:
 *   - o card de alerta no topo da aba PDV
 *   - o badge numérico no ícone do menu lateral
 *   - TOCA O ALARME quando um novo pedido chega e o usuário
 *     está na aba PDV (junto com o aviso visual)
 *
 * Chamada em 3 momentos:
 *   1. Ao abrir a aba PDV (carregarPDV)
 *   2. Quando chega INSERT de pedido (iniciarRealtime)
 *   3. A cada 60s pelo setInterval global (backup anti-falha de Realtime)
 *
 * @returns {Promise<number>} quantidade de pedidos pendentes
 */
async function _atualizarBadgePedidosPendentes() {
  // Conta apenas pedidos com status = 'pendente' (aguardando aceitação)
  const { count, error } = await supa
    .from("pedidos")
    .select("*", { count: "exact", head: true })
    .eq("status", "pendente");

  if (error) {
    console.warn("[_atualizarBadgePedidosPendentes]", error.message);
    return 0;
  }

  const n = count || 0;

  // ══════════════════════════════════════════════════════════════
  //  🔔 ALERTA SONORO no PDV
  //  Toca o alarme quando o número de pedidos pendentes AUMENTOU
  //  e o operador está na aba PDV. Usa a mesma campainha da aba
  //  Pedidos (`tocarAlarme`) — chamada idempotente: se já estiver
  //  tocando, o `tocarAlarme()` retorna sem duplicar.
  //
  //  O realtime já dispara `tocarAlarme()` em INSERTs, mas esta
  //  verificação por contagem é um backup que garante o som mesmo
  //  quando o canal Realtime falha ou está reconectando.
  // ══════════════════════════════════════════════════════════════
  const _countAnterior = window._pdvUltimoCountPendentes;
  const _incrementou =
    typeof _countAnterior === "number" &&
    _countAnterior >= 0 &&
    n > _countAnterior;

  window._pdvUltimoCountPendentes = n;

  if (_incrementou) {
    const _abaAtual = localStorage.getItem("app_lastTab");
    // Só toca se o operador está no PDV — nas outras abas o realtime
    // já cuida, e evita-se som duplicado fora de contexto.
    if (_abaAtual === "pdv" && typeof tocarAlarme === "function") {
      console.log(`[PDV] 🔔 Novo pedido pendente (${_countAnterior} → ${n}) — tocando alarme`);
      tocarAlarme();
    }
  }

  // ── 1. Badge do menu lateral ──────────────────────────────────
  const badgeMenu = document.getElementById("menu-pdv-badge");
  if (badgeMenu) {
    if (n > 0) {
      badgeMenu.textContent = n > 99 ? "99+" : String(n);
      badgeMenu.style.display = "inline-flex";
    } else {
      badgeMenu.style.display = "none";
    }
  }

  // ── 2. Card de alerta dentro da aba PDV ───────────────────────
  const card   = document.getElementById("pdv-alerta-pedidos");
  const titulo = document.getElementById("pdv-alerta-titulo");
  const sub    = document.getElementById("pdv-alerta-sub");

  if (card) {
    if (n > 0) {
      // Atualiza textos com o número em destaque
      if (titulo) {
        titulo.innerHTML =
          `<span id="pdv-alerta-count">${n}</span>` +
          (n === 1
            ? "pedido aguardando aceitação"
            : "pedidos aguardando aceitação");
      }
      if (sub) {
        sub.innerHTML = "Clique para revisar e confirmar os pedidos do app.";
      }
      card.style.display = "flex";
    } else {
      card.style.display = "none";
    }
  }

  return n;
};
// ============================================================
//  MÓDULO: CONTAS NA NOTA (FIADO)
//  Gerencia pedidos com forma_pagamento = "NaNota"
//  Permite visualizar, cobrar, imprimir e quitar contas
//
//  ── ALTERAÇÕES NESTA REVISÃO ─────────────────────────────────
//  1. Quitação agora grava dados estruturados em vez de depender
//     só de texto livre em obs_pagamento:
//       - pedidos.quitado_em                (timestamptz)
//       - pedidos.forma_pagamento_quitacao  (text)
//     Isso corrige dois problemas no relatório Financeiro:
//       a) a forma de pagamento escolhida na quitação não era
//          usada no breakdown por método (Efetivo/Cartão/Pix...)
//          porque pedidos.forma_pagamento continuava "NaNota" pra
//          sempre — só o texto em obs_pagamento guardava a forma
//          real, e o Financeiro nunca lia esse texto.
//       b) o Financeiro filtra pedidos por created_at (data de
//          CRIAÇÃO do pedido). Uma nota criada semanas atrás e
//          quitada hoje nunca aparecia no relatório do dia da
//          quitação. Com quitado_em, o admin.js passa a poder
//          filtrar pela data real do pagamento.
//     Requer migração SQL (rodar uma vez no Supabase):
//       ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS quitado_em TIMESTAMPTZ;
//       ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS forma_pagamento_quitacao TEXT;
//
//  2. Removida duplicidade de _notasModalFormaPagamento() — havia
//     duas declarações da mesma função (uma com 5 opções, outra
//     com 6 incluindo QrCelular); a segunda sobrescrevia a primeira
//     silenciosamente. Mantida uma única versão com 6 opções.
//
//  3. notasAgrupar() agora reconhece quitação tanto pelo campo novo
//     (quitado_em) quanto pelo marcador de texto antigo ([quitado),
//     garantindo retrocompatibilidade com pedidos já quitados antes
//     desta revisão.
// ============================================================

let _notas_pedidos   = [];   // todos os pedidos NaNota
let _notas_clientes  = {};   // agrupados por telefone/nome
let _notas_filtro    = 'pendente'; // pendente | quitado | todos

// ── INICIALIZAR ──────────────────────────────────────────────
async function notasInicializar() {
  document.getElementById('notas-loading')?.style && (document.getElementById('notas-loading').style.display = 'flex');
  await notasCarregar();
  document.getElementById('notas-loading')?.style && (document.getElementById('notas-loading').style.display = 'none');
}

async function notasCarregar() {
  const { data, error } = await supa
    .from('pedidos')
    .select('id, created_at, cliente_nome, cliente_telefone, itens, total_geral, forma_pagamento, obs_pagamento, status, tipo_entrega, quitado_em, forma_pagamento_quitacao')
    .eq('forma_pagamento', 'NaNota')
    .order('created_at', { ascending: false });

  if (error) { console.error('notasCarregar:', error); return; }
  _notas_pedidos = data || [];
  notasAgrupar();
  notasRenderKPIs();
  notasRenderLista();
}

// ── AGRUPAR POR CLIENTE ───────────────────────────────────────
function notasAgrupar() {
  _notas_clientes = {};
  for (const p of _notas_pedidos) {
    const tel  = (p.cliente_telefone || '').trim();
    const nome = (p.cliente_nome     || 'Cliente').trim();
    // Chave única: telefone limpo; sem telefone, usa nome normalizado para não misturar clientes diferentes
    const chave = tel || ('nome:' + nome.toLowerCase().replace(/\s+/g, '_'));
    if (!_notas_clientes[chave]) {
      _notas_clientes[chave] = { nome, telefone: tel, pedidos: [], total: 0, quitado: 0 };
    }
    // Reconhece quitação pelo campo novo (quitado_em) OU, para registros
    // antigos gravados antes desta revisão, pelo marcador de texto.
    const obs_norm = (p.obs_pagamento || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const quitado = !!p.quitado_em || obs_norm.includes('[quitado');
    _notas_clientes[chave].pedidos.push({ ...p, quitado });
    if (!quitado) _notas_clientes[chave].total += p.total_geral || 0;
    else          _notas_clientes[chave].quitado += p.total_geral || 0;
  }
}

// ── KPIs ──────────────────────────────────────────────────────
function notasRenderKPIs() {
  const clientes = _notasClientesComPeriodoEBusca();
  const totalAberto = clientes.reduce((s, c) => s + c.total, 0);
  const totalQuit   = clientes.reduce((s, c) => s + c.quitado, 0);
  const qtdAbertos  = clientes.filter(c => c.total > 0).length;

  const el = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  el('notas-kpi-clientes', clientes.length);
  el('notas-kpi-aberto',   'Gs ' + Math.round(totalAberto).toLocaleString('es-PY'));
  el('notas-kpi-quitado',  'Gs ' + Math.round(totalQuit).toLocaleString('es-PY'));
  el('notas-kpi-pendentes', qtdAbertos);
}

// ── RENDER LISTA ──────────────────────────────────────────────
function notasFiltrar() {
  _notas_filtro = document.getElementById('notas-filtro-status')?.value || 'pendente';
  notasRenderLista();
}

// Reaplica os filtros de período (data inicial/final) — dispara recálculo
// dos KPIs (que também respeitam o período) e da lista.
function notasAplicarFiltroPeriodo() {
  notasRenderKPIs();
  notasRenderLista();
}

function notasLimparFiltroPeriodo() {
  const ini = document.getElementById('notas-filtro-inicio');
  const fim = document.getElementById('notas-filtro-fim');
  if (ini) ini.value = '';
  if (fim) fim.value = '';
  notasAplicarFiltroPeriodo();
}

// Aplica período (data do pedido) + busca (nome/telefone) sobre
// _notas_clientes, recalculando total/quitado de cada cliente só com
// os pedidos que caem dentro da janela filtrada. Não aplica o filtro de
// status (pendente/quitado/todos) — esse é usado só para decidir quais
// linhas exibir na lista, os KPIs continuam representando o período todo.
function _notasClientesComPeriodoEBusca() {
  const busca = (document.getElementById('notas-busca')?.value || '').toLowerCase().trim();
  const dtIni = document.getElementById('notas-filtro-inicio')?.value || '';
  const dtFim = document.getElementById('notas-filtro-fim')?.value || '';

  let clientes = Object.entries(_notas_clientes).map(([chave, c]) => ({
    chave, ...c, pedidos: [...c.pedidos],
  }));

  if (dtIni || dtFim) {
    const iniMs = dtIni ? new Date(dtIni + 'T00:00:00').getTime() : -Infinity;
    const fimMs = dtFim ? new Date(dtFim + 'T23:59:59').getTime() : Infinity;
    clientes = clientes
      .map(c => {
        const pedidos = c.pedidos.filter(p => {
          const t = new Date(p.created_at).getTime();
          return t >= iniMs && t <= fimMs;
        });
        const total   = pedidos.filter(p => !p.quitado).reduce((s, p) => s + (p.total_geral || 0), 0);
        const quitado = pedidos.filter(p => p.quitado).reduce((s, p) => s + (p.total_geral || 0), 0);
        return { ...c, pedidos, total, quitado };
      })
      .filter(c => c.pedidos.length > 0);
  }

  if (busca) {
    clientes = clientes.filter(c =>
      c.nome.toLowerCase().includes(busca) || c.telefone.includes(busca)
    );
  }

  return clientes;
}

function notasRenderLista() {
  const cont = document.getElementById('notas-lista');
  if (!cont) return;

  let clientes = _notasClientesComPeriodoEBusca();

  // Filtro status
  if (_notas_filtro === 'pendente') clientes = clientes.filter(c => c.total > 0);
  if (_notas_filtro === 'quitado')  clientes = clientes.filter(c => c.total === 0 && c.quitado > 0);

  if (!clientes.length) {
    cont.innerHTML = `<div style="text-align:center;color:#aaa;padding:40px;font-size:0.9rem">
      ${_notas_filtro === 'pendente' ? '✅ ¡Ninguna cuenta abierta por el momento!' : 'Ningún resultado encontrado.'}
    </div>`;
    return;
  }

  cont.innerHTML = clientes.map(c => {
    const abertos   = c.pedidos.filter(p => !p.quitado);
    const quitados  = c.pedidos.filter(p => p.quitado);
    const temAberto = c.total > 0;

    const chaveSanitizada = c.chave.replace(/[^a-zA-Z0-9]/g, '');
    return `
    <div style="background:#fff;border-radius:14px;border:1.5px solid ${temAberto ? '#fca5a5' : '#bbf7d0'};margin-bottom:12px;overflow:hidden">
      <!-- Encabezado del cliente -->
      <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;cursor:pointer;background:${temAberto ? '#fff5f5' : '#f0fdf4'}"
           onclick="notasToggleCliente('${chaveSanitizada}')">
        <div>
          <div style="font-weight:800;font-size:0.95rem;color:#111">${c.nome}</div>
          <div style="font-size:0.78rem;color:#6b7280;margin-top:2px">${c.telefone || 'Sin teléfono'} · ${c.pedidos.length} pedido(s)</div>
        </div>
        <div style="text-align:right">
          ${temAberto
            ? `<div style="font-size:1rem;font-weight:900;color:#dc2626">Gs ${Math.round(c.total).toLocaleString('es-PY')}</div>
               <div style="font-size:0.72rem;color:#dc2626;font-weight:600">EM ABERTO</div>`
            : `<div style="font-size:0.85rem;font-weight:700;color:#16a34a">✅ Quitado</div>`
          }
        </div>
      </div>

      <!-- Detalle (pedidos) — oculto por defecto -->
      <div id="notas-det-${chaveSanitizada}" style="display:none;padding:0 16px 14px">
        ${abertos.length > 0 ? `
        <div style="margin-top:12px">
          <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:#dc2626;letter-spacing:.5px;margin-bottom:6px">
            📋 Pedidos em aberto
          </div>
          ${abertos.map(p => _notasPedidoRow(p, false)).join('')}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button onclick="notasQuitarTodos('${chaveSanitizada}')"
            style="flex:2;padding:10px;background:#16a34a;color:#fff;border:none;border-radius:9px;font-weight:700;cursor:pointer;font-size:0.85rem">
            ✅ Quitar tudo — Gs ${Math.round(c.total).toLocaleString('es-PY')}
          </button>
          <button onclick="notasImprimirConta('${chaveSanitizada}')"
            style="flex:1;padding:10px;background:#f3f4f6;color:#374151;border:1.5px solid #e5e7eb;border-radius:9px;font-weight:600;cursor:pointer;font-size:0.85rem">
            🖨️ Imprimir
          </button>
          ${c.telefone ? `
          <button onclick="notasAvisarCliente('${chaveSanitizada}')"
            style="flex:1;padding:10px;background:#25D366;color:#fff;border:none;border-radius:9px;font-weight:600;cursor:pointer;font-size:0.85rem">
            <i class="fab fa-whatsapp"></i> Avisar
          </button>` : ''}
        </div>` : ''}

        ${quitados.length > 0 ? `
        <div style="margin-top:${abertos.length > 0 ? '14px' : '12px'}">
          <div style="font-size:0.72rem;font-weight:700;text-transform:uppercase;color:#16a34a;letter-spacing:.5px;margin-bottom:6px">
            ✅ Ya saldados
          </div>
          ${quitados.map(p => _notasPedidoRow(p, true)).join('')}
        </div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function notasToggleCliente(chaveSanitizada) {
  const el = document.getElementById('notas-det-' + chaveSanitizada);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function _notasPedidoRow(p, quitado) {
  const data  = new Date(p.created_at).toLocaleString('es-PY', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
  const itens = Array.isArray(p.itens) ? p.itens : [];
  const resumo = itens.slice(0, 3).map(i => `${i.qtd || 1}x ${i.nome || i.n || '?'}`).join(', ') + (itens.length > 3 ? '...' : '');

  // Forma de pagamento da quitação: usa o campo estruturado quando existir,
  // com fallback pro texto livre para pedidos quitados antes desta revisão.
  const formaExib = p.forma_pagamento_quitacao
    || (p.obs_pagamento || '').match(/Forma:\s*([A-Za-zÀ-ú]+)/i)?.[1]
    || null;

  return `
  <div style="background:${quitado ? '#f0fdf4' : '#fff'};border:1px solid ${quitado ? '#bbf7d0' : '#fecaca'};border-radius:9px;padding:9px 12px;margin-bottom:6px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div style="font-size:0.78rem;font-weight:700;color:#111">Pedido #${p.id} · ${data}</div>
        <div style="font-size:0.74rem;color:#6b7280;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${resumo || '—'}</div>
      </div>
      <div style="text-align:right;margin-left:10px;flex-shrink:0">
        <div style="font-weight:800;font-size:0.88rem;color:${quitado ? '#16a34a' : '#dc2626'}">Gs ${Math.round(p.total_geral || 0).toLocaleString('es-PY')}</div>
        ${!quitado
          ? `<button onclick="notasQuitarPedido(${p.id}, event)"
              style="font-size:0.68rem;background:#dcfce7;color:#16a34a;border:1px solid #86efac;border-radius:5px;padding:2px 7px;cursor:pointer;margin-top:3px;font-weight:700">
              Quitar este
            </button>`
          : `<div style="font-size:0.68rem;color:#16a34a;font-weight:600;margin-top:2px">✅ Quitado${formaExib ? ' · ' + formaExib : ''}</div>`}
      </div>
    </div>
  </div>`;
}

// ============================================================
//  MODAL — ESCOLHA DA FORMA DE PAGAMENTO DA QUITAÇÃO
//  (única definição — antes havia duas declarações duplicadas
//   desta mesma função, a segunda sobrescrevia a primeira)
// ============================================================
function _notasModalFormaPagamento() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:24px;max-width:360px;width:100%;">
        <h3 style="margin-bottom:16px;font-size:1.1rem;">💵 Escolha a forma de pagamento</h3>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${['Efetivo','Cartao','Pix','Transferencia','QrPy','QrCelular'].map(m =>
            `<button data-forma="${m}" style="padding:12px;border:2px solid #e0e0e0;border-radius:8px;background:#f9f9f9;cursor:pointer;font-weight:600;font-size:0.95rem;text-align:left;">
              ${m}
            </button>`
          ).join('')}
        </div>
        <button id="cancel-quit" style="margin-top:12px;width:100%;padding:10px;background:#f0f0f0;border:none;border-radius:8px;cursor:pointer;font-weight:600;">Cancelar</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('[data-forma]').forEach(btn => {
      btn.onclick = () => {
        const forma = btn.dataset.forma;
        overlay.remove();
        resolve(forma);
      };
    });
    overlay.querySelector('#cancel-quit').onclick = () => {
      overlay.remove();
      resolve(null);
    };
  });
}

// ============================================================
//  QUITAR PEDIDO INDIVIDUAL
// ============================================================

async function notasQuitarPedido(pedidoId, event) {
  if (event) event.stopPropagation();

  if (!_sessaoCaixaAtiva) {
    alert('⚠️ No hay caja abierta. Abra la caja antes de saldar una cuenta.');
    return;
  }

  const ok = confirm('¿Marcar este pedido como PAGADO?');
  if (!ok) return;

  const formaPag = await _notasModalFormaPagamento();
  if (!formaPag) return; 

  const agora = new Date();
  const dataHora = agora.toLocaleString('es-PY');

  // Apenas atualiza os campos estruturados. O Financeiro fará o resto.
  const { error } = await supa
    .from('pedidos')
    .update({
      obs_pagamento: `[QUITADO em ${dataHora} - Forma: ${formaPag}]`,
      quitado_em: agora.toISOString(),
      forma_pagamento_quitacao: formaPag,
    })
    .eq('id', pedidoId);

  if (error) {
    alert('Error al saldar: ' + error.message);
    return;
  }

  const p = _notas_pedidos.find(x => x.id === pedidoId);
  if (!p) return;

  // Atualiza a lista local
  p.obs_pagamento = `[QUITADO em ${dataHora} - Forma: ${formaPag}]`;
  p.quitado_em = agora.toISOString();
  p.forma_pagamento_quitacao = formaPag;
  
  notasAgrupar();
  notasRenderKPIs();
  notasRenderLista();
  
  // Opcional: se a aba financeiro estiver aberta no fundo, recarrega
  if (typeof calcularFinanceiro === 'function') calcularFinanceiro();
}


// ============================================================
//  QUITAR TODOS OS PEDIDOS DE UM CLIENTE
// ============================================================

async function notasQuitarTodos(chaveSanitizada) {
  const entry = _notasClientePorId(chaveSanitizada);
  if (!entry) return;
  const [chave, c] = entry;
  const abertos = c.pedidos.filter(p => !p.quitado);
  if (!abertos.length) return;

  if (!_sessaoCaixaAtiva) {
    alert('⚠️ No hay caja abierta. Abra la caja antes de saldar.');
    return;
  }

  const ok = confirm(`¿Saldar TODOS los pedidos de ${c.nome}?\nTotal: Gs ${Math.round(c.total).toLocaleString('es-PY')}`);
  if (!ok) return;

  const formaPag = await _notasModalFormaPagamento();
  if (!formaPag) return;

  const agora = new Date();
  const dataHora = agora.toLocaleString('es-PY');
  const ids = abertos.map(p => p.id);

  // Apenas atualiza os campos estruturados
  const { error } = await supa
    .from('pedidos')
    .update({
      obs_pagamento: `[QUITADO em ${dataHora} - Forma: ${formaPag}]`,
      quitado_em: agora.toISOString(),
      forma_pagamento_quitacao: formaPag,
    })
    .in('id', ids);

  if (error) {
    alert('Error al saldar: ' + error.message);
    return;
  }

  // Atualiza lista local
  for (const p of _notas_pedidos) {
    if (ids.includes(p.id)) {
      p.obs_pagamento = `[QUITADO em ${dataHora} - Forma: ${formaPag}]`;
      p.quitado_em = agora.toISOString();
      p.forma_pagamento_quitacao = formaPag;
    }
  }
  
  notasAgrupar();
  notasRenderKPIs();
  notasRenderLista();
  
  // Opcional: recarrega financeiro
  if (typeof calcularFinanceiro === 'function') calcularFinanceiro();
}


// Helper: busca entrada do _notas_clientes pela chave sanitizada
function _notasClientePorId(chaveSanitizada) {
  return Object.entries(_notas_clientes).find(
    ([chave]) => chave.replace(/[^a-zA-Z0-9]/g, '') === chaveSanitizada
  );
}

// ── AVISAR CLIENTE VIA WHATSAPP ────────────────────────────────
function notasAvisarCliente(chaveSanitizada) {
  const entry = _notasClientePorId(chaveSanitizada);
  if (!entry) return;
  const [, c] = entry;

  const tel = (c.telefone || '').replace(/\D/g, '');
  if (!tel) {
    alert('Este cliente no tiene teléfono registrado.');
    return;
  }

  const abertos = c.pedidos.filter(p => !p.quitado);
  const nomeRestaurante = (typeof NOME_RESTAURANTE !== 'undefined' && NOME_RESTAURANTE) || 'Restaurante';
  const totalFmt = Math.round(c.total).toLocaleString('es-PY');
  const primeiroNome = (c.nome || 'Cliente').split(' ')[0];

  const msg = `¡Hola, ${primeiroNome}! 👋\n\n`
    + `Somos de *${nomeRestaurante}* y te escribimos para recordarte que tienes `
    + `${abertos.length > 1 ? `${abertos.length} pedidos` : 'un pedido'} pendientes en tu cuenta, `
    + `por un total de *Gs ${totalFmt}*.\n\n`
    + `¡Esperamos tu pago y desde ya te agradecemos! 🙏\n`
    + `Cualquier duda, estamos a tu disposición.`;

  const foneDestino = tel.startsWith('595') ? tel : `595${tel.replace(/^0/, '')}`;
  window.open(`https://wa.me/${foneDestino}?text=${encodeURIComponent(msg)}`, '_blank');
}

// ── AVISAR TODOS OS CLIENTES COM CONTA EM ABERTO ───────────────
function notasAvisarTodosPendentes() {
  const pendentes = Object.entries(_notas_clientes)
    .map(([chave, c]) => ({ chave, ...c }))
    .filter(c => c.total > 0 && c.telefone);

  if (!pendentes.length) {
    alert('Ningún cliente con teléfono y cuenta abierta.');
    return;
  }

  const ok = confirm(`Esto abrirá ${pendentes.length} conversación(es) en WhatsApp, una por cliente. ¿Continuar?`);
  if (!ok) return;

  pendentes.forEach((c, i) => {
    setTimeout(() => {
      const chaveSanitizada = c.chave.replace(/[^a-zA-Z0-9]/g, '');
      notasAvisarCliente(chaveSanitizada);
    }, i * 600);
  });
}

// ── IMPRIMIR CONTA ────────────────────────────────────────────
function notasImprimirConta(chaveSanitizada) {
  const entry = _notasClientePorId(chaveSanitizada);
  if (!entry) return;
  const [, c] = entry;
  const abertos = c.pedidos.filter(p => !p.quitado);

  const linhasPedidos = abertos.map(p => {
    const data  = new Date(p.created_at).toLocaleString('es-PY', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
    const itens = (Array.isArray(p.itens) ? p.itens : [])
      .map(i => `&nbsp;&nbsp;${i.qtd || 1}x ${i.nome || i.n || '?'} — Gs ${Math.round((i.preco || i.p || 0) * (i.qtd || 1)).toLocaleString('es-PY')}`)
      .join('<br>');
    return `<div style="margin-bottom:8px;border-bottom:1px dashed #ccc;padding-bottom:8px">
      <b>Pedido #${p.id}</b> · ${data}<br>
      ${itens}<br>
      <b>Total: Gs ${Math.round(p.total_geral || 0).toLocaleString('es-PY')}</b>
    </div>`;
  }).join('');

  const nomeRestaurante = document.getElementById('nome-loja-ticket')?.textContent
    || document.title
    || 'RESTAURANTE';

  const win = window.open('', '_blank', 'width=400,height=600');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8"><title>Cuenta — ${c.nome}</title>
    <style>
      * { margin:0;padding:0;box-sizing:border-box; }
      body { font-family:Arial,sans-serif;font-size:13px;padding:12px; }
      @media print { body{padding:2mm} @page{size:58mm auto;margin:2mm} button{display:none} }
    </style>
  </head><body>
    <div style="text-align:center;margin-bottom:8px">
      <b style="font-size:16px">${nomeRestaurante.toUpperCase()}</b><br>
      <span style="font-size:12px">CUENTA DEL CLIENTE</span>
    </div>
    <hr style="border-top:1px dashed #000;margin:6px 0">
    <div style="margin-bottom:8px">
      <b>Cliente:</b> ${c.nome}<br>
      <b>Tel:</b> ${c.telefone || '—'}
    </div>
    <hr style="border-top:1px dashed #000;margin:6px 0">
    ${linhasPedidos}
    <hr style="border-top:1px dashed #000;margin:6px 0">
    <div style="text-align:right;font-size:16px;font-weight:900">
      TOTAL: Gs ${Math.round(c.total).toLocaleString('es-PY')}
    </div>
    <div style="text-align:center;margin-top:10px;font-size:11px">*** GRACIAS ***</div>
    <br>
    <button onclick="window.print()" style="width:100%;padding:12px;background:#16a34a;color:#fff;border:none;font-size:14px;font-weight:700;border-radius:8px;cursor:pointer">
      🖨️ IMPRIMIR
    </button>
  </body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 500);
}

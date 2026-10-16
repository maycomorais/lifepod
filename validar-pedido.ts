// supabase/functions/validar-pedido/index.ts
// Edge Function — White Label
//
// Responsabilidade:
//   1. Recebe o payload do pedido
//   2. Verifica se a loja está aberta (loja_aberta + horarios_semanais)
//   3. Se for delivery com coordenadas, recalcula o frete no servidor
//   4. Verifica limite_distancia_km
//   5. Corrige silenciosamente se o cliente enviou frete menor que o real
//   6. Aplica descontos corretamente no total_geral
//   7. Insere o pedido com os valores corretos
//   8. Trava por caixa fechado (opcional, controlado por configuracoes)
//
// Deploy: supabase functions deploy validar-pedido --project-ref <REF>

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const LIMITES_KM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];

const FALLBACK_FRETE = [
  6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000, 30000, 33000,
  36000, 39000, 42000, 45000, 48000, 51000, 54000, 57000, 60000, 63000,
];

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function distanciaPelaRota(
  lat1: number, lon1: number, lat2: number, lon2: number
): Promise<number | null> {
  const url = `https://router.project-osrm.org/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    if (d.code === "Ok" && d.routes?.[0]?.distance) {
      return d.routes[0].distance / 1000;
    }
    return null;
  } catch {
    return null;
  }
}

function calcularFreteEsperado(
  dist: number,
  tabelaFrete: Array<{ loja: number; motoboy: number; acombinar?: boolean }> | null
): { loja: number; motoboy: number; acombinar: boolean } {
  let freteIndex = -1;
  for (let i = 0; i < LIMITES_KM.length; i++) {
    if (dist <= LIMITES_KM[i]) { freteIndex = i; break; }
  }
  if (freteIndex === -1) freteIndex = LIMITES_KM.length - 1;

  if (tabelaFrete?.[freteIndex]?.acombinar) {
    return { loja: 0, motoboy: 0, acombinar: true };
  }
  if (tabelaFrete?.[freteIndex]) {
    return {
      loja:      Number(tabelaFrete[freteIndex].loja)    || 0,
      motoboy:   Number(tabelaFrete[freteIndex].motoboy) || 0,
      acombinar: false,
    };
  }
  return {
    loja:      FALLBACK_FRETE[freteIndex],
    motoboy:   FALLBACK_FRETE[freteIndex],
    acombinar: false,
  };
}

function calcularFreteSemLocalizacao(
  tabelaFrete: Array<{ loja: number; motoboy: number; acombinar?: boolean }> | null
): { loja: number; motoboy: number; acombinar: boolean } {
  const idx = 2;
  if (tabelaFrete?.[idx]?.acombinar) {
    return { loja: 0, motoboy: 0, acombinar: true };
  }
  if (tabelaFrete?.[idx]) {
    return {
      loja:      Number(tabelaFrete[idx].loja)    || 0,
      motoboy:   Number(tabelaFrete[idx].motoboy) || 0,
      acombinar: false,
    };
  }
  return { loja: 12000, motoboy: 12000, acombinar: false };
}

function lojaEstaAberta(
  lojaAberta: boolean,
  horarios: Record<string, { fechado: boolean; turnos: Array<{ abre: string; fecha: string }> }> | null
): boolean {
  if (!lojaAberta) return false;
  if (!horarios || Object.keys(horarios).length === 0) return true;

  const agora = new Date();
  const agoraPy = new Date(agora.getTime() - 3 * 3600 * 1000);

  const diaKeys = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];
  const diaKey  = diaKeys[agoraPy.getUTCDay()];
  const cfg     = horarios[diaKey];

  if (!cfg) return true;
  if (cfg.fechado === true) return false;

  const turnos = (cfg.turnos || []).filter((t) => t.abre && t.fecha);
  if (turnos.length === 0) return true;

  const minAtual = agoraPy.getUTCHours() * 60 + agoraPy.getUTCMinutes();

  return turnos.some((t) => {
    const [hI, mI] = t.abre.split(":").map(Number);
    const [hF, mF] = t.fecha.split(":").map(Number);
    const ini = hI * 60 + mI;
    const fim = hF * 60 + mF;
    if (fim < ini) return minAtual >= ini || minAtual < fim;
    return minAtual >= ini && minAtual < fim;
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const payload = await req.json();

    const supa = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: cfg } = await supa
      .from("configuracoes")
      .select("tabela_frete, coord_lat, coord_lng, limite_distancia_km, loja_aberta, horarios_semanais, bloquear_venda_sem_caixa")
      .single();

    // ── Verifica se a loja está aberta ──────────────────────────
    const isAppDelivery = payload.tipo_entrega !== "balcao";
    if (isAppDelivery) {
      const aberta = lojaEstaAberta(
        cfg?.loja_aberta ?? true,
        cfg?.horarios_semanais ?? null
      );
      if (!aberta) {
        return new Response(
          JSON.stringify({ error: "Loja fechada. Aguarde o horário de atendimento." }),
          { status: 422, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
    }

    // ── Trava de caixa fechado (se ativada em configuracoes) ────
    //   Por padrão é TRUE para PDV/balcão. Para o app do cliente,
    //   só trava se o admin ativar explicitamente a flag
    //   `bloquear_venda_sem_caixa` em configuracoes.
    const _deveVerificarCaixa =
      payload.tipo_entrega === "balcao" ||
      cfg?.bloquear_venda_sem_caixa === true;

    if (_deveVerificarCaixa) {
      const { data: sessao } = await supa
        .from("sessoes_caixa")
        .select("id")
        .is("fechado_em", null)
        .order("aberto_em", { ascending: false })
        .limit(1);

      if (!sessao || sessao.length === 0) {
        return new Response(
          JSON.stringify({
            error: "Caixa fechado. Abra o caixa antes de registrar vendas.",
            code: "CAIXA_FECHADO",
          }),
          { status: 422, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
    }

    const tabelaFrete  = cfg?.tabela_frete       ?? null;
    const limiteDistKm = cfg?.limite_distancia_km ?? null;
    const coordLoja = {
      lat: parseFloat(cfg?.coord_lat ?? "0") || 0,
      lng: parseFloat(cfg?.coord_lng ?? "0") || 0,
    };

    let freteFinal     = 0;
    let freteMotoboy   = 0;
    let freteACombinar = false;

    if (payload.tipo_entrega === "delivery") {
      if (!payload.geo_lat || !payload.geo_lng) {
        const r = calcularFreteSemLocalizacao(tabelaFrete);
        freteFinal     = r.loja;
        freteMotoboy   = r.motoboy;
        freteACombinar = r.acombinar;
      } else if (!coordLoja.lat || !coordLoja.lng) {
        const r = calcularFreteSemLocalizacao(tabelaFrete);
        freteFinal     = r.loja;
        freteMotoboy   = r.motoboy;
        freteACombinar = r.acombinar;
      } else {
        const lat = parseFloat(payload.geo_lat);
        const lng = parseFloat(payload.geo_lng);
        const dist = await distanciaPelaRota(coordLoja.lat, coordLoja.lng, lat, lng);

        if (dist === null || !Number.isFinite(dist) || dist <= 0) {
          const r = calcularFreteSemLocalizacao(tabelaFrete);
          freteFinal     = r.loja;
          freteMotoboy   = r.motoboy;
          freteACombinar = r.acombinar;
        } else {
          if (limiteDistKm && dist > limiteDistKm) {
            return new Response(
              JSON.stringify({ error: `Distância (${dist.toFixed(1)}km) excede o limite de entrega (${limiteDistKm}km).` }),
              { status: 422, headers: { ...CORS, "Content-Type": "application/json" } }
            );
          }
          const r = calcularFreteEsperado(dist, tabelaFrete);
          freteFinal     = r.loja;
          freteMotoboy   = r.motoboy;
          freteACombinar = r.acombinar;
        }
      }
    }

    // ── Idempotência ─────────────────────────────────────────────
    const idempotencyKey = payload.idempotency_key as string | undefined;
    if (idempotencyKey) {
      const { data: existing } = await supa
        .from("pedidos")
        .select("id, frete_cobrado_cliente, frete_motoboy, frete_a_combinar")
        .eq("idempotency_key", idempotencyKey)
        .maybeSingle();
      if (existing) {
        return new Response(
          JSON.stringify({
            id: existing.id,
            frete_cobrado_cliente: existing.frete_cobrado_cliente,
            frete_motoboy: existing.frete_motoboy,
            frete_a_combinar: existing.frete_a_combinar,
            duplicate: true,
          }),
          { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
        );
      }
    }

    const subtotal         = Number(payload.subtotal          ?? 0);
    const descontoCupom    = Number(payload.desconto_cupom    ?? 0);
    const descontoPdv      = Number(payload.desconto_pdv_valor ?? 0);
    const descontoCashback = Number(payload.cashback_valor    ?? 0);
    const freteParaTotal   = payload.tipo_entrega === "delivery" ? freteFinal : 0;

    const totalGeral = Math.max(
      0,
      subtotal - descontoCupom - descontoPdv - descontoCashback + freteParaTotal
    );

    const pedido = {
      ...payload,
      frete_cobrado_cliente: freteFinal,
      frete_motoboy:         freteMotoboy,
      frete_a_combinar:      freteACombinar,
      total_geral:           totalGeral,
    };

    const { data: salvo, error } = await supa
      .from("pedidos")
      .insert([pedido])
      .select()
      .single();

    if (error) {
      console.error("[validar-pedido] Erro ao inserir:", error);
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        id: salvo.id,
        frete_cobrado_cliente: freteFinal,
        frete_motoboy: freteMotoboy,
        frete_a_combinar: freteACombinar,
      }),
      { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[validar-pedido] Erro inesperado:", err);
    return new Response(
      JSON.stringify({ error: "Erro interno" }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
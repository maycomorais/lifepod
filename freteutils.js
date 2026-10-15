// ═══════════════════════════════════════════════════════════════
//  freteUtils.js — Cálculo de frete unificado
//  Usado por: app.js, admin.js
//  ⚠️  A Edge Function validar-pedido/index.ts replica esta lógica
//      LITERALMENTE. Qualquer alteração DEVE ser espelhada lá.
//
//  Regras:
//    - Distância conhecida + faixa normal    → cobra valor da tabela
//    - Distância conhecida + faixa "combinar"→ cobra 0 (a combinar)
//    - Sem localização (GPS negado)          → taxa padrão (2,1–3 km)
//    - OSRM falha                            → taxa padrão (2,1–3 km)
// ═══════════════════════════════════════════════════════════════

const FRETE_FAIXAS_KM = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
];

const FRETE_FALLBACK = [
  6000, 9000, 12000, 15000, 18000, 21000, 24000, 27000, 30000, 33000,
  36000, 39000, 42000, 45000, 48000, 51000, 54000, 57000, 60000, 63000,
];

const FRETE_FAIXA_FALLBACK_SEM_GPS = 2; // índice da faixa "2,1 a 3 km"

/**
 * Consulta OSRM (rota real de carro). Retorna distância em km ou null.
 * Timeout 6s. Sem fallback Haversine — se falhar, retorna null.
 */
async function obterDistanciaPelaRota(latOrigem, lngOrigem, latDestino, lngDestino) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${lngOrigem},${latOrigem};${lngDestino},${latDestino}?overview=false`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    if (d.code === "Ok" && d.routes?.[0]?.distance) {
      return d.routes[0].distance / 1000;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Calcula o frete para uma distância conhecida.
 * Respeita o campo `acombinar` da faixa correspondente.
 *
 * @returns {{ loja:number, motoboy:number, index:number, distancia:number, acombinar:boolean }}
 */
function calcularFretePorDistancia(distKm, tabelaFrete) {
  if (!Number.isFinite(distKm) || distKm <= 0) {
    return calcularFreteSemLocalizacao(tabelaFrete);
  }

  let idx = -1;
  for (let i = 0; i < FRETE_FAIXAS_KM.length; i++) {
    if (distKm <= FRETE_FAIXAS_KM[i]) { idx = i; break; }
  }
  // Acima de 20 km → teto = última faixa (19,1 a 20 km)
  if (idx === -1) idx = FRETE_FAIXAS_KM.length - 1;

  const faixa = Array.isArray(tabelaFrete) ? tabelaFrete[idx] : null;

  // ── Faixa marcada como "A combinar" pelo admin ──────────────────
  if (faixa && faixa.acombinar === true) {
    return {
      loja: 0,
      motoboy: 0,
      index: idx,
      distancia: distKm,
      acombinar: true,
    };
  }

  // ── Faixa normal → cobra valores da tabela (ou fallback) ────────
  return {
    loja:    Number(faixa?.loja)    || FRETE_FALLBACK[idx],
    motoboy: Number(faixa?.motoboy) || FRETE_FALLBACK[idx],
    index: idx,
    distancia: distKm,
    acombinar: false,
  };
}

/**
 * Frete quando o cliente NÃO informa localização (GPS negado, OSRM falhou).
 * Cobra a faixa fixa "2,1 a 3 km" — a não ser que o admin tenha marcado
 * essa faixa específica como "a combinar" (raro).
 */
function calcularFreteSemLocalizacao(tabelaFrete) {
  const idx = FRETE_FAIXA_FALLBACK_SEM_GPS;
  const faixa = Array.isArray(tabelaFrete) ? tabelaFrete[idx] : null;

  if (faixa && faixa.acombinar === true) {
    return {
      loja: 0,
      motoboy: 0,
      index: idx,
      distancia: null,
      semLocalizacao: true,
      acombinar: true,
    };
  }

  return {
    loja:    Number(faixa?.loja)    || FRETE_FALLBACK[idx],
    motoboy: Number(faixa?.motoboy) || FRETE_FALLBACK[idx],
    index: idx,
    distancia: null,
    semLocalizacao: true,
    acombinar: false,
  };
}
// Consumo de Claude: lo que gastaron las corridas (siempre disponible) y, si la cuenta lo informa, el porcentaje
// usado del plan en la ventana de 5 horas y en la semana. Lo ven el Propietario y quien tenga el permiso
// "ver consumo"; a ellos les llega el aviso cuando el plan pasa el umbral que se definió en la charla.

const HORA = 3_600_000;

export function crearConsumo({ db, ajustes, politica, salida = null, avisos = null, plan = async () => null, reloj = () => Date.now(), log = console }) {
  let cache = { en: 0, datos: null };

  /** Porcentaje del plan, con caché (no se consulta en cada mensaje). */
  async function delPlan({ fresco = false } = {}) {
    const ahora = reloj();
    const vigencia = cache.datos ? 5 * 60_000 : 30 * 60_000;
    if (!fresco && ahora - cache.en < vigencia) return cache.datos;
    cache.en = ahora;
    try { cache.datos = await plan(); } catch (e) { log.warn?.('[consumo] plan', e.message); cache.datos = null; }
    return cache.datos;
  }

  function suma(desde) {
    return db.prepare(`SELECT COUNT(*) AS corridas, COALESCE(SUM(tokens_entrada), 0) AS entrada, COALESCE(SUM(tokens_cache), 0) AS cache,
      COALESCE(SUM(tokens_salida), 0) AS salida, COALESCE(SUM(costo_usd), 0) AS costo FROM corridas WHERE inicio >= ? AND costo_usd IS NOT NULL`).get(desde);
  }

  function local() {
    const ahora = reloj();
    return { cincoHoras: suma(ahora - 5 * HORA), semana: suma(ahora - 7 * 24 * HORA) };
  }

  const k = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const horaDe = (ms) => new Date(ms).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', timeZone: ajustes.get('zona_horaria', 'UTC') || 'UTC' });

  /** Una línea para el bloque <superagent> (lo que ya está en caché: no hace pedidos). */
  function linea({ contexto = null } = {}) {
    const l = local();
    const p = cache.datos;
    const partes = [];
    if (p?.cincoHoras?.pct != null) partes.push(`plan: ${Math.round(p.cincoHoras.pct)}% de las 5 h${p.cincoHoras.reinicia ? ` (se renueva ${horaDe(p.cincoHoras.reinicia)})` : ''}${p.semana?.pct != null ? `, ${Math.round(p.semana.pct)}% de la semana` : ''}`);
    partes.push(`últimas 5 h: ${l.cincoHoras.corridas} corridas, ${k(l.cincoHoras.entrada + l.cincoHoras.cache + l.cincoHoras.salida)} tokens (≈ US$ ${l.cincoHoras.costo.toFixed(2)} a precio de API)`);
    if (contexto) partes.push(`contexto de esta conversación: ${k(contexto)} tokens (se compacta solo al ${ajustes.num('compactar_pct', 60)}%)`);
    return `Consumo de Claude: ${partes.join('; ')}.`;
  }

  async function resumen() {
    return { plan: await delPlan(), local: local(), avisoPct: ajustes.num('aviso_consumo_pct', 80), compactarPct: ajustes.num('compactar_pct', 60) };
  }

  /** Personas que ven el consumo (y reciben sus avisos): el Propietario y quien tenga el permiso. */
  function destinatarios() {
    return db.prepare('SELECT id, telefono, verificada FROM personas WHERE activa = 1 AND alta_manual = 1 AND telefono IS NOT NULL').all()
      .filter((p) => politica.para({ personaId: p.id }).decidir('ver_consumo').decision === 'permitir');
  }

  /** Después de cada corrida: si el plan pasó el umbral, avisa una vez por ventana. */
  async function revisar() {
    const p = await delPlan();
    const umbral = ajustes.num('aviso_consumo_pct', 80);
    if (!umbral || umbral > 100) return null;
    for (const [nombre, v] of [['5 h', p?.cincoHoras], ['semana', p?.semana]]) {
      if (v?.pct == null || v.pct < umbral) continue;
      const clave = `aviso_consumo:${nombre}:${v.reinicia ?? Math.floor(reloj() / (5 * HORA))}`;
      if (ajustes.get(clave)) continue;
      ajustes.set(clave, '1');
      const texto = `Aviso de consumo: Claude va por el ${Math.round(v.pct)}% del plan (${nombre === '5 h' ? 'ventana de 5 horas' : 'semana'})${v.reinicia ? `; se renueva ${nombre === '5 h' ? `a las ${horaDe(v.reinicia)}` : new Date(v.reinicia).toLocaleDateString('es')}` : ''}. Si se llega al 100%, los mensajes quedan en cola hasta que se renueve.`;
      // El Propietario lo recibe por su canal de avisos; los demás con el permiso, por WhatsApp.
      avisos?.alPropietario(texto, { tipo: 'aviso' });
      for (const d of destinatarios()) {
        if (politica.para({ personaId: d.id }).decidir('aprobar').decision === 'permitir') continue;
        salida?.encolar({ chatId: `${d.telefono}@c.us`, texto, origen: 'consumo' });
      }
      return texto;
    }
    return null;
  }

  return { linea, resumen, revisar, delPlan, local, destinatarios };
}

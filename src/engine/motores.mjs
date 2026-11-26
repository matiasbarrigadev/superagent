// Qué motor corre cada cosa. El Propietario lo elige conversando (configurar_motores, con ficha y confirmación en
// otro mensaje) o en el panel (Motores); acá se guarda y se aplica. La autoridad sigue en el gateway:
// - si un motor no puede sacar de verdad una herramienta que el rol no tiene, no corre para ese rol;
// - un motor por uso con tope de gasto no pasa del tope;
// - con respaldo configurado, si un motor se queda sin plan, sin crédito o sin credencial, sigue el próximo.

export const TIPOS_MOTOR = {
  propietario: 'Tu charla con el agente (modo completo)',
  equipo: 'Charlas internas y grupos',
  terceros: 'Clientes y personas externas',
  trabajos: 'Trabajos y sesiones de proyecto',
  rutinas: 'Rutinas programadas',
};

/** Lo que sabe el panel y el agente de cada motor. */
export const INFO_MOTOR = {
  claude: { nombre: 'Claude', variante: 'Suscripción Pro / Max', pago: 'suscripcion', credencial: 'Cuenta de Claude', modelos: ['opus', 'sonnet', 'haiku'] },
  'claude-api': { nombre: 'Claude', variante: 'Clave de API', pago: 'uso', credencial: 'ANTHROPIC_API_KEY', modelos: ['opus', 'sonnet', 'haiku'] },
  codex: { nombre: 'Codex', variante: 'ChatGPT o clave de OpenAI', pago: 'suscripcion_o_uso', credencial: 'Cuenta de ChatGPT o CODEX_API_KEY', modelos: ['gpt-5.5', 'gpt-5.5-codex', 'gpt-5.5-mini'] },
  gemini: { nombre: 'Gemini', variante: 'Clave de Google AI Studio', pago: 'uso_con_capa_gratis', credencial: 'GEMINI_API_KEY', modelos: ['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-flash'] },
  opencode: { nombre: 'OpenCode', variante: 'DeepSeek, MiniMax, Kimi, Qwen, OpenRouter…', pago: 'uso', credencial: 'La clave de cada proveedor', modelos: ['deepseek/deepseek-chat', 'minimax/MiniMax-M2', 'moonshotai/kimi-k2', 'openrouter/<modelo>', 'opencode/<modelo>-free'] },
};
export const NOMBRES_MOTOR = Object.fromEntries(Object.entries(INFO_MOTOR).map(([k, v]) => [k, `${v.nombre} (${v.variante})`]));
const POR_USO = new Set(['claude-api', 'opencode', 'gemini', 'codex']);
// Los que informan el precio de cada corrida: solo a esos se les puede poner tope de gasto.
const CON_PRECIO = new Set(['claude-api', 'opencode']);

/** Tipo de corrida para elegir motor, a partir de lo que armó el contexto. */
export function tipoMotor(spec) {
  if (spec.completo) return 'propietario';
  if (spec.variante === 'tercero') return 'terceros';
  if (spec.tipo === 'trabajo' || spec.tipo === 'sesion') return 'trabajos';
  if (spec.tipo === 'rutina') return 'rutinas';
  return 'equipo';
}

const DIA = 86_400_000;

/**
 * `gasto(motor, desde)`: dólares gastados por ese motor desde una fecha (lo que informan las corridas).
 * `reloj`: para los bloqueos por límite.
 */
export function crearMotores({ ajustes, adaptadores, cuenta = null, gasto = () => 0, reloj = () => Date.now() }) {
  const bloqueos = new Map(); // motor → { hasta, motivo }

  function leer() {
    try { return JSON.parse(ajustes.get('motores') || '{}'); } catch { return {}; }
  }

  /** Lo que le falta a un motor para correr (null si nada). */
  function disponible(id, modelo = null) {
    if (!adaptadores[id]) return 'un motor conocido';
    if (id === 'claude') return cuenta?.tokenActual?.() ? null : 'conectar la cuenta de Claude (panel → Inicio → Claude)';
    if (id === 'claude-api') return cuenta?.tieneClaveApi?.() ? null : 'la clave ANTHROPIC_API_KEY (panel → Conexiones → Variables)';
    return adaptadores[id].falta?.(modelo) ?? null;
  }

  function gastoDe(id) {
    const ahora = new Date(reloj());
    const dia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).getTime();
    const mes = new Date(ahora.getFullYear(), ahora.getMonth(), 1).getTime();
    return { dia: Number(gasto(id, dia) || 0), mes: Number(gasto(id, mes) || 0) };
  }

  /** null si puede gastar; si no, el texto de qué tope pasó. */
  function sobreTope(id) {
    const t = leer().topes?.[id];
    if (!t || !CON_PRECIO.has(id)) return null;
    const g = gastoDe(id);
    if (t.dia != null && g.dia >= t.dia) return `llegó a su tope diario de US$ ${t.dia}`;
    if (t.mes != null && g.mes >= t.mes) return `llegó a su tope mensual de US$ ${t.mes}`;
    return null;
  }

  function bloqueado(id) {
    const b = bloqueos.get(id);
    if (b && b.hasta > reloj()) return b.motivo;
    if (b) bloqueos.delete(id);
    return null;
  }

  /** Un motor dio límite o sin credencial: por un rato no se elige (si hay respaldo, corre el siguiente). */
  function bloquear(id, motivo, ms = motivo === 'limite' ? 15 * 60_000 : 5 * 60_000) {
    bloqueos.set(id, { hasta: reloj() + ms, motivo });
  }

  /** ¿Este motor puede correr esta corrida? Devuelve null o por qué no. */
  function impedimento(spec, cand) {
    const ad = adaptadores[cand.motor];
    if (!ad) return 'no existe';
    if (!spec.completo && ad.puedeNegar) {
      const tiene = new Set(spec.herramientasClaude ?? []);
      const sinGarantia = [...adaptadores.claude.puedeNegar].filter((h) => !tiene.has(h) && !ad.puedeNegar.has(h));
      if (sinGarantia.length) return `no puede sacar ${sinGarantia.join(', ')}`;
    }
    if (cand.motor === 'opencode' && !cand.modelo) return 'no tiene modelo elegido';
    const falta = disponible(cand.motor, cand.modelo);
    if (falta) return `falta ${falta}`;
    const tope = sobreTope(cand.motor);
    if (tope) return tope;
    const b = bloqueado(cand.motor);
    if (b) return b === 'limite' ? 'está en su límite de uso' : 'su credencial no funciona';
    return null;
  }

  /**
   * Motor de una corrida: { motor, modelo (o null: el de siempre), tipo, familia, nota, detener }.
   * `detener`: texto si no debe correr nada (todos los posibles pasaron su tope de gasto).
   */
  function elegir(spec) {
    const c = leer();
    const tipo = tipoMotor(spec);
    const principal = c[tipo] ?? c.defecto ?? { motor: 'claude' };
    // Sin suscripción conectada pero con clave de API, Claude usa la clave (instalación solo con API).
    const base = principal.motor === 'claude' && disponible('claude') && !disponible('claude-api') ? { ...principal, motor: 'claude-api' } : principal;
    const candidatos = [base, ...(c.respaldo ?? [])].filter((x, i, a) => adaptadores[x?.motor] && a.findIndex((y) => y.motor === x.motor && (y.modelo ?? null) === (x.modelo ?? null)) === i);
    const motivos = [];
    for (const cand of candidatos) {
      const imp = impedimento(spec, cand);
      if (!imp) {
        const nota = motivos.length ? `${motivos.join('; ')}: corre ${cand.motor}` : base !== principal ? 'sin suscripción conectada: usa la clave de API' : null;
        return { motor: cand.motor, modelo: cand.modelo ?? null, tipo, familia: adaptadores[cand.motor].familia ?? 'claude', nota, respaldo: cand !== base };
      }
      motivos.push(`${cand.motor} ${imp}`);
    }
    // Nada puede correr. Si fue por un tope de gasto, no se corre (el tope es del Propietario); si no, se intenta con
    // el principal y el error sigue el camino de siempre (avisos, cola).
    const porTope = candidatos.every((x) => sobreTope(x.motor));
    // Uno que el rol permita (aunque le falte la credencial o esté en su límite); si ninguno, Claude.
    const elegido = candidatos.find((x) => !/no puede sacar|no tiene modelo/.test(impedimento(spec, x) ?? '')) ?? { motor: 'claude' };
    return {
      motor: elegido.motor, modelo: elegido.modelo ?? null, tipo, familia: adaptadores[elegido.motor]?.familia ?? 'claude',
      nota: motivos.join('; '), detener: porTope ? `${motivos.join('; ')}.` : null, respaldo: false,
    };
  }

  /** Para el panel y el agente: todo lo que hay, con estado real. */
  function estado() {
    const c = leer();
    return {
      tipos: Object.entries(TIPOS_MOTOR).map(([id, desc]) => {
        const a = c[id] ?? c.defecto ?? { motor: 'claude' };
        return { id, desc, motor: a.motor, modelo: a.modelo ?? null, propio: !!c[id], falta: disponible(a.motor, a.modelo) };
      }),
      defecto: c.defecto ?? { motor: 'claude' },
      motores: Object.keys(adaptadores).map((id) => ({
        id, ...INFO_MOTOR[id], porUso: POR_USO.has(id), conPrecio: CON_PRECIO.has(id), falta: id === 'opencode' ? null : disponible(id),
        gasto: gastoDe(id), tope: c.topes?.[id] ?? null, sobreTope: sobreTope(id), bloqueado: bloqueado(id),
      })),
      respaldo: c.respaldo ?? [],
    };
  }

  /** Texto para el agente: qué corre cada tipo, qué falta, respaldo, topes y gasto. */
  function ficha(cambios = null) {
    const c = aplicar(leer(), cambios ?? {});
    const lineas = [];
    for (const [t, desc] of Object.entries(TIPOS_MOTOR)) {
      const a = c[t] ?? c.defecto ?? { motor: 'claude' };
      const falta = disponible(a.motor, a.modelo);
      lineas.push(`- ${t} (${desc}): ${a.motor}${a.modelo ? ` con ${a.modelo}` : ''}${falta ? ` — falta ${falta}` : ''}`);
    }
    const resp = (c.respaldo ?? []).length ? `Respaldo (si el motor de turno se queda sin plan, crédito o credencial): ${c.respaldo.map((r) => `${r.motor}${r.modelo ? ` (${r.modelo})` : ''}`).join(' → ')}.` : 'Sin respaldo automático: si el motor de turno se queda sin plan o crédito, esas charlas esperan.';
    const topes = Object.entries(c.topes ?? {}).map(([m, t]) => `${m}: ${t.dia != null ? `US$ ${t.dia}/día` : ''}${t.dia != null && t.mes != null ? ', ' : ''}${t.mes != null ? `US$ ${t.mes}/mes` : ''} (gastado hoy US$ ${gastoDe(m).dia.toFixed(2)}, este mes US$ ${gastoDe(m).mes.toFixed(2)})`);
    return `${lineas.join('\n')}\n\n${resp}\n${topes.length ? `Topes de gasto: ${topes.join('; ')}.` : 'Sin topes de gasto.'}\n\nMotores:\n${Object.keys(adaptadores).map((k) => `- ${k}: ${NOMBRES_MOTOR[k]}${POR_USO.has(k) ? ', por uso' : ''}`).join('\n')}\nTodos respetan los roles: lo que un rol no tiene no lo tiene en ningún motor.`;
  }

  function validarAsig(a, donde) {
    if (!adaptadores[a?.motor]) throw new Error(`Motor desconocido${donde ? ` en ${donde}` : ''}: ${a?.motor}. Los motores: ${Object.keys(adaptadores).join(', ')}.`);
    const modelo = a.modelo ? String(a.modelo).trim().slice(0, 120) : null;
    if (a.motor === 'opencode' && !modelo) throw new Error('Para OpenCode hace falta el modelo, con la forma proveedor/modelo (por ejemplo deepseek/deepseek-chat).');
    if (modelo && !/^[\w.:/@-]+$/.test(modelo)) throw new Error(`Modelo inválido: ${modelo}`);
    return { motor: a.motor, ...(modelo ? { modelo } : {}) };
  }

  /**
   * Valida cambios. Forma: { <tipo>|defecto: { motor, modelo } | null, respaldo: [{ motor, modelo }] | null,
   * topes: { <motor>: { dia, mes } | null } }.
   */
  function validar(cambios) {
    const out = {};
    for (const [t, a] of Object.entries(cambios ?? {})) {
      if (t === 'respaldo') {
        if (a === null) { out.respaldo = null; continue; }
        if (!Array.isArray(a) || a.length > 4) throw new Error('El respaldo es una lista de hasta 4 motores, en orden.');
        out.respaldo = a.map((x, i) => validarAsig(x, `respaldo ${i + 1}`));
        continue;
      }
      if (t === 'topes') {
        out.topes = {};
        for (const [m, v] of Object.entries(a ?? {})) {
          if (!adaptadores[m]) throw new Error(`Motor desconocido en topes: ${m}.`);
          if (!POR_USO.has(m)) throw new Error(`${m} no se cobra por uso: no lleva tope.`);
          if (!CON_PRECIO.has(m)) throw new Error(`${m} no informa el precio de cada corrida: no se le puede controlar un tope (sí a claude-api y opencode).`);
          if (v === null) { out.topes[m] = null; continue; }
          const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
          const dia = num(v.dia), mes = num(v.mes);
          for (const x of [dia, mes]) if (x !== null && !(x >= 0 && x <= 100_000)) throw new Error('Los topes van en dólares, entre 0 y 100000.');
          out.topes[m] = { dia, mes };
        }
        continue;
      }
      if (t !== 'defecto' && !TIPOS_MOTOR[t]) throw new Error(`Tipo desconocido: ${t}. Los tipos: defecto, ${Object.keys(TIPOS_MOTOR).join(', ')}, respaldo, topes.`);
      out[t] = a === null ? null : validarAsig(a, t);
    }
    return out;
  }

  function aplicar(c, v) {
    const n = { ...c, topes: { ...(c.topes ?? {}) } };
    for (const [t, a] of Object.entries(v)) {
      if (t === 'topes') { for (const [m, x] of Object.entries(a)) { if (x === null || (x.dia === null && x.mes === null)) delete n.topes[m]; else n.topes[m] = x; } continue; }
      if (a === null) delete n[t]; else n[t] = a;
    }
    if (!Object.keys(n.topes).length) delete n.topes;
    return n;
  }

  function configurar(cambios) {
    const c = aplicar(leer(), validar(cambios));
    ajustes.set('motores', JSON.stringify(c));
    return c;
  }

  return { elegir, estado, ficha, validar, configurar, disponible, leer, bloquear, bloqueado, gastoDe, sobreTope };
}

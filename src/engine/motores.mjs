// Qué motor corre cada cosa. El Propietario lo elige conversando (herramienta configurar_motores, con ficha y
// confirmación en otro mensaje); acá se guarda y se aplica. La autoridad sigue en el gateway: si un motor no puede
// sacar de verdad una herramienta que el rol no tiene, no corre para ese rol (corre Claude).

export const TIPOS_MOTOR = {
  propietario: 'el Propietario en su charla (modo completo)',
  equipo: 'las demás charlas internas (equipo, grupos)',
  terceros: 'personas externas (clientes, terceros)',
  trabajos: 'trabajos y sesiones de proyecto',
  rutinas: 'rutinas programadas',
};

export const NOMBRES_MOTOR = {
  claude: 'Claude con la suscripción (Pro/Max): sin costo extra, con las ventanas del plan',
  'claude-api': 'Claude con clave de API (ANTHROPIC_API_KEY): se paga por uso, en dólares',
  opencode: 'OpenCode: DeepSeek, MiniMax, Kimi, Qwen, OpenRouter… con la clave de cada proveedor, por uso',
};

/** Tipo de corrida para elegir motor, a partir de lo que armó el contexto. */
export function tipoMotor(spec) {
  if (spec.completo) return 'propietario';
  if (spec.variante === 'tercero') return 'terceros';
  if (spec.tipo === 'trabajo' || spec.tipo === 'sesion') return 'trabajos';
  if (spec.tipo === 'rutina') return 'rutinas';
  return 'equipo';
}

export function crearMotores({ ajustes, adaptadores, cuenta = null }) {
  function leer() {
    try { return JSON.parse(ajustes.get('motores') || '{}'); } catch { return {}; }
  }

  /** Lo que cada motor necesita y si lo tiene. */
  function disponible(id, modelo = null) {
    if (id === 'claude') return cuenta?.tokenActual?.() ? null : 'conectar la cuenta de Claude (panel → Claude)';
    if (id === 'claude-api') return cuenta?.tieneClaveApi?.() ? null : 'la clave ANTHROPIC_API_KEY (panel → Variables de entorno)';
    if (id === 'opencode') return adaptadores.opencode?.falta(modelo) ?? null;
    return 'un motor conocido';
  }

  /**
   * Motor de una corrida. Devuelve { motor, modelo (o null: el de siempre), tipo, nota }.
   * Si a Claude le falta la suscripción y hay clave de API, usa la clave (instalación solo con API).
   */
  function elegir(spec) {
    const c = leer();
    const tipo = tipoMotor(spec);
    const asig = c[tipo] ?? c.defecto ?? { motor: 'claude' };
    let motor = adaptadores[asig.motor] ? asig.motor : 'claude';
    let modelo = asig.modelo ?? null;
    let nota = null;
    // Roles y autoridad: lo que el rol no tiene, el motor tiene que poder sacarlo.
    const ad = adaptadores[motor];
    if (!spec.completo && ad?.puedeNegar) {
      const tiene = new Set(spec.herramientasClaude ?? []);
      const sinGarantia = [...adaptadores.claude.puedeNegar].filter((h) => !tiene.has(h) && !ad.puedeNegar.has(h));
      if (sinGarantia.length) { nota = `${motor} no puede sacar ${sinGarantia.join(', ')}: corre Claude`; motor = 'claude'; modelo = null; }
    }
    if (motor === 'opencode' && !modelo) { nota = 'OpenCode sin modelo elegido: corre Claude'; motor = 'claude'; }
    if (motor === 'claude' && disponible('claude') && !disponible('claude-api')) { motor = 'claude-api'; nota = nota ?? 'sin suscripción conectada: usa la clave de API'; }
    if (motor === 'claude-api' && disponible('claude-api') && !disponible('claude')) { motor = 'claude'; modelo = null; }
    return { motor, modelo, tipo, familia: adaptadores[motor]?.familia ?? 'claude', nota };
  }

  /** Texto para el agente: qué corre cada tipo, qué falta y qué cuesta. */
  function ficha(cambios = null) {
    const c = { ...leer(), ...(cambios ?? {}) };
    const lineas = [];
    for (const [t, desc] of Object.entries(TIPOS_MOTOR)) {
      const a = c[t] ?? c.defecto ?? { motor: 'claude' };
      const falta = disponible(a.motor, a.modelo);
      lineas.push(`- ${t} (${desc}): ${a.motor}${a.modelo ? ` con ${a.modelo}` : ''}${falta ? ` — falta ${falta}` : ''}`);
    }
    return `${lineas.join('\n')}\n\nMotores:\n${Object.entries(NOMBRES_MOTOR).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\nTodos respetan los roles: las herramientas que un rol no tiene no las tiene en ningún motor.`;
  }

  /** Valida y guarda. `cambios`: { tipo: { motor, modelo } | null } (null vuelve al de por defecto). */
  function validar(cambios) {
    const out = {};
    for (const [t, a] of Object.entries(cambios ?? {})) {
      if (t !== 'defecto' && !TIPOS_MOTOR[t]) throw new Error(`Tipo desconocido: ${t}. Los tipos: defecto, ${Object.keys(TIPOS_MOTOR).join(', ')}.`);
      if (a === null) { out[t] = null; continue; }
      if (!adaptadores[a?.motor]) throw new Error(`Motor desconocido: ${a?.motor}. Los motores: ${Object.keys(adaptadores).join(', ')}.`);
      const modelo = a.modelo ? String(a.modelo).trim() : null;
      if (a.motor === 'opencode' && !modelo) throw new Error('Para OpenCode hace falta el modelo, con la forma proveedor/modelo (por ejemplo deepseek/deepseek-chat).');
      out[t] = { motor: a.motor, ...(modelo ? { modelo } : {}) };
    }
    return out;
  }

  function configurar(cambios) {
    const v = validar(cambios);
    const c = leer();
    for (const [t, a] of Object.entries(v)) { if (a === null) delete c[t]; else c[t] = a; }
    ajustes.set('motores', JSON.stringify(c));
    return c;
  }

  return { elegir, ficha, validar, configurar, disponible, leer };
}

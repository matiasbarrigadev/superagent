// Motores de IA: qué motor atiende cada tipo de conversación, respaldo automático, topes de gasto y las credenciales
// de cada motor. Todo esto también se cambia hablando con el agente ("usá DeepSeek para los clientes").
import { useEffect, useMemo, useState } from 'react';
import { borrar, post, put } from '../api.js';
import { useAccion, useDatos } from '../hooks.js';
import { Aviso, Boton, CampoChico, Chip, Estado, Girando, Selector, Subtitulo, Tabla, Tarjeta } from '../components/ui.jsx';

const NOMBRE_TIPO = {
  propietario: 'Vos (Propietario)', equipo: 'Equipo y grupos', terceros: 'Clientes y externos', trabajos: 'Trabajos', rutinas: 'Rutinas',
};
const TIPO_MODELO_CLAUDE = { propietario: 'orquestador', equipo: 'orquestador', terceros: 'tercero', trabajos: 'trabajo', rutinas: 'rutina' };
const PAGO = {
  suscripcion: { tono: 'verde', texto: 'Suscripción' },
  suscripcion_o_uso: { tono: 'azul', texto: 'Suscripción o por uso' },
  uso: { tono: 'ambar', texto: 'Por uso' },
  uso_con_capa_gratis: { tono: 'violeta', texto: 'Capa gratis + uso' },
};
const usd = (n) => (n == null ? '—' : `US$ ${Number(n).toFixed(2)}`);
const nombreMotor = (m) => (m ? `${m.nombre} · ${m.variante}` : '');
const cx = (...c) => c.filter(Boolean).join(' ');
/** "falta …" del servidor → etiqueta corta; el texto completo queda en el tooltip. */
function Falta({ texto }) {
  const t = String(texto).replace(/^falta /, '');
  const corto = /cuenta de Claude/.test(t) ? 'Falta conectar Claude' : /ChatGPT/.test(t) ? 'Falta conectar ChatGPT' : /([A-Z][A-Z0-9_]{5,})/.test(t) ? `Falta ${/([A-Z][A-Z0-9_]{5,})/.exec(t)[1]}` : /modelo/.test(t) ? 'Falta el modelo' : 'Falta configurar';
  return <Estado tono="espera" title={`Falta ${t}`}>{corto}</Estado>;
}


/** Login de Codex con la cuenta de ChatGPT: link + código, y espera a que quede conectada. */
function LoginCodex({ codex, recargar }) {
  const { cargando, error, correr } = useAccion();
  const [l, setL] = useState(codex?.login ?? null);
  useEffect(() => {
    if (!l) return undefined;
    const t = setInterval(recargar, 3000);
    return () => clearInterval(t);
  }, [l, recargar]);
  useEffect(() => { if (codex?.conectada) setL(null); }, [codex?.conectada]);
  if (codex?.conectada) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Estado tono="ok">ChatGPT conectado</Estado>
        <Boton variante="fantasma" cargando={cargando === 'x'} onClick={correr('x', async () => { await borrar('/api/motores/codex'); recargar(); })}>Desconectar</Boton>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {!l ? (
        <Boton variante="secundario" className="self-start" cargando={cargando === 'l'} onClick={correr('l', async () => setL(await post('/api/motores/codex/login')))}>Conectar ChatGPT</Boton>
      ) : (
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm dark:border-sky-900 dark:bg-sky-950/40">
          <p>1. Abrí <a className="font-medium text-sky-700 underline dark:text-sky-300" href={l.url} target="_blank" rel="noreferrer">{l.url}</a> y entrá con tu cuenta de ChatGPT.</p>
          <p className="mt-1">2. Escribí este código:</p>
          <p className="my-2 select-all font-mono text-2xl font-semibold tracking-widest">{l.codigo}</p>
          <p className="flex items-center gap-2 text-xs text-stone-600 dark:text-stone-400"><Girando /> Esperando que lo autorices (vence en 15 minutos). No compartas el código.</p>
        </div>
      )}
      {error && <Aviso>{error}</Aviso>}
    </div>
  );
}

/** Cargar una clave que necesita un motor (queda cifrada; no se vuelve a mostrar). */
function CargarClave({ nombre, alGuardar }) {
  const [abierto, setAbierto] = useState(false);
  const [valor, setValor] = useState('');
  const { cargando, error, correr } = useAccion();
  if (!abierto) return <Boton variante="secundario" className="min-h-8 px-3 py-1" onClick={() => setAbierto(true)}>Cargar</Boton>;
  return (
    <form className="flex flex-col gap-1.5" onSubmit={correr('g', async () => { await post('/api/entorno', { nombre, valor, descripcion: 'Clave de un motor de IA' }); setValor(''); setAbierto(false); alGuardar(); })}>
      <div className="flex gap-1.5">
        <CampoChico type="password" autoComplete="off" autoFocus aria-label={`Valor de ${nombre}`} placeholder="Pegá la clave" value={valor} onChange={(e) => setValor(e.target.value)} className="min-w-40" />
        <Boton className="min-h-8 px-3 py-1" cargando={cargando === 'g'} disabled={!valor.trim()}>Guardar</Boton>
        <Boton type="button" variante="fantasma" className="min-h-8 px-2 py-1" onClick={() => setAbierto(false)}>×</Boton>
      </div>
      {error && <Aviso>{error}</Aviso>}
    </form>
  );
}

export default function Motores() {
  const { datos, cargar, error: errorCarga } = useDatos('/api/motores');
  const { cargando, error, setError, correr } = useAccion();
  const [borrador, setBorrador] = useState(null);
  const [confirmando, setConfirmando] = useState(false);
  const [ok, setOk] = useState(null);

  // Borrador editable: lo que se ve en pantalla hasta guardar.
  const original = useMemo(() => (datos ? {
    tipos: Object.fromEntries(datos.tipos.map((t) => [t.id, { motor: t.motor, modelo: t.modelo ?? '' }])),
    respaldo: datos.respaldo.map((r) => ({ motor: r.motor, modelo: r.modelo ?? '' })),
    topes: Object.fromEntries(datos.motores.filter((m) => m.conPrecio).map((m) => [m.id, { dia: m.tope?.dia ?? '', mes: m.tope?.mes ?? '' }])),
  } : null), [datos]);
  useEffect(() => { if (original && !borrador) setBorrador(structuredClone(original)); }, [original, borrador]);

  const motores = datos?.motores ?? [];
  const porId = Object.fromEntries(motores.map((m) => [m.id, m]));
  const opcionesMotor = motores.map((m) => ({ valor: m.id, texto: nombreMotor(m) }));

  const cambios = useMemo(() => {
    if (!borrador || !original) return [];
    const l = [];
    for (const [t, a] of Object.entries(borrador.tipos)) {
      const o = original.tipos[t];
      if (a.motor !== o.motor || (a.modelo ?? '') !== (o.modelo ?? '')) l.push(`${NOMBRE_TIPO[t]}: ${porId[a.motor]?.nombre ?? a.motor}${a.modelo ? ` (${a.modelo})` : ''}`);
    }
    if (JSON.stringify(borrador.respaldo) !== JSON.stringify(original.respaldo)) l.push(`Respaldo: ${borrador.respaldo.length ? borrador.respaldo.map((r) => `${porId[r.motor]?.nombre ?? r.motor}${r.modelo ? ` (${r.modelo})` : ''}`).join(' → ') : 'apagado'}`);
    for (const [m, x] of Object.entries(borrador.topes)) {
      const o = original.topes[m];
      if (String(x.dia) !== String(o?.dia ?? '') || String(x.mes) !== String(o?.mes ?? '')) l.push(`Tope de ${porId[m]?.nombre ?? m} (${porId[m]?.variante ?? ''}): ${x.dia !== '' ? `US$ ${x.dia}/día` : 'sin tope diario'}, ${x.mes !== '' ? `US$ ${x.mes}/mes` : 'sin tope mensual'}`);
    }
    return l;
  }, [borrador, original, porId]);

  if (errorCarga) return <Aviso>{errorCarga}</Aviso>;
  if (!datos || !borrador) return <div className="flex justify-center p-10"><Girando className="size-6" /></div>;

  const setTipo = (t, cambio) => setBorrador((b) => ({ ...b, tipos: { ...b.tipos, [t]: { ...b.tipos[t], ...cambio } } }));
  const setResp = (lista) => setBorrador((b) => ({ ...b, respaldo: lista }));
  const setTope = (m, cambio) => setBorrador((b) => ({ ...b, topes: { ...b.topes, [m]: { ...b.topes[m], ...cambio } } }));
  const modeloClaude = (t) => datos.modelosClaude.find((x) => x.tipo_corrida === TIPO_MODELO_CLAUDE[t])?.modelo;
  const faltaDe = (motor, modelo) => {
    const m = porId[motor];
    if (!m) return 'motor desconocido';
    if (motor === 'opencode') {
      if (!modelo) return 'elegí un modelo (proveedor/modelo)';
      const prov = modelo.split('/')[0];
      if (prov === 'opencode' && /-free$/.test(modelo)) return null;
      const k = datos.claves.find((c) => c.motor === 'opencode' && c.proveedor === prov);
      return k && !k.cargada ? `falta ${k.nombre}` : null;
    }
    return m.falta;
  };

  const guardar = correr('guardar', async () => {
    const body = {};
    for (const [t, a] of Object.entries(borrador.tipos)) body[t] = { motor: a.motor, ...(a.modelo ? { modelo: a.modelo.trim() } : {}) };
    body.respaldo = borrador.respaldo.filter((r) => r.motor).map((r) => ({ motor: r.motor, ...(r.modelo ? { modelo: r.modelo.trim() } : {}) }));
    body.topes = Object.fromEntries(Object.entries(borrador.topes).map(([m, x]) => [m, x.dia === '' && x.mes === '' ? null : { dia: x.dia === '' ? null : Number(x.dia), mes: x.mes === '' ? null : Number(x.mes) }]));
    await put('/api/motores', body);
    setConfirmando(false); setOk('Listo: quedó guardado. Las charlas que cambian de motor arrancan una conversación nueva, con la memoria de siempre.');
    setBorrador(null); cargar();
  });

  const datalist = (motor) => (porId[motor]?.modelos?.length ? `modelos-${motor}` : undefined);

  return (
    <div className="grid gap-5">
      {Object.values(porId).map((m) => (
        <datalist key={m.id} id={`modelos-${m.id}`}>{m.modelos.filter((x) => !x.includes('<')).map((x) => <option key={x} value={x} />)}</datalist>
      ))}

      <Tarjeta titulo="Quién atiende cada conversación">
        <p className="mb-4 text-sm text-stone-600 dark:text-stone-400">
          Cada tipo de conversación puede usar otro motor. Por ejemplo, Claude con tu suscripción para vos y los trabajos, y DeepSeek
          (mucho más barato) para atender clientes. Los roles valen igual en todos: lo que un rol no tiene, no lo tiene en ningún motor.
        </p>
        <Tabla
          filas={datos.tipos}
          columnas={[
            { clave: 'tipo', titulo: 'Conversación', principal: true, ancho: 'w-[28%]', render: (t) => (<div><div className="font-medium">{NOMBRE_TIPO[t.id]}</div><div className="text-xs text-stone-500 dark:text-stone-400">{t.desc}</div></div>) },
            { clave: 'motor', titulo: 'Motor', ancho: 'w-[30%]', render: (t) => <Selector aria-label={`Motor de ${NOMBRE_TIPO[t.id]}`} value={borrador.tipos[t.id].motor} onChange={(e) => setTipo(t.id, { motor: e.target.value, modelo: '' })} opciones={opcionesMotor} /> },
            { clave: 'modelo', titulo: 'Modelo', render: (t) => {
              const a = borrador.tipos[t.id];
              const ph = a.motor.startsWith('claude') ? `por defecto (${modeloClaude(t.id) ?? 'sonnet'})` : a.motor === 'opencode' ? 'proveedor/modelo' : 'el de siempre';
              return <CampoChico aria-label={`Modelo de ${NOMBRE_TIPO[t.id]}`} list={datalist(a.motor)} placeholder={ph} value={a.modelo} onChange={(e) => setTipo(t.id, { modelo: e.target.value })} />;
            } },
            { clave: 'estado', titulo: 'Estado', render: (t) => { const a = borrador.tipos[t.id]; const f = faltaDe(a.motor, a.modelo); return f ? <Falta texto={f} /> : <Estado tono="ok">Listo</Estado>; } },
          ]}
        />
      </Tarjeta>

      <Tarjeta titulo="Motores">
        <Tabla
          filas={motores}
          columnas={[
            { clave: 'motor', titulo: 'Motor', principal: true, render: (m) => (<div><div className="font-medium">{m.nombre}</div><div className="text-xs text-stone-500 dark:text-stone-400">{m.variante}</div></div>) },
            { clave: 'pago', titulo: 'Cómo se paga', render: (m) => <Chip tono={PAGO[m.pago]?.tono}>{PAGO[m.pago]?.texto ?? m.pago}</Chip> },
            { clave: 'estado', titulo: 'Credencial', render: (m) => (m.id === 'codex' ? <LoginCodex codex={datos.codex} recargar={cargar} />
              : m.bloqueado ? <Estado tono="error">{m.bloqueado === 'limite' ? 'En su límite' : 'No funciona'}</Estado>
                : m.id === 'opencode' ? <span className="text-xs text-stone-500 dark:text-stone-400">La del proveedor de cada modelo</span>
                  : m.falta ? <Falta texto={m.falta} /> : <Estado tono="ok">Conectado</Estado>) },
            { clave: 'gasto', titulo: 'Gastado', alinear: 'derecha', render: (m) => (m.porUso && !m.conPrecio ? <span className="text-xs text-stone-500" title="Este motor no informa el precio de cada corrida: miralo en la cuenta del proveedor.">no informa</span> : m.porUso ? (
              <div className={cx('whitespace-nowrap leading-tight', m.sobreTope && 'font-semibold text-red-700 dark:text-red-400')} title={m.sobreTope ?? undefined}>
                <div>{usd(m.gasto.dia)} <span className="text-xs font-normal text-stone-500">hoy</span></div>
                <div>{usd(m.gasto.mes)} <span className="text-xs font-normal text-stone-500">mes</span></div>
              </div>
            ) : <span className="text-stone-400">incluido</span>) },
            { clave: 'tope', titulo: 'Tope US$ (día · mes)', render: (m) => (m.conPrecio ? (
              <div className="flex max-w-48 gap-1.5">
                <CampoChico type="number" min="0" step="0.5" inputMode="decimal" aria-label={`Tope diario de ${m.nombre}`} placeholder="sin" value={borrador.topes[m.id]?.dia ?? ''} onChange={(e) => setTope(m.id, { dia: e.target.value })} />
                <CampoChico type="number" min="0" step="1" inputMode="decimal" aria-label={`Tope mensual de ${m.nombre}`} placeholder="sin" value={borrador.topes[m.id]?.mes ?? ''} onChange={(e) => setTope(m.id, { mes: e.target.value })} />
              </div>
            ) : <span className="text-stone-400">—</span>) },
          ]}
        />
        <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
          El gasto es lo que informa cada motor: Claude con clave y OpenCode dan el precio exacto; Codex con clave y Gemini no informan precio
          (por eso su tope no se puede controlar). Con un tope alcanzado, esas charlas esperan y te llega un aviso.
        </p>
      </Tarjeta>

      <Tarjeta titulo="Respaldo automático">
        <Subtitulo ayuda="Si el motor de turno se queda sin plan, sin crédito o sin credencial, la charla sigue con el primero de esta lista que funcione, y te aviso. Cuando el motor de siempre se recupera, se vuelve solo.">En orden</Subtitulo>
        <Tabla
          vacio="Apagado: si el motor de turno se queda sin plan o sin crédito, esas charlas esperan en cola."
          filas={borrador.respaldo.map((r, i) => ({ ...r, i }))}
          claveFila={(r) => r.i}
          columnas={[
            { clave: 'orden', titulo: '#', principal: true, ancho: 'w-12', render: (r) => <span className="font-semibold tabular-nums text-stone-500">{r.i + 1}</span> },
            { clave: 'motor', titulo: 'Motor', render: (r) => <Selector aria-label={`Motor de respaldo ${r.i + 1}`} value={r.motor} onChange={(e) => setResp(borrador.respaldo.map((x, j) => (j === r.i ? { motor: e.target.value, modelo: '' } : x)))} opciones={opcionesMotor} /> },
            { clave: 'modelo', titulo: 'Modelo', render: (r) => <CampoChico aria-label={`Modelo de respaldo ${r.i + 1}`} list={datalist(r.motor)} placeholder={r.motor === 'opencode' ? 'proveedor/modelo' : 'el de siempre'} value={r.modelo} onChange={(e) => setResp(borrador.respaldo.map((x, j) => (j === r.i ? { ...x, modelo: e.target.value } : x)))} /> },
            { clave: 'estado', titulo: 'Estado', render: (r) => { const f = faltaDe(r.motor, r.modelo); return f ? <Falta texto={f} /> : <Estado tono="ok">Listo</Estado>; } },
            { clave: 'acciones', titulo: '', alinear: 'derecha', render: (r) => (
              <div className="flex justify-end gap-1">
                <Boton variante="fantasma" className="min-h-8 px-2 py-1" disabled={r.i === 0} aria-label="Subir" onClick={() => { const l = [...borrador.respaldo]; [l[r.i - 1], l[r.i]] = [l[r.i], l[r.i - 1]]; setResp(l); }}>↑</Boton>
                <Boton variante="fantasma" className="min-h-8 px-2 py-1" disabled={r.i === borrador.respaldo.length - 1} aria-label="Bajar" onClick={() => { const l = [...borrador.respaldo]; [l[r.i + 1], l[r.i]] = [l[r.i], l[r.i + 1]]; setResp(l); }}>↓</Boton>
                <Boton variante="fantasma" className="min-h-8 px-2 py-1" onClick={() => setResp(borrador.respaldo.filter((_, j) => j !== r.i))}>Quitar</Boton>
              </div>
            ) },
          ]}
        />
        {borrador.respaldo.length < 4 && (
          <Boton variante="secundario" className="mt-3" onClick={() => setResp([...borrador.respaldo, { motor: motores.find((m) => !m.falta && m.id !== 'claude')?.id ?? 'claude-api', modelo: '' }])}>Sumar un respaldo</Boton>
        )}
      </Tarjeta>

      <Tarjeta titulo="Claves de los motores">
        <p className="mb-4 text-sm text-stone-600 dark:text-stone-400">
          Se cargan acá (o el agente te manda el link): quedan cifradas, no se vuelven a mostrar y cada una llega solo a las corridas del motor que la usa.
        </p>
        <Tabla
          filas={datos.claves}
          claveFila={(k) => k.nombre}
          columnas={[
            { clave: 'nombre', titulo: 'Clave', principal: true, render: (k) => <code className="font-mono text-sm">{k.nombre}</code> },
            { clave: 'para', titulo: 'Para', render: (k) => <span>{porId[k.motor]?.nombre ?? k.motor}<span className="text-stone-500 dark:text-stone-400"> · {k.proveedor}</span></span> },
            { clave: 'estado', titulo: 'Estado', render: (k) => (k.cargada ? <Estado tono="ok">Cargada</Estado> : <Estado>Sin cargar</Estado>) },
            { clave: 'accion', titulo: '', alinear: 'derecha', render: (k) => <div className="flex justify-end"><CargarClave nombre={k.nombre} alGuardar={cargar} /></div> },
          ]}
        />
      </Tarjeta>

      {(cambios.length > 0 || ok || error) && (
        <div className="sticky bottom-3 z-10">
          <div className="rounded-2xl border border-stone-200 bg-white/95 p-4 shadow-lg backdrop-blur dark:border-stone-700 dark:bg-stone-900/95">
            {ok && !cambios.length && <Aviso tipo="ok">{ok}</Aviso>}
            {cambios.length > 0 && (
              <div className="flex flex-col gap-3">
                <div>
                  <p className="text-sm font-semibold">{confirmando ? '¿Confirmás estos cambios?' : `${cambios.length} cambio${cambios.length > 1 ? 's' : ''} sin guardar`}</p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-stone-700 dark:text-stone-300">{cambios.map((c) => <li key={c}>{c}</li>)}</ul>
                </div>
                <div className="flex flex-wrap gap-2">
                  {confirmando
                    ? <><Boton cargando={cargando === 'guardar'} onClick={guardar}>Sí, guardar</Boton><Boton variante="secundario" onClick={() => setConfirmando(false)}>Revisar</Boton></>
                    : <><Boton onClick={() => { setOk(null); setError(null); setConfirmando(true); }}>Guardar cambios</Boton><Boton variante="fantasma" onClick={() => { setBorrador(structuredClone(original)); setConfirmando(false); }}>Descartar</Boton></>}
                </div>
              </div>
            )}
            {error && <div className="mt-2"><Aviso>{error}</Aviso></div>}
          </div>
        </div>
      )}

      <p className="text-center text-xs text-stone-500 dark:text-stone-400">
        También se cambia hablando con el agente: “usá DeepSeek para los clientes”, “si se acaba Claude seguí con Gemini”, “ponele un tope de 5 dólares por día a OpenCode”.
      </p>
    </div>
  );
}

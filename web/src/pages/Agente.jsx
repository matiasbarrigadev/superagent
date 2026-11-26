// Ajustes del agente: general, modelos por tipo de corrida, equipo, chats y grupos, trabajos, rutinas,
// entradas por webhook y reglas de contacto. Todo se puede pausar.
import { useEffect, useState } from 'react';
import { borrar, patch, post } from '../api.js';
import { useAccion, useDatos } from '../hooks.js';
import { AreaTexto, Aviso, Boton, Campo, Estado, Interruptor, Selector, Tarjeta, Vacio, fechaCorta } from '../components/ui.jsx';

const TIPOS = {
  orquestador: 'Orquestador (Propietario y Colaboradores)', tercero: 'Con un Tercero', busqueda: 'Subagentes de búsqueda',
  trabajo: 'Trabajos en segundo plano', rutina: 'Rutinas', respaldo: 'Respaldo si el modelo está saturado',
};
const ESFUERZOS = [{ valor: '', texto: 'Por defecto' }, ...['low', 'medium', 'high', 'xhigh', 'max'].map((e) => ({ valor: e, texto: { low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' }[e] }))];
const ESTADO_TRABAJO = { en_cola: ['En cola', 'neutro'], corriendo: ['Corriendo', 'espera'], terminado: ['Terminado', 'ok'], fallido: ['Falló', 'error'] };

function General({ datos, recargar }) {
  const [f, setF] = useState(null);
  const { cargando, error, correr } = useAccion();
  const [ok, setOk] = useState(false);
  useEffect(() => { if (datos) setF(datos.ajustes); }, [datos]);
  if (!f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Tarjeta titulo="General">
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={correr('guardar', async () => { await patch('/api/ajustes', f); setOk(true); setTimeout(() => setOk(false), 2000); recargar(); })}>
        <Campo etiqueta="Nombre del agente" value={f.nombre_agente ?? ''} onChange={set('nombre_agente')} ayuda="En grupos, responde también cuando lo llaman por este nombre." />
        <Campo etiqueta="Zona horaria" value={f.zona_horaria ?? ''} onChange={set('zona_horaria')} ayuda="Por ejemplo America/Argentina/Buenos_Aires." />
        <Campo etiqueta="Espera de silencio (segundos)" type="number" min="0" value={f.espera_silencio_s ?? ''} onChange={set('espera_silencio_s')} ayuda="Junta los mensajes seguidos en una sola respuesta." />
        <Campo etiqueta="Espera máxima (segundos)" type="number" min="5" value={f.espera_maxima_s ?? ''} onChange={set('espera_maxima_s')} />
        <Campo etiqueta="Trabajos a la vez" type="number" min="1" max="10" value={f.max_trabajos ?? ''} onChange={set('max_trabajos')} ayuda="Para no agotar el plan de Claude. No es un tope de uso." />
        <Campo etiqueta="Conversaciones a la vez" type="number" min="1" max="20" value={f.max_corridas ?? ''} onChange={set('max_corridas')} ayuda="Cuida la memoria del servidor." />
        <div className="flex items-center justify-between gap-3 sm:col-span-2">
          <div>
            <p className="text-sm font-medium">Ritmo suave para contactos nuevos</p>
            <p className="text-xs text-stone-500 dark:text-stone-400">Solo cuando el agente le escribe primero a un número que nunca escribió. Protege el número de bloqueos.</p>
          </div>
          <Interruptor etiqueta="Ritmo suave" prendido={f.ritmo_suave === '1'} alCambiar={(v) => setF({ ...f, ritmo_suave: v ? '1' : '0' })} />
        </div>
        {f.ritmo_suave === '1' && (
          <>
            <Campo etiqueta="Contactos nuevos por hora" type="number" min="1" value={f.ritmo_por_hora ?? ''} onChange={set('ritmo_por_hora')} />
            <Campo etiqueta="Minutos entre uno y otro" type="number" min="0" value={f.ritmo_espaciado_min ?? ''} onChange={set('ritmo_espaciado_min')} />
          </>
        )}
        {[['navegador', 'Navegador', 'Para quien tenga permiso de usar la web.'], ['describir_imagenes', 'Describir imágenes de externos', 'Usa Claude para describir las fotos que mandan los Terceros.'], ['enviar_audio', 'Notas de voz', 'El agente puede mandar audios como nota de voz.']].map(([k, t, a]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <div><p className="text-sm font-medium">{t}</p><p className="text-xs text-stone-500 dark:text-stone-400">{a}</p></div>
            <Interruptor etiqueta={t} prendido={f[k] === '1'} alCambiar={(v) => setF({ ...f, [k]: v ? '1' : '0' })} />
          </div>
        ))}
        <AreaTexto etiqueta="Instrucciones extra" rows={3} className="sm:col-span-2" value={f.instrucciones_extra ?? ''} onChange={set('instrucciones_extra')}
          ayuda="Se suman a las instrucciones base del agente (no a las de Terceros)." />
        <div className="flex items-center gap-3 sm:col-span-2">
          <Boton cargando={cargando === 'guardar'}>Guardar</Boton>
          {ok && <span className="text-sm text-emerald-700 dark:text-emerald-400">Guardado</span>}
          {f.onboarding_hecho === '1' && (
            <Boton type="button" variante="fantasma" onClick={correr('onb', async () => { await patch('/api/ajustes', { onboarding_hecho: '0' }); recargar(); })}>Repetir la configuración inicial</Boton>
          )}
        </div>
      </form>
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

function Modelos({ datos, recargar }) {
  const { error, correr } = useAccion();
  return (
    <Tarjeta titulo="Modelos por tipo de corrida">
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">Alias como opus, sonnet o haiku toman siempre el modelo más nuevo. Qué modelos podés usar depende de tu plan de Claude.</p>
      <ul className="flex flex-col gap-3">
        {datos.modelos.map((m) => (
          <li key={m.tipo_corrida} className="grid gap-2 sm:grid-cols-[1fr_9rem_9rem] sm:items-end">
            <p className="text-sm font-medium">{TIPOS[m.tipo_corrida] ?? m.tipo_corrida}</p>
            <Campo etiqueta="Modelo" defaultValue={m.modelo}
              onBlur={(e) => e.target.value !== m.modelo && correr('m', async () => { await patch(`/api/modelos/${m.tipo_corrida}`, { modelo: e.target.value, esfuerzo: m.esfuerzo }); recargar(); })()} />
            {m.tipo_corrida !== 'respaldo' ? (
              <Selector etiqueta="Esfuerzo" value={m.esfuerzo ?? ''} opciones={ESFUERZOS}
                onChange={(e) => correr('e', async () => { await patch(`/api/modelos/${m.tipo_corrida}`, { modelo: m.modelo, esfuerzo: e.target.value || null }); recargar(); })()} />
            ) : <span />}
          </li>
        ))}
      </ul>
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

function Equipo({ datos, recargar }) {
  const { correr } = useAccion();
  return (
    <Tarjeta titulo="Equipo de subagentes">
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">El agente los usa para tareas cortas. Nunca tienen más herramientas que la conversación que los llama.</p>
      <ul className="flex flex-col divide-y divide-stone-200 dark:divide-stone-800">
        {datos.equipo.map((e) => (
          <li key={e.nombre} className="flex items-center justify-between gap-3 py-2">
            <div className="text-sm"><span className="font-medium">{e.nombre}</span> <span className="text-stone-500">· {e.modelo}</span>
              <p className="text-stone-600 dark:text-stone-400">{e.para_que}</p></div>
            <Interruptor etiqueta={`Activar ${e.nombre}`} prendido={e.activo} alCambiar={(v) => correr('x', async () => { await patch(`/api/equipo/${e.nombre}`, { activo: v }); recargar(); })()} />
          </li>
        ))}
      </ul>
    </Tarjeta>
  );
}

function Chats() {
  const { datos, cargar } = useDatos('/api/chats', { cada: 20000 });
  const { correr } = useAccion();
  const grupos = datos?.chats?.filter((c) => c.tipo === 'grupo') ?? [];
  return (
    <Tarjeta titulo="Grupos">
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">Los grupos empiezan apagados. En un grupo activo, el agente responde solo si lo mencionan, le responden o lo llaman por su nombre.</p>
      {grupos.length ? (
        <ul className="flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
          {grupos.map((g) => (
            <li key={g.id} className="flex items-center justify-between gap-3 py-2">
              <span>{g.nombre || g.id}<span className="ml-2 text-xs text-stone-500">{fechaCorta(g.ultimo)}</span></span>
              <Interruptor etiqueta={`Activar ${g.nombre || g.id}`} prendido={g.activo} alCambiar={(v) => correr('g', async () => { await patch(`/api/chats/${encodeURIComponent(g.id)}`, { activo: v }); cargar(); })()} />
            </li>
          ))}
        </ul>
      ) : <Vacio>Todavía no llegó ningún mensaje de un grupo.</Vacio>}
    </Tarjeta>
  );
}

function Trabajos() {
  const { datos } = useDatos('/api/trabajos', { cada: 10000 });
  return (
    <Tarjeta titulo="Trabajos en segundo plano">
      {datos?.trabajos?.length ? (
        <ul className="flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
          {datos.trabajos.map((t) => {
            const [txt, tono] = ESTADO_TRABAJO[t.estado] ?? [t.estado, 'neutro'];
            return (
              <li key={t.id} className="py-2">
                <div className="flex items-center justify-between gap-2"><span className="font-medium">{t.id}</span><Estado tono={tono}>{txt}</Estado></div>
                <p className="mt-1 text-stone-600 dark:text-stone-400">{t.descripcion.slice(0, 200)}</p>
                <p className="text-xs text-stone-500">Pedido por {t.pedido_por ?? 'alguien'} · {fechaCorta(t.creado)}</p>
                {t.resultado && <details className="mt-1"><summary className="cursor-pointer text-xs text-stone-500">Resultado</summary><p className="mt-1 whitespace-pre-wrap">{t.resultado}</p></details>}
              </li>
            );
          })}
        </ul>
      ) : <Vacio>No hay trabajos.</Vacio>}
    </Tarjeta>
  );
}

function Rutinas() {
  const { datos, cargar } = useDatos('/api/rutinas');
  const { error, correr } = useAccion();
  return (
    <Tarjeta titulo="Rutinas">
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">Se crean pidiéndoselas al agente ("todos los lunes a las 9, mandame el resumen").</p>
      {datos?.rutinas?.length ? (
        <ul className="flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
          {datos.rutinas.map((r) => (
            <li key={r.id} className="py-2">
              <div className="flex items-center justify-between gap-2">
                <span><span className="font-medium">R-{r.id}</span> <code className="ml-1 text-xs">{r.cuando}</code> <span className="text-xs text-stone-500">{r.zona_horaria}</span></span>
                <div className="flex items-center gap-2">
                  {!r.aprobada && <Estado tono="espera">Sin aprobar</Estado>}
                  <Interruptor etiqueta={`Activar R-${r.id}`} disabled={!r.aprobada} prendido={r.activa} alCambiar={(v) => correr('a', async () => { await patch(`/api/rutinas/${r.id}`, { activa: v }); cargar(); })()} />
                  <Boton variante="fantasma" onClick={correr('b', async () => { await borrar(`/api/rutinas/${r.id}`); cargar(); })}>Borrar</Boton>
                </div>
              </div>
              <p className="mt-1">{r.instruccion}</p>
              <p className="text-xs text-stone-500">De {r.creador ?? 'alguien'} · próxima {fechaCorta(r.proxima)} · destinos: {r.destinos.join(', ')}</p>
              {r.pausa_motivo && !r.activa && <p className="text-xs text-amber-700 dark:text-amber-400">{r.pausa_motivo}</p>}
            </li>
          ))}
        </ul>
      ) : <Vacio>No hay rutinas.</Vacio>}
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

function Entradas() {
  const { datos, cargar } = useDatos('/api/entradas');
  const [f, setF] = useState({ nombre: '', instruccion: '' });
  const [nueva, setNueva] = useState(null);
  const { cargando, error, correr } = useAccion();
  return (
    <Tarjeta titulo="Entradas por webhook">
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">Para formularios u otros sistemas. Cada pedido despierta al agente con el contenido como dato externo, nunca como orden.</p>
      <form className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
        onSubmit={correr('crear', async () => { setNueva(await post('/api/entradas', f)); setF({ nombre: '', instruccion: '' }); cargar(); })}>
        <Campo etiqueta="Nombre" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} required />
        <Campo etiqueta="Qué tiene que hacer el agente" value={f.instruccion} onChange={(e) => setF({ ...f, instruccion: e.target.value })} />
        <Boton cargando={cargando === 'crear'}>Crear</Boton>
      </form>
      {nueva && (
        <div className="mt-3"><Aviso tipo="ok">
          <p>Guardá el secreto ahora: no se vuelve a mostrar.</p>
          <p className="mt-1 break-all">URL: <code>{nueva.url}</code></p>
          <p className="break-all">Header <code>X-Superagent-Secreto</code>: <code>{nueva.secreto}</code></p>
        </Aviso></div>
      )}
      <ul className="mt-3 flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
        {datos?.entradas?.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span><span className="font-medium">{e.nombre}</span> <code className="ml-1 text-xs text-stone-500">/entrada/{e.id}</code>
              <span className="block text-xs text-stone-500">Último uso: {fechaCorta(e.ultima)}</span></span>
            <div className="flex items-center gap-2">
              <Interruptor etiqueta={`Activar ${e.nombre}`} prendido={e.activa} alCambiar={(v) => correr('a', async () => { await patch(`/api/entradas/${e.id}`, { activa: v }); cargar(); })()} />
              <Boton variante="fantasma" onClick={correr('b', async () => { await borrar(`/api/entradas/${e.id}`); cargar(); })}>Borrar</Boton>
            </div>
          </li>
        ))}
      </ul>
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

function Reglas() {
  const { datos, cargar } = useDatos('/api/reglas');
  const [f, setF] = useState({ origen: '', a_quien: '*', mensaje_base: '' });
  const { cargando, error, correr } = useAccion();
  return (
    <Tarjeta titulo="Reglas de contacto">
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">
        Para que el agente le escriba primero a números nuevos sin pedirte permiso cada vez. Origen: <code>entrada:&lt;id&gt;</code>, <code>rutina:&lt;n&gt;</code> o <code>*</code>.
      </p>
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={correr('crear', async () => { await post('/api/reglas', f); setF({ origen: '', a_quien: '*', mensaje_base: '' }); cargar(); })}>
        <Campo etiqueta="Origen" placeholder="entrada:abc123" value={f.origen} onChange={(e) => setF({ ...f, origen: e.target.value })} required />
        <Campo etiqueta="A quién" ayuda='"*" = cualquiera; o números separados por coma.' value={f.a_quien} onChange={(e) => setF({ ...f, a_quien: e.target.value })} />
        <AreaTexto etiqueta="Mensaje base" rows={2} className="sm:col-span-2" value={f.mensaje_base} onChange={(e) => setF({ ...f, mensaje_base: e.target.value })} />
        <div><Boton cargando={cargando === 'crear'}>Aprobar regla</Boton></div>
      </form>
      <ul className="mt-3 flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
        {datos?.reglas?.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span><code>{r.origen}</code> → {r.a_quien}{r.mensaje_base && <span className="block text-xs text-stone-500">{r.mensaje_base}</span>}</span>
            <div className="flex items-center gap-2">
              <Interruptor etiqueta="Activar regla" prendido={r.activa} alCambiar={(v) => correr('a', async () => { await patch(`/api/reglas/${r.id}`, { activa: v }); cargar(); })()} />
              <Boton variante="fantasma" onClick={correr('b', async () => { await borrar(`/api/reglas/${r.id}`); cargar(); })}>Borrar</Boton>
            </div>
          </li>
        ))}
      </ul>
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

export default function Agente() {
  const { datos, error, cargar } = useDatos('/api/ajustes');
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {error && <Aviso>{error}</Aviso>}
      {datos && (
        <>
          <div className="lg:col-span-2"><General datos={datos} recargar={cargar} /></div>
          <Modelos datos={datos} recargar={cargar} />
          <div className="grid content-start gap-5"><Equipo datos={datos} recargar={cargar} /><Chats /></div>
          <Trabajos />
          <Sesiones />
          <Rutinas />
          <Entradas />
          <Reglas />
          <Lecciones />
          <Instrucciones />
        </>
      )}
    </div>
  );
}

export function Lecciones() {
  const { datos, cargar } = useDatos('/api/lecciones');
  const [regla, setRegla] = useState('');
  const { cargando, error, correr } = useAccion();
  return (
    <Tarjeta titulo="Lecciones">
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">Correcciones que el agente respeta siempre. Las guarda él cuando lo corregís; las de un Colaborador esperan tu aprobación.</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={correr('n', async () => { await post('/api/lecciones', { regla }); setRegla(''); cargar(); })}>
        <Campo etiqueta="Lección nueva" value={regla} onChange={(e) => setRegla(e.target.value)} className="min-w-64 flex-1" />
        <Boton cargando={cargando === 'n'} disabled={regla.trim().length < 3}>Agregar</Boton>
      </form>
      <ul className="mt-3 flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
        {datos?.lecciones?.map((l) => (
          <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className={l.estado === 'desactivada' ? 'text-stone-400 line-through' : ''}>{l.regla}
              {l.como_aplicar && <span className="block text-xs text-stone-500">{l.como_aplicar}</span>}
              <span className="block text-xs text-stone-500">{l.autor_nombre ?? 'el agente'}{l.publica ? ' · también con externos' : ''}{l.estado === 'propuesta' ? ' · esperando aprobación' : ''}</span></span>
            <div className="flex items-center gap-2">
              {l.estado !== 'propuesta' && <Interruptor etiqueta="Activar lección" prendido={l.estado === 'activa'} alCambiar={(v) => correr('a', async () => { await patch(`/api/lecciones/${l.id}`, { estado: v ? 'activa' : 'desactivada' }); cargar(); })()} />}
              <Boton variante="fantasma" onClick={correr('b', async () => { await borrar(`/api/lecciones/${l.id}`); cargar(); })}>Borrar</Boton>
            </div>
          </li>
        ))}
      </ul>
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

export function Instrucciones() {
  const { datos, cargar } = useDatos('/api/instrucciones');
  const { error, correr } = useAccion();
  const versiones = datos?.versiones ?? [];
  return (
    <Tarjeta titulo="Versiones de las instrucciones">
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">Las cambia el agente cuando se lo piden (si lo pide un Colaborador, con tu aprobación). Podés volver a cualquier versión.</p>
      {versiones.length ? (
        <ul className="flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
          {versiones.map((v) => (
            <li key={v.version} className="py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">v{v.version} {v.activa && <Estado tono="ok">activa</Estado>} <span className="text-xs text-stone-500">{v.pedida_por ?? ''}</span></span>
                {!v.activa && <Boton variante="fantasma" onClick={correr('v', async () => { await post(`/api/instrucciones/${v.version}/activar`); cargar(); })}>Volver a esta</Boton>}
              </div>
              <details><summary className="cursor-pointer text-xs text-stone-500">Ver</summary><pre className="mt-1 whitespace-pre-wrap text-xs">{v.contenido}</pre></details>
            </li>
          ))}
        </ul>
      ) : <Vacio>Todavía se usan solo las instrucciones base.</Vacio>}
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

export function Sesiones() {
  const { datos, cargar } = useDatos('/api/sesiones', { cada: 15000 });
  const { error, correr } = useAccion();
  const estado = (id, e) => correr('e', async () => { await patch(`/api/sesiones/${id}`, { estado: e }); cargar(); });
  return (
    <Tarjeta titulo="Sesiones de proyecto">
      <p className="mb-3 text-sm text-stone-600 dark:text-stone-400">Conversaciones largas por proyecto, con su propia memoria. El agente les pasa pedidos y ellas le contestan a él. Se abren pidiéndoselo al agente.</p>
      {datos?.sesiones?.length ? (
        <ul className="flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
          {datos.sesiones.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span><span className="font-medium">S-{s.id} {s.nombre}</span> <span className="text-xs text-stone-500">· {s.proyecto}{s.pendientes ? ` · ${s.pendientes} en el buzón` : ''}</span></span>
              <div className="flex items-center gap-2">
                <Estado tono={s.estado === 'activa' ? 'ok' : s.estado === 'pausada' ? 'espera' : 'neutro'}>{s.estado}</Estado>
                {s.estado === 'activa' && <Boton variante="fantasma" onClick={estado(s.id, 'pausada')}>Pausar</Boton>}
                {s.estado === 'pausada' && <Boton variante="fantasma" onClick={estado(s.id, 'activa')}>Reanudar</Boton>}
                {s.estado !== 'archivada' && <Boton variante="fantasma" onClick={estado(s.id, 'archivada')}>Archivar</Boton>}
              </div>
            </li>
          ))}
        </ul>
      ) : <Vacio>No hay sesiones de proyecto.</Vacio>}
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

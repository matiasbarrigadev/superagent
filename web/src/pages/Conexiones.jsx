// Conexiones: conectores MCP remotos (OAuth o clave), proyectos con repo y GitHub.
import { useEffect, useRef, useState } from 'react';
import { api, borrar, patch, post } from '../api.js';
import { useAccion, useDatos } from '../hooks.js';
import { AreaTexto, Aviso, Boton, Campo, Estado, fechaCorta, Interruptor, Selector, Tabla, Tarjeta, Vacio } from '../components/ui.jsx';

const ESTADOS = { activa: ['Conectado', 'ok'], pendiente: ['Falta autorizar', 'espera'], error: ['Con problemas', 'error'], desconectada: ['Desconectado', 'neutro'] };

function Conector({ c, roles, recargar }) {
  const { cargando, error, correr } = useAccion();
  const [abierto, setAbierto] = useState(false);
  const [link, setLink] = useState(null);
  const [txt, tono] = ESTADOS[c.estado] ?? [c.estado, 'neutro'];
  const hab = c.habilitada_para ?? {};
  const apagadas = new Set(hab.apagadas ?? []);
  return (
    <li className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{c.app} {c.alcance === 'persona' && <span className="text-xs text-stone-500">(cuenta personal)</span>}</p>
          <p className="break-all text-xs text-stone-500">{c.url_mcp}</p>
        </div>
        <Estado tono={tono}>{txt}</Estado>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {c.estado !== 'activa' && hab.auth !== 'clave' && (
          <Boton cargando={cargando === 'aut'} onClick={correr('aut', async () => { setLink((await post(`/api/conectores/${c.id}/autorizar`)).link); recargar(); })}>Autorizar</Boton>
        )}
        <Boton variante="secundario" cargando={cargando === 'act'} onClick={correr('act', async () => { await post(`/api/conectores/${c.id}/actualizar`); recargar(); })}>Actualizar herramientas</Boton>
        <Boton variante="fantasma" onClick={() => setAbierto(!abierto)}>{abierto ? 'Cerrar' : `Permisos (${c.herramientas.length} herramientas)`}</Boton>
        <Boton variante="fantasma" onClick={correr('b', async () => { await borrar(`/api/conectores/${c.id}`); recargar(); })}>Quitar</Boton>
      </div>
      {link && <div className="mt-3"><Aviso tipo="info">Abrí este link y autorizá: <a className="break-all underline" href={link} target="_blank" rel="noreferrer">{link}</a></Aviso></div>}
      {abierto && (
        <div className="mt-3 grid gap-3">
          {c.alcance !== 'persona' && (
            <div>
              <p className="mb-1 text-sm font-medium">Roles que lo pueden usar</p>
              <div className="flex flex-wrap gap-3">
                {roles.map((r) => (
                  <label key={r} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={(hab.roles ?? []).includes(r)}
                      onChange={correr('r', async (e) => { const s = new Set(hab.roles ?? []); e.target.checked ? s.add(r) : s.delete(r); await patch(`/api/conectores/${c.id}`, { roles: [...s] }); recargar(); })} />
                    {r}
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-stone-500">Además, cada rol necesita "Herramientas del negocio": "solo leer" ve las que no escriben. Lo que escribe, pedido por un Colaborador, pasa por tu aprobación.</p>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Interruptor etiqueta="Solo lectura" prendido={c.solo_lectura} disabled={c.solo_lectura && !hab.solo_lectura}
              alCambiar={(v) => correr('sl', async () => { await patch(`/api/conectores/${c.id}`, { solo_lectura: v }); recargar(); })()} />
            <span>Solo lectura
              <span className="block text-xs text-stone-500">
                {c.solo_lectura && !hab.solo_lectura
                  ? 'Su dirección le pide al servicio que no deje escribir (read_only): ninguna herramienta cuenta como escritura.'
                  : 'Ninguna herramienta cuenta como escritura: no piden aprobación y las ve un rol que solo lee. Prendelo solo si el servicio de verdad no deja escribir con esta conexión (conectado en modo lectura o con un usuario que solo lee).'}
              </span>
            </span>
          </label>
          <ul className="flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
            {c.herramientas.map((h) => (
              <li key={h.nombre} className="flex items-center justify-between gap-3 py-1.5">
                <span><code>{h.nombre}</code> {h.escribe && !c.solo_lectura && <Estado tono="espera">escribe</Estado>}<span className="block text-xs text-stone-500">{h.descripcion?.slice(0, 140)}</span></span>
                <Interruptor etiqueta={`Habilitar ${h.nombre}`} prendido={!apagadas.has(h.nombre)}
                  alCambiar={(v) => correr('h', async () => { const s = new Set(apagadas); v ? s.delete(h.nombre) : s.add(h.nombre); await patch(`/api/conectores/${c.id}`, { apagadas: [...s] }); recargar(); })()} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <div className="mt-2"><Aviso>{error}</Aviso></div>}
    </li>
  );
}

function Conectores() {
  const { datos, cargar } = useDatos('/api/conectores');
  const [f, setF] = useState({ nombre: '', url: '', auth: 'oauth', clave: '' });
  const [link, setLink] = useState(null);
  const { cargando, error, correr } = useAccion();
  return (
    <Tarjeta titulo="Servicios conectados">
      <p className="mb-4 text-sm text-stone-600 dark:text-stone-400">
        Lo más simple: pedíselo al agente por WhatsApp ("conectá Supabase") y te manda el link para autorizar.
      </p>
      {datos?.entorno?.some((e) => e.conectado) && (
        <div className="mb-4">
          <p className="mb-2 text-sm font-medium">En el entorno del agente</p>
          <ul className="flex flex-wrap gap-2">
            {datos.entorno.filter((e) => e.conectado).map((e) => (
              <li key={e.servicio} className="flex items-center gap-2 rounded-full border border-stone-200 px-3 py-1.5 text-sm dark:border-stone-800">
                <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
                {e.servicio}{e.cuenta ? <span className="text-stone-500 dark:text-stone-400">· {e.cuenta}</span> : null}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">Los conectó el agente con el login de cada herramienta. Los usa cuando trabaja con vos.</p>
        </div>
      )}
      {datos?.conectores?.some((c) => c.app !== 'github') && <p className="mb-2 text-sm font-medium">Por MCP</p>}
      <ul className="mb-4 flex flex-col gap-3">
        {datos?.conectores?.filter((c) => c.app !== 'github').map((c) => <Conector key={c.id} c={c} roles={datos.roles} recargar={cargar} />)}
      </ul>
      <details className="rounded-xl border border-dashed border-stone-300 p-4 dark:border-stone-700">
        <summary className="cursor-pointer text-sm font-medium">Agregar un servicio MCP a mano</summary>
        <p className="mt-2 mb-3 text-xs text-stone-500 dark:text-stone-400">El agente usa estos servicios a través del sistema: nunca ve los tokens.</p>
      <form className="grid gap-2 sm:grid-cols-2" onSubmit={correr('crear', async () => { const r = await post('/api/conectores', f); setLink(r.link ?? null); setF({ nombre: '', url: '', auth: 'oauth', clave: '' }); cargar(); })}>
        <Campo etiqueta="Nombre" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} required />
        <Campo etiqueta="URL del servidor MCP" placeholder="https://…" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required />
        <Selector etiqueta="Autorización" value={f.auth} onChange={(e) => setF({ ...f, auth: e.target.value })} opciones={[{ valor: 'oauth', texto: 'OAuth (link para autorizar)' }, { valor: 'clave', texto: 'Clave o token' }]} />
        {f.auth === 'clave' && <Campo etiqueta="Clave" type="password" autoComplete="off" value={f.clave} onChange={(e) => setF({ ...f, clave: e.target.value })} required />}
        <div className="sm:col-span-2"><Boton cargando={cargando === 'crear'}>Agregar</Boton></div>
      </form>
      {datos?.catalogo && (
        <p className="mt-2 text-xs text-stone-500">Sugeridos: {datos.catalogo.map((c, i) => (
          <button key={c.nombre} type="button" className="underline" onClick={() => setF({ ...f, nombre: c.nombre, url: c.url, auth: c.auth })}>{c.nombre}{i < datos.catalogo.length - 1 ? ', ' : ''}</button>
        ))} (verificá la URL con el proveedor).</p>
      )}
      </details>
      {link && <div className="mt-3"><Aviso tipo="info">Abrí este link y autorizá: <a className="break-all underline" href={link} target="_blank" rel="noreferrer">{link}</a></Aviso></div>}
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

function Proyectos() {
  const { datos, cargar } = useDatos('/api/proyectos');
  const [f, setF] = useState({ nombre: '', repo: '', rama_principal: 'main' });
  const [token, setToken] = useState('');
  const [ok, setOk] = useState(null);
  const [abierto, setAbierto] = useState(null);
  const { cargando, error, correr } = useAccion();
  const gh = datos?.github;
  return (
    <Tarjeta titulo="Proyectos y GitHub" accion={gh && <Estado tono={gh.conectado ? 'ok' : 'espera'}>{gh.conectado ? `GitHub conectado${gh.usuario ? ` · ${gh.usuario}` : ''}` : 'GitHub sin conectar'}</Estado>}>
      {gh?.conectado && gh.origen === 'entorno' && <p className="mb-4 text-sm text-stone-600 dark:text-stone-400">Conectado con el login que hizo el agente. Los proyectos de abajo son opcionales: sirven para que otras personas le pidan cambios de código en una rama propia.</p>}
      {gh && !gh.conectado && (
        <div className="mb-4 grid gap-2">
          {gh.dispositivo ? (
            <Boton className="justify-self-start" cargando={cargando === 'disp'} onClick={correr('disp', async () => { await post('/api/github/dispositivo'); setOk('Te mandé por WhatsApp el link de GitHub y el código.'); })}>Conectar GitHub por WhatsApp</Boton>
          ) : <p className="text-sm text-stone-600 dark:text-stone-400">Lo más simple: pedile al agente por WhatsApp "conectá GitHub" y te manda el link y el código. También podés pegar acá un token limitado a los repos que necesites.</p>}
          <form className="flex flex-wrap items-end gap-2" onSubmit={correr('tok', async () => { await post('/api/github/token', { token }); setToken(''); cargar(); })}>
            <Campo etiqueta="Token de GitHub" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="min-w-64 flex-1" />
            <Boton variante="secundario" cargando={cargando === 'tok'} disabled={!token}>Guardar</Boton>
          </form>
        </div>
      )}
      {ok && <div className="mb-3"><Aviso tipo="ok">{ok}</Aviso></div>}
      <form className="grid gap-2 sm:grid-cols-[1fr_1fr_8rem_auto] sm:items-end" onSubmit={correr('p', async () => { await post('/api/proyectos', f); setF({ nombre: '', repo: '', rama_principal: 'main' }); cargar(); })}>
        <Campo etiqueta="Proyecto" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} required />
        <Campo etiqueta="Repo (dueño/nombre)" placeholder="miorg/sitio" value={f.repo} onChange={(e) => setF({ ...f, repo: e.target.value })} />
        <Campo etiqueta="Rama principal" value={f.rama_principal} onChange={(e) => setF({ ...f, rama_principal: e.target.value })} />
        <Boton cargando={cargando === 'p'}>Agregar</Boton>
      </form>
      {datos?.proyectos?.length ? (
        <ul className="mt-3 flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
          {datos.proyectos.map((p) => (
            <li key={p.id} className="py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-medium">{p.nombre}</span> {p.repo && <code className="ml-1 text-xs">{p.repo}</code>} <span className="text-xs text-stone-500">· {p.rama_principal} · {p.cliente}</span></span>
                <div className="flex gap-1">
                  <Boton variante="fantasma" onClick={() => setAbierto(abierto === p.id ? null : p.id)}>{abierto === p.id ? 'Cerrar' : 'Publicación'}</Boton>
                  <Boton variante="fantasma" onClick={correr('b', async () => { await borrar(`/api/proyectos/${p.id}`); cargar(); })}>Quitar</Boton>
                </div>
              </div>
              {abierto === p.id && <Publicacion proyecto={p} />}
            </li>
          ))}
        </ul>
      ) : <div className="mt-3"><Vacio>Sin proyectos. El agente trabaja en código dentro de trabajos con proyecto: clona el repo, trabaja en una rama y abre un PR.</Vacio></div>}
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </Tarjeta>
  );
}

/** Pedido abierto desde el link del agente (#entorno?pedido=…). */
function pedidoDelHash() {
  const m = /[?&]pedido=([\w-]+)/.exec(window.location.hash);
  return m ? m[1] : null;
}

function Variables() {
  const { datos, cargar } = useDatos('/api/entorno');
  const { cargando, error, setError, correr } = useAccion();
  const [pedido, setPedido] = useState(null);
  const [f, setF] = useState({ nombre: '', valor: '', descripcion: '' });
  const [ok, setOk] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    const leer = async () => {
      const id = pedidoDelHash();
      if (!id) return;
      try {
        const p = await api(`/api/entorno/pedido/${id}`);
        setPedido({ id, ...p });
        setF((x) => ({ ...x, nombre: p.nombre }));
        setTimeout(() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      } catch (e) { setError(e.message); }
    };
    leer();
    window.addEventListener('hashchange', leer);
    return () => window.removeEventListener('hashchange', leer);
  }, [setError]);

  const guardar = correr('g', async (e) => {
    const r = await post('/api/entorno', pedido ? { pedido: pedido.id, valor: f.valor } : f);
    setOk(pedido ? `${r.nombre} quedó guardada. El agente ya sigue con lo que estaba haciendo.` : `${r.nombre} quedó guardada.`);
    setF({ nombre: '', valor: '', descripcion: '' });
    if (pedido) { setPedido(null); window.history.replaceState(null, '', '#conexiones'); }
    cargar();
  });

  const vars = datos?.variables ?? [];
  return (
    <div ref={ref} className="scroll-mt-6">
      <Tarjeta titulo="Variables de entorno">
        <p className="mb-4 text-sm text-stone-600 dark:text-stone-400">
          Tokens y claves que el agente usa cuando trabaja con vos, como en tu PC. Se cargan acá, nunca por el chat:
          quedan cifradas y no se vuelven a mostrar. Los demás roles no las ven.
        </p>
        {pedido && (
          <div className="mb-4"><Aviso tipo="info">
            El agente te pide <b>{pedido.nombre}</b>{pedido.para ? `: ${pedido.para}` : '.'}
          </Aviso></div>
        )}
        <form onSubmit={guardar} className="grid gap-3 sm:grid-cols-2">
          <Campo etiqueta="Nombre" value={f.nombre} disabled={!!pedido} placeholder="VERCEL_TOKEN" autoCapitalize="characters"
            onChange={(e) => setF({ ...f, nombre: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
          <Campo etiqueta="Valor" type="password" autoComplete="off" value={f.valor} onChange={(e) => setF({ ...f, valor: e.target.value })} />
          {!pedido && <Campo className="sm:col-span-2" etiqueta="Para qué es (opcional)" value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} />}
          <div className="flex gap-2 sm:col-span-2">
            <Boton type="submit" cargando={cargando === 'g'} disabled={!f.nombre || !f.valor}>Guardar</Boton>
            {pedido && <Boton type="button" variante="fantasma" onClick={() => { setPedido(null); setF({ nombre: '', valor: '', descripcion: '' }); window.history.replaceState(null, '', '#conexiones'); }}>Ahora no</Boton>}
          </div>
        </form>
        {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
        {ok && <div className="mt-3"><Aviso tipo="ok">{ok}</Aviso></div>}
        {vars.length > 0 && (
          <Tabla
            className="mt-5"
            filas={vars}
            claveFila={(v) => v.nombre}
            columnas={[
              { clave: 'nombre', titulo: 'Variable', principal: true, render: (v) => <code className="font-mono text-sm">{v.nombre}</code> },
              { clave: 'descripcion', titulo: 'Para qué', render: (v) => <span className="text-stone-600 dark:text-stone-400">{v.descripcion || '—'}</span> },
              { clave: 'guardada', titulo: 'Guardada', render: (v) => <span className="whitespace-nowrap text-stone-600 dark:text-stone-400">{fechaCorta(v.guardada)}</span> },
              { clave: 'acciones', titulo: '', alinear: 'derecha', render: (v) => <Boton variante="fantasma" cargando={cargando === v.nombre} onClick={correr(v.nombre, async () => { await borrar(`/api/entorno/${v.nombre}`); cargar(); })}>Borrar</Boton> },
            ]}
          />
        )}
      </Tarjeta>
    </div>
  );
}

export default function Conexiones() {
  return (
    <div className="grid grid-cols-1 gap-5 [&>*]:min-w-0">
      <Variables />
      <Conectores />
      <Proyectos />
    </div>
  );
}

const ESTADO_PASO = { ok: 'ok', fallido: 'error', omitido: 'neutro' };

export function Publicacion({ proyecto }) {
  const { datos, cargar } = useDatos(`/api/proyectos/${proyecto.id}/publicacion`);
  const [f, setF] = useState(null);
  const [cred, setCred] = useState({ proveedor: 'vercel', variable: '', valor: '' });
  const [ok, setOk] = useState(null);
  const { cargando, error, correr } = useAccion();
  if (datos && !f) {
    const p = datos.procedimiento ?? {};
    setF({
      dominios: (datos.dominios ?? []).join(', '), respaldo: p.respaldo ?? '', ensayo: p.ensayo ?? '', migraciones: p.migraciones ?? '', deploy: p.deploy ?? '',
      verificacion: (p.verificacion ?? []).map((v) => `${v.url} | ${v.contiene}`).join('\n'),
    });
  }
  if (!f) return null;
  const guardar = correr('g', async () => {
    const r = await patchProc(proyecto.id, f);
    setOk(`Procedimiento guardado (versión ${r.version}).`);
    cargar();
  });
  return (
    <div className="mt-2 grid gap-3 rounded-xl bg-stone-50 p-3 dark:bg-stone-950">
      <p className="text-xs text-stone-600 dark:text-stone-400">Los cinco pasos son obligatorios. Los corre el gateway (no el modelo), en un clon limpio de la rama principal, con las credenciales solo en esos comandos. Todo lo que sale se tacha.</p>
      <form className="grid gap-2" onSubmit={guardar}>
        <Campo etiqueta="Dominios del proyecto" placeholder="sitio.com, api.sitio.com" value={f.dominios} onChange={(e) => setF({ ...f, dominios: e.target.value })} />
        {['respaldo', 'ensayo', 'migraciones', 'deploy'].map((k) => (
          <Campo key={k} etiqueta={`Paso: ${k}`} className="font-mono" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} required />
        ))}
        <AreaTexto etiqueta="Verificación (una por línea: URL | texto que tiene que aparecer)" rows={2} value={f.verificacion} onChange={(e) => setF({ ...f, verificacion: e.target.value })} />
        <div><Boton cargando={cargando === 'g'}>Guardar procedimiento</Boton>{datos.version ? <span className="ml-2 text-xs text-stone-500">versión actual {datos.version}</span> : null}</div>
      </form>
      <div>
        <p className="mb-1 text-sm font-medium">Credenciales (solo se ven los nombres)</p>
        <ul className="text-sm">{datos.credenciales.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 py-1"><span><code>{c.variable}</code> <span className="text-xs text-stone-500">{c.alcance ?? ''}{c.rotada ? ' · rotada' : ''}</span></span>
            <Boton variante="fantasma" onClick={correr('b', async () => { await borrar(`/api/credenciales/${c.id}`); cargar(); })}>Quitar</Boton></li>
        ))}</ul>
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={correr('c', async () => { await post(`/api/proyectos/${proyecto.id}/credenciales`, cred); setCred({ ...cred, valor: '', variable: '' }); cargar(); })}>
          <Selector aria-label="Proveedor" value={cred.proveedor} onChange={(e) => setCred({ ...cred, proveedor: e.target.value })}
            opciones={['vercel', 'cloudflare', 'supabase', 'github', 'otro'].map((p) => ({ valor: p, texto: p }))} />
          <Campo etiqueta="Variable (opcional)" placeholder="VERCEL_TOKEN" value={cred.variable} onChange={(e) => setCred({ ...cred, variable: e.target.value.toUpperCase() })} />
          <Campo etiqueta="Valor (token limitado al proyecto)" type="password" autoComplete="off" value={cred.valor} onChange={(e) => setCred({ ...cred, valor: e.target.value })} />
          <Boton variante="secundario" cargando={cargando === 'c'} disabled={!cred.valor}>Guardar o rotar</Boton>
        </form>
      </div>
      {datos.publicaciones.length > 0 && (
        <div>
          <p className="mb-1 text-sm font-medium">Últimas publicaciones</p>
          <ul className="text-sm">{datos.publicaciones.map((p) => (
            <li key={p.id} className="py-1">
              <Estado tono={p.estado === 'ok' ? 'ok' : p.estado === 'fallida' ? 'error' : 'espera'}>{p.estado}</Estado> <span className="text-xs text-stone-500">v{p.procedimiento_version} · {new Date(p.inicio).toLocaleString('es')}</span>
              <div className="mt-1 flex flex-wrap gap-1">{p.pasos.map((x) => <Estado key={x.paso} tono={ESTADO_PASO[x.estado] ?? 'neutro'}>{x.paso}</Estado>)}</div>
            </li>
          ))}</ul>
        </div>
      )}
      {ok && <Aviso tipo="ok">{ok}</Aviso>}
      {error && <Aviso>{error}</Aviso>}
    </div>
  );
}

async function patchProc(id, f) {
  const { api } = await import('../api.js');
  return api(`/api/proyectos/${id}/procedimiento`, {
    method: 'PUT',
    body: {
      dominios: f.dominios.split(',').map((d) => d.trim()).filter(Boolean),
      procedimiento: {
        respaldo: f.respaldo, ensayo: f.ensayo, migraciones: f.migraciones, deploy: f.deploy,
        verificacion: f.verificacion.split('\n').map((l) => l.split('|').map((x) => x.trim())).filter(([u]) => u).map(([url, contiene]) => ({ url, contiene })),
      },
    },
  });
}

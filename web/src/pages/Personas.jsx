// Personas y roles: alta por número, cambio de rol, edición de roles y "responder a números sin alta".
import { useState } from 'react';
import { borrar, patch, post } from '../api.js';
import { useAccion, useDatos } from '../hooks.js';
import { Aviso, Boton, Campo, Estado, Interruptor, Selector, Tarjeta, Vacio } from '../components/ui.jsx';
import AccesoPanel from '../components/AccesoPanel.jsx';

const TEXTO = {
  true: 'Sí', false: 'No', no: 'No', ninguna: 'No', lectura: 'Solo leer', lectura_escritura: 'Leer y escribir',
  solo_leer: 'Solo leer', en_rama: 'Sí, en una rama', con_aprobacion: 'Con aprobación', directo: 'Directo',
};

function EditorRol({ rol, catalogo, alGuardar, alCancelar }) {
  const [nombre, setNombre] = useState(rol?.nombre ?? '');
  const [descripcion, setDescripcion] = useState(rol?.descripcion ?? '');
  const [permisos, setPermisos] = useState(rol?.permisos ?? Object.fromEntries(catalogo.map((c) => [c.permiso, c.niveles[0]])));
  const { cargando, error, correr } = useAccion();
  const guardar = correr('guardar', async () => {
    if (rol?.id) await patch(`/api/roles/${rol.id}`, { nombre, descripcion, permisos });
    else await post('/api/roles', { nombre, descripcion, permisos });
    alGuardar();
  });
  return (
    <form onSubmit={guardar} className="mt-3 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <div className="grid gap-3 sm:grid-cols-2">
        <Campo etiqueta="Nombre" value={nombre} onChange={(e) => setNombre(e.target.value)} disabled={rol?.predefinido} required />
        <Campo etiqueta="Qué hace (en simple)" value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {catalogo.map((c) => (
          <Selector key={c.permiso} etiqueta={c.nombre} value={String(permisos[c.permiso])}
            onChange={(e) => {
              const v = c.niveles.find((n) => String(n) === e.target.value);
              setPermisos((p) => ({ ...p, [c.permiso]: v }));
            }}
            opciones={c.niveles.map((n) => ({ valor: n, texto: TEXTO[String(n)] ?? String(n) }))} />
        ))}
      </div>
      <div className="mt-4 flex gap-2">
        <Boton cargando={cargando === 'guardar'}>Guardar</Boton>
        <Boton type="button" variante="secundario" onClick={alCancelar}>Cancelar</Boton>
      </div>
      {error && <div className="mt-3"><Aviso>{error}</Aviso></div>}
    </form>
  );
}

export default function Personas({ usuario, secciones }) {
  const pers = useDatos('/api/personas');
  const rls = useDatos('/api/roles');
  const [alta, setAlta] = useState({ nombre: '', telefono: '', rolId: '' });
  const [editando, setEditando] = useState(null); // id de rol, 'nuevo' o null
  const { cargando, error, correr } = useAccion();
  const roles = pers.datos?.roles ?? [];
  const recargar = () => { pers.cargar(); rls.cargar(); };
  const rolPorDefecto = roles.find((r) => r.nombre === 'Colaborador')?.id ?? roles[0]?.id;

  return (
    <div className="grid gap-5">
      {usuario?.accesos === 'todo' && <AccesoPanel secciones={secciones} usuario={usuario} />}
      <Tarjeta titulo="Todas las personas">
        <form className="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
          onSubmit={correr('alta', async () => { await post('/api/personas', { ...alta, rolId: Number(alta.rolId || rolPorDefecto) }); setAlta({ nombre: '', telefono: '', rolId: '' }); recargar(); })}>
          <Campo etiqueta="Nombre" value={alta.nombre} onChange={(e) => setAlta({ ...alta, nombre: e.target.value })} />
          <Campo etiqueta="WhatsApp con código de país" inputMode="tel" placeholder="5491112345678" value={alta.telefono} onChange={(e) => setAlta({ ...alta, telefono: e.target.value })} required />
          <Selector etiqueta="Rol" value={String(alta.rolId || rolPorDefecto || '')} onChange={(e) => setAlta({ ...alta, rolId: e.target.value })}
            opciones={roles.map((r) => ({ valor: r.id, texto: r.nombre }))} />
          <Boton cargando={cargando === 'alta'}>Dar de alta</Boton>
        </form>
        {pers.datos?.personas?.length ? (
          <ul className="flex flex-col divide-y divide-stone-200 text-sm dark:divide-stone-800">
            {pers.datos.personas.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <span className="font-medium">{p.nombre || 'Sin nombre'}</span>
                  {p.telefono && <span className="ml-2 text-stone-500">+{p.telefono}</span>}
                  {!p.alta_manual && <span className="ml-2"><Estado>Escribió sin alta</Estado></span>}
                  {p.panel && <span className="ml-2"><Estado tono="ok">Entra al panel</Estado></span>}
                </div>
                <div className="flex items-center gap-2">
                  <Selector aria-label={`Rol de ${p.nombre ?? p.telefono}`} value={String(p.rol_id)}
                    onChange={correr(`rol${p.id}`, async (e) => { await patch(`/api/personas/${p.id}`, { rolId: Number(e.target.value) }); recargar(); })}
                    opciones={roles.map((r) => ({ valor: r.id, texto: r.nombre }))} />
                  {!p.panel && <Boton variante="fantasma" onClick={correr(`baja${p.id}`, async () => { await borrar(`/api/personas/${p.id}`); recargar(); })}>Dar de baja</Boton>}
                </div>
              </li>
            ))}
          </ul>
        ) : <Vacio>Todavía no hay personas.</Vacio>}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-stone-200 pt-4 dark:border-stone-800">
          <div>
            <p className="text-sm font-medium">Responder a números sin alta</p>
            <p className="text-xs text-stone-500 dark:text-stone-400">Si está prendido, quien escribe sin estar dado de alta conversa como Tercero. Si no, se ignora.</p>
          </div>
          <Interruptor etiqueta="Responder a números sin alta" prendido={pers.datos?.responderSinAlta}
            alCambiar={(v) => correr('sinalta', async () => { await post('/api/cuenta/responder-sin-alta', { valor: v }); pers.cargar(); })()} />
        </div>
        {(error || pers.error) && <div className="mt-3"><Aviso>{error || pers.error}</Aviso></div>}
      </Tarjeta>

      <Tarjeta titulo="Roles" accion={<Boton variante="secundario" onClick={() => setEditando('nuevo')}>Rol nuevo</Boton>}>
        {editando === 'nuevo' && rls.datos && (
          <EditorRol catalogo={rls.datos.catalogo} alGuardar={() => { setEditando(null); recargar(); }} alCancelar={() => setEditando(null)} />
        )}
        <ul className="mt-2 flex flex-col gap-3">
          {rls.datos?.roles?.map((r) => (
            <li key={r.id} className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{r.nombre} {r.predefinido && <span className="ml-1 text-xs text-stone-500">predefinido</span>}
                  <span className="ml-2 text-xs text-stone-500">{r.personas} {r.personas === 1 ? 'persona' : 'personas'}</span></p>
                {r.nombre !== 'Propietario' && (
                  <div className="flex gap-2">
                    <Boton variante="fantasma" onClick={() => setEditando(editando === r.id ? null : r.id)}>{editando === r.id ? 'Cerrar' : 'Editar'}</Boton>
                    {!r.predefinido && <Boton variante="fantasma" onClick={correr(`borrar${r.id}`, async () => { await borrar(`/api/roles/${r.id}`); recargar(); })}>Borrar</Boton>}
                  </div>
                )}
              </div>
              {r.descripcion && <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">{r.descripcion}</p>}
              {editando === r.id ? (
                <EditorRol rol={r} catalogo={rls.datos.catalogo} alGuardar={() => { setEditando(null); recargar(); }} alCancelar={() => setEditando(null)} />
              ) : (
                <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
                  {r.enPalabras.filter((x) => x.valor !== false && x.valor !== 'no' && x.valor !== 'ninguna').map((x) => `${x.nombre}: ${x.texto}`).join(' · ') || 'Nada'}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Tarjeta>
    </div>
  );
}

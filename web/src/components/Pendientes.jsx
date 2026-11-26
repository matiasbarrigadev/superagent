// Inicio: lo que espera al Propietario. Propuestas (tarjetas con permisos en palabras), aprobaciones y avisos.
import { post } from '../api.js';
import { useAccion, useDatos } from '../hooks.js';
import { Aviso, Boton, Campo, Estado, Tarjeta, Vacio, fechaCorta } from './ui.jsx';
import { useState } from 'react';

function TarjetaPropuesta({ p, alDecidir }) {
  const { cargando, error, correr } = useAccion();
  const d = p.datos;
  return (
    <li className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          <span className="mr-2 text-xs text-stone-500">{p.id}</span>
          {p.tipo === 'rol' ? <>Rol nuevo: {d.nombre}</> : <>{d.nombre} (+{d.telefono}) como {d.rol}</>}
        </p>
        <Estado tono="espera">Propuesta del agente</Estado>
      </div>
      {d.descripcion && <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">{d.descripcion}</p>}
      {p.permisos && (
        <ul className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
          {p.permisos.map((x) => (
            <li key={x.permiso} className={x.valor === false || x.valor === 'no' || x.valor === 'ninguna' ? 'text-stone-400 dark:text-stone-600' : ''}>
              {x.nombre}: <span className="font-medium">{x.texto}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        <Boton cargando={cargando === 'si'} onClick={correr('si', async () => { await post(`/api/propuestas/${p.id}/confirmar`); alDecidir(); })}>Confirmar</Boton>
        <Boton variante="secundario" cargando={cargando === 'no'} onClick={correr('no', async () => { await post(`/api/propuestas/${p.id}/descartar`); alDecidir(); })}>Descartar</Boton>
      </div>
      {error && <div className="mt-2"><Aviso>{error}</Aviso></div>}
    </li>
  );
}

function TarjetaAprobacion({ a, alDecidir }) {
  const { cargando, error, correr } = useAccion();
  const [comentario, setComentario] = useState('');
  return (
    <li className="rounded-xl border border-stone-200 p-4 dark:border-stone-800">
      <p className="text-sm"><span className="mr-2 font-semibold">{a.id}</span>{a.detalle}</p>
      <p className="mt-1 text-xs text-stone-500">{fechaCorta(a.creada)}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Boton cargando={cargando === 'si'} onClick={correr('si', async () => { await post(`/api/aprobaciones/${a.id}/aprobar`); alDecidir(); })}>Aprobar</Boton>
        <Campo etiqueta="Comentario (opcional)" value={comentario} onChange={(e) => setComentario(e.target.value)} className="min-w-48 flex-1" />
        <Boton variante="peligro" cargando={cargando === 'no'} onClick={correr('no', async () => { await post(`/api/aprobaciones/${a.id}/rechazar`, { comentario }); alDecidir(); })}>Rechazar</Boton>
      </div>
      {error && <div className="mt-2"><Aviso>{error}</Aviso></div>}
    </li>
  );
}

export default function Pendientes() {
  const props = useDatos('/api/propuestas?estado=pendiente', { cada: 8000 });
  const aps = useDatos('/api/aprobaciones?estado=pendiente', { cada: 8000 });
  const avisos = useDatos('/api/avisos', { cada: 15000 });
  const { correr } = useAccion();
  const recargar = () => { props.cargar(); aps.cargar(); avisos.cargar(); };
  const lista = avisos.datos?.avisos ?? [];
  const sinLeer = lista.filter((x) => !x.leido).length;

  return (
    <div className="grid gap-5 lg:col-span-2 lg:grid-cols-2">
      <Tarjeta titulo="Para confirmar">
        {props.datos?.propuestas?.length || aps.datos?.aprobaciones?.length ? (
          <ul className="flex flex-col gap-3">
            {props.datos?.propuestas?.map((p) => <TarjetaPropuesta key={p.id} p={p} alDecidir={recargar} />)}
            {aps.datos?.aprobaciones?.map((a) => <TarjetaAprobacion key={a.id} a={a} alDecidir={recargar} />)}
          </ul>
        ) : <Vacio>No hay nada esperando tu ok.</Vacio>}
        {(props.error || aps.error) && <div className="mt-3"><Aviso>{props.error || aps.error}</Aviso></div>}
      </Tarjeta>

      <Tarjeta titulo={`Avisos${sinLeer ? ` (${sinLeer} nuevos)` : ''}`}
        accion={sinLeer ? <Boton variante="fantasma" onClick={correr('leer', async () => { await post('/api/avisos/leidos'); avisos.cargar(); })}>Marcar leídos</Boton> : null}>
        {lista.length ? (
          <ul className="flex max-h-96 flex-col divide-y divide-stone-200 overflow-y-auto text-sm dark:divide-stone-800">
            {lista.map((x) => (
              <li key={x.id} className={`py-2 ${x.leido ? 'text-stone-500 dark:text-stone-400' : ''}`}>
                <div className="flex items-center justify-between gap-2">
                  <Estado tono={x.tipo === 'error' ? 'error' : x.tipo === 'consulta' ? 'espera' : 'neutro'}>
                    {x.tipo === 'consulta' ? (x.estado === 'resuelto' ? 'Consulta respondida' : 'Consulta') : x.tipo === 'error' ? 'Problema' : 'Aviso'}
                  </Estado>
                  <span className="text-xs text-stone-500">{fechaCorta(x.ts)}</span>
                </div>
                <p className="mt-1 whitespace-pre-line">{x.texto}</p>
              </li>
            ))}
          </ul>
        ) : <Vacio>Sin avisos.</Vacio>}
      </Tarjeta>
    </div>
  );
}

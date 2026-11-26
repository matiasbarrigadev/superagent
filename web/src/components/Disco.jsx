// Disco: cuánto se usa del volumen de datos, qué ocupa más, la limpieza automática y su configuración.
// El agente también lo ve y lo cuida; esto es para mirarlo y ajustarlo.
import { useState } from 'react';
import { patch, post } from '../api.js';
import { useAccion, useDatos } from '../hooks.js';
import { Aviso, Boton, CampoChico, Chip, Interruptor, Tabla, Tarjeta, fechaCorta } from './ui.jsx';

const cx = (...c) => c.filter(Boolean).join(' ');
const legible = (b) => (b == null ? '—' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : `${Math.round(b / 1024)} KB`);
const TIPO = {
  propietario: ['Tu entorno', 'violeta'], chat: ['Charla', 'azul'], trabajo: ['Trabajo', 'ambar'], sesion: ['Sesión', 'ambar'],
  adjuntos: ['WhatsApp', 'verde'], salientes: ['Enviados', 'verde'], repos: ['Repos', 'neutro'], base: ['Base', 'neutro'], grabaciones: ['Pruebas', 'neutro'], otro: ['Otro', 'neutro'],
};

export default function Disco() {
  const { datos, cargar, error: errorCarga } = useDatos('/api/disco', { cada: 60_000 });
  const { cargando, error, correr } = useAccion();
  const [resultado, setResultado] = useState(null);
  const [dias, setDias] = useState(null);
  if (errorCarga) return null;
  if (!datos) return null;
  const v = datos.volumen;
  const c = datos.config;
  const tono = v.pct >= c.umbral ? 'bg-red-500' : v.pct >= c.umbral - 15 ? 'bg-amber-500' : 'bg-emerald-600';
  const limpiar = (simular) => correr(simular ? 's' : 'l', async () => { const r = await post('/api/disco/limpiar', { simular }); setResultado({ ...r, simular }); cargar(); });
  const configurar = (cambio) => correr('c', async () => { await patch('/api/disco', cambio); cargar(); })();

  return (
    <Tarjeta titulo="Disco" accion={<span className="text-sm tabular-nums text-stone-600 dark:text-stone-400">{legible(v.usado)} de {legible(v.total)}</span>}>
      <div className="grid gap-4">
        <div>
          <div className="h-3 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v.pct ?? 0} aria-label="Uso del disco">
            <div className={cx('h-full rounded-full transition-all', tono)} style={{ width: `${Math.min(100, v.pct ?? 0)}%` }} />
          </div>
          <p className="mt-1.5 flex justify-between text-xs text-stone-500 dark:text-stone-400">
            <span>{v.pct}% usado · {legible(v.libre)} libres</span>
            <span>Aviso al {c.umbral}%</span>
          </p>
          {v.pct >= c.umbral && <div className="mt-2"><Aviso>El disco pasó el {c.umbral}%. El agente ya está avisado y libera espacio por su cuenta; te escribe solo si hace falta que decidas algo. También podés ampliar el volumen en Railway (se cobra solo lo usado).</Aviso></div>}
        </div>

        <Tabla
          corte="md"
          filas={datos.desglose.slice(0, 8)}
          claveFila={(p, i) => `${p.clave ?? p.tipo}-${i}`}
          columnas={[
            { clave: 'nombre', titulo: 'Qué ocupa', principal: true, render: (p) => <span className="font-medium">{p.nombre}</span> },
            { clave: 'tipo', titulo: 'Tipo', render: (p) => <Chip tono={(TIPO[p.tipo] ?? TIPO.otro)[1]}>{(TIPO[p.tipo] ?? TIPO.otro)[0]}</Chip> },
            { clave: 'tamano', titulo: 'Tamaño', alinear: 'derecha', render: (p) => <span className="tabular-nums">{legible(p.tamano)}</span> },
          ]}
        />

        <div className="grid gap-3 rounded-xl bg-stone-50 p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center dark:bg-stone-950/50">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2">
              <Interruptor etiqueta="Limpieza automática" prendido={c.automatica} alCambiar={(x) => configurar({ automatica: x })} />
              <span>Limpieza automática cada hora</span>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-stone-600 dark:text-stone-400">Adjuntos por</span>
              <CampoChico type="number" min="0" max="3650" className="w-20" aria-label="Días que se guardan los adjuntos" value={dias ?? c.diasAdjuntos}
                onChange={(e) => setDias(e.target.value)} onBlur={() => { if (dias !== null && Number(dias) !== c.diasAdjuntos) configurar({ diasAdjuntos: Number(dias) }); setDias(null); }} />
              <span className="text-stone-600 dark:text-stone-400">días {c.diasAdjuntos === 0 && '(siempre)'}</span>
            </label>
          </div>
          <div className="flex gap-2">
            <Boton variante="secundario" cargando={cargando === 's'} onClick={limpiar(true)}>Ver qué borraría</Boton>
            <Boton cargando={cargando === 'l'} onClick={limpiar(false)}>Limpiar ahora</Boton>
          </div>
        </div>

        {resultado && (
          <Aviso tipo={resultado.acciones.length ? 'ok' : 'info'}>
            {resultado.acciones.length
              ? `${resultado.simular ? 'Borraría' : 'Listo, se liberaron'} ${legible(resultado.liberado)}: ${resultado.acciones.join('; ')}.`
              : 'No hay nada para limpiar automáticamente. Si hace falta más espacio, pedile al agente que revise su entorno o ampliá el volumen.'}
          </Aviso>
        )}
        {error && <Aviso>{error}</Aviso>}
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Se borra solo lo que ya cumplió su función: carpetas de trabajos terminados, adjuntos y archivos enviados viejos (queda su texto) y temporales.
          Nunca las charlas, la base ni tu entorno: eso lo ordena el agente con tu ok.
          {datos.ultimaLimpieza && ` Última limpieza: ${fechaCorta(datos.ultimaLimpieza.en)} (${legible(datos.ultimaLimpieza.liberado)}).`}
        </p>
      </div>
    </Tarjeta>
  );
}

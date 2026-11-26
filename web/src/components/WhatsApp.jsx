// Estado de WhatsApp: QR que se refresca solo, código de vinculación con número, desvincular.
import { useEffect, useRef, useState } from 'react';
import { api, post } from '../api.js';
import { Aviso, Boton, Campo, Estado, Girando, Tarjeta } from './ui.jsx';

const ESTADOS = {
  WORKING: { texto: 'Conectado', tono: 'ok' },
  SCAN_QR_CODE: { texto: 'Esperando vinculación', tono: 'espera' },
  STARTING: { texto: 'Iniciando…', tono: 'neutro' },
  STOPPED: { texto: 'Detenido', tono: 'neutro' },
  NO_CREADA: { texto: 'Preparando…', tono: 'neutro' },
  FAILED: { texto: 'Falló', tono: 'error' },
};

const numeroDe = (id) => String(id ?? '').split('@')[0];

export default function WhatsApp({ base = '/api/whatsapp', titulo = 'WhatsApp', pie = null }) {
  const [estado, setEstado] = useState(null);
  const [error, setError] = useState(null);
  const [modo, setModo] = useState('qr');
  const [qrVersion, setQrVersion] = useState(0);
  const [qrFalla, setQrFalla] = useState(false);
  const [telefono, setTelefono] = useState('');
  const [codigo, setCodigo] = useState(null);
  const [cargando, setCargando] = useState(null);
  const [confirmando, setConfirmando] = useState(false);
  const vivo = useRef(true);

  async function refrescar() {
    try {
      const e = await api(`${base}/estado`);
      if (!vivo.current) return;
      setEstado(e);
      setError(null);
      if (e.status !== 'SCAN_QR_CODE') setCodigo(null);
    } catch (err) {
      if (vivo.current) setError(err.message);
    }
  }

  useEffect(() => {
    vivo.current = true;
    refrescar();
    const t = setInterval(refrescar, 3000);
    return () => { vivo.current = false; clearInterval(t); };
  }, []);

  // El QR de WhatsApp cambia cada ~20 s: se pide uno nuevo cada 10 s mientras se espera.
  const esperando = estado?.status === 'SCAN_QR_CODE';
  useEffect(() => {
    if (!esperando || modo !== 'qr') return;
    const t = setInterval(() => setQrVersion((v) => v + 1), 10_000);
    return () => clearInterval(t);
  }, [esperando, modo]);

  const accion = (nombre, fn) => async (e) => {
    e?.preventDefault();
    setError(null);
    setCargando(nombre);
    try { await fn(); } catch (err) { setError(err.message); } finally { setCargando(null); }
  };

  const pedirCodigo = accion('codigo', async () => {
    const r = await post(`${base}/codigo`, { telefono });
    setCodigo(r.codigo);
  });

  const desvincular = accion('desvincular', async () => {
    await post(`${base}/desvincular`);
    setConfirmando(false);
    setModo('qr');
    await refrescar();
  });

  const reiniciar = accion('reiniciar', async () => {
    await post(`${base}/reiniciar`);
    await refrescar();
  });

  const info = ESTADOS[estado?.status] ?? { texto: estado?.status ?? 'Consultando…', tono: 'neutro' };

  return (
    <Tarjeta titulo={titulo} accion={<Estado tono={info.tono}>{info.texto}</Estado>}>
      <div className="flex flex-col gap-4">
        {!estado && !error && <div className="flex justify-center py-10 text-stone-400"><Girando className="size-6" /></div>}

        {estado?.status === 'WORKING' && (
          <>
            <div className="rounded-xl bg-emerald-50 p-4 dark:bg-emerald-950/40">
              <p className="text-sm text-stone-600 dark:text-stone-400">Número vinculado</p>
              <p className="text-lg font-semibold">+{numeroDe(estado.me?.id)}</p>
              {estado.me?.nombre && <p className="text-sm text-stone-600 dark:text-stone-400">{estado.me.nombre}</p>}
            </div>
            {!confirmando ? (
              <Boton variante="peligro" onClick={() => setConfirmando(true)}>Desvincular y volver a vincular</Boton>
            ) : (
              <div className="flex flex-col gap-3 rounded-xl border border-red-200 p-4 dark:border-red-900">
                <p className="text-sm">El agente deja de recibir y enviar mensajes hasta que vincules un número de nuevo. ¿Seguro?</p>
                <div className="flex flex-wrap gap-2">
                  <Boton variante="peligro" cargando={cargando === 'desvincular'} onClick={desvincular}>Sí, desvincular</Boton>
                  <Boton variante="secundario" onClick={() => setConfirmando(false)}>Cancelar</Boton>
                </div>
              </div>
            )}
          </>
        )}

        {esperando && (
          <>
            <div role="tablist" className="grid grid-cols-2 rounded-lg bg-stone-100 p-1 text-sm dark:bg-stone-800">
              {[['qr', 'Escanear QR'], ['codigo', 'Código con número']].map(([id, nombre]) => (
                <button key={id} role="tab" aria-selected={modo === id} onClick={() => setModo(id)}
                  className={`rounded-md px-3 py-1.5 font-medium ${modo === id ? 'bg-white shadow-sm dark:bg-stone-950' : 'text-stone-600 dark:text-stone-400'}`}>
                  {nombre}
                </button>
              ))}
            </div>

            {modo === 'qr' && (
              <div className="flex flex-col items-center gap-3">
                {!qrFalla ? (
                  <img key={qrVersion} src={`${base}/qr?v=${qrVersion}`} alt="QR para vincular WhatsApp"
                    onError={() => { setQrFalla(true); setTimeout(() => { setQrFalla(false); setQrVersion((v) => v + 1); }, 3000); }}
                    className="size-64 rounded-xl bg-white p-3" />
                ) : (
                  <div className="flex size-64 items-center justify-center rounded-xl bg-stone-100 text-stone-400 dark:bg-stone-800"><Girando className="size-6" /></div>
                )}
                <p className="text-center text-sm text-stone-600 dark:text-stone-400">
                  En el teléfono: WhatsApp → <b>Dispositivos vinculados</b> → <b>Vincular un dispositivo</b>. El QR se actualiza solo.
                </p>
              </div>
            )}

            {modo === 'codigo' && (
              <div className="flex flex-col gap-4">
                {!codigo ? (
                  <form onSubmit={pedirCodigo} className="flex flex-col gap-3">
                    <Campo etiqueta="Número del WhatsApp a vincular" type="tel" value={telefono} onChange={(e) => setTelefono(e.target.value)}
                      inputMode="tel" autoComplete="off" placeholder="+54 9 11 1234 5678" required
                      ayuda="Con código de país. Es el número del teléfono donde está WhatsApp." />
                    <Boton type="submit" cargando={cargando === 'codigo'}>Pedir código</Boton>
                  </form>
                ) : (
                  <div className="flex flex-col items-center gap-3 text-center">
                    <p className="text-sm text-stone-600 dark:text-stone-400">Código de vinculación</p>
                    <p className="select-all font-mono text-4xl font-semibold tracking-[0.2em]">{codigo}</p>
                    <p className="text-sm text-stone-600 dark:text-stone-400">
                      En el teléfono: WhatsApp → <b>Dispositivos vinculados</b> → <b>Vincular un dispositivo</b> → <b>Vincular con número de teléfono</b>, y escribí este código.
                    </p>
                    <Boton variante="fantasma" onClick={() => setCodigo(null)}>Pedir otro</Boton>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {(estado?.status === 'FAILED' || estado?.status === 'STOPPED') && (
          <Boton variante="secundario" cargando={cargando === 'reiniciar'} onClick={reiniciar}>Reiniciar la sesión</Boton>
        )}

        <Aviso>{error}</Aviso>
        {pie}
      </div>
    </Tarjeta>
  );
}

// Cuenta de Claude del Propietario: estado (verificado solo, en segundo plano), login guiado (link + código), terminal de respaldo y desconexión.
import { lazy, Suspense, useEffect, useState } from 'react';
import { api, post } from '../api.js';
import { Aviso, Boton, Estado, Girando, Tarjeta } from './ui.jsx';
// xterm pesa: se carga solo cuando se abre la terminal.
const Terminal = lazy(() => import('./Terminal.jsx'));

export default function Claude() {
  const [estado, setEstado] = useState(null);
  const [terminal, setTerminal] = useState(false);
  const [cargando, setCargando] = useState(null);
  const [confirmando, setConfirmando] = useState(false);
  const [error, setError] = useState(null);
  const [login, setLogin] = useState(null); // { url } mientras se espera el código
  const [codigoLogin, setCodigoLogin] = useState('');

  async function refrescar() {
    try {
      setEstado(await api('/api/claude/estado'));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => { refrescar(); }, []);
  // Mientras el gateway verifica el token (en segundo plano), se vuelve a consultar cada pocos segundos.
  useEffect(() => {
    if (estado?.conectado && estado.funciona == null) {
      const t = setTimeout(refrescar, 4000);
      return () => clearTimeout(t);
    }
  }, [estado]);

  const accion = (nombre, fn) => async () => {
    setError(null);
    setCargando(nombre);
    try { await fn(); } catch (e) { setError(e.message); } finally { setCargando(null); }
  };

  const desconectar = accion('desconectar', async () => {
    await post('/api/claude/desconectar');
    setConfirmando(false);
    await refrescar();
  });

  const iniciarLogin = accion('login', async () => {
    setCodigoLogin('');
    setLogin(await post('/api/claude/login'));
  });
  const enviarCodigo = (e) => {
    e.preventDefault();
    return accion('codigo', async () => {
      await post('/api/claude/login/codigo', { codigo: codigoLogin });
      setLogin(null);
      setCodigoLogin('');
      await refrescar();
    })();
  };
  const cancelarLogin = () => { post('/api/claude/login/cancelar').catch(() => {}); setLogin(null); setCodigoLogin(''); };

  const roto = estado?.conectado && estado.funciona === false;
  const tono = !estado ? 'neutro' : roto ? 'error' : estado.conectado ? (estado.funciona ? 'ok' : 'espera') : estado.instalado === false ? 'error' : 'espera';
  const texto = !estado ? 'Consultando…' : roto ? 'No funciona' : estado.conectado ? (estado.funciona ? 'Conectado' : 'Verificando…') : estado.instalado === false ? 'No instalado' : 'Sin conectar';

  return (
    <Tarjeta titulo="Claude" accion={<Estado tono={tono}>{texto}</Estado>}>
      <div className="flex flex-col gap-4">
        {!estado && !error && <div className="flex justify-center py-10 text-stone-400"><Girando className="size-6" /></div>}

        {estado?.conectado && !terminal && (
          <>
            <div className="rounded-xl bg-stone-50 p-4 text-sm dark:bg-stone-950">
              <p className="text-stone-600 dark:text-stone-400">El agente usa tu suscripción de Claude, con un token de larga duración guardado cifrado.</p>
              {estado.vence && <p className="mt-1 text-stone-500 dark:text-stone-400">Vence aprox. el {new Date(estado.vence).toLocaleDateString('es')}.</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              {!confirmando && <Boton variante="peligro" onClick={() => setConfirmando(true)}>Desconectar</Boton>}
            </div>
            {confirmando && (
              <div className="flex flex-col gap-3 rounded-xl border border-red-200 p-4 dark:border-red-900">
                <p className="text-sm">El agente deja de responder hasta que conectes una cuenta de nuevo. ¿Seguro?</p>
                <div className="flex flex-wrap gap-2">
                  <Boton variante="peligro" cargando={cargando === 'desconectar'} onClick={desconectar}>Sí, desconectar</Boton>
                  <Boton variante="secundario" onClick={() => setConfirmando(false)}>Cancelar</Boton>
                </div>
              </div>
            )}
            {roto && (
              <Aviso>
                El token guardado no funciona{estado.detalle ? <>: <span className="font-mono">{estado.detalle}</span></> : '.'} Desconectá y volvé a conectar Claude.
              </Aviso>
            )}
          </>
        )}

        {estado && !estado.conectado && !terminal && !login && (
          <>
            <p className="text-sm text-stone-600 dark:text-stone-400">
              El agente usa tu suscripción de Claude. Conectala en dos pasos: autorizás en claude.ai y pegás acá el
              código que te muestra.
            </p>
            {estado.error && <Aviso>{estado.error}</Aviso>}
            <Boton onClick={iniciarLogin} cargando={cargando === 'login'} disabled={estado.instalado === false}>Conectar Claude</Boton>
            <button type="button" className="self-start text-xs text-stone-500 underline dark:text-stone-400" onClick={() => setTerminal(true)}>
              ¿No funciona? Usar la terminal
            </button>
          </>
        )}

        {login && !estado?.conectado && (
          <form className="flex flex-col gap-4" onSubmit={enviarCodigo}>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">1. Autorizá en Claude</p>
              <a href={login.url} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white">
                Abrir claude.ai
              </a>
              <p className="text-xs text-stone-500 dark:text-stone-400">Se abre en otra pestaña. Iniciá sesión, tocá Autorizar y copiá el código que aparece.</p>
            </div>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium" htmlFor="codigo-claude">2. Pegá el código</label>
              <input id="codigo-claude" value={codigoLogin} onChange={(e) => setCodigoLogin(e.target.value)} autoComplete="off" spellCheck={false}
                className="rounded-xl border border-stone-300 bg-white px-3 py-2.5 font-mono text-sm dark:border-stone-700 dark:bg-stone-900" placeholder="Pegá acá el código de claude.ai" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Boton cargando={cargando === 'codigo'} disabled={!codigoLogin.trim()}>Conectar</Boton>
              <Boton type="button" variante="secundario" onClick={cancelarLogin}>Cancelar</Boton>
            </div>
          </form>
        )}

        {terminal && (
          <div className="flex flex-col gap-3">
            <Suspense fallback={<div className="flex h-80 items-center justify-center rounded-xl bg-stone-950 text-stone-500"><Girando className="size-6" /></div>}>
              <Terminal alTerminar={() => refrescar()} />
            </Suspense>
            <Boton variante="secundario" onClick={() => { setTerminal(false); refrescar(); }}>Cerrar terminal</Boton>
          </div>
        )}

        <Aviso>{error}</Aviso>
      </div>
    </Tarjeta>
  );
}

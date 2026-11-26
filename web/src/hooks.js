// Carga de datos con refresco opcional y acciones con estado de carga y error.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export function useDatos(ruta, { cada = 0 } = {}) {
  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const vivo = useRef(true);
  const cargar = useCallback(async () => {
    try {
      const d = await api(ruta);
      if (vivo.current) { setDatos(d); setError(null); }
    } catch (e) {
      if (vivo.current) setError(e.message);
    }
  }, [ruta]);
  useEffect(() => {
    vivo.current = true;
    cargar();
    const t = cada ? setInterval(cargar, cada) : null;
    return () => { vivo.current = false; if (t) clearInterval(t); };
  }, [cargar, cada]);
  return { datos, error, cargar, setError };
}

/** Envuelve una acción: guarda cuál está cargando y el último error. */
export function useAccion() {
  const [cargando, setCargando] = useState(null);
  const [error, setError] = useState(null);
  const correr = useCallback((nombre, fn) => async (e) => {
    if (e?.type === 'submit') e.preventDefault();
    setError(null);
    setCargando(nombre);
    try { return await fn(e); } catch (err) { setError(err.message); return null; } finally { setCargando(null); }
  }, []);
  return { cargando, error, setError, correr };
}

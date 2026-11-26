---
name: instalar-superagent
description: Instalar, levantar, deployar o actualizar un Superagent (agente de WhatsApp sobre Claude Code) en Railway o en local con Docker Compose. Usar cuando piden "levantá un superagent", "instalalo en Railway", "corrélo en mi máquina con docker", "actualizá mi instalación" o algo parecido.
---

# Instalar Superagent

Un Superagent son dos servicios:

- **`waha`**: WhatsApp (imagen `devlikeapro/waha:gows-2026.9.2`, motor GOWS). Nunca se expone a internet.
- **`superagent`**: la imagen publicada `ghcr.io/matiasbarrigadev/superagent:<versión>` (amd64 y arm64). Gateway +
  panel + Claude Code. Puerto 8080, healthcheck `/salud`.

**Instalá siempre desde la imagen, con una versión fija** (la última de
[Releases](https://github.com/matiasbarrigadev/superagent/releases), por ejemplo `0.3.0`), no desde el repo: así la
instalación no cambia sola, se actualiza cuando la persona quiere y se puede volver atrás. El repo (`Dockerfile`)
es solo para quien va a modificar el código.

Comparten una clave (`WAHA_API_KEY`). Todo lo demás (HMAC, secreto de sesión, URLs internas) lo resuelve el gateway
solo. **No pidas ni escribas tokens de Claude, GitHub ni de otros servicios**: se conectan después, desde el panel o
hablando con el agente por WhatsApp.

## 0. Preguntar lo mínimo

Antes de empezar, confirmá con la persona:

1. **¿Dónde?** Railway (24/7, recomendado) o Docker en su máquina/servidor.
2. **Zona horaria** (ej. `America/Santiago`). Si no sabe, `UTC`; el agente la puede cambiar después.
3. En Docker: **¿tiene un dominio** apuntando al servidor? (para HTTPS con Caddy). Si no, queda en `localhost`.

No hace falta nada más para instalar. El número de WhatsApp y la cuenta de Claude se conectan al final, con la persona.

## A. Railway

### Si hay un template publicado

Si la persona tiene un link `railway.com/new/template/...` (o el README lo muestra), es un botón **Deploy** y se
salta al paso *Verificar*.

### Con la CLI de Railway (`railway`, 5.x)

Pedile a la persona que haga `railway login` si `railway whoami` falla (el login es suyo). Después:

```sh
railway init --name superagent            # o `railway link` a un proyecto existente

# Lo más simple: el template publicado, https://railway.com/deploy/superagente-en-whatsapp (si la persona
# puede tocar el botón Deploy). Con la CLI, la misma receta:
# Servicio 1: waha (el nombre "waha" es obligatorio: el gateway lo busca en waha.railway.internal:3000)
KEY=$(openssl rand -hex 32); PASS=$(openssl rand -hex 24)
railway add --service waha --image devlikeapro/waha:gows-2026.9.2 \
  --variables "PORT=3000" --variables "WAHA_API_KEY=$KEY" \
  --variables "WHATSAPP_DEFAULT_ENGINE=GOWS" --variables "WHATSAPP_RESTART_ALL_SESSIONS=True" \
  --variables "WAHA_DASHBOARD_ENABLED=False" --variables "WHATSAPP_SWAGGER_ENABLED=False" \
  --variables "WAHA_PRINT_QR=False" \
  --variables "WAHA_DASHBOARD_USERNAME=admin" --variables "WAHA_DASHBOARD_PASSWORD=$PASS" \
  --variables "WHATSAPP_SWAGGER_USERNAME=admin" --variables "WHATSAPP_SWAGGER_PASSWORD=$PASS"
railway service waha && railway volume add --mount-path /app/.sessions

# Servicio 2: superagent (imagen publicada, versión fija)
railway add --service superagent --image ghcr.io/matiasbarrigadev/superagent:<versión> \
  --variables "PORT=8080" --variables 'WAHA_API_KEY=${{waha.WAHA_API_KEY}}' --variables "TZ=<zona>"
railway service superagent && railway volume add --mount-path /data
railway domain --service superagent --port 8080
unset KEY PASS
```

Notas:

- `PORT=3000` en `waha` es obligatoria (Railway inyecta `PORT` y WAHA la usa).
- `'${{waha.WAHA_API_KEY}}'` va con comillas simples: es una referencia de Railway, no una variable del shell.
- No muestres `KEY` ni `PASS` en el chat ni los guardes en archivos.
- Sin CLI: la misma receta por la web está en [railway/TEMPLATE.md](../../../railway/TEMPLATE.md).
- Si la CLI cambió y un flag no existe, mirá `railway <comando> --help` antes de improvisar.

No hay build: Railway baja la imagen (unos 3 GB) y arranca en un par de minutos. Seguilo con
`railway logs --service superagent`. Healthcheck `/salud` y restart policy *Always* se configuran en el servicio
(*Settings*), porque `railway.json` solo aplica cuando se construye desde el repo.

## B. Docker Compose (local o servidor)

Requisitos: Docker con Compose v2, unos 8 GB de disco, 4 GB de RAM. En Windows y Mac, Docker Desktop.

```sh
mkdir superagent && cd superagent
curl -fsSLO https://raw.githubusercontent.com/matiasbarrigadev/superagent/main/docker-compose.yml
echo "SUPERAGENT_VERSION=<versión>" > .env    # además, opcional: TZ, puerto, URL pública, dominio (ver .env.ejemplo)
docker compose up -d
```

No hace falta clonar el repo. Para desarrollar sobre el código:
`docker compose -f docker-compose.yml -f docker-compose.desarrollo.yml up -d --build`.

- El servicio `secretos` corre una vez y genera las claves en un volumen. No hay que escribir ninguna.
- `waha` no publica puertos; solo lo ve el gateway.
- El panel queda en `http://localhost:8080` (solo desde la máquina; `SUPERAGENT_BIND=0.0.0.0` para la red).
- **Con dominio**: `SUPERAGENT_DOMINIO=agente.ejemplo.com` y `SUPERAGENT_PUBLIC_URL=https://agente.ejemplo.com` en
  `.env`, y `docker compose --profile https up -d` (Caddy saca el certificado; puertos 80/443 abiertos).
- **Sin dominio pero con teléfono**: los links que manda el agente (OAuth, pedidos de variables) apuntan a
  `SUPERAGENT_PUBLIC_URL`. Con `localhost` solo abren en esa máquina; ofrecé un túnel (ej. `cloudflared tunnel
  --url http://localhost:8080`) y poné esa URL en `SUPERAGENT_PUBLIC_URL`.

## La URL del panel (lo más importante de entregar)

Apenas el servicio esté arriba, conseguí la URL del panel y dásela a la persona **como primer resultado**, en un link
clickeable. Todo lo que sigue lo hace ella desde ahí.

| Dónde | Cómo obtener la URL |
|---|---|
| Railway (CLI) | `railway domain list --service superagent --json` → el dominio `*.up.railway.app` (o el propio). La URL es `https://<dominio>`. |
| Railway (web) | servicio `superagent` → *Settings → Networking → Public domain*. |
| Docker local | `http://localhost:<SUPERAGENT_PORT>` (8080 por defecto). Con Caddy, `https://<SUPERAGENT_DOMINIO>`. |
| Cualquiera | Los logs del gateway la imprimen al arrancar: `[superagent x.y.z] escuchando en … · panel: <url>`. |

No uses `railway variables` para buscarla: lista valores crudos, incluida `WAHA_API_KEY`.

**Link de setup**: mientras no exista el Propietario, los logs también traen `[setup] Link directo al setup:
<url>/?setup=<código>`. Ese link abre el panel directo en la creación de cuenta. Durante las primeras 2 horas
desde el primer arranque alcanza con la URL sola (no pide código). Pasado ese tiempo hace falta el link con código:
dáselo a la persona por el chat con ella, nunca en archivos ni commits.

- Railway: `railway logs --service superagent | grep -E "panel:|\[setup\]"`
- Docker: `docker compose logs superagent | grep -E "panel:|\[setup\]"`

**Después de instalar, el propio agente sabe su URL**: cuando el Propietario le escribe por WhatsApp "pasame el
panel", el gateway le da el link en su contexto (sale de `SUPERAGENT_PUBLIC_URL` o del dominio de Railway). Por eso
en Docker conviene poner una URL pública en `SUPERAGENT_PUBLIC_URL`: con `localhost` el link solo abre en esa máquina.

## Verificar

1. **Salud**: `curl -fsS <url>/salud` devuelve `{"ok":true,...}`. En Docker: `docker compose ps` con `superagent`
   *healthy*.
2. **Logs**: la línea `panel:` con la URL correcta (si dice `localhost` en Railway, falta el dominio público).
3. **WAHA**: en los logs de `superagent` no tiene que haber errores de conexión a WAHA (401 = las dos
   `WAHA_API_KEY` no coinciden).

## Entregar a la persona

Mandale un mensaje así (con la URL real, no lo dejes para el final de una explicación larga):

> Tu Superagent está listo: **<url>** (o, si ya pasaron 2 horas: <link de setup>)
>
> 1. Creá tu cuenta: nombre, email, contraseña y app de códigos. **Guardá los 10 códigos de recuperación.**
> 2. **Inicio → Conectar Claude**: seguí el link, autorizá con tu cuenta de Claude (Pro o Max) y pegá el código.
> 3. **Inicio → Tu número de WhatsApp**: tu WhatsApp personal. El panel te muestra un código.
> 4. **Inicio → Vincular WhatsApp**: desde el teléfono del agente, WhatsApp → Dispositivos vinculados → escaneá el QR.
>    El agente te escribe al instante: respóndele con el código y se configura contigo por WhatsApp.
>
> Después, si necesitás el panel, pedíselo al agente por WhatsApp: "pasame el panel".

Estos pasos los hace la persona: no los hagas vos ni le pidas contraseñas, códigos ni tokens.

## Actualizar

Con la imagen, la instalación no cambia sola: se actualiza cuando la persona lo decide. Antes, mirá las notas de la
versión nueva en Releases.

- **Railway**: en el servicio `superagent`, cambiar el tag de la imagen a la versión nueva (*Settings → Source*, o
  `railway service superagent` y editar la imagen) y redeployar. Los volúmenes se conservan. Para volver atrás, el
  tag anterior.
- **Docker**: cambiar `SUPERAGENT_VERSION` en `.env` y `docker compose pull && docker compose up -d`. Nunca
  `down -v` (borra WhatsApp, base y tokens).
- **Instalaciones viejas desde el repo**: pasar el servicio a la imagen (en Railway, cambiar *Source* a la imagen; en
  Docker, bajar el `docker-compose.yml` nuevo). Los volúmenes son los mismos, no se pierde nada.
- Las migraciones de la base corren solas al arrancar.

## Problemas comunes

| Síntoma | Causa probable |
|---|---|
| El build de Railway falla en `whisper` o `npm ci` | Falta de memoria en el build; reintentar o subir el plan |
| Healthcheck falla en Railway | El volumen no está en `/data`, o `PORT` no es 8080 |
| El panel dice que WhatsApp no conecta | `waha` no se llama `waha`, le falta `PORT=3000`, o las `WAHA_API_KEY` difieren |
| Los mensajes no llegan al agente | WAHA no alcanza al gateway por la red interna: mirá los logs de `waha` (reintentos de webhook) y, fuera de Railway/compose, fijá `SUPERAGENT_INTERNAL_URL` |
| El QR expira | Normal: se regenera; escanearlo dentro del minuto |
| Los links del agente no abren en el teléfono | `SUPERAGENT_PUBLIC_URL` apunta a `localhost` |

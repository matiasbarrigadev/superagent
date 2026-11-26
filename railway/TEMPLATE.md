# Superagent en Railway

La instalación es un template de Railway: un botón **Deploy** crea los dos servicios (`waha` y `superagent`), sus
volúmenes, el dominio y los secretos. Nadie escribe variables. Después se abre un link y se sigue en el panel.

- **Armar el template**: una sola vez, en la cuenta de Railway del dueño (más abajo).
- **Instalar**: Deploy → abrir el dominio → crear el Propietario → conectar Claude → escanear el QR.

## Instalar con el template

1. Abrir el template y tocar **Deploy**. Railway baja la imagen (unos 3 GB): tarda un par de minutos.
2. Cuando `superagent` esté en verde, abrir su dominio público. Durante las primeras 2 horas desde el primer
   arranque el panel no pide código: se crea el Propietario directamente. Pasado ese tiempo pide el código de setup;
   el link con el código está en **superagent → Variables → `SUPERAGENT_SETUP_LINK`**. La ventana se cambia con
   `SUPERAGENT_SETUP_SIN_CODIGO_MIN` (0 = pedir siempre el código).
3. En el panel: nombre, email, contraseña y app de códigos (TOTP). Guardar los 10 códigos de recuperación.
4. **Inicio → Claude → Conectar Claude**: se abre `claude setup-token`; autorizar con la cuenta de Claude y pegar el
   código. Queda guardado cifrado.
5. **Inicio → WhatsApp**: escanear el QR con el teléfono del número del agente, o pedir el código de vinculación.
6. **Inicio → Verificar tu número**: tu WhatsApp personal. Al verificarlo, el agente te escribe por WhatsApp para
   configurarse con vos.

Un agente puede hacer todo esto con la CLI de Railway: ver la skill
[`.claude/skills/instalar-superagent`](../.claude/skills/instalar-superagent/SKILL.md).

## Armar el template (una vez)

En Railway: **Templates → New Template**. Agregar dos servicios con estos valores.

### Servicio 1: `waha`

- **Nombre**: `waha` (exacto: el gateway lo busca como `waha.railway.internal`).
- **Source**: Docker image `devlikeapro/waha:gows-2026.9.2`.
- **Volumen**: `/app/.sessions` (ahí queda la sesión de WhatsApp: sin volumen, cada reinicio pide QR nuevo).
- **Restart policy**: Always.
- **Public networking**: ninguno.
- **Variables**:

```
PORT=3000
WAHA_API_KEY=${{secret(64)}}
WHATSAPP_DEFAULT_ENGINE=GOWS
WHATSAPP_RESTART_ALL_SESSIONS=True
WAHA_DASHBOARD_ENABLED=False
WHATSAPP_SWAGGER_ENABLED=False
WAHA_PRINT_QR=False
WAHA_DASHBOARD_USERNAME=admin
WHATSAPP_SWAGGER_USERNAME=admin
WAHA_DASHBOARD_PASSWORD=${{secret(48)}}
WHATSAPP_SWAGGER_PASSWORD=${{secret(48)}}
```

`PORT=3000` es obligatoria: Railway le inyecta `PORT` a cada servicio y WAHA la usa antes que su puerto propio.

### Servicio 2: `superagent`

- **Nombre**: `superagent`.
- **Source**: Docker image `ghcr.io/matiasbarrigadev/superagent:0.3.0` (una versión fija; `latest` también sirve,
  pero cambia sola cuando sale una nueva). Para un fork con cambios propios, el repo (usa `Dockerfile` y
  `railway.json`).
- **Healthcheck**: `/salud`. **Restart policy**: Always.
- **Volumen**: `/data`.
- **Public networking**: HTTP, puerto `8080`.
- **Variables**:

```
PORT=8080
WAHA_API_KEY=${{waha.WAHA_API_KEY}}
SUPERAGENT_SETUP_CODE=${{secret(12, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789")}}
SUPERAGENT_SETUP_LINK=https://${{RAILWAY_PUBLIC_DOMAIN}}/?setup=${{SUPERAGENT_SETUP_CODE}}
TZ=UTC
```

Guardar el template. Railway da un link de deploy (`railway.com/new/template/...`) para reusarlo.

La imagen es pública: el template funciona en cualquier cuenta de Railway, sin acceso a GitHub. Para actualizar
una instalación, se cambia el tag de la imagen del servicio `superagent` y se redeploya; los volúmenes quedan.

### Lo que el gateway resuelve solo

| Qué | Cómo |
|---|---|
| URL pública (links de aprobación y OAuth) | `RAILWAY_PUBLIC_DOMAIN`, que Railway inyecta |
| URL interna para los eventos de WhatsApp | `RAILWAY_PRIVATE_DOMAIN` + puerto |
| Dirección de WAHA | `http://waha.railway.internal:3000` |
| Secreto de sesión y clave HMAC | se generan en el primer arranque y quedan en `/data/.secretos.env` |
| Token de Claude, GitHub y conectores | se conectan desde el panel y quedan cifrados en `/data` |

Cualquiera de estas se puede pisar con su variable (`SUPERAGENT_PUBLIC_URL`, `SUPERAGENT_INTERNAL_URL`, `WAHA_URL`,
`SUPERAGENT_SESSION_SECRET`, `WHATSAPP_HOOK_HMAC_KEY`).

## Recursos

| | `superagent` | `waha` |
|---|---|---|
| RAM | 2 GB mínimo; 4 GB con trabajos de código y navegador a la vez | 512 MB |
| CPU | 2 vCPU (audios y Chromium) | 1 vCPU |
| Volumen | 5 GB para empezar | 1 GB |

## Opcionales (variables de `superagent`)

| Variable | Para qué |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | Conectar GitHub por WhatsApp. Sin ella, se pega un token limitado en el panel |
| `SUPERAGENT_GRABAR_WEBHOOKS=1` | Guarda los webhooks crudos en `/data/grabaciones`; apagarla después |
| `SUPERAGENT_RESET_OWNER=1` | Último recurso si el Propietario perdió todo: vuelve a modo setup y conserva lo demás. Una vez por valor (`2`, `3`…). Quitarla al terminar |

**No borrar el volumen `/data`**: ahí está el secreto que cifra el token de Claude, los TOTP y las credenciales.

## A verificar en el primer despliegue

- En Inicio, WhatsApp muestra el QR (el gateway llega a `waha` por la red privada).
- Escribirle al número del agente y recibir respuesta (estado "Conectado").
- Un redeploy de cualquiera de los dos no pide el QR de nuevo ni pierde la cuenta de Claude.
- Opcional, en la shell de `superagent`: `node scripts/verificar-aislamiento.mjs`, `verificar-medios.mjs`,
  `verificar-navegador.mjs`, `verificar-codigo.mjs` y `verificar-publicacion.mjs`. Cada una termina en "OK".

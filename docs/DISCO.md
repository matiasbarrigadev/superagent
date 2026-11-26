# Disco

Todo lo que tiene que sobrevivir a un reinicio vive en el volumen de datos (`/data`):

- la base;
- las charlas y los trabajos, cada uno en su carpeta aislada;
- tu entorno de Propietario;
- los adjuntos de WhatsApp y los archivos que mandó el agente;
- las copias de los repos.

El volumen tiene un tamaño máximo. En Railway se amplía en *Volume → Settings → Volume Size* y se cobra solo lo
usado; no se puede achicar. Superagent lo cuida en tres niveles.

## 1. Limpieza automática (cada hora)

Borra solo lo que ya cumplió su función:

| Qué | Cuándo |
|---|---|
| Carpeta de un trabajo terminado o fallido (clon del repo, dependencias, builds) | Un día después de terminar. Lo que dejó para mandar ya es un archivo F-n; su trabajo ya está en la rama |
| Adjuntos de WhatsApp | A los 90 días. Queda su texto extraído (transcripción, OCR), y la bandeja y el agente lo siguen viendo |
| Archivos que mandó el agente | A los 90 días |
| Temporales de cada charla | Con más de un día |
| Grabaciones de webhooks de prueba | Con más de una semana |

Nunca toca:

- la base;
- los secretos;
- las charlas en curso;
- las sesiones de proyecto;
- tu entorno de Propietario;
- la sesión de WhatsApp.

Los 90 días y la limpieza automática se cambian conversando ("guardá los adjuntos 30 días"), con confirmación en
otro mensaje, o en el panel.

## 2. Aviso al 80 %

Cuando el volumen pasa el umbral (80 % por defecto, se puede cambiar entre 50 y 99), una vez por día:

- te llega un aviso con lo que más ocupa;
- el agente se despierta con `[disco al N%]`, mira el detalle y te propone qué liberar o ampliar el volumen.

## 3. El agente lo cuida

- **Contexto:** vos, los trabajos y las sesiones ven en cada corrida cuánto se usa y qué ocupa más.
- **Herramienta `disco`** (solo con vos), con cuatro acciones:
  - `ver`: el uso y el desglose por charla, trabajo, tu entorno, adjuntos, repos y base;
  - `simular`: qué borraría la limpieza, sin tocar nada;
  - `limpiar`: correr la limpieza ahora;
  - `configurar`: cambiar la limpieza, con confirmación en otro mensaje.
- **Sus instrucciones:** borrar dependencias y builds que no va a volver a usar (`node_modules`, `.next`, `dist`,
  cachés), no clonar dos veces, mirar el espacio antes de algo pesado. Lo que se regenera solo lo borra sin
  preguntar; lo demás (repos con trabajo sin subir, tus apps, tus archivos), solo con tu ok.

## En el panel

**Inicio → Disco** muestra:

- la barra de uso;
- lo que más ocupa;
- la limpieza automática, que se puede prender y apagar;
- los días de los adjuntos;
- **Ver qué borraría** y **Limpiar ahora**.

## Fuera de Railway

En Docker, `/data` suele estar en el disco del servidor: el porcentaje es el de ese disco. Para medir contra un
límite propio, se puede fijar `SUPERAGENT_DISCO_LIMITE_GB`.

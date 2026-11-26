# syntax=docker/dockerfile:1
# Imagen de Superagent: gateway + panel + Claude Code + herramientas del agente. WAHA va en su propio servicio.

# --- Panel (SPA)
FROM node:24-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# --- Dependencias del gateway (node-pty compila con python/make/g++ de la imagen completa)
FROM node:24-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- whisper.cpp (transcripción local de audios), compilado y con su modelo
FROM debian:bookworm AS whisper
ARG WHISPER_VERSION=v1.9.5
ARG WHISPER_MODELO=base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates cmake make g++ curl && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${WHISPER_VERSION}" https://github.com/ggml-org/whisper.cpp /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
 && cmake --build /src/build -j"$(nproc)" --target whisper-cli \
 && mkdir -p /opt/whisper/modelos /opt/whisper/muestras \
 && cp /src/build/bin/whisper-cli /opt/whisper/ \
 && cp /src/samples/jfk.wav /opt/whisper/muestras/ \
 && sh /src/models/download-ggml-model.sh "${WHISPER_MODELO}" /opt/whisper/modelos

# --- Imagen final
FROM node:24-bookworm-slim
ARG CLAUDE_CODE_VERSION=2.1.331
ARG PLAYWRIGHT_MCP_VERSION=0.0.84
# CLIs de la publicación (etapa 8c); gh viene de apt.
ARG WRANGLER_VERSION=4.158.0
ARG VERCEL_VERSION=65.12.1
ARG SUPABASE_VERSION=2.122.1

# Herramientas del agente:
# - base: git, gh, ssh;  - medios: ffmpeg, poppler (PDF), tesseract (OCR);
# - documentos: python con python-docx, openpyxl y python-pptx;  - navegador: Chromium (sin interfaz).
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini git ca-certificates curl openssh-client gh procps passwd \
      ffmpeg poppler-utils tesseract-ocr tesseract-ocr-spa tesseract-ocr-eng \
      python3 python3-pip python3-docx python3-openpyxl python3-pil python3-lxml \
      chromium fonts-dejavu-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir --break-system-packages python-pptx==1.0.2

COPY --from=whisper /opt/whisper /opt/whisper

RUN npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
      "wrangler@${WRANGLER_VERSION}" "vercel@${VERCEL_VERSION}" "supabase@${SUPABASE_VERSION}" \
 && npm cache clean --force

# "agente" solo corre el login de Claude. Cada conversación corre con su propio usuario, creado al vuelo.
RUN useradd --create-home --uid 1001 --shell /bin/bash agente \
 && mkdir -p /data && chmod 0711 /data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=web /app/web/dist ./web/dist
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY agente ./agente
COPY docs ./docs

ENV NODE_ENV=production \
    SUPERAGENT_DATA_DIR=/data \
    SUPERAGENT_WEB_DIST=/app/web/dist \
    WHISPER_BIN=/opt/whisper/whisper-cli \
    WHISPER_MODELO=/opt/whisper/modelos/ggml-base.bin \
    CHROMIUM_BIN=/usr/bin/chromium \
    PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# El gateway corre como root dentro del contenedor solo para poder lanzar cada corrida con su propio usuario.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--no-warnings", "src/server.mjs"]

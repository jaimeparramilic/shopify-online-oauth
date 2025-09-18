# syntax=docker/dockerfile:1

################################################################################
# Dockerfile Multi-etapa Optimizado para Producción con Bootloader
################################################################################

# --- Etapa de Builder ---
# Aquí instalamos dependencias y preparamos la aplicación.
FROM node:20-slim AS builder
ENV NODE_ENV=production
WORKDIR /app

# Copia los archivos de definición de paquetes
COPY package*.json ./

# Instala SOLO las dependencias de producción usando el lockfile.
# Es más rápido, seguro y reproducible que 'npm install'.
RUN npm ci

# Copia el resto del código fuente de la aplicación
COPY . .


# --- Etapa de Runtime ---
# Esta es la imagen final, optimizada para ser ligera y segura.
FROM node:20-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080

WORKDIR /app

# Instala curl para usarlo en el HEALTHCHECK. Es más estándar.
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Copia la aplicación con las dependencias desde la etapa 'builder'
COPY --from=builder /app /app

# Crea un usuario no-root para correr la aplicación por seguridad
RUN useradd --system --uid 1001 --gid 0 nodeuser
USER nodeuser

EXPOSE 8080

# HEALTHCHECK mejorado usando curl. Verifica que la ruta /healthz responde con 200 OK.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -f http://127.0.0.1:${PORT}/healthz || exit 1

# Comando para arrancar la aplicación.
# Usamos el bootloader inteligente que se encarga de iniciar el servidor real.
CMD ["node", "src/boot.js"]

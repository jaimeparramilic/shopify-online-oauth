# syntax=docker/dockerfile:1
# -------------------------------------------------------
# Etapa base
# -------------------------------------------------------
FROM node:20-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# -------------------------------------------------------
# Etapa deps (instala dependencias)
# -------------------------------------------------------
FROM base AS deps
# Solo los manifests para cachear npm ci
COPY package*.json ./
# Si usas npm: (si usas pnpm/yarn, cambia aquí)
RUN npm install --legacy-peer-deps --no-audit --no-fund

# -------------------------------------------------------
# Etapa build (opcional: TS/build)
# - Si NO tienes build, esto sigue sin romper
# -------------------------------------------------------
FROM deps AS build
COPY . .
# Si existe un script build (TS/webpack), se ejecuta; si no, continúa
RUN npm run build || echo "No build step, continuing"
# Prune para runtime (quita devDependencies)
RUN npm prune --omit=dev

# -------------------------------------------------------
# Etapa final (runtime)
# -------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app

# Copiamos todo lo ya resuelto (código + node_modules pruned)
COPY --from=build /app /app

# Security: corre como usuario no-root
RUN useradd -m nodeuser && chown -R nodeuser:nodeuser /app
USER nodeuser

# Expone puerto
EXPOSE 8080

# Healthcheck simple (útil para depurar arranque)
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:'+process.env.PORT+'/healthz', r=>{if(r.statusCode!==200)process.exit(1)}).on('error',()=>process.exit(1))"

# Importante: arrancamos el boot (NO el server directo)
# El boot abre el puerto y luego importa tu server.
CMD ["node","src/boot.js"]

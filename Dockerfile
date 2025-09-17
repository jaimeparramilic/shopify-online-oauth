# Etapa de build: compila módulos nativos (better-sqlite3)
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++ \
 && npm ci

# Etapa final (runtime) mínima
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY . .
COPY --from=build /app/node_modules ./node_modules
EXPOSE 8080
CMD ["node","src/server.js"]



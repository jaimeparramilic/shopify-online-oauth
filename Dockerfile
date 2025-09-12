# Imagen base Node 20
FROM node:20-alpine

# 1) Directorio de trabajo dentro del contenedor
WORKDIR /app

# 2) Instala deps con caché eficiente
COPY package*.json ./
RUN npm ci --omit=dev

# 3) Copia el resto del código
COPY . .

# 4) Variables/puerto
ENV NODE_ENV=production
EXPOSE 8080

# 5) Arranque (ruta relativa al WORKDIR)
CMD ["node", "src/server.js"]


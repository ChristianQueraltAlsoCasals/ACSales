# Etapa 1: compilar el cliente (React + Vite)
FROM node:22-alpine AS web
WORKDIR /web
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
RUN npm run build

# Etapa 2: servidor Node que sirve la API y la web compilada
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev
COPY server/server.cjs server/db.js server/schema.sql \
     server/auth.js server/erp-auth.js server/erp-db.js server/constellation.js \
     server/achuman-client.js ./
COPY --from=web /web/dist ./public
ENV PORT=8102
EXPOSE 8102
CMD ["node", "server.cjs"]

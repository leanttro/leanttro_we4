FROM node:20-slim

WORKDIR /app

# Dependências de sistema que o Baileys costuma precisar
# (build de libs nativas + libs gráficas pro QR code no terminal)
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

# Instala dependências primeiro (cache de camada)
COPY package.json .
COPY package-lock.json* .
RUN npm install --omit=dev

# Copia o código
COPY index.js .

# Pasta onde o Baileys guarda a sessão autenticada
# (também é montada como volume no docker-compose, isso aqui é fallback)
RUN mkdir -p /app/auth_info_estoque

EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
    CMD node -e "require('http').get('http://localhost:3000/status', r => process.exit(r.statusCode < 500 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]

FROM node:24-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js ./
COPY src ./src

# La base de datos y las copias viven fuera de la imagen, en un volumen.
ENV DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data

USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "index.js"]

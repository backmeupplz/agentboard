FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js API.md ./
COPY public public
COPY bin bin
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]

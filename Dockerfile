FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0 DB_PATH=/app/data/competitor-pulse.db
CMD ["node", "server/start.js", "index"]

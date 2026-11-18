FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && groupadd --gid 10001 panel && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin panel
COPY --chown=10001:10001 src ./src
COPY --chown=10001:10001 public ./public
RUN mkdir -p /app/data/media && chown -R 10001:10001 /app/data
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/server.js"]

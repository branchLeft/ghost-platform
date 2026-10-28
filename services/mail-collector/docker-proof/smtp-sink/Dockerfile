# syntax=docker/dockerfile:1
# Proof-only image: a real authenticated SMTP listener standing in for mx1.
# Both dependencies are public npm packages -- no GitHub Packages secret
# needed here, unlike the collector's and the shim's own Dockerfiles.
FROM node:26.5.0-bookworm-slim
# Node 26 ships without corepack, so pnpm is installed here.
RUN npm install --global pnpm@11.17.0
WORKDIR /app
COPY package.json ./
RUN pnpm install --prod
COPY sink.mjs deliveries.mjs ./
USER node
EXPOSE 2525
CMD ["node", "sink.mjs"]

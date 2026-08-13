# node:sqlite (the durable queue/store backing this service) is a built-in
# module, not a native npm dependency needing node-gyp — so there is no
# musl-compatibility reason to prefer -alpine here. bookworm-slim is chosen
# instead because it tracks Debian's glibc and Node's own release-testing
# matrix, which matters more at this service's scale than the size delta.
FROM node:26.5.0-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Dev dependencies (typescript, vitest, etc.) are only needed for the build
# step above — pruning them keeps @types/*, tsc and the test toolchain out
# of the image that actually ships.
RUN npm prune --omit=dev

USER node
EXPOSE 8080
CMD ["node", "dist/server.js"]

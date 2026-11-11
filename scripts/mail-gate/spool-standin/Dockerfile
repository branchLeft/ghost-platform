# Local stand-in for the mail spool, used only where the pinned mailgun-shim
# image cannot be pulled. See server.js. CI runs the pinned digest instead.
FROM node:26.5.0-bookworm-slim
WORKDIR /app
COPY server.js ./server.js
COPY cli.js ./dist/cli.js
USER 31000:31000
CMD ["node", "server.js"]

FROM node:22-bookworm-slim@sha256:be979e5523c76fa4d5ca4ebd3099078f220aa47ec39c48ad5b5df9314debd6eb
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/push-relay-worker/self-hosted
COPY push-relay-worker/self-hosted/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && case "$(node -p process.arch)" in x64) arch=64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac \
 && ln -s "$PWD/node_modules/@cloudflare/workerd-linux-$arch/bin/workerd" /usr/local/bin/airsim-workerd \
 && airsim-workerd --version \
 && npm cache clean --force
WORKDIR /app
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
COPY push-relay-worker/ ./push-relay-worker/
COPY setup/ ./setup/
# Local source trees can have restrictive parent-directory modes.
RUN find /app -name node_modules -prune -o -type d -exec chmod 0755 {} + \
 && find /app -name node_modules -prune -o -type f -exec chmod 0644 {} + \
 && test "$(openssl x509 -in setup/trust/apple-roots.pem -outform DER | sha256sum | cut -d' ' -f1)" = b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024 \
 && test "$(openssl x509 -in setup/trust/apple-intermediates.pem -outform DER | sha256sum | cut -d' ' -f1)" = ea4757885538dd8cb59ff4556f676087d83c85e70902c122e42c0808b5bce14c \
 && openssl verify -CAfile setup/trust/apple-roots.pem setup/trust/apple-intermediates.pem \
 && install -d -m 0700 -o node -g node /data
ENV NODE_ENV=production \
    AIRSIM_DATA_DIR=/data \
    AIRSIM_WORKER_DIR=/app/push-relay-worker \
    AIRSIM_WORKERD_PATH=/usr/local/bin/airsim-workerd \
    AIRSIM_SETUP_HOST=0.0.0.0 \
    AIRSIM_SETUP_PORT=18181
USER node
EXPOSE 18181 18788
CMD ["node", "/app/setup/server.mjs"]

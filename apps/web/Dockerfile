FROM node:22-alpine AS build

ARG NEXT_PUBLIC_CEBOLA_API_URL=http://localhost:3001
ENV NEXT_PUBLIC_CEBOLA_API_URL=$NEXT_PUBLIC_CEBOLA_API_URL

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN npm ci

# O web agora importa @cebola/contracts/codecs (os padrões de codec, num módulo sem
# dependências). Só o package.json do contracts era copiado, o que basta para o npm ci montar o
# workspace mas não para existir dist/ — e o next build não achava o módulo. O Dockerfile do API
# já fazia estes dois passos; aqui faltavam.
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
RUN npm run build --workspace=@cebola/contracts \
    && npm run build --workspace=@cebola/web

FROM caddy:2.10-alpine

COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/out /srv
RUN cp /usr/bin/caddy /usr/bin/caddy-unprivileged

USER 65532:65532
EXPOSE 3000
CMD ["caddy-unprivileged", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

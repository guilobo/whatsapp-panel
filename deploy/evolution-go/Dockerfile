FROM golang:1.26.10-alpine AS build

RUN apk add --no-cache git build-base libjpeg-turbo-dev libwebp-dev
WORKDIR /build

ARG EVOLUTION_GO_REV=80d7c72c0727e091425d10f5654b7ccf07e01abe
ARG VERSION=0.7.3-reply1
COPY evolution-go.patch /tmp/evolution-go.patch
RUN git init . \
    && git remote add origin https://github.com/evolution-foundation/evolution-go.git \
    && git fetch --depth 1 origin "${EVOLUTION_GO_REV}" \
    && git checkout --detach FETCH_HEAD \
    && git apply --check /tmp/evolution-go.patch \
    && git apply /tmp/evolution-go.patch \
    && go mod download \
    && CGO_ENABLED=1 go build -ldflags "-X main.version=${VERSION}" -o server ./cmd/evolution-go

FROM alpine:3.19.1 AS final
RUN apk add --no-cache tzdata ffmpeg libjpeg-turbo libwebp poppler-utils
WORKDIR /app
COPY --from=build /build/server .
COPY --from=build /build/manager/dist ./manager/dist
COPY --from=build /build/VERSION ./VERSION
ENV TZ=America/Sao_Paulo
ENTRYPOINT ["/app/server"]

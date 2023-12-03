FROM alpine:3.18.5
WORKDIR /

COPY . .

# hadolint ignore=DL3018
RUN apk add --no-cache bash nodejs npm openjdk11 && \
    npm i -g

ENTRYPOINT ["npm-groovy-lint"]

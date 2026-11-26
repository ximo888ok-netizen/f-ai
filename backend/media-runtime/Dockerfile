FROM oven/bun:1.4.3-debian AS fal
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN git init /src && git -C /src fetch --depth=1 https://github.com/fal-ai-community/genmedia-cli.git 66f7bf73b973038ecd2975a9fbefa1a3b1752dde && git -C /src checkout --detach FETCH_HEAD
WORKDIR /src
RUN bun install --frozen-lockfile && bun run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir 'requests>=2.32,<3' 'pillow>=10,<13' 'numpy<3' python-dotenv 'mcp>=1.16,<2' jsonschema websockets oss2 alibabacloud-aidge20260428==6.0.1
ENV PATH="/opt/venv/bin:${PATH}"
ARG KLING_PACKAGE=@klingai/cli-cn@0.2.4
RUN npm install -g @iqinghu/qhkit@0.16.1 @dlazy/cli@1.2.3 "$KLING_PACKAGE" vidu-cli@0.2.42 pixverse@1.4.24 mmx-cli@1.0.29 @volcengine/ark-cli@1.0.65 && npm cache clean --force
COPY --from=fal /src/dist/genmedia /usr/local/bin/genmedia
USER 65532:65532
WORKDIR /tmp

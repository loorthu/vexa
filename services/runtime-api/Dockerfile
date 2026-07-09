FROM python:3.12-slim

WORKDIR /app

# Optional internal PyPI mirror for corporate / air-gapped builds where the
# build host cannot reach public PyPI. Defaults to public PyPI so normal builds
# are unchanged. Pass with:
#   docker build --build-arg PIP_INDEX_URL=https://<mirror>/simple \
#                --build-arg PIP_TRUSTED_HOST=<mirror-host>
ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_TRUSTED_HOST=

# Copy source and install
COPY pyproject.toml README.md ./
COPY runtime_api/ runtime_api/
COPY profiles.example.yaml profiles.yaml
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" \
        ${PIP_TRUSTED_HOST:+--trusted-host $PIP_TRUSTED_HOST} \
        ".[kubernetes]" \
    && groupadd -r runtime && useradd -r -g runtime runtime \
    && chown -R runtime:runtime /app

USER runtime

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:8090/health').raise_for_status()" || exit 1

CMD ["uvicorn", "runtime_api.main:app", "--host", "0.0.0.0", "--port", "8090"]

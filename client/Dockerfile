# OffBalance provider client. It asks for your API key and session key (both from the UI's
# Provider Setup page), so run it interactively:
#   docker build -t offbalance-client client
#   docker run --rm -it \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -v "$HOME/.offbalance:$HOME/.offbalance" -e HOME="$HOME" \
#     -v offbalance-tls:/certs:ro \
#     offbalance-client
# (docker compose does all of this: see HOW_TO_RUN_WITH_DOCKER.md)
#
# Jobs run as sibling containers on the host's Docker daemon (via the socket).
# The daemon resolves bind mounts on the host, so the job output dir
# ($HOME/.offbalance/jobs) must be mounted at the same path inside and outside.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app/client
COPY requirements.txt ./
RUN pip install -r requirements.txt

COPY . .

# main.py reads ../dev.env and ../blockchain/deployments/localhost.json
ENV OFFBALANCE_SERVER_URL=https://server:5000 \
    RPC_URL=http://blockchain:8545 \
    REQUESTS_CA_BUNDLE=/certs/cert.pem

ENTRYPOINT ["python", "-u", "main.py"]

# OffBalance provider client.
#
#   docker build -t offbalance-client client/
#   docker run -it --rm --network host \
#     -v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)" \
#     --user "$(id -u):$(id -g)" \
#     -v "$HOME/.offbalance:$HOME/.offbalance" -e OFFBALANCE_JOBS_DIR="$HOME/.offbalance/jobs" \
#     -e OFFBALANCE_SERVER_URL=https://localhost:5000 -e RPC_URL=http://127.0.0.1:8545 \
#     offbalance-client
#
# -it: the client prompts for the API key and session key.
# docker.sock: jobs run as sibling containers on the host's Docker daemon.
# Same jobs path inside and out: the daemon bind-mounts job output by host path.
# --user: job output files belong to you, not root.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

ENTRYPOINT ["python", "main.py"]

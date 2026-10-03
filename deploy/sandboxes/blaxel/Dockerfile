FROM ubuntu:24.04
USER root
ARG BOXHAVEN_RUNTIME_REF=fde03179f46ed5067ce1463ce90b6af459886881
SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends curl ca-certificates openssh-server libnspr4 libnss3 libxkbcommon0 libcups2t64 libpango-1.0-0 libcairo2 \
    && curl -fsSL "https://raw.githubusercontent.com/finbarr/boxhaven/${BOXHAVEN_RUNTIME_REF}/cmd/bh/assets/remote-vm-install.sh" -o /tmp/boxhaven-install.sh \
    && bash /tmp/boxhaven-install.sh \
    && rm /tmp/boxhaven-install.sh \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/* /root/.npm /root/.cache \
    && rm -f /etc/ssh/ssh_host_* /etc/boxhaven/ssh_host_* /root/.ssh/authorized_keys /home/boxhaven/.ssh/authorized_keys \
    && install -d -m 0755 /etc/boxhaven \
    && install -m 0600 /dev/null /etc/boxhaven/agent.env \
    && truncate -s 0 /etc/machine-id
COPY --from=ghcr.io/blaxel-ai/sandbox@sha256:2972f6342e3c27330307f752be8d5f2052a39950c709814dc7e657483031e118 /sandbox-api /usr/local/bin/sandbox-api
ENV SANDBOX_DISABLE_PROCESS_LOGGING=true
ENTRYPOINT ["/usr/local/bin/sandbox-api"]
CMD []
EXPOSE 8080 8081 9898

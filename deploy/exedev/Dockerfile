# Build from a committed checkout with an explicit, digest-pinned exeuntu base.
ARG EXEUNTU_IMAGE
FROM ${EXEUNTU_IMAGE}
USER root
SHELL ["/bin/bash", "-euxo", "pipefail", "-c"]
COPY cmd/bh/assets/remote-vm-install.sh /tmp/boxhaven-install.sh
RUN rm -f /opt/boxhaven/remote/ready \
    && bash /tmp/boxhaven-install.sh \
    && rm /tmp/boxhaven-install.sh

# exeuntu ships native agent binaries in /usr/local/bin. Prefer the versions
# installed by BoxHaven when npm's global prefix is elsewhere (for example /usr).
RUN npm_bin="$(NPM_CONFIG_PREFIX='' npm prefix -g)/bin" \
    && for tool in codex gemini opencode copilot pi; do \
      test -x "$npm_bin/$tool"; \
      if [ "$npm_bin" != /usr/local/bin ]; then ln -sf "$npm_bin/$tool" "/usr/local/bin/$tool"; fi; \
    done

# exe.dev owns gateway SSH. The direct WebSocket transport uses this separate
# loopback listener, with only BoxHaven certificates authorized.
RUN printf '%s\n' \
    'Port 2222' 'ListenAddress 127.0.0.1' \
    'HostKey /etc/boxhaven/ssh_host_ed25519_key' \
    'PidFile /run/boxhaven-sshd.pid' \
    'TrustedUserCAKeys /etc/ssh/boxhaven_user_ca_keys' \
    'AuthorizedPrincipalsFile /etc/ssh/auth_principals/%u' \
    'AuthorizedKeysFile none' 'AuthenticationMethods publickey' \
    'PasswordAuthentication no' 'KbdInteractiveAuthentication no' \
    'PermitRootLogin no' 'UsePAM yes' 'AllowUsers boxhaven' \
    > /etc/boxhaven/sshd_config \
    && printf '%s\n' '[Unit]' 'Description=BoxHaven certificate SSH' \
    'After=network.target' 'ConditionPathExists=/etc/boxhaven/ssh_host_ed25519_key' \
    '[Service]' 'Type=simple' \
    'ExecStart=/usr/sbin/sshd -D -e -f /etc/boxhaven/sshd_config' \
    'Restart=always' 'RestartSec=1' '[Install]' 'WantedBy=multi-user.target' \
    > /etc/systemd/system/boxhaven-sshd.service \
    && systemctl enable boxhaven-sshd

# Identity and credentials are generated during first boot, never baked in.
RUN rm -f /etc/ssh/ssh_host_* /etc/boxhaven/ssh_host_* \
    /root/.ssh/authorized_keys /home/boxhaven/.ssh/authorized_keys \
    /home/exedev/.ssh/authorized_keys /root/.bash_history /home/boxhaven/.bash_history \
    && install -m 0600 /dev/null /etc/boxhaven/agent.env \
    && truncate -s 0 /etc/machine-id \
    && rm -f /var/lib/dbus/machine-id \
    && ln -s /etc/machine-id /var/lib/dbus/machine-id

LABEL exe.dev/login-user="exedev" exe.dev/install-shelley="false"
EXPOSE 80 9898

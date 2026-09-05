Name:           ness-web
Version:        1.0.0
Release:        1%{?dist}
Summary:        Node.js server to control Ness D8x/D16x alarm panel via IP232

License:        MIT
URL:            https://github.com/msekara/ness-web
# Create a source tarball with:
#   tar --transform 's,^,ness-web-1.0.0/,' \
#       -czf ~/rpmbuild/SOURCES/ness-web-1.0.0.tar.gz \
#       src/ dashboard.html package.json package-lock.json README.md .env.example
Source0:        %{name}-%{version}.tar.gz

# Systemd unit macros
BuildRequires:  systemd-rpm-macros
# node + npm must be present at build time (for npm ci)
BuildRequires:  nodejs >= 18
BuildRequires:  npm

Requires:       nodejs >= 18
Requires(pre):  shadow-utils
%{?systemd_requires}

# No compiled code — mark as noarch
BuildArch:      noarch

%description
A Node.js REST + WebSocket server that controls a Ness D8x/D16x alarm panel
via the Ness IP232 serial-over-ethernet module.

Features:
  - Arm away / home / night / disarm
  - Real-time zone status monitoring
  - AUX output control
  - WebSocket push for live events
  - Browser-based dashboard at http://<host>:5555/

Configuration is done via /etc/ness-web/config.js or environment
variables in /etc/sysconfig/ness-web.

# ── Prep ─────────────────────────────────────────────────────────────────────
%prep
%autosetup

# ── Build ─────────────────────────────────────────────────────────────────────
%build
# Install Node dependencies into the source tree (no devDependencies)
npm ci --omit=dev

# ── Install ───────────────────────────────────────────────────────────────────
%install
# Application files → /usr/share/ness-web/
install -d %{buildroot}%{_datadir}/%{name}
cp -a src/ dashboard.html package.json node_modules/ \
    %{buildroot}%{_datadir}/%{name}/

# Default configuration → /etc/ness-web/
install -d %{buildroot}%{_sysconfdir}/%{name}
install -m 0640 src/config.js \
    %{buildroot}%{_sysconfdir}/%{name}/config.js

# sysconfig environment file (for overrides via env vars)
install -d %{buildroot}%{_sysconfdir}/sysconfig
cat > %{buildroot}%{_sysconfdir}/sysconfig/%{name} << 'EOF'
# Environment overrides for ness-web.
# These are passed directly to the Node.js process.
# Uncomment and set values as needed.

# IP232 module address
#NESS_HOST=192.168.1.100
#NESS_PORT=4196

# Panel layout
#NESS_ZONE_COUNT=16
#NESS_OUTPUT_COUNT=4

# HTTP API
#PORT=5555
#HOST=0.0.0.0

# Optional API key (leave blank to disable auth)
#NESS_API_KEY=
EOF

# Systemd unit → /usr/lib/systemd/system/
install -d %{buildroot}%{_unitdir}
cat > %{buildroot}%{_unitdir}/%{name}.service << 'EOF'
[Unit]
Description=Ness D8x/D16x Alarm Web Server
Documentation=https://github.com/example/ness-web
After=network.target

[Service]
Type=simple
User=ness-web
Group=ness-web
WorkingDirectory=%{_datadir}/%{name}

# Load environment overrides from sysconfig
EnvironmentFile=-%{_sysconfdir}/sysconfig/%{name}

# Point config loader at /etc so the packaged config is used
Environment=NESS_CONFIG=%{_sysconfdir}/%{name}/config.js
ExecStart=/usr/bin/node src/index.js

Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=ness-web

# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=%{_sysconfdir}/%{name}

[Install]
WantedBy=multi-user.target
EOF

# Log directory → /var/log/ness-web/
install -d %{buildroot}%{_localstatedir}/log/%{name}

# ── Scripts ───────────────────────────────────────────────────────────────────
%pre
# Create a dedicated system user/group if they don't already exist
getent group  ness-web > /dev/null || groupadd -r ness-web
getent passwd ness-web > /dev/null || \
    useradd -r -g ness-web -d %{_datadir}/%{name} -s /sbin/nologin \
            -c "Ness Web Server" ness-web
exit 0

%post
%systemd_post %{name}.service

%preun
%systemd_preun %{name}.service

%postun
%systemd_postun_with_restart %{name}.service

# ── Files ─────────────────────────────────────────────────────────────────────
%files
# Application
%dir %{_datadir}/%{name}
%dir %{_datadir}/%{name}/src
%{_datadir}/%{name}/src/
%{_datadir}/%{name}/dashboard.html
%{_datadir}/%{name}/package.json
%{_datadir}/%{name}/node_modules/

# Configuration — marked noreplace so upgrades don't overwrite user edits
%dir %{_sysconfdir}/%{name}
%config(noreplace) %attr(0640, root, ness-web) %{_sysconfdir}/%{name}/config.js
%config(noreplace) %{_sysconfdir}/sysconfig/%{name}

# Systemd unit
%{_unitdir}/%{name}.service

# Log directory
%dir %attr(0750, ness-web, ness-web) %{_localstatedir}/log/%{name}

# Docs
%doc README.md .env.example

# ── Changelog ────────────────────────────────────────────────────────────────
%changelog
* Sat Sep 05 2026 Mladen Sekara <msekara@emefes.com> - 1.0.0-1
- Initial package

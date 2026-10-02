{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.agentboard;
  bindsLowPort = cfg.port < 1024;
  listensOnWildcard = lib.elem cfg.host [
    "0.0.0.0"
    "::"
  ];
  listensOnLoopback =
    lib.hasPrefix "127." cfg.host
    || lib.elem cfg.host [
      "localhost"
      "::1"
      "0:0:0:0:0:0:0:1"
    ];
  needsAddress = !(listensOnLoopback || listensOnWildcard);
in
{
  options.services.agentboard = {
    enable = lib.mkEnableOption "agentboard, a realtime kanban board for AI agents";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalMD "agentboard built with the host's `pkgs`";
      description = "The agentboard package to run.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = ''
        Address to listen on. Keep it on localhost and put a TLS proxy in
        front to reach it from other machines. The proxy must forward the
        original `Host` (or set `X-Forwarded-Host`) and `X-Forwarded-Proto`,
        or browser sign-in is refused as cross-origin. With nginx, that is
        `services.nginx.recommendedProxySettings = true`; Caddy and
        `tailscale serve` do it already.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "Port to listen on.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the port in the firewall. Only useful when `host` is not a loopback address.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr (lib.types.strMatching "/.+");
      default = null;
      example = "/run/secrets/agentboard.env";
      description = ''
        File with extra environment variables, such as `ADMIN_EMAIL`,
        `ADMIN_PASSWORD` and `ADMIN_NAME` to create the owner on first start.
        Without them, the owner is created through the setup link printed to
        the journal (`journalctl -u agentboard`).

        The file holds a password, so it must not live in the Nix store:
        not a path literal in your configuration, and not an
        `environment.etc` entry, which links into the store. Use a secrets
        manager such as agenix or sops-nix, or a file you place on the host.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    warnings =
      lib.optional (cfg.openFirewall && listensOnLoopback)
        "services.agentboard.openFirewall opens port ${toString cfg.port}, but agentboard listens on ${cfg.host}, so connections from other machines are still refused. Set services.agentboard.host as well.";

    systemd.services.agentboard = {
      description = "agentboard";
      wantedBy = [ "multi-user.target" ];
      wants = lib.optional needsAddress "network-online.target";
      after = [ "network.target" ] ++ lib.optional needsAddress "network-online.target";
      startLimitIntervalSec = 60;
      startLimitBurst = 5;

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        DATA_DIR = "%S/agentboard";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "on-failure";
        RestartSec = 5;

        DynamicUser = true;
        StateDirectory = "agentboard";
        StateDirectoryMode = "0700";
        UMask = "0077";

        CapabilityBoundingSet = if bindsLowPort then [ "CAP_NET_BIND_SERVICE" ] else "";
        AmbientCapabilities = lib.mkIf bindsLowPort [ "CAP_NET_BIND_SERVICE" ];
        LockPersonality = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectProc = "invisible";
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
        SystemCallFilter = [
          "@system-service"
          "~@privileged"
        ];
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}

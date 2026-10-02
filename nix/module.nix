{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.agentboard;
  bindsLowPort = cfg.port < 1024;
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
      description = "Address to listen on. Keep it on localhost and put a TLS proxy in front to reach it from other machines.";
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
      type = lib.types.nullOr lib.types.str;
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
      lib.optional
        (
          cfg.openFirewall
          && lib.elem cfg.host [
            "127.0.0.1"
            "::1"
            "localhost"
          ]
        )
        "services.agentboard.openFirewall opens port ${toString cfg.port}, but agentboard listens on ${cfg.host}, so connections from other machines are still refused. Set services.agentboard.host as well.";

    systemd.services.agentboard = {
      description = "agentboard";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        DATA_DIR = "/var/lib/agentboard";
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
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}

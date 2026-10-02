self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.agentboard;
in
{
  options.services.agentboard = {
    enable = lib.mkEnableOption "agentboard, a realtime kanban board for AI agents";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.agentboard;
      defaultText = lib.literalExpression "agentboard.packages.\${system}.agentboard";
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
      description = "Open the port in the firewall.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/agentboard.env";
      description = ''
        File with extra environment variables, such as `ADMIN_EMAIL`,
        `ADMIN_PASSWORD` and `ADMIN_NAME` to create the owner on first start.
        Without them, the owner is created through the setup link printed to
        the journal (`journalctl -u agentboard`).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.agentboard = {
      description = "agentboard";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      environment = {
        HOST = cfg.host;
        PORT = toString cfg.port;
        DATA_DIR = "/var/lib/agentboard";
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        Restart = "on-failure";

        DynamicUser = true;
        StateDirectory = "agentboard";
        StateDirectoryMode = "0700";
        UMask = "0077";

        CapabilityBoundingSet = "";
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
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}

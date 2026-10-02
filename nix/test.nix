self: {
  name = "agentboard";

  nodes = {
    defaults = {
      imports = [ self.nixosModules.agentboard ];
      services.agentboard.enable = true;
    };

    custom = {
      imports = [ self.nixosModules.agentboard ];
      services.agentboard = {
        enable = true;
        port = 80;
        environmentFile = "/run/secrets/agentboard.env";
      };
    };
  };

  testScript = ''
    start_all()

    with subtest("defaults: port 3000, no capabilities, owner created through the setup link"):
        defaults.wait_for_unit("agentboard.service")
        defaults.wait_for_open_port(3000)
        defaults.succeed("curl -sf http://127.0.0.1:3000/api/health")
        defaults.succeed("curl -sf http://127.0.0.1:3000/api | grep -q agentboard")
        defaults.succeed("curl -sf http://127.0.0.1:3000/vendor/markdown-it.mjs >/dev/null")
        defaults.wait_until_succeeds("journalctl -u agentboard | grep -q '?setup='")
        defaults.succeed("test -f /var/lib/agentboard/board.db")
        defaults.succeed("test \"$(systemctl show -P CapabilityBoundingSet agentboard)\" = \"\"")

    with subtest("a unit that cannot start ends up failed instead of restarting forever"):
        custom.wait_until_succeeds("test \"$(systemctl show -P Result agentboard)\" = start-limit-hit", timeout=120)

    with subtest("custom: port 80 and an environment file written at runtime"):
        custom.succeed(
            "install -d -m 700 /run/secrets",
            "printf 'ADMIN_EMAIL=owner@example.com\\nADMIN_PASSWORD=a long password\\n' > /run/secrets/agentboard.env",
            "chmod 600 /run/secrets/agentboard.env",
            "systemctl reset-failed agentboard",
            "systemctl start agentboard",
        )
        custom.wait_for_unit("agentboard.service")
        custom.wait_for_open_port(80)
        custom.succeed("curl -sf http://127.0.0.1/api/health")
        custom.wait_until_succeeds("journalctl -u agentboard | grep -q 'created owner'")
        custom.succeed("systemctl show -P AmbientCapabilities agentboard | grep -q cap_net_bind_service")
  '';
}

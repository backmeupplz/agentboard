self: {
  name = "agentboard";

  nodes.machine = {
    imports = [ self.nixosModules.agentboard ];
    services.agentboard = {
      enable = true;
      port = 80;
      environmentFile = "/run/secrets/agentboard.env";
    };
  };

  testScript = ''
    machine.wait_for_unit("multi-user.target")
    machine.succeed(
      "install -d -m 700 /run/secrets",
      "printf 'ADMIN_EMAIL=owner@example.com\\nADMIN_PASSWORD=a long password\\n' > /run/secrets/agentboard.env",
      "chmod 600 /run/secrets/agentboard.env",
      "systemctl restart agentboard",
    )
    machine.wait_for_unit("agentboard.service")
    machine.wait_for_open_port(80)
    machine.succeed("curl -sf http://127.0.0.1/api/health")
    machine.succeed("curl -sf http://127.0.0.1/api | grep -q agentboard")
    machine.succeed("curl -sf http://127.0.0.1/vendor/markdown-it.mjs >/dev/null")
    machine.wait_until_succeeds("journalctl -u agentboard | grep -q 'created owner'")
    machine.succeed("test -f /var/lib/agentboard/board.db")
  '';
}

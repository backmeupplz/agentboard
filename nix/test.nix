self:
{
  name = "agentboard";

  nodes.machine = { pkgs, ... }: {
    imports = [ self.nixosModules.agentboard ];
    services.agentboard = {
      enable = true;
      environmentFile = pkgs.writeText "agentboard.env" ''
        ADMIN_EMAIL=owner@example.com
        ADMIN_PASSWORD=a long password
      '';
    };
  };

  testScript = ''
    machine.wait_for_unit("agentboard.service")
    machine.wait_for_open_port(3000)
    machine.succeed("curl -sf http://127.0.0.1:3000/api/health")
    machine.succeed("curl -sf http://127.0.0.1:3000/api | grep -q agentboard")
    machine.succeed("curl -sf http://127.0.0.1:3000/vendor/markdown-it.mjs >/dev/null")
    machine.wait_until_succeeds("journalctl -u agentboard | grep -q 'created owner'")
    machine.succeed("test -f /var/lib/agentboard/board.db")
  '';
}

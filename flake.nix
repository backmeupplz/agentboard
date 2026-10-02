{
  description = "A tiny realtime kanban board for AI agents and the humans watching them";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      forAllSystems =
        f:
        nixpkgs.lib.genAttrs [
          "x86_64-linux"
          "aarch64-linux"
          "aarch64-darwin"
        ] (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        agentboard = pkgs.callPackage ./nix/package.nix { };
        default = agentboard;
      });

      overlays.default = final: prev: {
        agentboard = final.callPackage ./nix/package.nix { };
      };

      nixosModules = rec {
        agentboard = ./nix/module.nix;
        default = agentboard;
      };

      checks = forAllSystems (
        pkgs:
        {
          inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) agentboard;
        }
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          module = pkgs.testers.runNixOSTest (import ./nix/test.nix self);
        }
      );
    };
}

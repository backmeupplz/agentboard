{
  description = "A tiny realtime kanban board for AI agents and the humans watching them";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: {
        agentboard = pkgs.callPackage ./nix/package.nix { };
        default = self.packages.${pkgs.stdenv.hostPlatform.system}.agentboard;
      });

      overlays.default = final: prev: {
        agentboard = final.callPackage ./nix/package.nix { };
      };

      nixosModules.agentboard = import ./nix/module.nix self;
      nixosModules.default = self.nixosModules.agentboard;

      checks = forAllSystems (pkgs:
        { package = self.packages.${pkgs.stdenv.hostPlatform.system}.agentboard; }
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          module = pkgs.testers.runNixOSTest (import ./nix/test.nix self);
        });
    };
}

{
  description = "A tiny realtime kanban board for AI agents and the humans watching them";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    core-flake = {
      url = "github:purplenoodlesoop/core-flake";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, core-flake, ... }:
    core-flake.lib.evalFlake {
      specialArgs = { inherit self; };
      perSystem.imports = [ ./nix/agentboard.nix ];
      topLevel = {
        overlays.default = final: prev: {
          agentboard = final.callPackage ./nix/package.nix { };
        };
        nixosModules = rec {
          agentboard = import ./nix/module.nix self;
          default = agentboard;
        };
      };
    };
}

{
  pkgs,
  lib,
  self,
  ...
}:
let
  agentboard = pkgs.callPackage ./package.nix { };
in
{
  flake.packages = {
    inherit agentboard;
    default = agentboard;
  };

  flake.output.checks = {
    inherit agentboard;
  }
  // lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
    module = pkgs.testers.runNixOSTest (import ./test.nix self);
  };
}

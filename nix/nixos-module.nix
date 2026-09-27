{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.zag;
in
{
  options.programs.zag = {
    enable = lib.mkEnableOption "ZAG coding agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.zag.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "ZAG package to install system-wide.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];
  };
}

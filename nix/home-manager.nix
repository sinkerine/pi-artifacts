self: { config, lib, pkgs, ... }: let
  inherit (lib) mkOption mkEnableOption types;
  cfg = config.services.pi-artifacts;
  configPath = "${config.xdg.configHome}/pi-artifacts/config.json";
in {
  options.services.pi-artifacts = {
    enable = mkEnableOption "Pi artifacts service";
    package = mkOption { type = types.package; default = self.packages.${pkgs.stdenv.hostPlatform.system}.default; };
    bindAddress = mkOption { type = types.str; default = "127.0.0.1"; };
    port = mkOption { type = types.port; default = 4317; };
    publicUrl = mkOption { type = types.str; default = "http://127.0.0.1:4317"; };
    serviceUrl = mkOption { type = types.nullOr types.str; default = null; };
    dataDir = mkOption { type = types.str; default = "${config.xdg.dataHome}/pi-artifacts"; };
    workDir = mkOption { type = types.str; default = "${config.xdg.stateHome}/pi-artifacts/work"; };
    tokenFile = mkOption { type = types.str; default = "${cfg.dataDir}/publish-token"; };
    limits = mkOption { type = types.attrsOf types.ints.positive; default = { maxFiles = 100; maxTotalBytes = 10485760; maxFileBytes = 2097152; buildTimeoutMs = 30000; }; };
    enablePiExtension = mkEnableOption "link only the Pi artifacts extension";
  };
  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    xdg.configFile."pi-artifacts/config.json".text = builtins.toJSON ({ schemaVersion = 1; inherit (cfg) bindAddress port publicUrl dataDir workDir tokenFile limits; } // lib.optionalAttrs (cfg.serviceUrl != null) { inherit (cfg) serviceUrl; });
    home.sessionVariables.PI_ARTIFACTS_CONFIG = configPath;
    home.file = lib.mkIf cfg.enablePiExtension { ".pi/agent/extensions/pi-artifacts".source = "${cfg.package}/lib/pi-artifacts/dist/extensions"; };
    systemd.user.services.pi-artifacts = {
      Unit.Description = "Pi artifacts";
      Service = { ExecStart = "${cfg.package}/bin/pi-artifacts serve --config ${configPath}"; Restart = "on-failure"; };
      Install.WantedBy = [ "default.target" ];
    };
  };
}

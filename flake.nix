{
  description = "Immutable Pi artifacts service, viewer and extension";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/1c89083e451e891152365b799595cf7790a43325";
  inputs.home-manager = { url = "github:nix-community/home-manager"; inputs.nixpkgs.follows = "nixpkgs"; };
  outputs = { self, nixpkgs, home-manager }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
    # A path source includes newly authored files without changing the Git index.
    source = builtins.path { path = ./.; name = "pi-artifacts-source"; filter = path: type:
      !(builtins.elem (baseNameOf path) [ ".git" ".pi" "node_modules" "dist" "coverage" ".artifacts-checks" "test-results" "playwright-report" "result" ]); };
    nodeModules = pkgs.importNpmLock.buildNodeModules { npmRoot = source; nodejs = pkgs.nodejs_22; };
    package = pkgs.stdenvNoCC.mkDerivation {
      PI_ARTIFACTS_MV = "${pkgs.coreutils}/bin/mv";
      pname = "pi-artifacts"; version = "0.1.0"; src = source;
      nativeBuildInputs = [ pkgs.nodejs_22 pkgs.makeWrapper ];
      buildPhase = ''ln -s ${nodeModules}/node_modules node_modules; npm run build'';
      installPhase = ''
        mkdir -p $out/lib/pi-artifacts $out/bin
        cp -r dist package.json $out/lib/pi-artifacts/
        ln -s ${nodeModules}/node_modules $out/lib/pi-artifacts/node_modules
        makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/pi-artifacts --add-flags $out/lib/pi-artifacts/dist/service/cli.js --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.util-linux pkgs.coreutils ]}
      '';
    };
  in {
    packages.${system}.default = package;
    devShells.${system}.default = pkgs.mkShell {
      packages = [ pkgs.nodejs_22 pkgs.util-linux pkgs.chromium pkgs.playwright-driver.browsers pkgs.dejavu_fonts ];
      PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
      PI_ARTIFACTS_CHROMIUM = "${pkgs.chromium}/bin/chromium";
      shellHook = ''ln -sfn ${nodeModules}/node_modules node_modules'';
    };
    homeManagerModules.default = import ./nix/home-manager.nix self;
    checks.${system} = {
      package = package;
      module = let
        evaluate = settings: home-manager.lib.homeManagerConfiguration {
          inherit pkgs;
          modules = [ self.homeManagerModules.default { home.username = "fixture"; home.homeDirectory = "/home/fixture"; home.stateVersion = "25.11"; services.pi-artifacts = settings; } ];
        };
        disabled = (evaluate {}).config;
        enabled = (evaluate { enable = true; enablePiExtension = true; port = 9876; publicUrl = "https://example.test/artifacts"; serviceUrl = "http://127.0.0.1:9876/artifacts"; bindAddress = "::1"; dataDir = "/tmp/data"; workDir = "/tmp/work"; tokenFile = "/tmp/token"; limits.maxFiles = 8; }).config;
        noExtension = (evaluate { enable = true; }).config;
        generated = builtins.fromJSON enabled.xdg.configFile."pi-artifacts/config.json".text;
      in assert !(disabled.systemd.user.services ? pi-artifacts);
         assert !(noExtension.home.file ? ".pi/agent/extensions/pi-artifacts");
         assert generated.port == 9876 && generated.bindAddress == "::1" && generated.limits.maxFiles == 8;
         assert generated.publicUrl == "https://example.test/artifacts" && generated.dataDir == "/tmp/data" && generated.workDir == "/tmp/work" && generated.tokenFile == "/tmp/token";
         assert enabled.home.file.".pi/agent/extensions/pi-artifacts".source == "${package}/lib/pi-artifacts/dist/extensions";
         pkgs.runCommand "pi-artifacts-module-check" {} ''test -x ${package}/bin/pi-artifacts; touch $out'';
    };
  };
}

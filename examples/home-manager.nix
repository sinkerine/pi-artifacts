{ inputs, ... }: {
  imports = [ inputs.pi-artifacts.homeManagerModules.default ];
  services.pi-artifacts = {
    enable = true;
    bindAddress = "127.0.0.1";
    port = 4317;
    publicUrl = "https://artifacts.example.test/artifacts/";
    serviceUrl = "http://127.0.0.1:4317/artifacts/";
    enablePiExtension = false; # Opt in only after reviewing trusted-code behavior.
  };
}

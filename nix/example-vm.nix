{
  lib,
  modulesPath,
  ...
}:
{
  imports = [ (modulesPath + "/virtualisation/qemu-vm.nix") ];

  networking.hostName = "blossom-vm";

  services.blossom-server = {
    enable = true;
    openFirewall = true;

    settings = {
      host = "0.0.0.0";
      publicDomain = "localhost:3000";

      storage = {
        backend = "local";
        rules = [
          {
            type = "*";
            expiration = "1 week";
          }
        ];
      };

      # Keep the demonstration easy to exercise with curl. Production servers
      # should normally require a valid BUD-11 Nostr authorization event.
      upload.requireAuth = false;
    };
  };

  services.openssh.enable = true;
  networking.firewall.allowedTCPPorts = [ 22 ];

  virtualisation = {
    memorySize = 2048;
    cores = 2;
    forwardPorts = [
      {
        from = "host";
        host.port = 3000;
        guest.port = 3000;
      }
      {
        from = "host";
        host.port = 2222;
        guest.port = 22;
      }
    ];
  };

  system.stateVersion = "25.11";

  # This configuration is intentionally a demo, not a production baseline.
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
}

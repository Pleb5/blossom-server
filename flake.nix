{
  description = "Blossom Server - Deno-based Blossom blob storage server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
      ];

      forAllSystems =
        f:
        nixpkgs.lib.genAttrs systems (
          system:
          f system (
            import nixpkgs {
              inherit system;
            }
          )
        );

      sourceExclusions = [
        ".git"
        ".planning"
        ".claude"
        "data"
        "flake.nix"
        "flake.lock"
        "nix"
        "node_modules"
        "vendor"
      ];

      src = nixpkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: _type: !(nixpkgs.lib.elem (baseNameOf path) sourceExclusions);
      };
    in
    {
      nixosModules = {
        blossom-server = import ./nix/module.nix self;
        default = self.nixosModules.blossom-server;
      };

      packages = forAllSystems (
        system: pkgs:
        (import ./nix/package.nix {
          inherit pkgs src systems;
          version = (builtins.fromJSON (builtins.readFile ./deno.json)).version;
        })
        // {
          # `nix run .#vm` — a disposable Blossom demonstration VM.
          vm =
            (nixpkgs.lib.nixosSystem {
              modules = [
                { nixpkgs.hostPlatform = system; }
                "${nixpkgs}/nixos/modules/virtualisation/qemu-vm.nix"
                self.nixosModules.default
                ./nix/example-vm.nix
              ];
            }).config.system.build.vm;
        }
      );

      apps = forAllSystems (
        system: _pkgs: {
          default = {
            type = "app";
            program = "${self.packages.${system}.default}/bin/blossom-server";
            meta.description = "Run the Blossom Server package";
          };
        }
      );

      devShells = forAllSystems (
        _system: pkgs: {
          default = pkgs.mkShell {
            packages = [
              pkgs.deno
            ]
            ++ [ pkgs.ffmpeg ];

            shellHook = ''
              echo "Blossom Server dev shell"
              echo "  deno task build"
              echo "  deno task dev"
              echo "  nix build .#blossom-server"
            '';
          };
        }
      );

      checks = forAllSystems (
        system: _pkgs: {
          package = self.packages.${system}.default;
        }
      );
    };
}

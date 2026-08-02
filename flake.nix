{
  description = "Blossom Server - Deno-based Blossom blob storage server";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
      ];

      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          f system (import nixpkgs {
            inherit system;
          }));
    in
    {
      packages = forAllSystems (_system: pkgs:
        let
          inherit (pkgs) lib stdenvNoCC;
          version = (builtins.fromJSON (builtins.readFile ./deno.json)).version;

          src = lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let
                base = baseNameOf path;
              in
              !(base == ".git" || base == ".planning" || base == ".claude" || base == "data"
                || base == "node_modules");
          };

          denoDeps = stdenvNoCC.mkDerivation {
            pname = "blossom-server-deno-deps";
            inherit version src;

            nativeBuildInputs = [ pkgs.deno ];

            buildPhase = ''
              runHook preBuild

              export DENO_DIR="$out"
              deno cache --frozen --lock=deno.lock main.ts
              deno cache \
                --config src/landing/client/deno.json \
                --lock=src/landing/client/deno.lock \
                src/landing/client/index.tsx
              deno task build:client

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              runHook postInstall
            '';

            outputHashMode = "recursive";
            outputHashAlgo = "sha256";
            outputHash = "sha256-dEt9Sg5vM7PZPT/R6Q41P6Sm36RNTZrVCP6MzDPvdHI=";
          };

          blossom-server = stdenvNoCC.mkDerivation {
            pname = "blossom-server";
            inherit version src;

            nativeBuildInputs = [
              pkgs.deno
              pkgs.makeWrapper
            ];

            buildPhase = ''
              runHook preBuild

              cp -R ${denoDeps} deno-dir
              chmod -R u+w deno-dir
              export DENO_DIR="$PWD/deno-dir"

              client_bundle="$out/share/blossom-server/public/client.js"
              substituteInPlace src/routes/landing.tsx \
                --replace-fail 'const CLIENT_BUNDLE_PATH = "./public/client.js";' \
                               "const CLIENT_BUNDLE_PATH = \"$client_bundle\";"

              deno task build:client

              deno cache --frozen --lock=deno.lock main.ts

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/share/blossom-server" "$out/share/deno-dir" "$out/bin"
              cp -R main.ts deno.json deno.lock public src "$out/share/blossom-server/"
              cp -R deno-dir/. "$out/share/deno-dir/"

              makeWrapper ${lib.getExe pkgs.deno} "$out/bin/blossom-server" \
                --prefix PATH : ${lib.makeBinPath [ pkgs.ffmpeg ]} \
                --set DENO_DIR "$out/share/deno-dir" \
                --add-flags "run" \
                --add-flags "-P" \
                --add-flags "--config=$out/share/blossom-server/deno.json" \
                --add-flags "--frozen" \
                --add-flags "--lock=$out/share/blossom-server/deno.lock" \
                --add-flags "$out/share/blossom-server/main.ts"

              runHook postInstall
            '';

            meta = {
              description = "Deno-based Blossom blob storage server";
              homepage = "https://github.com/hzrd149/blossom-server";
              license = lib.licenses.mit;
              mainProgram = "blossom-server";
              platforms = systems;
            };
          };
        in
        {
          default = blossom-server;
          inherit blossom-server denoDeps;
        });

      apps = forAllSystems (system: _pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/blossom-server";
          meta.description = "Run the Blossom Server package";
        };
      });

      devShells = forAllSystems (_system: pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.deno
            pkgs.ffmpeg
          ];

          shellHook = ''
            echo "Blossom Server dev shell"
            echo "  deno task build"
            echo "  deno task dev"
            echo "  nix build .#blossom-server"
          '';
        };
      });

      checks = forAllSystems (system: _pkgs: {
        package = self.packages.${system}.default;
      });
    };
}

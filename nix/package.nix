{
  pkgs,
  src,
  version,
  systems,
}:
let
  inherit (pkgs) lib stdenvNoCC;

  denoDeps = stdenvNoCC.mkDerivation {
    pname = "blossom-server-deno-deps";
    inherit version src;

    nativeBuildInputs = [ pkgs.deno ];

    buildPhase = ''
      runHook preBuild

      export DENO_DIR="/build/deno-dir"
      deno install --frozen --lock=deno.lock --entrypoint main.ts
      deno install \
        --config src/landing/client/deno.json \
        --frozen \
        --lock=src/landing/client/deno.lock \
        --entrypoint src/landing/client/index.tsx
      deno task build:client

      mkdir -p "$out"
      cp -R vendor node_modules "$out/"
      mkdir -p "$out/src/landing/client"
      cp -R src/landing/client/vendor src/landing/client/node_modules "$out/src/landing/client/"
      cp public/client.js "$out/client.js"

      runHook postBuild
    '';

    dontInstall = true;

    outputHashMode = "recursive";
    outputHash = "sha256-HUSspxQJMc7ayPvTaRUfy/XUE+yTZirXQJVLj7oWN48=";
  };

  runtimeDeps = [ pkgs.ffmpeg ];

  blossom-server = stdenvNoCC.mkDerivation {
    pname = "blossom-server";
    inherit version src;

    nativeBuildInputs = [
      pkgs.deno
      pkgs.makeWrapper
    ];

    buildPhase = ''
      runHook preBuild

      cp -R ${denoDeps}/vendor ${denoDeps}/node_modules .
      mkdir -p src/landing/client
      cp -R ${denoDeps}/src/landing/client/vendor ${denoDeps}/src/landing/client/node_modules \
        src/landing/client/

      client_bundle="$out/share/blossom-server/public/client.js"
      substituteInPlace src/routes/landing.tsx \
        --replace-fail 'const CLIENT_BUNDLE_PATH = "./public/client.js";' \
                       "const CLIENT_BUNDLE_PATH = \"$client_bundle\";"

      cp ${denoDeps}/client.js public/client.js

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/share/blossom-server" "$out/bin"
      cp -R main.ts deno.json deno.lock public src vendor node_modules "$out/share/blossom-server/"

      makeWrapper ${lib.getExe pkgs.deno} "$out/bin/blossom-server" \
        --prefix PATH : ${lib.makeBinPath runtimeDeps} \
        --add-flags "run" \
        --add-flags "--cached-only" \
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
}

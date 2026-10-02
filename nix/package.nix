{
  lib,
  buildNpmPackage,
  importNpmLock,
  nodejs_24,
  makeWrapper,
}:

let
  manifest = lib.importJSON ../package.json;
  runtimeFiles = [
    "package.json"
    "server.js"
    "API.md"
    "public"
    "bin"
  ];
  src = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.unions (
      map (name: ../. + "/${name}") runtimeFiles
      ++ [
        ../package-lock.json
        ../test.js
      ]
    );
  };
in
buildNpmPackage {
  pname = manifest.name;
  inherit (manifest) version;
  inherit src;

  nodejs = nodejs_24;
  npmDeps = importNpmLock { npmRoot = src; };
  npmConfigHook = importNpmLock.npmConfigHook;
  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  doCheck = true;
  __darwinAllowLocalNetworking = true;
  checkPhase = ''
    runHook preCheck
    node --test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/agentboard $out/bin
    cp -r ${lib.concatStringsSep " " runtimeFiles} node_modules $out/lib/agentboard/
    makeWrapper ${lib.getExe nodejs_24} $out/bin/agentboard \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/agentboard/server.js" \
      --set-default DATA_DIR data
    makeWrapper ${lib.getExe nodejs_24} $out/bin/kb \
      --add-flags "$out/lib/agentboard/bin/kb.mjs"
    runHook postInstall
  '';

  meta = {
    inherit (manifest) description;
    homepage = "https://agentboard.win";
    license = lib.licenses.mit;
    mainProgram = "agentboard";
    platforms = nodejs_24.meta.platforms;
  };
}

{
  lib,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
}:

let
  manifest = lib.importJSON ../package.json;
in
buildNpmPackage {
  pname = manifest.name;
  inherit (manifest) version;

  src = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../server.js
      ../API.md
      ../public
      ../bin
      ../test.js
    ];
  };

  nodejs = nodejs_24;
  npmDepsHash = "sha256-bKtC5X/ve61hQOUTQYcA0hXu4zv2HfuVeNMXEaYYDGk=";
  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    npm prune --omit=dev
    mkdir -p $out/lib/agentboard $out/bin
    cp -r package.json server.js API.md public bin node_modules $out/lib/agentboard/
    makeWrapper ${lib.getExe nodejs_24} $out/bin/agentboard \
      --add-flags "--disable-warning=ExperimentalWarning $out/lib/agentboard/server.js" \
      --set-default NODE_ENV production
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

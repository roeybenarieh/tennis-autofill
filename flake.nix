{
  description = "tennis-autofill";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/master";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          nodejs = pkgs.nodejs_22; # needs >= 22.13 (node:sqlite without a flag)
          # Memory: a 1 MB young generation and size-optimised code take ~12 MB off the idle heap
          # (about 61 -> 48 MB). Not --jitless (slow decryption) or a heap cap (history sync spikes).
          nodeFlags = "--max-semi-space-size=1 --optimize-for-size";
        in
        rec {
          # npmDepsHash: refresh after changing package-lock.json (set it to pkgs.lib.fakeHash,
          # run `nix build`, copy the hash from the error). Flakes only see Git-tracked files.
          tennis-autofill = pkgs.buildNpmPackage {
            pname = "tennis-autofill";
            version = "0.2.0";
            src = ./.;
            inherit nodejs;
            npmDepsHash = "sha256-CCROh2UhpkFD5N8KaCjOb8Pjn9INDfCdfIobaIczMZE=";
            dontNpmBuild = true; # plain JS, nothing to compile
            makeCacheWritable = true; # npm writes to its cache during install
            nativeBuildInputs = [ pkgs.makeWrapper ];
            # xdg-open (fallback when submission fails) and notify-send are on the wrapper's PATH
            postInstall = ''
              rm -f $out/bin/tennis-autofill
              makeWrapper ${nodejs}/bin/node $out/bin/tennis-autofill \
                --add-flags "--disable-warning=ExperimentalWarning ${nodeFlags} $out/lib/node_modules/tennis-autofill/index.js" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.xdg-utils pkgs.libnotify ]}
            '';
            meta.mainProgram = "tennis-autofill";
          };
          default = tennis-autofill;
        });
    };
}

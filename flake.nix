# for more information: https://medium.com/@daniel.garcia_57638/nix-nirvana-packaging-python-apps-with-uv2nix-c44e79ae4bc9
{
  description = "tennis-autofill";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/master";
    flake-utils.url = "github:numtide/flake-utils";

    # Core pyproject-nix ecosystem tools
    pyproject-nix.url = "github:pyproject-nix/pyproject.nix";
    uv2nix.url = "github:pyproject-nix/uv2nix";
    pyproject-build-systems.url = "github:pyproject-nix/build-system-pkgs";

    # Ensure consistent dependencies between these tools
    pyproject-nix.inputs.nixpkgs.follows = "nixpkgs";
    uv2nix.inputs.nixpkgs.follows = "nixpkgs";
    pyproject-build-systems.inputs.nixpkgs.follows = "nixpkgs";
    uv2nix.inputs.pyproject-nix.follows = "pyproject-nix";
    pyproject-build-systems.inputs.pyproject-nix.follows = "pyproject-nix";
  };

  outputs = { self, nixpkgs, flake-utils, uv2nix, pyproject-nix, pyproject-build-systems, ... }:
    (flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        python = pkgs.python312; # desired Python version

        # 1. Load Project Workspace (parses pyproject.toml, uv.lock)
        workspace = uv2nix.lib.workspace.loadWorkspace {
          workspaceRoot = ./.; # Root of flake/project
        };

        # 2. Generate Nix Overlay from uv.lock (via workspace)
        uvLockedOverlay = workspace.mkPyprojectOverlay {
          sourcePreference = "wheel"; # Or "sdist"
        };

        # 3. Placeholder for Your Custom Package Overrides
        myCustomOverrides = final: prev: {
          # whatsapp-api-client-python's sdist uses setuptools without declaring it
          whatsapp-api-client-python = prev.whatsapp-api-client-python.overrideAttrs (old: {
            nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ final.resolveBuildSystem { setuptools = [ ]; };
          });
        };

        # 4. Construct the Final Python Package Set
        pythonSet =
          (pkgs.callPackage pyproject-nix.build.packages { inherit python; }).overrideScope (nixpkgs.lib.composeManyExtensions [
            pyproject-build-systems.overlays.default # For build tools
            uvLockedOverlay # Your locked dependencies
            myCustomOverrides # Your fixes
          ]);

        # --- This is where your project's metadata is accessed ---
        projectNameInToml = "tennis-autofill"; # MUST match [project.name] in pyproject.toml!
        thisProjectAsNixPkg = pythonSet.${projectNameInToml};

        # 5. Create the Python Runtime Environment
        appPythonEnv = pythonSet.mkVirtualEnv
          (thisProjectAsNixPkg.pname + "-env")
          workspace.deps.default; # Uses deps from pyproject.toml [project.dependencies]

        # app dependencies packages
        dep_packages = with pkgs; [
          appPythonEnv # Runtime Python environment
          libnotify
          uv
        ];
      in
      {
        # Development Shell
        devShells.default = pkgs.mkShell {
          packages = dep_packages;
          shellHook = "";
        };

        # Nix Package for Your Application
        packages.default = pkgs.stdenv.mkDerivation {
          pname = thisProjectAsNixPkg.pname;
          version = thisProjectAsNixPkg.version;
          src = ./.; # Source of your main script

          nativeBuildInputs = [ pkgs.makeWrapper ];
          buildInputs = dep_packages;

          installPhase = ''
            mkdir -p $out/bin
            cp main.py $out/bin/main.py
            # wrapper: xdg-open is used as the fallback when submission fails
            makeWrapper ${appPythonEnv}/bin/python $out/bin/${thisProjectAsNixPkg.pname} \
              --add-flags $out/bin/main.py \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.xdg-utils pkgs.libnotify ]}
          '';

          # specify main program for using getExe
          meta.mainProgram = thisProjectAsNixPkg.pname;
        };
        packages.${thisProjectAsNixPkg.pname} = self.packages.${system}.default;

        # App for `nix run`
        apps.default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/${thisProjectAsNixPkg.pname}";
        };
        apps.${thisProjectAsNixPkg.pname} = self.apps.${system}.default;
      }
    ))
    // {
      # NixOS module: `services.tennis-autofill.enable = true;`
      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.tennis-autofill;
        in
        {
          options.services.tennis-autofill = {
            enable = lib.mkEnableOption "tennis-autofill, which auto-fills Google Forms posted in the WhatsApp group";
            user = lib.mkOption {
              type = lib.types.str;
              description = "User to run as. Its Chromium profile supplies the Google login cookies.";
            };
            environmentFile = lib.mkOption {
              type = lib.types.str;
              default = "${config.users.users.${cfg.user}.home}/.config/tennis-autofiller/env";
              description = ''
                KEY=VALUE file with GREEN_API_ID_INSTANCE, GREEN_API_TOKEN and OPENROUTER_API_KEY.
                Loaded by systemd as root before the service drops to `user`. Optional: a missing file is ignored.
              '';
            };
          };

          config = lib.mkIf cfg.enable {
            systemd.services.tennis-autofill = {
              description = "tennis-autofill";
              wantedBy = [ "multi-user.target" ];
              wants = [ "network-online.target" ];
              after = [ "network-online.target" ];
              environment.HOME = config.users.users.${cfg.user}.home;
              script = ''
                export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(${pkgs.coreutils}/bin/id -u)/bus"
                exec ${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/tennis-autofill
              '';
              serviceConfig = {
                User = cfg.user;
                EnvironmentFile = "-${cfg.environmentFile}"; # "-" = optional
                StateDirectory = "tennis-autofill";
                WorkingDirectory = "/var/lib/tennis-autofill"; # main.py writes hello.txt to the cwd
                # stdout (one line per poll) goes to a file that logrotate caps, not to the journal
                StandardOutput = "append:/var/lib/tennis-autofill/tennis-autofill.log";
                Restart = "on-failure";
                RestartSec = 60;
              };
            };

            # keep 7 compressed daily logs; copytruncate so the running service keeps its file handle
            services.logrotate.settings.tennis-autofill = {
              files = "/var/lib/tennis-autofill/tennis-autofill.log";
              frequency = "daily";
              rotate = 7;
              compress = true;
              missingok = true;
              copytruncate = true;
            };
          };
        };
    };
}

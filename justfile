default:
  @just --list

[group('uv')]
run:
  uv run main.py

[group('uv')]
dep-tree:
  uv tree


[group('nix')]
update-dependencies:
  nix flake update

[group('nix')]
dev-shell:
  nix develop .#default

[group('nix')]
run-nix:
  nix run .#default

[group('nix')]
show-flake:
  nix flake show

[group('nix')]
build:
  nix build .#default

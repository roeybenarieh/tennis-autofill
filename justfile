default:
  @just --list

[group('node')]
install:
  npm ci

[group('node')]
run:
  node index.js

[group('node')]
test:
  npm test

# pair WhatsApp (QR file at ~/whatsapp-qr.html) and print your groups and their IDs
[group('node')]
list-groups:
  node index.js --list-groups

[group('nix')]
update-dependencies:
  nix flake update

[group('nix')]
run-nix:
  nix run .#default

[group('nix')]
show-flake:
  nix flake show

[group('nix')]
build:
  nix build .#default

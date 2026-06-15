{
  description = "h2h ranking stuff";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs = inputs: (
    inputs.flake-utils.lib.eachDefaultSystem (system: (
      let
        pkgs = inputs.nixpkgs.legacyPackages.${system};
        pwdp = "${pkgs.playwright-driver.browsers}";
        nativeBuildInputs = [
          pkgs.playwright
          pkgs.playwright-driver.browsers
          pkgs.nodejs
        ];
        vars = [
          ["PLAYWRIGHT_BROWSERS_PATH" pwdp]
          ["PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS" "true"]
          ["PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS" "ubuntu-24.04"]
        ];
        shellHook = builtins.concatStringsSep "\n" (
          map (kv: builtins.concatStringsSep
                     " "
                     ["export" (builtins.concatStringsSep "=" kv)])
                     vars
        );
        yt-upload-playwright = (pkgs.callPackage ./default.nix (
          { inherit nativeBuildInputs vars; }
        ));
      in {
        packages = {
          yt-upload-playwright = yt-upload-playwright;
          default = yt-upload-playwright;
        };
        devShells.default = (
          pkgs.mkShell { inherit nativeBuildInputs shellHook; }
        );
      }
    ))
  );
}

---
"@tobilu/qmd": patch
---

The Nix flake package sets `meta.mainProgram = "qmd"`, so `lib.getExe` consumers no longer see the nixpkgs deprecation warning. #934 (thanks @jm-g)

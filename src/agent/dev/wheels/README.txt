ISHKAPON Pyodide calculation wheels.

pyodide npm package: 0.29.5
lock abi_version:    2025_0
packages:            mpmath, numpy, sympy

These files were fetched by src/agent/dev/fetch-wheels.mjs and their SHA-256
digests verified against pyodide-lock.json.

The agent host passes this directory to Pyodide as `packageBaseUrl`, which is
what makes the sandbox offline: a missing wheel is an ENOENT, never a
download. This directory must be unpacked alongside the app in a packaged
build (electron-builder.yml: asarUnpack).

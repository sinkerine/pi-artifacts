#!/bin/sh
# Use the Nix-built executable; replace with your config path.
exec pi-artifacts serve --config "${PI_ARTIFACTS_CONFIG:?Set an absolute config path}"

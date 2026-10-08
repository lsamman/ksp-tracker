#!/bin/bash
# Builds FleetTracker.dll and installs it into each KSP install's GameData.
set -e
cd "$(dirname "$0")"
STEAM=~/.local/share/Steam/steamapps/common
KSPS=("Kerbal Space Program" "Kerbal Space Program Modded SOL")
MANAGED="$STEAM/${KSPS[0]}/KSP_x64_Data/Managed"

mkdir -p out
mcs -target:library -out:out/FleetTracker.dll -nowarn:0618 \
  -r:"$MANAGED/Assembly-CSharp.dll" \
  -r:"$MANAGED/UnityEngine.dll" \
  -r:"$MANAGED/UnityEngine.CoreModule.dll" \
  -r:"$MANAGED/UnityEngine.UI.dll" \
  -r:"$MANAGED/UnityEngine.InputLegacyModule.dll" \
  FleetTracker.cs
echo "built out/FleetTracker.dll"

for k in "${KSPS[@]}"; do
  dest="$STEAM/$k/GameData/FleetTracker"
  mkdir -p "$dest/PluginData"
  cp out/FleetTracker.dll "$dest/"
  # never overwrite an existing config (it holds the token)
  [ -f "$dest/PluginData/config.cfg" ] || cp config.example.cfg "$dest/PluginData/config.cfg"
  echo "installed -> $dest"
done

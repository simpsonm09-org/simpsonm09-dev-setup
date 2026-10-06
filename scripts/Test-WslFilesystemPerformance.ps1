# platforms: windows
[CmdletBinding()]
param(
    [string] $DrvfsRoot = '/mnt/d/dev/simpsonm09',
    [int] $SmallFiles = 500,
    [int] $LargeMb = 200
)

# Compares small-file and large-file I/O on the Windows mount against the ext4
# filesystem. It works only inside a dedicated .wsl-perf-bench directory and
# never removes the root it is given.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$template = @'
set -e
DRVFS="__ROOT__"
SMALL=__SMALL__
LARGE=__LARGE__
bench_small() {
  base="$1/small"; rm -rf "$base"; mkdir -p "$base"
  s=$(date +%s%N)
  i=0; while [ "$i" -lt "$SMALL" ]; do : > "$base/f$i"; i=$((i+1)); done
  e=$(date +%s%N)
  printf "%s small %s\n" "$2" $(( (e-s)/1000000 ))
  rm -rf "$base"
}
bench_large() {
  base="$1/large"; rm -rf "$base"; mkdir -p "$base"
  s=$(date +%s%N)
  dd if=/dev/zero of="$base/blob.bin" bs=1M count="$LARGE" conv=fdatasync status=none
  e=$(date +%s%N)
  printf "%s large %s\n" "$2" $(( (e-s)/1000000 ))
  rm -rf "$base"
}
bench_small "$DRVFS/.wsl-perf-bench" drvfs
bench_small "$HOME/.wsl-perf-bench" ext4
bench_large "$DRVFS/.wsl-perf-bench" drvfs
bench_large "$HOME/.wsl-perf-bench" ext4
rm -rf "$DRVFS/.wsl-perf-bench" "$HOME/.wsl-perf-bench"
'@

$script = $template.Replace('__ROOT__', $DrvfsRoot).Replace('__SMALL__', "$SmallFiles").Replace('__LARGE__', "$LargeMb")
$lines = wsl -e bash -lc $script
if ($LASTEXITCODE -ne 0) { throw "The WSL benchmark failed." }

$results = @{}
foreach ($line in $lines) {
    if ($line -match '^(\S+)\s+(small|large)\s+(\d+)\s*$') {
        $results["$($matches[1])/$($matches[2])"] = [int]$matches[3]
    }
}

$drvfsSmall = $results['drvfs/small']
$ext4Small = $results['ext4/small']
$drvfsLarge = $results['drvfs/large']
$ext4Large = $results['ext4/large']

$smallRatio = if ($ext4Small -gt 0) { [math]::Round($drvfsSmall / $ext4Small, 1) } else { 0 }
$largeRatio = if ($ext4Large -gt 0) { [math]::Round($drvfsLarge / $ext4Large, 1) } else { 0 }

Write-Host "Small files ($SmallFiles): ext4 $ext4Small ms, drvfs $drvfsSmall ms ($smallRatio x slower)"
Write-Host "Large write (${LargeMb} MB + fsync): ext4 $ext4Large ms, drvfs $drvfsLarge ms ($largeRatio x slower)"
Write-Host "Windows mount compared: $DrvfsRoot against ext4 under ~"

if ($smallRatio -ge 3 -or $largeRatio -ge 3) {
    Write-Host 'Cross-filesystem I/O is expensive here. Keep heavy Linux-side I/O in the ext4 working area (~/work).'
}

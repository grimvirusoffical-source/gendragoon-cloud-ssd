# Pillow native dependency candidates

This builder produces candidate replacements for the existing Chaquopy FreeType
2.9.1 and libjpeg-turbo 1.5.3 runtime wheels. It does not change the Android app's
dependency selection, accept an SDK license, install a system toolchain, or edit
Red-SecretsXAI. A successful build is a binary compatibility and packaging check;
Android execution remains a separate acceptance gate.

The actual APK audit found 4 KiB load alignment in FreeType on both supported
ABIs and libjpeg on x86_64. The original arm64 JPEG library already has adequate
alignment. Both JPEG ABIs are rebuilt together to retain a documented, consistent
source and feature profile.

## Reviewed inputs

The public Chaquopy recipes are pinned to commit
`1f63c93d8beaf7062fbe51888ab9235475df3bb8` in
[chaquo/chaquopy](https://github.com/chaquo/chaquopy/tree/1f63c93d8beaf7062fbe51888ab9235475df3bb8/server/pypi/packages).
The script contains the official release archive URLs, SHA256 digests, and exact
SHA256 digests of the four original Chaquopy wheels. It downloads only those
bounded, verified inputs.

FreeType retains system zlib support, with HarfBuzz, PNG, and BZip2 disabled to
match the original dependency profile. JPEG retains the v6b API, eight-bit
samples, arithmetic encoding and decoding, and in-memory source and destination
managers. TurboJPEG and SIMD remain disabled, matching the original recipe.

FreeType uses its unchanged upstream CMake build. JPEG 1.5.3 has a Windows-only
CMake build, so the wrapper compiles the unchanged source list from its upstream
`Makefile.am`, uses the exact `jconfig.h` from each pinned reference wheel, and
instantiates its upstream symbol-version map for the existing v6b configuration.
The wrapper sets the existing Chaquopy SONAME without patching upstream source.

## Run in an isolated build tree

Use Linux with Python 3.12 or later, the official Android NDK r28c
`28.2.13676358`, CMake 3.22.1, and Ninja. Keep inputs, downloads, sources, logs,
and build output within a new private directory. The output directory must not
already exist. Android platform 21 is used to match the existing wheel tags.

```sh
systemd-run --scope --quiet \
  -p CPUQuota=200% -p MemoryMax=4G -p MemorySwapMax=0 -p TasksMax=256 \
  nice -n 15 ionice -c 2 -n 7 python3 -B build_runtime.py \
    --ndk /private-build/toolchains/android-ndk-r28c \
    --cmake /private-build/toolchains/cmake/bin/cmake \
    --ninja /private-build/toolchains/ninja/ninja \
    --output /private-build/outputs/pillow-candidate
```

The builder uses two compilation jobs within the resource limit. It strips
unneeded symbols and verifies each library's ELF architecture, exact SONAME,
preserved original exported API, allowed system dependencies, and 16 KiB load
alignment and offset congruence. Obsolete linker-generated address symbols are
reported separately from the original library API. FreeType must retain its
`libz.so` dependency. Absolute private build paths are rejected.

Only `wheels/` is a candidate distribution output. It contains four runtime-only
wheels with a distinct `9016` build tag, `provenance.json`, and `SHA256SUMS`.
Each wheel contains its shared library, original distribution metadata, a newly
computed wheel `RECORD`, upstream notices and licenses, Android NDK and LLVM
notices, and a build receipt. Development headers, source files, build logs, and
private encryption inputs are excluded. The source versions are unchanged.

## Acceptance before changing app inputs

1. Verify every wheel and receipt against `SHA256SUMS`, including the original
   input hashes, library architecture, SONAME, exports, dependencies, and ELF
   alignment. Inspect the final APK's actual extracted native libraries.
2. On each supported Android ABI, load Pillow and execute PNG encoding and
   decoding, JPEG encoding and decoding, and a real FreeType font render.
   Preserve the existing font and image functionality.
3. Exercise the full authenticated encryption to visual PNG to authenticated
   decryption fixture on Android using the unchanged pinned Red-SecretsXAI core
   and sourceless codec modules.
4. Run the packaged app on the required 16 KiB Android device or emulator and
   check all native dependencies. These two dependency replacements do not
   establish that other libraries, ZIP alignment, or Python assets are correct.

Keep these outputs candidate-only until those gates pass. The builder does not
claim that matching exported symbols proves identical behavior or fixes every
Android runtime issue.

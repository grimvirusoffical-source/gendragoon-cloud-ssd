# Android NumPy candidate builds

The current Chaquopy NumPy 1.26.2 wheels depend on external OpenBLAS 0.2.20 and gfortran 4.9 libraries whose actual ELF load segments are 4 KiB aligned. `check_native_pages.py` rejects those dependencies even when GenDragoon's own `librsx.so` files pass. No compatibility fallback or weakened audit is used.

This isolated recipe builds the complete official NumPy 2.5.4 source release, SHA-256 `9a94cf751c9ad8ebaa835bcd3d40dacf8534ad086b88c38029b65123c7999d2a`, with cibuildwheel 4.3.4's supported Python 3.13 Android crossbuild. The NumPy version matches the tested Mac runtime. External BLAS/LAPACK are disabled through documented Meson options. NumPy's own LAPACK-lite and all required core, linalg, FFT and random modules remain present. The pinned encryption library/source is neither modified nor included in the dependency build.

The build hook preserves all official Android linker flags, including `--no-undefined`, the target Python library search directory and 16 KiB maximum page size, and explicitly links `libpython3.13.so`. Every resulting Python extension must contain that actual ELF `DT_NEEDED` entry. Android requires this direct link even when Python is already loaded; it cannot use Linux-style implicit symbol resolution. This follows [PEP 738's linkage contract](https://peps.python.org/pep-0738/#linkage). The first device candidate exposed the missing direct link and is not approved for shipping.

`.github/workflows/android-dependencies.yml` uses licensed GitHub-hosted Android runners, builds arm64-v8a and x86_64 in separate bounded jobs, and publishes only candidate wheels, provenance and checksums. Docker and private credentials are unnecessary. The script verifies source hashes, native architecture/alignment, required modules and license notices, and rejects residual external BLAS/Fortran references. Candidate metadata explicitly says that device runtime verification is pending.

From an authorized environment with Java 17, Python 3.13, Android SDK licenses and the exact builder installed:

```sh
python -m pip install cibuildwheel==4.3.4
python -B native/Mobile/Android/dependencies/build_numpy.py --abi x86_64 --work-dir /absolute/new/isolated-build
```

The official build tool may install its required SDK/NDK/target-Python packages into the configured build environment. GenDragoon does not install global private credentials or modify other applications. Build concurrency is limited to two native compiler jobs.

A candidate wheel is **not** the shipping dependency pin. Before adoption, both architecture candidates must pass the complete packaged-APK ELF audit and the actual GenDragoon embedded codec, encrypted graph, cross-workspace AAD and portable-vault instrumentation on 4 KiB and 16 KiB Android. Package and restore compatibility must remain unchanged. A successful crosscompile alone does not establish Android behavior or store readiness.

## Explicit complete-app candidate profile

`candidate-lock.json` binds exactly eight public wheels: both complete NumPy 2.5.4 builds, the unchanged official Pillow 11.0.0 binaries, and both rebuilt FreeType 2.9.1 and JPEG 1.5.3 runtimes. The four small replacement runtimes are compiled-only inputs in `candidate-inputs/`; their reproducible builder, original recipe/source pins, configuration, preserved exports and licenses are recorded in `pillow-runtime/`. The NumPy wheels include the exact builder NDK 27.3 and LLVM redistribution notices and a freshly generated wheel RECORD. No private encryption source is included.

The NumPy artifacts are pinned to successful workflow run `40282484235` at source `793603cfb0a2ffb39ed4aa5adf1a43f0ae02cf19`. They are temporary GitHub Actions artifacts with a 14-day retention period. An expired or absent artifact fails this test profile; the workflow never substitutes an unreviewed wheel. Successful candidates need a durable, hash-bound distribution before any eventual shipping adoption.

The separate `android-candidate-device.yml` workflow downloads those exact public artifacts with the workflow's temporary read-only token, downloads the two SHA-pinned official Pillow wheels over verified TLS, and validates every whole-wheel hash, byte count, internal RECORD, native architecture and 16 KiB load alignment. Pip then runs offline against that exact set. Setting `GENDRAGOON_ANDROID_CANDIDATE_WHEELS` explicitly enables the profile and produces a separate `.runtimecandidate` application ID and version suffix. Default builds retain their existing dependency pins.

To prepare and inspect the isolated profile locally after obtaining the public artifacts:

```sh
gh run download 40282484235 --repo grimvirusoffical-source/gendragoon-cloud-ssd --pattern 'Android-NumPy-candidate-*' --dir /absolute/new/numpy-artifacts
python3.13 -B native/Mobile/Android/dependencies/candidate_profile.py --directory /absolute/new/candidate-wheels --prepare-from /absolute/new/numpy-artifacts
cd native/Mobile/Android
GENDRAGOON_ANDROID_CANDIDATE_WHEELS=/absolute/new/candidate-wheels gradle :app:assembleDebug :app:lint :app:testDebugUnitTest
```

The device workflow checks the actual complete APK's native dependencies for both arm64 and x86_64, then runs the actual x86_64 app on separate 4 KiB and 16 KiB Android emulators. Its six device tests exercise the pinned encryption/visual renderer at small and full 64 KiB chunk sizes, complete encrypted archive graph and cross-workspace authentication, Mac portable-vault/JCE/core interoperability, required NumPy linear algebra plus JPEG and FreeType behavior, and a Mac-produced encrypted PNG decoded and authenticated on Android. The full-size case also checks the actual carrier remains inside the storage protocol's 8 MiB limit. The public dummy carrier and keys are test data only. Failure evidence is retained separately for each page size, including a bounded emulator log. These emulator results do not establish behavior on physical ARM devices or store acceptance.

## Android file publication adapter

Android's app sandbox rejects the anonymous-file hard-link publication used by the library's Linux file I/O. GenDragoon's Android-only `gendragoon_android_codec.py` therefore delegates bounded cloud chunk and metadata encryption to the pinned library's existing memory `seal`/`open_` APIs and its exact file-payload helpers. These APIs use the same RSX3 authenticated format; both directions of interoperability with the unmodified file APIs are tested. No vendor function, source, cipher, key derivation or wire format is modified.

New encryption accepts at most 64 KiB plaintext, 2 KiB AAD and 68 KiB resulting ciphertext. Historical compact reads separately allow at most 8 MiB ciphertext and authenticated plaintext, matching the unchanged compact decoder's exact payload limit. The device graph test restores a real 2 MiB historical compact carrier and rejects wrong AAD, tampering and an oversized input without publishing plaintext. Restored payloads must authenticate completely, including final tag and clean EOF, before any plaintext output is created. Outputs use exclusive creation and mode 0600 in GenDragoon's private managed directories; existing files and symlinks are never replaced. Failed encryption, wrong AAD/key, ciphertext tampering, oversize inputs and disk-write failures have explicit negative tests. Both archive data and the metadata/index graph pass through this same bounded adapter. A partially written private staging file is never a verified transfer or library entry.

Primary references: [Chaquopy's current Android wheel guidance](https://github.com/chaquo/chaquopy/tree/master/server/pypi), [cibuildwheel Android support](https://cibuildwheel.pypa.io/en/stable/platforms/#android), [NumPy BLAS/LAPACK build options](https://numpy.org/doc/stable/building/blas_lapack.html), and [Android's 16 KiB checks](https://developer.android.com/guide/practices/page-sizes).

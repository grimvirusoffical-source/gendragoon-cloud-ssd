# Android NumPy candidate builds

The current Chaquopy NumPy 1.26.2 wheels depend on external OpenBLAS 0.2.20 and gfortran 4.9 libraries whose actual ELF load segments are 4 KiB aligned. `check_native_pages.py` rejects those dependencies even when GenDragoon's own `librsx.so` files pass. No compatibility fallback or weakened audit is used.

This isolated recipe builds the complete official NumPy 2.5.4 source release, SHA-256 `9a94cf751c9ad8ebaa835bcd3d40dacf8534ad086b88c38029b65123c7999d2a`, with cibuildwheel 4.3.4's supported Python 3.13 Android crossbuild. The NumPy version matches the tested Mac runtime. External BLAS/LAPACK are disabled through documented Meson options. NumPy's own LAPACK-lite and all required core, linalg, FFT and random modules remain present. The pinned encryption library/source is neither modified nor included in the dependency build.

`.github/workflows/android-dependencies.yml` uses licensed GitHub-hosted Android runners, builds arm64-v8a and x86_64 in separate bounded jobs, and publishes only candidate wheels, provenance and checksums. Docker and private credentials are unnecessary. The script verifies source hashes, native architecture/alignment, required modules and license notices, and rejects residual external BLAS/Fortran references. Candidate metadata explicitly says that device runtime verification is pending.

From an authorized environment with Java 17, Python 3.13, Android SDK licenses and the exact builder installed:

```sh
python -m pip install cibuildwheel==4.3.4
python -B native/Mobile/Android/dependencies/build_numpy.py --abi x86_64 --work-dir /absolute/new/isolated-build
```

The official build tool may install its required SDK/NDK/target-Python packages into the configured build environment. GenDragoon does not install global private credentials or modify other applications. Build concurrency is limited to two native compiler jobs.

A candidate wheel is **not** the shipping dependency pin. Before adoption, both architecture candidates must pass the complete packaged-APK ELF audit and the actual GenDragoon embedded codec, encrypted graph, cross-workspace AAD and portable-vault instrumentation on 4 KiB and 16 KiB Android. Package and restore compatibility must remain unchanged. A successful crosscompile alone does not establish Android behavior or store readiness.

Primary references: [Chaquopy's current Android wheel guidance](https://github.com/chaquo/chaquopy/tree/master/server/pypi), [cibuildwheel Android support](https://cibuildwheel.pypa.io/en/stable/platforms/#android), [NumPy BLAS/LAPACK build options](https://numpy.org/doc/stable/building/blas_lapack.html), and [Android's 16 KiB checks](https://developer.android.com/guide/practices/page-sizes).

#!/usr/bin/env python3
"""Candidate-only, same-version Chaquopy Pillow library rebuilds for 16 KiB pages.

Run under the operator's isolated CPU/memory limits. This never installs an SDK,
accepts a license prompt, changes the app's dependency pins, or touches librsx.
"""
import argparse
import base64
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import tarfile
import urllib.request
import zipfile

sys.dont_write_bytecode = True
RECIPE_COMMIT = "1f63c93d8beaf7062fbe51888ab9235475df3bb8"
BUILD_NUMBER = "9016"
ABIS = {"arm64-v8a": ("arm64_v8a", 183), "x86_64": ("x86_64", 62)}
LINKER_SYMBOLS = {"__bss_start", "__bss_start__", "__bss_end__", "_bss_end__", "__end__", "_edata", "_end", "_init", "_fini"}
PACKAGES = {
    "freetype": {
        "version": "2.9.1", "source": "freetype-2.9.1.tar.gz",
        "url": "https://download.savannah.gnu.org/releases/freetype/freetype-2.9.1.tar.gz",
        "sha256": "ec391504e55498adceb30baceebd147a6e963f636eb617424bcfc47a169898ce",
        "target": "freetype", "soname": "libfreetype.so", "wheelBuild": "2",
        "wheelHashes": {"arm64-v8a": "7a8262dc69d1bbf7209b3b7576744743670bd5a8cba48c7d8f08c151943ccbc7", "x86_64": "831e0fd721d132b7b04946399d714de9945acc56dffa34f3c037592cb17c8de1"},
        "options": ["-DBUILD_SHARED_LIBS=ON", "-DFT_WITH_ZLIB=ON", "-DCMAKE_DISABLE_FIND_PACKAGE_PNG=TRUE", "-DCMAKE_DISABLE_FIND_PACKAGE_HarfBuzz=TRUE", "-DCMAKE_DISABLE_FIND_PACKAGE_BZip2=TRUE"],
        "licenses": ["docs/FTL.TXT", "docs/LICENSE.TXT", "docs/GPLv2.TXT"],
    },
    "libjpeg": {
        "version": "1.5.3", "source": "libjpeg-turbo-1.5.3.tar.gz",
        "url": "https://downloads.sourceforge.net/project/libjpeg-turbo/1.5.3/libjpeg-turbo-1.5.3.tar.gz",
        "sha256": "b24890e2bb46e12e72a79f7e965f409f4e16466d00e1dd15d93d73ee6b592523",
        "target": "jpeg", "soname": "libjpeg_chaquopy.so", "wheelBuild": "1",
        "wheelHashes": {"arm64-v8a": "5555be57a2633fb5a3c0c810e89c8b705c471e3dabd95aa596fc7fdd48322728", "x86_64": "0ae61fe258eb17a34e66fb6b1c233eb6c5e6a8854e0900a1806422e9f5625a86"},
        "options": ["-DWITH_SIMD=OFF", "-DWITH_TURBOJPEG=OFF", "-DENABLE_STATIC=OFF", "-DENABLE_SHARED=ON", "-DWITH_JPEG7=OFF", "-DWITH_JPEG8=OFF", "-DWITH_12BIT=OFF", "-DWITH_ARITH_ENC=ON", "-DWITH_ARITH_DEC=ON", "-DWITH_MEM_SRCDST=ON", "-DBUILD=20171220"],
        "licenses": ["README.ijg", "LICENSE.md"],
    },
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def download(url, expected, target):
    if not target.exists():
        request = urllib.request.Request(url, headers={"User-Agent": "GenDragoon-dependency-verifier"})
        with urllib.request.urlopen(request, timeout=120) as response:
            data = response.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024 or sha(data) != expected:
            raise RuntimeError("Official input digest or bounded size mismatch")
        target.write_bytes(data)
    if sha(target.read_bytes()) != expected:
        raise RuntimeError("Cached input digest mismatch")
    return target


def elf(data):
    if data[:6] != b"\x7fELF\x02\x01":
        raise RuntimeError("Expected a little-endian ELF64 shared library")
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phsize, phcount = struct.unpack_from("<HH", data, 54)
    loads, dynamic = [], None
    for i in range(phcount):
        p = phoff + phsize * i
        kind = struct.unpack_from("<I", data, p)[0]
        offset, address, _, length = struct.unpack_from("<QQQQ", data, p + 8)
        if kind == 1:
            loads.append((offset, address, length, struct.unpack_from("<Q", data, p + 48)[0]))
        if kind == 2:
            dynamic = (offset, length)
    if not loads or not dynamic:
        raise RuntimeError("Missing ELF load or dynamic headers")
    tags, needed = {}, []
    for p in range(dynamic[0], sum(dynamic), 16):
        tag, value = struct.unpack_from("<QQ", data, p)
        if tag == 0:
            break
        tags[tag] = value
        if tag == 1:
            needed.append(value)
    address = tags[5]
    strings = next(offset + address - base for offset, base, length, _ in loads if base <= address < base + length)
    string = lambda n: data[strings + n:].split(b"\0", 1)[0].decode("utf8")
    shoff = struct.unpack_from("<Q", data, 40)[0]
    shsize, shcount = struct.unpack_from("<HH", data, 58)
    sections = [struct.unpack_from("<IIQQQQIIQQ", data, shoff + i * shsize) for i in range(shcount)]
    exports = set()
    for section in sections:
        if section[1] != 11:
            continue
        names = sections[section[6]]
        table = data[names[4]:names[4] + names[5]]
        for p in range(section[4], section[4] + section[5], section[9]):
            name, info, other, defined = struct.unpack_from("<IBBH", data, p)
            if defined and (info >> 4) in (1, 2) and (other & 3) in (0, 3):
                exports.add(table[name:].split(b"\0", 1)[0].decode("utf8"))
    versions = set()
    if 0x6FFFFFFC in tags:
        address = tags[0x6FFFFFFC]
        position = next(offset + address - base for offset, base, length, _ in loads if base <= address < base + length)
        for _ in range(tags[0x6FFFFFFD]):
            _, _, _, _, _, auxiliary, following = struct.unpack_from("<HHHHIII", data, position)
            name = struct.unpack_from("<I", data, position + auxiliary)[0]
            versions.add(string(name))
            if not following:
                break
            position += following
    return {"machine": struct.unpack_from("<H", data, 18)[0], "soname": string(tags[14]),
            "needed": [string(n) for n in needed], "loads": loads, "exports": exports,
            "versions": versions}


def wheel_name(name, record, abi, build):
    return f"chaquopy_{name}-{record['version']}-{build}-py3-none-android_21_{ABIS[abi][0]}.whl"


def jpeg_wrapper(upstream, wrapper, configuration):
    """Use upstream's library source set and the original wheel's exact ABI config.

    Release 1.5.3's CMake is Windows-only. This wrapper mirrors its official
    --without-turbojpeg --without-simd Autotools profile without changing sources
    or requiring a global make/autoconf installation.
    """
    text = (upstream / "Makefile.am").read_text()
    match = re.search(r"^libjpeg_la_SOURCES = (.*?)(?:\n\n)", text, re.M | re.S)
    if not match:
        raise RuntimeError("Upstream JPEG source-list layout changed")
    names = match.group(1).replace("$(HDRS)", "").replace("\\\n", " ").split()
    names += ["jaricom.c", "jcarith.c", "jdarith.c", "jsimd_none.c"]
    if len(names) != len(set(names)) or any(not (upstream / n).is_file() or not n.endswith(".c") for n in names):
        raise RuntimeError("Unexpected unchanged upstream JPEG source set")
    required = [b"#define JPEG_LIB_VERSION 62", b"#define C_ARITH_CODING_SUPPORTED 1",
                b"#define D_ARITH_CODING_SUPPORTED 1", b"#define MEM_SRCDST_SUPPORTED 1"]
    if any(value not in configuration for value in required) or b"#define WITH_SIMD 1" in configuration:
        raise RuntimeError("Original JPEG ABI/profile no longer matches this wrapper")
    (wrapper / "jconfig.h").write_bytes(configuration)
    (wrapper / "jconfigint.h").write_text(
        '#define BUILD "20171220"\n#define inline __inline__\n'
        '#define INLINE __attribute__((always_inline)) __inline__\n'
        '#define PACKAGE_NAME "libjpeg-turbo"\n#define VERSION "1.5.3"\n#define SIZEOF_SIZE_T 8\n')
    version_map = (upstream / "libjpeg.map.in").read_text().replace("@JPEG_LIB_VERSION_DECIMAL@", "6.2")
    version_map = version_map.replace("@MEM_SRCDST_FUNCTIONS@", "global: jpeg_mem_dest; jpeg_mem_src;")
    if "@" in version_map:
        raise RuntimeError("Unreviewed JPEG symbol-version template")
    (wrapper / "libjpeg.map").write_text(version_map)
    (wrapper / "CMakeLists.txt").write_text(
        'cmake_minimum_required(VERSION 3.22)\nproject(GenDragoonPillowRuntime C)\n'
        'add_library(jpeg SHARED\n' + ''.join('  "${GD_UPSTREAM}/' + n + '"\n' for n in names) + ')\n'
        'target_include_directories(jpeg PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}" "${GD_UPSTREAM}")\n'
        'target_link_libraries(jpeg PRIVATE m)\n'
        'target_link_options(jpeg PRIVATE "-Wl,--version-script,${CMAKE_CURRENT_SOURCE_DIR}/libjpeg.map")\n'
        'set_target_properties(jpeg PROPERTIES OUTPUT_NAME jpeg_chaquopy)\n')
    return sha(configuration)


def package_wheel(reference, library, package, record, abi, output, proof, licenses):
    files = {}
    with zipfile.ZipFile(reference) as old:
        info = f"chaquopy_{package}-{record['version']}.dist-info"
        for member in old.namelist():
            if member.startswith(info + "/") and not member.endswith("/RECORD"):
                files[member] = old.read(member)
        # Runtime-only wheel: keep full shared-library functionality; development
        # headers and build/source trees are intentionally not public app inputs.
        files["chaquopy/lib/" + record["soname"]] = library.read_bytes()
    wheel = files[info + "/WHEEL"].decode()
    lines = [line for line in wheel.splitlines() if not line.startswith(("Build:", "Generator:"))]
    lines += ["Build: " + BUILD_NUMBER, "Generator: GenDragoon same-version 16-KiB candidate rebuild"]
    files[info + "/WHEEL"] = ("\n".join(lines) + "\n").encode()
    for name, data in licenses.items():
        files[info + "/licenses/" + name] = data
    files[info + "/GENDRAGOON-REBUILD.json"] = (json.dumps(proof, sort_keys=True, indent=2) + "\n").encode()
    rows = []
    for name, data in sorted(files.items()):
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        rows.append([name, "sha256=" + digest, str(len(data))])
    rows.append([info + "/RECORD", "", ""])
    csvdata = io.StringIO(newline="")
    csv.writer(csvdata, lineterminator="\n").writerows(rows)
    files[info + "/RECORD"] = csvdata.getvalue().encode()
    target = output / wheel_name(package, record, abi, BUILD_NUMBER)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            member = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            member.compress_type = zipfile.ZIP_DEFLATED
            member.external_attr = 0o100644 << 16
            archive.writestr(member, data, compresslevel=9)
    return {"archive": target.name, "bytes": target.stat().st_size, "sha256": sha(target.read_bytes()), "proof": proof}


def build(args):
    ndk, output = args.ndk.resolve(), args.output.resolve()
    if output.exists() or not output.parent.is_dir():
        raise RuntimeError("Choose a new output directory inside the private build tree")
    if "28.2.13676358" not in (ndk / "source.properties").read_text():
        raise RuntimeError("This candidate requires the reviewed NDK 28.2.13676358")
    output.mkdir(mode=0o700)
    downloads, sources, wheels = (output / name for name in ("downloads", "sources", "wheels"))
    for folder in (downloads, sources, wheels):
        folder.mkdir(mode=0o700)
    toolchain = ndk / "build/cmake/android.toolchain.cmake"
    prebuilt = ndk / "toolchains/llvm/prebuilt/linux-x86_64"
    strip = prebuilt / "bin/llvm-strip"
    licenses = {"Android-NDK-r28c-NOTICE.txt": (ndk / "NOTICE").read_bytes(),
                "Android-NDK-r28c-LLVM-NOTICE.txt": (prebuilt / "NOTICE").read_bytes()}
    artifacts = []
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    for package, record in PACKAGES.items():
        source = download(record["url"], record["sha256"], downloads / record["source"])
        folder = sources / package
        folder.mkdir()
        with tarfile.open(source) as archive:
            archive.extractall(folder, filter="data")
        children = list(folder.iterdir())
        if len(children) != 1 or not (children[0] / "CMakeLists.txt").is_file():
            raise RuntimeError("Unexpected upstream source archive layout")
        upstream = children[0]
        notice = dict(licenses)
        for name in record["licenses"]:
            notice[package + "-" + Path(name).name] = (upstream / name).read_bytes()
        wrapper = output / (package + "-wrapper")
        wrapper.mkdir()
        if package != "libjpeg":
            (wrapper / "CMakeLists.txt").write_text(
                'cmake_minimum_required(VERSION 3.22)\nproject(GenDragoonPillowRuntime C)\n'
                'add_subdirectory("${GD_UPSTREAM}" upstream)\n'
                f'set_target_properties({record["target"]} PROPERTIES OUTPUT_NAME {record["soname"][3:-3]})\n'
                f'set_property(TARGET {record["target"]} PROPERTY VERSION)\n'
                f'set_property(TARGET {record["target"]} PROPERTY SOVERSION)\n')
        for abi in ABIS:
            original_name = wheel_name(package, record, abi, record["wheelBuild"])
            url = f"https://chaquo.com/pypi-13.1/chaquopy-{package}/{original_name}"
            reference = download(url, record["wheelHashes"][abi], downloads / original_name)
            with zipfile.ZipFile(reference) as archive:
                old_data = archive.read("chaquopy/lib/" + record["soname"])
                config_sha = jpeg_wrapper(upstream, wrapper, archive.read("chaquopy/include/jconfig.h")) if package == "libjpeg" else None
            old = elf(old_data)
            directory = output / (package + "-" + abi)
            command = [str(args.cmake), "-S", str(wrapper), "-B", str(directory), "-G", "Ninja",
                       "-DCMAKE_MAKE_PROGRAM=" + str(args.ninja.resolve()), "-DCMAKE_TOOLCHAIN_FILE=" + str(toolchain),
                       "-DGD_UPSTREAM=" + str(upstream), "-DANDROID_ABI=" + abi, "-DANDROID_PLATFORM=android-21",
                       "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384 -Wl,--no-undefined",
                       "-DCMAKE_C_FLAGS_RELEASE=-O2 -DNDEBUG -ffile-prefix-map=" + str(output) + "=gendragoon-pillow-runtime",
                       *record["options"]]
            with (output / (package + "-" + abi + ".log")).open("w") as log:
                subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
                subprocess.run([str(args.cmake), "--build", str(directory), "--target", record["target"], "--parallel", "2"], env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
            candidates = list(directory.rglob(record["soname"]))
            if len(candidates) != 1:
                raise RuntimeError("Expected one exact-SONAME candidate library")
            library = candidates[0]
            subprocess.run([str(strip), "--strip-unneeded", str(library)], check=True)
            data, parsed = library.read_bytes(), elf(library.read_bytes())
            # GNU ld also emits version-node names as absolute dynsym entries;
            # LLD keeps those in ELF version definitions without fake exports.
            # Check real exported API and version definitions independently.
            missing = old["exports"] - parsed["exports"] - LINKER_SYMBOLS - old["versions"]
            if missing:
                raise RuntimeError("Original exported API missing: " + ", ".join(sorted(missing)))
            if old["versions"] - parsed["versions"]:
                raise RuntimeError("Original ELF symbol-version definitions missing")
            if parsed["machine"] != ABIS[abi][1] or parsed["soname"] != record["soname"]:
                raise RuntimeError("Architecture or exact Chaquopy SONAME changed")
            if any(align < 16384 or offset % 16384 != address % 16384 for offset, address, _, align in parsed["loads"]):
                raise RuntimeError("Candidate does not support 16 KiB load alignment")
            if set(parsed["needed"]) - {"libm.so", "libz.so", "libdl.so", "libc.so"}:
                raise RuntimeError("Unexpected native dependency")
            if package == "freetype" and "libz.so" not in parsed["needed"]:
                raise RuntimeError("The original system-zlib font support was lost")
            if str(output).encode() in data:
                raise RuntimeError("Private build paths remain in a distribution library")
            proof = {"schema": 1, "status": "candidate-device-tests-required", "package": package,
                     "version": record["version"], "abi": abi, "apiLevel": 21,
                     "officialRecipeCommit": RECIPE_COMMIT, "sourceURL": record["url"], "sourceSHA256": record["sha256"],
                     "referenceWheelSHA256": record["wheelHashes"][abi], "librarySHA256": sha(data),
                     "soname": parsed["soname"], "needed": parsed["needed"],
                     "loadAlignments": [load[3] for load in parsed["loads"]],
                     "originalExportsPreserved": len(old["exports"] & parsed["exports"]), "missingOriginalAPIExports": [],
                     "symbolVersionDefinitions": sorted(parsed["versions"]),
                     "omittedOldLinkerSymbols": sorted((old["exports"] - parsed["exports"]) & LINKER_SYMBOLS),
                     "profile": record["options"], "ndkVersion": "28.2.13676358",
                     "buildMethod": "unchanged-upstream-cmake" if package == "freetype" else "unchanged-autotools-source-list-with-original-wheel-config",
                     "originalConfigurationSHA256": config_sha,
                     "privateEncryptionSourceChanged": False, "runtimeOnlyWheel": True,
                     "pending": ["Android Pillow JPEG and FreeType font test", "16 KiB device/emulator test", "Full encrypted visual codec instrumentation"]}
            artifacts.append(package_wheel(reference, library, package, record, abi, wheels, proof, notice))
            print(json.dumps({"package": package, "abi": abi, "verified": True, "libraryBytes": len(data)}), flush=True)
    manifest = {"schema": 1, "status": "candidate-only-no-app-pin-changed", "artifacts": artifacts}
    (wheels / "provenance.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    (wheels / "SHA256SUMS").write_text("".join(a["sha256"] + "  " + a["archive"] + "\n" for a in artifacts))
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ndk", type=Path, required=True)
    parser.add_argument("--cmake", type=Path, required=True)
    parser.add_argument("--ninja", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    build(parser.parse_args())

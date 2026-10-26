"""Actual-device dependency probes; public dummy fixtures only, no network."""
import hashlib
import io
import json
from pathlib import Path


def dependencies():
    import numpy as np
    from PIL import Image, ImageFont, features
    coefficients, *_ = np.linalg.lstsq(np.array([[1., 1.], [2., 1.], [3., 1.]]), np.array([3., 5., 7.]), rcond=None)
    if not np.allclose(coefficients, [2., 1.]) or not np.isclose(np.linalg.norm([3., 4.]), 5.):
        raise RuntimeError('Required complete NumPy linear algebra failed')
    if not all(features.check(name) for name in ('jpg', 'zlib', 'freetype2')):
        raise RuntimeError('Required Pillow JPEG, PNG or font support is unavailable')
    image = Image.new('RGB', (16, 16), (40, 110, 190))
    stream = io.BytesIO()
    image.save(stream, format='JPEG', quality=95)
    with Image.open(io.BytesIO(stream.getvalue())) as restored:
        restored.load()
        if restored.size != image.size or any(abs(a-b) > 5 for a, b in zip(restored.getpixel((8, 8)), (40, 110, 190))):
            raise RuntimeError('Actual Pillow JPEG encoding/decoding failed')
    # Pillow's bundled Aileron font exercises the actual FreeType shared library.
    font = ImageFont.load_default(size=14)
    if font.getmask('GenDragoon 123').getbbox() is None:
        raise RuntimeError('Actual FreeType font rasterization failed')
    return json.dumps({'ok': True, 'numpy': np.__version__, 'jpeg': True, 'font': True, 'lapackLite': True})


def cross_platform(directory, secret):
    from redxai import _librsx
    from redsecretsxai import decode_image
    root = Path(directory)
    metadata = json.loads((root / 'mac-visual-v1.json').read_text())
    png = (root / 'mac-visual-v1.png').read_bytes()
    if hashlib.sha256(png).hexdigest() != metadata['pngSHA256']:
        raise RuntimeError('Public Mac visual fixture carrier differs')
    sealed = root / 'sealed'
    sealed.write_bytes(decode_image(png))
    with _librsx.session_open_readonly(secret, str(root / 'public.keymap'))[0] as session:
        _librsx.decrypt_file(session, str(sealed), out_path=str(root / 'restored'), aad=metadata['aad'].encode())
        rejected = False
        try:
            _librsx.decrypt_file(session, str(sealed), out_path=str(root / 'wrong-aad'), aad=b'wrong-cross-platform-aad')
        except Exception:
            rejected = True
    plain = (root / 'restored').read_bytes()
    if not rejected or len(plain) != metadata['plainBytes'] or hashlib.sha256(plain).hexdigest() != metadata['plainSHA256']:
        raise RuntimeError('Mac-to-Android visual decryption or AAD isolation failed')
    return json.dumps({'verified': True, 'crossPlatform': True, 'wrongAadRejected': rejected})

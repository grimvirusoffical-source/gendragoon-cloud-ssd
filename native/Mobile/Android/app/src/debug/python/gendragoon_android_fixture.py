"""Debug APK test fixture. No production endpoints, credentials or user data."""
import hashlib
import json
from pathlib import Path


def roundtrip(directory):
    import gendragoon_redx_storage as storage
    root=Path(directory);root.mkdir(mode=0o700,parents=True,exist_ok=True)
    blobs,items={},{}
    class Receiver:
        def __init__(self,config):
            self.config=config;self.workspace=config["workspaceId"];self.receiver=config["receiverId"];self.secret=config["storageSecret"];self.keymap=Path(config["keymapPath"])
        def verified_workers(self,write=False):return 2
        def get_png(self,oid):
            if (self.workspace,oid)not in blobs:raise storage.RedXStorageError("Fixture blob missing",404)
            return blobs[self.workspace,oid]
        def put_png(self,oid,png):
            blobs[self.workspace,oid]=png
            return {"id":oid,"carrierBytes":len(png),"carrierSha256":hashlib.sha256(png).hexdigest()}
        def register(self,key,value):items[key]={"key":key,**value};return items[key]
    config={"provider":"redxai","cloudApi":storage.API,"workspaceId":"a"*32,"receiverId":"b"*64,"bearerToken":"rxca_"+"c"*43,"storageSecret":"PUBLIC-TEST-ONLY-Android-fixture-secret-1234","keymapPath":str(root/"fixture.keymap")}
    source=root/"selected";plain=b"PUBLIC ANDROID FIXTURE\0"*37;source.write_bytes(plain);sha=hashlib.sha256(plain).hexdigest();manifest=[{"path":".","type":"file","executable":0,"size":len(plain),"sha256":sha}]
    result=storage.upload_archive(config,source,"d"*18,"fixture.txt","file","flat",sha,manifest,client_factory=Receiver)
    destination=root/"restored";restored=storage.download_archive(config,items["d"*18],destination,client_factory=Receiver)
    if destination.read_bytes()!=plain or restored["manifest"]!=manifest:raise RuntimeError("Actual Android pinned archive graph did not roundtrip")
    # Same ciphertext at a different workspace must fail AEAD authentication.
    sample_id=next(iter(blobs))[1];foreign={**config,"workspaceId":"e"*32};blobs[foreign["workspaceId"],sample_id]=blobs[config["workspaceId"],sample_id]
    rejected=False
    try:
        with storage.Codec(Receiver(foreign))as codec:codec.open(blobs[foreign["workspaceId"],sample_id],sample_id)
    except Exception:rejected=True
    if not rejected:raise RuntimeError("Android codec accepted ciphertext under another workspace AAD")
    # Preserve older compact carriers with data larger than today's write chunk.
    # All encryption, payload packing and compact carrier APIs are unchanged.
    from redsecretsxai import encode_storage_image
    from gendragoon_android_codec import MAX_LEGACY_READ
    legacy_plain = (b'PUBLIC legacy compact fixture\0' * 100000)[:2*1024*1024]
    legacy_id = '9'*32
    legacy_aad = storage.aad(config['receiverId'], config['workspaceId'], legacy_id)
    with storage.Codec(Receiver(config)) as codec:
        sealed = storage.rsx.seal(codec._session, storage.rsx._pack_file_payload('plain', legacy_plain), aad=legacy_aad)
        if codec.open(encode_storage_image(sealed), legacy_id) != legacy_plain:
            raise RuntimeError('Historic compact PNG did not authenticate and restore')
        source = root/'legacy-sealed'
        source.write_bytes(sealed)
        corrupt = root/'legacy-corrupt'
        corrupt.write_bytes(sealed[:-1]+bytes([sealed[-1]^1]))
        oversized = root/'legacy-oversized'
        with oversized.open('xb') as output:output.truncate(MAX_LEGACY_READ+1)
        for incoming, given_aad, name in [(source,b'wrong-aad','wrong-aad'),(corrupt,legacy_aad,'tampered'),(oversized,legacy_aad,'oversized')]:
            target = root/('unpublished-'+name)
            try:storage.rsx.decrypt_file(codec._session,incoming,out_path=target,aad=given_aad)
            except Exception:pass
            else:raise RuntimeError('Invalid legacy input unexpectedly restored')
            if target.exists():raise RuntimeError('Invalid legacy input published plaintext')
    return json.dumps({"ok":True,"verified":True,"pngObjects":len(blobs)-1,"plainBytes":len(plain),"crossWorkspaceRejected":rejected,"legacyCompactBytes":len(legacy_plain),"legacyBadAuthNoOutput":True})

"""GenDragoon Cloud SSD SDK for Python: the storage provider API (/provider/v1), encrypted files and folders,
folder sync, sharing, change events and the connect handshake."""
from .account import AccountClient, ConnectRequest, parse_connect_link
from .client import VERSION, Client, ListItem, ListPage, Manifest, PutResult
from .connect import PKCE, Connector, Loopback, connect_link, new_pkce, pkce_challenge
from .crypto import (drive_manifest_key, open_chunk, open_manifest, seal_chunk, seal_manifest, sub_key, unwrap_master_key,
                     wrap_master_key)
from .drive import DEFAULT_CHUNK_SIZE, Drive, Entry, clean_path, collect_garbage
from .errors import APIError, ChecksumError, CorruptError, GendragoonError, LockedError, WrongPassphraseError
from .events import Event, watch
from .gate import DEFAULT_MAX_LEVEL, LEVELS, MAX_LEVEL_ENV, LevelError, Operation, level_gate, parse_level
from .keyring import Keyring
from .operations import OPERATIONS
from .share import Identity, create_read_key, export_share, list_read_keys, open_share, open_share_envelope, revoke_read_key
from .sync import SyncReport, mirror, pull, push

__version__ = VERSION
__all__ = [n for n in dir() if not n.startswith("_")]

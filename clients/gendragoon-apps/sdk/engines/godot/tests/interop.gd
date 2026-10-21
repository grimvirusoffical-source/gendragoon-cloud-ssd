extends SceneTree
## The Godot participant of the cross-language interop check (sdk/contract/run.sh): opens the shared encrypted drive
## "interop", verifies every file the other SDKs wrote, and writes its own. Prints one JSON line.
## Environment: GD_SDK_BASE, GD_SDK_KEY, GD_SDK_PASSPHRASE, GD_SDK_LANG (default "godot"). --init creates the master key.


func _initialize() -> void:
	_run()


func _fail(msg: String) -> void:
	printerr("interop: " + msg)
	quit(1)


func _run() -> void:
	await process_frame
	var lang := OS.get_environment("GD_SDK_LANG")
	if lang.is_empty():
		lang = "godot"
	var c := GendragoonClient.new(OS.get_environment("GD_SDK_BASE"), OS.get_environment("GD_SDK_KEY"))
	root.add_child(c)
	var keys := GendragoonKeyring.new(c)
	var passphrase := OS.get_environment("GD_SDK_PASSPHRASE")
	var k: GendragoonResult
	if OS.get_cmdline_user_args().has("--init"):
		k = await keys.create(passphrase)
	else:
		k = await keys.unlock(passphrase)
	if not k.ok:
		return _fail("keyring: %s" % k)
	var d := GendragoonDrive.new(c, "interop", keys)
	var listing := await d.list("")
	if not listing.ok:
		return _fail("list: %s" % listing)
	var verified := []
	for e in listing.value:
		if e["folder"] or not String(e["name"]).begins_with("from-"):
			continue
		var who := String(e["name"]).trim_prefix("from-").trim_suffix(".txt")
		var got := await d.read_file(e["path"])
		if not got.ok or (got.value as PackedByteArray).get_string_from_utf8() != "hello from %s\n" % who:
			return _fail("%s: unexpected content" % e["path"])
		verified.append(who)
	var w := await d.write_file("from-%s.txt" % lang, ("hello from %s\n" % lang).to_utf8_buffer())
	if not w.ok:
		return _fail("write: %s" % w)
	print(JSON.stringify({"lang": lang, "verified": verified}))
	quit(0)
